import type { IHtmlFrameTarget, Muya } from '@muyajs/core'
import {
  collectHtmlFrameTargets,
  findHtmlBlockSpans,
  formatHtmlSize,
  isHeavyHtml
} from '@muyajs/core'
import log from 'electron-log'
import { t } from '../i18n'
import { buildLiveFrame, buildLivePlaceholder, LIVE_FRAME_CLASS_PREFIX } from './exportLiveFrame'

// 导出前，把「带沙箱帧的内嵌 HTML 块」换成它在导出物里的样子。
//
// 背景：内嵌 HTML 块的尺寸是会话内的（拖拽/缩放只写内联 style，从不写回 markdown），
// 而导出是把 markdown 重新渲染一遍 —— 块里 `<script>` 会被 DOMPurify 剥掉或转义，
// 结果导出物里那块要么空白、要么只剩一段可见的源码文本。
//
// 两种导出形态：
//   · image（PDF / 打印 / docx）：按当前显示尺寸离屏重放一张 PNG（主进程负责，
//     见 main/ipc/exportHtmlFrame.ts）。纸面上要的就是一张定格的图。
//   · live（HTML 导出）：保留成一个沙箱 iframe —— 单文件带走也能点、能交互，不用
//     再单独发一份原型 html。源码直接进 `srcdoc`，不依赖墨记自己的引导页。
//     `srcdoc` 是 HTML 属性，转义只处理 `&` 与 `"`（`<`/`>` 是标记本身，不能转）。
//
// 替换只作用于导出用的 markdown 副本，文档本身不动。

/** 与 htmlPreview 的判定保持一致：块内有 `<script` 才会挂沙箱帧。 */
const SCRIPT_TAG_REG = /<script[\s>/]/i

export interface IInlineHtmlBlocksResult {
  /** 可直接交给导出渲染的 markdown */
  markdown: string
  /** 按标记序号排列的 iframe 片段（仅 live 形态非空） */
  frames: string[]
}

// 尺寸按编辑器里的显示尺寸给；块比页面还宽时（拉得很宽的原型）**等比**缩小，不能只压
// 宽度：固定高度 + 图片 height:100% 会把内容横向挤扁（实测 1260×476 的块在 A4 上被压成
// 一条窄条）。height:auto 让高度跟着宽度走，比例永远是对的。
const buildImageBlock = (width: number, dataUrl: string): string =>
  `<div style="width:${width}px;max-width:100%;overflow:hidden;break-inside:avoid">` +
  `<img src="${dataUrl}" alt="内嵌 HTML" style="display:block;width:100%;height:auto;border:0">` +
  '</div>'

/**
 * 同时在截的块数上限。每块截图大半时间花在主进程等内容稳定、等出帧的固定时长上
 * （实测约 440ms/块），逐块串行时 12 块的 PRD 光截图就要 5.3s；每块各占一个离屏
 * 渲染进程，所以只放开到 3 个，不无限并发。
 */
export const RASTERIZE_CONCURRENCY = 3

/**
 * 逐块截图，结果按文档顺序返回；任何一块失败就返回 null（调用方整篇按原样导出），
 * 失败后不再发起新的截图。
 */
const rasterizeAll = async (
  targets: IHtmlFrameTarget[],
  shellUrl: string
): Promise<string[] | null> => {
  const dataUrls: string[] = new Array(targets.length)
  let next = 0
  let failed = false

  const worker = async (): Promise<void> => {
    while (!failed && next < targets.length) {
      const index = next++
      const target = targets[index]
      const result = await window.electron.ipcRenderer.invoke('mt::export::rasterize-html-frame', {
        shellUrl,
        html: target.html,
        width: target.width,
        height: target.height,
        zoom: target.zoom
      })
      if (!result?.dataUrl) {
        failed = true
        return
      }
      dataUrls[index] = result.dataUrl
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(RASTERIZE_CONCURRENCY, targets.length) }, () => worker())
  )
  return failed ? null : dataUrls
}

/** 大体积 HTML 块在 PDF / 打印 / docx 里的占位（编辑器里也只显示降级卡片，没有帧可截）。 */
const buildHeavyNote = (html: string): string =>
  '<div style="padding:12px 16px;border:1px dashed #b8b8b8;border-radius:6px;color:#666;' +
  'font-size:13px;break-inside:avoid">' +
  escapeText(t('editor.htmlFile.exportHeavy', { size: formatHtmlSize(html) })) +
  '</div>'

const TEXT_ENTITIES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;'
}
const escapeText = (text: string): string =>
  text.replace(/[&<>"]/g, (ch) => TEXT_ENTITIES[ch] ?? ch)

/** 大体积脚本块在 HTML 导出里的高度：编辑器里没有帧，没有显示尺寸可照搬。 */
const HEAVY_LIVE_HEIGHT = 800

/**
 * 返回可直接交给导出渲染的 markdown，以及 live 形态要注入的 iframe 片段。
 *
 * 两类块分开处理：
 *   · 轻量脚本块：编辑器里挂着帧，按帧的显示尺寸截图 / 转活帧。帧与源码数量对不上、
 *     截图失败时这部分宁可原样导出，绝不猜。
 *   · 大体积脚本块（`isHeavyHtml`，编辑器里只显示降级卡片、没有帧）：HTML 导出照样
 *     保留成活帧（源码进 srcdoc，跟随页面宽度）；PDF / 打印 / docx 换成一行说明，
 *     不把几 MB 的源码当静态 HTML 塞进纸面。
 *   不含脚本的大块原样导出（静态 HTML，与改动前一致）。
 */
export const inlineFramedHtmlBlocks = async (
  muya: Muya,
  markdown: string,
  options: { live?: boolean } = {}
): Promise<IInlineHtmlBlocksResult> => {
  const unchanged: IInlineHtmlBlocksResult = { markdown, frames: [] }
  const targets = collectHtmlFrameTargets(muya?.domNode)
  const spans = findHtmlBlockSpans(markdown).filter((span) => SCRIPT_TAG_REG.test(span.text))
  if (!targets.length && !spans.length) return unchanged

  // 只有轻量脚本块在编辑器里挂了帧；按同一条件筛源码，顺序即文档顺序。
  const heavy = spans.map((span) => isHeavyHtml(span.text))
  const framed = spans.filter((_, index) => !heavy[index])
  const replacements = new Map<number, string>()
  const frames: string[] = []

  let framedReplacements: string[] | null = null
  if (framed.length !== targets.length) {
    log.warn(
      `[export] 内嵌 HTML 块数量对不上（帧 ${targets.length} / 源码 ${framed.length}），本块按原样导出`
    )
  } else if (targets.length && options.live) {
    framedReplacements = []
  } else if (targets.length) {
    const shellUrl = new URL('html-frame.html', document.baseURI).href
    const dataUrls = await rasterizeAll(targets, shellUrl)
    if (dataUrls) {
      // 用编辑器里的显示尺寸展示：导出物看到的和屏幕上一样大。
      framedReplacements = targets.map((target, index) =>
        buildImageBlock(target.width, dataUrls[index])
      )
    } else {
      log.warn('[export] 内嵌 HTML 块截图失败，本块按原样导出')
    }
  }

  let framedIndex = 0
  spans.forEach((span, index) => {
    if (heavy[index]) {
      if (options.live) {
        replacements.set(index, buildLivePlaceholder(frames.length, 0, HEAVY_LIVE_HEIGHT, true))
        frames.push(buildLiveFrame(span.text))
      } else {
        replacements.set(index, buildHeavyNote(span.text))
      }
      return
    }
    const target = targets[framedIndex]
    const image = framedReplacements?.[framedIndex]
    framedIndex++
    if (!framedReplacements) return
    if (options.live) {
      // 活的：不需要截图，源码直接进 srcdoc。
      replacements.set(
        index,
        buildLivePlaceholder(frames.length, target.width, target.height, target.auto)
      )
      frames.push(buildLiveFrame(target.html))
    } else if (image) {
      replacements.set(index, image)
    }
  })

  if (!replacements.size) return unchanged

  const lines = markdown.split('\n')
  const kept: string[] = []
  let cursor = 0

  spans.forEach((span, index) => {
    const replacement = replacements.get(index)
    if (replacement === undefined) return
    kept.push(...lines.slice(cursor, span.start), replacement, '')
    cursor = span.blankTerminated ? span.end + 1 : span.end
  })
  kept.push(...lines.slice(cursor))

  return { markdown: kept.join('\n'), frames }
}
