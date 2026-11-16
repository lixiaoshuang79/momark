/**
 * 把「粘贴进来的 html 文件」内联成可整体写进 .md 的一段 HTML。
 *
 * 目标：转换后 .md 是**单文件可带走**的 —— 别人只拿到这个 .md、断网打开也能看到
 * 完整效果。所以 html 所在目录（含子目录）里的 CSS / JS / 图片都要读进正文里：样式塞进
 * `<style>`、脚本塞进 `<script>`、图片转 base64 data URI。远程 http(s) 资源、data:
 * 资源、锚点保持原样（它们不依赖本地文件）。
 *
 * 读取范围只限 html 所在目录：内联结果会投进能跑脚本的沙箱帧，页面脚本读得到内联进来的
 * 一切，`../.ssh/id_rsa`、`/etc/passwd` 这类引用一旦读进来就等于交给了页面。范围按
 * realpath 判定，目录里指向外面的符号链接同样算越界。
 *
 * 返回结构里同时给出 `inlined` / `missed`，让调用方可以如实告知用户「哪些资源没内联
 * 上、为什么」（读不到的文件不静默吞掉）。
 */

import pathe from 'pathe'
import { HTML_INLINE_RESOURCE_MAX_BYTES, HTML_INLINE_TOTAL_MAX_BYTES } from 'common/html/limits'
import { t } from '../i18n'

const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml',
  '.avif': 'image/avif'
}

/** 去掉 query / hash 并按 URL 规则解码，得到文件系统路径片段。 */
const toFilePath = (src: string): string => {
  const clean = src.split('#')[0].split('?')[0]
  try {
    return decodeURIComponent(clean)
  } catch {
    return clean
  }
}

const isExternal = (src: string): boolean => !src || /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(src)

const base64Length = (bytes: number): number => Math.ceil(bytes / 3) * 4

/**
 * - `outside`：解析后（含符号链接）不在 html 所在目录内，按设计不读；
 * - `missing`：文件不存在或不是普通文件；
 * - `too-large`：超过单资源上限，或读进来会让整份文档超过总量上限；
 * - `unreadable`：存在但读取失败（权限等）。
 */
export type HtmlInlineMissReason = 'outside' | 'missing' | 'too-large' | 'unreadable'

export interface IMissedResource {
  /** 按 html 所在目录解析出的绝对路径（未跟随符号链接）。 */
  path: string
  reason: HtmlInlineMissReason
}

export interface IInlineHtmlResult {
  /** 内联后的完整 HTML 文档（末尾已去掉空行，写进 .md 后重新解析不会断开块）。 */
  html: string
  /** 成功内联的资源（绝对路径），用于如实回报。 */
  inlined: string[]
  /** 没内联上的资源及原因。 */
  missed: IMissedResource[]
}

interface IInlinedDom {
  doc: Document
  inlined: string[]
  missed: IMissedResource[]
}

type ReadAs = 'text' | 'dataUrl'

/**
 * 把本地 html 里的同目录资源读进 DOM（样式 → `<style>`、脚本 → 内联 `<script>`、
 * 图片 → data URI），由调用方决定怎么序列化。
 */
async function inlineHtmlResources(raw: string, filePath: string): Promise<IInlinedDom> {
  const htmlDir = pathe.dirname(pathe.resolve(filePath))
  const realHtmlDir = await window.fileUtils.realpath(htmlDir).catch(() => htmlDir)
  const doc = new DOMParser().parseFromString(raw, 'text/html')
  const inlined: string[] = []
  const missed: IMissedResource[] = []
  let budget = HTML_INLINE_TOTAL_MAX_BYTES - raw.length

  const miss = (path: string, reason: HtmlInlineMissReason): null => {
    missed.push({ path, reason })
    return null
  }

  /** 解析 + 范围 / 体积校验 + 读取；任何一步不过都记进 `missed` 并返回 null。 */
  const read = async (
    baseDir: string,
    src: string,
    as: ReadAs
  ): Promise<{ path: string; content: string } | null> => {
    const path = pathe.resolve(baseDir, toFilePath(src))
    if (!window.fileUtils.isChildOfDirectory(htmlDir, path)) return miss(path, 'outside')

    let real: string
    let size: number
    try {
      real = await window.fileUtils.realpath(path)
      const stat = await window.fileUtils.stat(real)
      if (!stat.isFile) return miss(path, 'missing')
      size = stat.size
    } catch {
      return miss(path, 'missing')
    }
    if (!window.fileUtils.isChildOfDirectory(realHtmlDir, real)) return miss(path, 'outside')
    if (size > HTML_INLINE_RESOURCE_MAX_BYTES) return miss(path, 'too-large')

    const cost = as === 'dataUrl' ? base64Length(size) : size
    if (cost > budget) return miss(path, 'too-large')

    try {
      if (as === 'text') {
        const content = String(await window.fileUtils.readFile(real, 'utf8'))
        budget -= cost
        return { path, content }
      }
      const mime = MIME_BY_EXT[pathe.extname(real).toLowerCase()] ?? 'application/octet-stream'
      const base64 = String(await window.fileUtils.readFile(real, 'base64'))
      budget -= cost
      return { path, content: `data:${mime};base64,${base64}` }
    } catch {
      return miss(path, 'unreadable')
    }
  }

  // <link rel="stylesheet" href="本地.css"> -> <style>…</style>
  for (const link of Array.from(doc.querySelectorAll('link[rel~="stylesheet"][href]'))) {
    const href = link.getAttribute('href') ?? ''
    if (isExternal(href)) continue

    const sheet = await read(htmlDir, href, 'text')
    if (!sheet) continue
    inlined.push(sheet.path)

    // 内联后的样式表里若还有 url(...) 引用本地图片，一并换成 data URI（相对样式表解析）。
    let css = sheet.content
    const urls = Array.from(css.matchAll(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g))
    for (const match of urls) {
      const ref = match[2]
      if (!ref || isExternal(ref)) continue

      const asset = await read(pathe.dirname(sheet.path), ref, 'dataUrl')
      if (!asset) continue
      css = css.replace(match[0], () => `url("${asset.content}")`)
      inlined.push(asset.path)
    }

    const style = doc.createElement('style')
    style.textContent = css
    link.replaceWith(style)
  }

  // <script src="本地.js"> -> <script>…</script>（保留 type，模块脚本语义不变）
  for (const script of Array.from(doc.querySelectorAll('script[src]'))) {
    const src = script.getAttribute('src') ?? ''
    if (isExternal(src)) continue

    const code = await read(htmlDir, src, 'text')
    if (!code) continue
    script.removeAttribute('src')
    script.textContent = code.content
    inlined.push(code.path)
  }

  // <img src="本地图片"> -> data URI
  for (const img of Array.from(doc.querySelectorAll('img[src]'))) {
    const src = img.getAttribute('src') ?? ''
    if (isExternal(src)) continue

    const image = await read(htmlDir, src, 'dataUrl')
    if (!image) continue
    img.setAttribute('src', image.content)
    inlined.push(image.path)
  }

  return { doc, inlined, missed }
}

const dedupeMissed = (missed: IMissedResource[]): IMissedResource[] => {
  const seen = new Map<string, IMissedResource>()
  for (const item of missed) seen.set(`${item.reason}\n${item.path}`, item)
  return Array.from(seen.values())
}

const REASON_ORDER: readonly HtmlInlineMissReason[] = [
  'outside',
  'missing',
  'too-large',
  'unreadable'
]

const REASON_KEY: Record<HtmlInlineMissReason, string> = {
  outside: 'editor.htmlInline.outside',
  missing: 'editor.htmlInline.missing',
  'too-large': 'editor.htmlInline.tooLarge',
  unreadable: 'editor.htmlInline.unreadable'
}

/** 按原因汇总未内联的资源，例如「2 个在 html 所在目录之外、1 个不存在」。 */
export const describeMissedResources = (missed: IMissedResource[]): string =>
  REASON_ORDER.map((reason) => {
    const count = missed.filter((m) => m.reason === reason).length
    return count ? t(REASON_KEY[reason], { count }) : ''
  })
    .filter(Boolean)
    .join(t('editor.htmlInline.separator'))

/**
 * 内联一个本地 html 文件里的资源，得到可整体写进 .md 的 HTML 块源码。
 *
 * @param raw  html 文件原文
 * @param filePath 该 html 文件在磁盘上的绝对路径（用来解析相对资源、限定读取范围）
 */
export async function inlineHtmlDocument(
  raw: string,
  filePath: string
): Promise<IInlineHtmlResult> {
  const { doc, inlined, missed } = await inlineHtmlResources(raw, filePath)

  return {
    // 两处刻意的规范化：
    // ① 去掉 `<!DOCTYPE …>`：CommonMark 的声明型 html 块在第一个 `>` 处就结束，带 doctype
    //    的整篇文档写回 .md 后会被拆成两个块，重开时脚本块只剩半页。渲染时沙箱帧（引导页
    //    自带 doctype）和静态 div 都不依赖它，所以去掉了没有任何损失（单测
    //    `insertHtmlBlock.spec.ts` 里钉住了这条拆分行为）。
    // ② 压掉块内空行：空行会终止 html 块，同样会把一个块切成两个（HTML 语义不受影响）。
    html: doc.documentElement.outerHTML.replace(/\n\s*\n/g, '\n').trim(),
    inlined: Array.from(new Set(inlined)),
    missed: dedupeMissed(missed)
  }
}

/**
 * 内联一个本地 html 文件里的资源，用于在右栏沙箱帧里**预览**（不写回任何文件）。
 *
 * 为什么要内联：沙箱帧是不透明源，加载不了 `file://`（`@shared/types/momarkFile`
 * 文件头的实测矩阵），本地图片协议又只放行图片 —— 原型页引用的同目录 CSS / JS
 * 只有读进源码才能生效。与写进 .md 的版本不同，这里保留 `<!DOCTYPE html>`（标准
 * 模式渲染）和原文里的空行（`<pre>` / `<textarea>` 内容不被改写）。
 */
export async function inlineHtmlForPreview(
  raw: string,
  filePath: string
): Promise<IInlineHtmlResult> {
  const { doc, inlined, missed } = await inlineHtmlResources(raw, filePath)

  return {
    html: `<!DOCTYPE html>\n${doc.documentElement.outerHTML}`,
    inlined: Array.from(new Set(inlined)),
    missed: dedupeMissed(missed)
  }
}
