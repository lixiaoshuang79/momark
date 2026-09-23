import type { Muya } from '@muyajs/core'
import { collectHtmlFrameTargets, findHtmlBlockSpans } from '@muyajs/core'
import log from 'electron-log'
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
 * 返回可直接交给导出渲染的 markdown，以及 live 形态要注入的 iframe 片段。
 * 任何一步对不上（帧与源码数量不符、截图失败）都宁可原样导出，绝不猜。
 */
export const inlineFramedHtmlBlocks = async (
  muya: Muya,
  markdown: string,
  options: { live?: boolean } = {}
): Promise<IInlineHtmlBlocksResult> => {
  const unchanged: IInlineHtmlBlocksResult = { markdown, frames: [] }
  const targets = collectHtmlFrameTargets(muya?.domNode)
  if (!targets.length) return unchanged

  // 只有块内含脚本的块才在编辑器里挂了帧；按同一条件筛源码，顺序即文档顺序。
  const spans = findHtmlBlockSpans(markdown).filter((span) => SCRIPT_TAG_REG.test(span.text))
  if (spans.length !== targets.length) {
    log.warn(
      `[export] 内嵌 HTML 块数量对不上（帧 ${targets.length} / 源码 ${spans.length}），本块按原样导出`
    )
    return unchanged
  }

  const replacements: string[] = []
  const frames: string[] = []

  if (options.live) {
    // 活的：不需要截图，源码直接进 srcdoc。
    targets.forEach((target, index) => {
      replacements.push(buildLivePlaceholder(index, target.width, target.height, target.auto))
      frames.push(buildLiveFrame(target.html))
    })
  } else {
    const shellUrl = new URL('html-frame.html', document.baseURI).href

    for (const target of targets) {
      const result = await window.electron.ipcRenderer.invoke('mt::export::rasterize-html-frame', {
        shellUrl,
        html: target.html,
        width: target.width,
        height: target.height,
        zoom: target.zoom
      })

      if (!result?.dataUrl) {
        log.warn('[export] 内嵌 HTML 块截图失败，本块按原样导出')
        return unchanged
      }

      // 用编辑器里的显示尺寸展示：导出物看到的和屏幕上一样大。
      replacements.push(buildImageBlock(target.width, result.dataUrl))
    }
  }

  const lines = markdown.split('\n')
  const kept: string[] = []
  let cursor = 0

  spans.forEach((span, index) => {
    kept.push(...lines.slice(cursor, span.start), replacements[index], '')
    cursor = span.blankTerminated ? span.end + 1 : span.end
  })
  kept.push(...lines.slice(cursor))

  return { markdown: kept.join('\n'), frames }
}
