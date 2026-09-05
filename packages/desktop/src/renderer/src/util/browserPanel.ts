/**
 * 文档模式预览渲染管线（PHASE2-SPEC §5 / report 3.md §6）：
 * 引擎 MarkdownToHtml（@muyajs/core）→ DOMPurify 3.4.14 清洗
 * （FORBID_TAGS 禁 iframe/object/embed/form/input/button；禁内联 style）
 * → 图片相对路径按文档目录解析为 file:// 绝对路径。
 */
import type { Config } from 'dompurify'
import { sanitize } from './dompurify'
import markdownToHtml from './markdownToHtml'

const DOC_MODE_DOMPURIFY_CONFIG = Object.freeze({
  USE_PROFILES: { html: true },
  FORBID_TAGS: ['iframe', 'object', 'embed', 'form', 'input', 'button'],
  FORBID_ATTR: ['style', 'contenteditable'],
  ALLOW_DATA_ATTR: false,
  RETURN_TRUSTED_TYPE: false,
  // 本地 MD 预览的图片走 file://（渲染前已按文档目录解析为绝对路径）。
  ALLOWED_URI_REGEXP:
    /^(?:(?:(?:f|ht)tps?|mailto|tel|data|file):|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i // eslint-disable-line no-useless-escape
}) as Config

const URL_REG = /^(?:https?:|file:|data:|mailto:|tel:|[a-z][a-z0-9+.-]*:)/i

// 相对/绝对本地路径 → file://（Windows 盘符与 UNC 归一）。
const toFileUrl = (p: string): string => {
  const normalized = p.replace(/\\/g, '/')
  if (/^\/\//.test(normalized)) return `file://${normalized}`
  if (/^[a-zA-Z]:\//.test(normalized)) return `file:///${normalized}`
  return `file://${normalized}`
}

const resolveAgainstDocDir = (src: string | null, docDir: string): string => {
  if (!src) return ''
  if (URL_REG.test(src)) return src
  if (src.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(src)) return toFileUrl(src)
  if (!docDir) return src
  return toFileUrl(window.path.join(docDir, src))
}

/**
 * 渲染 Markdown 为面板文档窗格可注入的干净 HTML。
 * @param markdown 原始 Markdown 文本
 * @param docDir   文档所在目录（图片相对路径解析基准；空串则不解析）
 */
export const renderMarkdownPreview = async (markdown: string, docDir: string): Promise<string> => {
  const rendered = await markdownToHtml(markdown)
  const clean = sanitize(rendered, DOC_MODE_DOMPURIFY_CONFIG)
  const doc = new DOMParser().parseFromString(clean, 'text/html')
  doc.querySelectorAll('img[src]').forEach((img) => {
    const resolved = resolveAgainstDocDir(img.getAttribute('src'), docDir)
    if (resolved) img.setAttribute('src', resolved)
  })
  doc.querySelectorAll('a[href]').forEach((a) => {
    const href = a.getAttribute('href')
    if (!href) return
    if (URL_REG.test(href) || href.startsWith('#')) return
    a.setAttribute('href', resolveAgainstDocDir(href, docDir))
  })
  return doc.body.innerHTML
}
