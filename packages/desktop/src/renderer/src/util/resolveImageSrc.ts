// Resolve an <img>'s src for export / static print (GH#678): a relative local
// path is resolved to an absolute `file://` URL against the current document
// directory; URLs, `data:` URIs, and already-absolute / `file://` srcs are left
// untouched. Ported from the legacy muyajs `getImageInfo(src)` so a saved
// styled-HTML / PDF document keeps rendering its images after it is moved out of
// the source folder.
import { pathToMomarkFileUrl } from '@shared/types/momarkFile'

const IMAGE_EXT_REG = /\.(?:jpeg|jpg|png|gif|svg|webp)(?=\?|$)/i

export function localPathToFileUrl(src: string): string {
  const normalized = src.replace(/\\/g, '/')

  if (/^\/\/[^/]+\/[^/]+/.test(normalized)) {
    return `file://${normalized.slice(2)}`
  }

  if (/^[a-z]:\//i.test(normalized)) {
    return `file:///${normalized}`
  }

  return `file://${normalized}`
}

/** 绝对路径 → URL 的两种产出方式（导出的静态文件 vs 应用内渲染）。 */
export type LocalPathToUrl = (absolutePath: string) => string

export function resolveLocalImageSrc(
  src: string,
  toUrl: LocalPathToUrl = localPathToFileUrl
): string {
  if (!src) return src
  // Already a URL or data: URI — leave as-is (avoids `file://file://…`).
  if (/^(?:https?:|file:|data:|momark-file:)/i.test(src)) return src
  // Only rewrite recognised local image paths (mirrors muyajs's IMAGE_EXT_REG
  // gate) — leave anything else untouched, e.g. an extensionless absolute
  // server path `/api/image?id=…` must not become `file:///api/image…`.
  if (!IMAGE_EXT_REG.test(src)) return src
  // Absolute local image path (POSIX / UNC / Windows drive) → file://.
  if (/^(?:\/|\\\\|[a-zA-Z]:[\\/])/.test(src)) return toUrl(src)
  // Relative local image path — resolve against the document directory.
  if (window.DIRNAME) return toUrl(window.path.join(window.DIRNAME, src))
  return src
}

/**
 * A-12：应用内渲染（打印容器/PDF 的静态渲染）用的那一份——产出本地图片协议 URL
 * （`momark-file://local/<绝对路径>`），而**不是** `file://`。
 *
 * 分家的原因：产物去向不同。导出到磁盘的 .html 要给外部浏览器打开，必须留
 * `file://`（见 `exportHtml.ts`）；而打印容器渲染在编辑器窗口自己的文档里，宿主
 * 打开 `webSecurity` 后 dev 形态（http://localhost）加载不了 `file://`，打包形态
 * 虽是 file:// 文档能过、但没有理由再依赖它——统一走协议这条已验证的通道。
 */
export const resolveLocalImageSrcForDisplay = (src: string): string =>
  resolveLocalImageSrc(src, pathToMomarkFileUrl)
