// Desktop-side styled-HTML export wrapper for the @muyajs/core engine.
//
// The new engine (`@muyajs/core`) exposes `MarkdownToHtml(md, muya).generate()`
// which produces a full standalone HTML document (markdown rendered, diagrams
// rasterised, github-markdown-css + katex + prism linked, plus the engine
// export stylesheet). It has NO equivalent of the legacy muyajs
// `exportStyledHTML`, which additionally injected a table-of-contents at the
// `[TOC]` marker and wrapped the article in a header/footer page table for PDF
// / print. This helper reproduces that desktop-specific behaviour on top of the
// engine output so the export result stays equivalent to the legacy engine.

import type { Muya } from '@muyajs/core'
import { MarkdownToHtml } from '@muyajs/core'
import { sanitize, EXPORT_DOMPURIFY_CONFIG } from './dompurify'
import { resolveLocalImageSrc } from './resolveImageSrc'
import { resolveLocalLinkHref } from './resolveLinkHref'
import {
  buildFrameControlsScript,
  buildFrameControlsStyle,
  injectLiveFrames
} from './exportLiveFrame'

export interface HeaderFooterPart {
  type?: number
  left?: string
  center?: string
  right?: string
}

/**
 * 把页眉/页脚三格配置编译成 `webContents.printToPDF` 的 header/footerTemplate。
 * 支持占位符：`{page}` → 页码（Chromium 真实页码）、`{date}` → 系统日期、
 * `{title}` → 文档标题；其余文本原样渲染。type 1 = 单格（居中），type 2 = 三格
 * （左/中/右）。返回 null 表示无需页眉/页脚。
 */
export const buildPrintHeaderFooterTemplate = (
  part: HeaderFooterPart | null | undefined,
  _isHeader: boolean
): string | null => {
  if (!part || !part.type) {
    return null
  }
  const esc = (s: string): string =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

  const renderCell = (raw: string | undefined): string => {
    const text = esc(raw ?? '')
      .replace(/\{page\}/g, '<span class="pageNumber"></span>')
      .replace(/\{date\}/g, '<span class="date"></span>')
      .replace(/\{title\}/g, '<span class="title"></span>')
    return text
  }

  const { type, left = '', center = '', right = '' } = part
  if (type === 1) {
    return `<div style="font-size:9px;color:#3f3f3f;width:100%;display:flex;justify-content:center;"><span>${renderCell(center)}</span></div>`
  }
  return `<div style="font-size:9px;color:#3f3f3f;width:100%;display:flex;justify-content:space-between;"><span style="text-align:left;">${renderCell(left)}</span><span style="text-align:center;">${renderCell(center)}</span><span style="text-align:right;">${renderCell(right)}</span></div>`
}

export interface ExportStyledHtmlOptions {
  title?: string
  printOptimization?: boolean
  extraCss?: string
  /** Pre-rendered TOC HTML (from `getHtmlToc`). Injected at `[TOC]`. */
  toc?: string
  header?: HeaderFooterPart | null
  footer?: HeaderFooterPart | null
  headerFooterStyled?: boolean
  /** Editor text direction ('ltr' | 'rtl' | 'auto'); set on the exported <html>. */
  dir?: string
  /**
   * 「活的」内嵌 HTML 块（HTML 导出）。按标记序号排列的沙箱 iframe 片段，
   * 由 `inlineFramedHtmlBlocks` 以 live 形态产出；见下方 injectLiveFrames。
   */
  frames?: string[]
}

// Ported verbatim from legacy muyajs `headerFooterStyle.css` so the page
// header/footer table lays out the same in the exported document.
const HEADER_FOOTER_CSS = `
:root { --footerHeaderBorderColor: #1c1c1c; }
table.page-container { width: 100%; border-collapse: collapse; }
table.page-container > tbody,
table.page-container > tbody > tr,
table.page-container > tbody > tr > td { display: block; width: 100vw; }
table.page-container > tbody > tr > td { overflow-wrap: anywhere; }
table.page-container > thead,
table.page-container > tfoot { display: table-header-group; }
.page-header .hf-container,
.page-footer-fake .hf-container,
.page-footer .hf-container { display: flex; justify-content: space-between; font-size: 0.75em; font-weight: 400; }
.page-header { display: table-header-group; }
.page-header .hf-container { margin-bottom: 16px; }
.page-header.styled .hf-container { padding-bottom: 1px; border-bottom: 1px solid var(--footerHeaderBorderColor); }
.page-header .hf-container > div { flex: 1; max-height: 100px; overflow: hidden; }
.page-header .header-content-left { text-align: left; margin-right: 4px; }
.page-header .header-content { text-align: center; }
.page-header .header-content-right { text-align: right; margin-left: 4px; }
.page-header.single .header-content-left,
.page-header.single .header-content-right { display: none; }
.page-footer-fake { display: table-footer-group; }
.page-footer-fake .hf-container { margin-top: 16px; visibility: hidden; }
.page-footer { position: fixed; bottom: 0; left: 0; right: 0; }
.page-footer.styled .hf-container { padding-top: 1px; border-top: 1px solid var(--footerHeaderBorderColor); }
.page-footer .hf-container > div { flex: 1; white-space: nowrap; overflow: hidden; }
.page-footer .footer-content-left { text-align: left; margin-right: 14px; }
.page-footer .footer-content { text-align: center; }
.page-footer .footer-content-right { text-align: right; margin-left: 14px; }
.page-footer.single .footer-content-left,
.page-footer.single .footer-content-right { display: none; }
`

const HF_TABLE_START = '<table class="page-container">'
const HF_TABLE_END = '</table>'
const HF_TABLE_FOOTER = `<tfoot class="page-footer-fake"><tr><td>
  <div class="hf-container">&nbsp;</div>
</td></tr></tfoot>`

const styledClass = (value: boolean | undefined): string => {
  if (value === undefined) return ''
  return value ? ' styled' : ' simple'
}

// Header/footer left/center/right are user-supplied, so sanitize them here.
// The article body is NOT sanitized again (it was already sanitized by the
// engine during render); re-sanitizing it strips diagram <foreignObject>
// labels and drops mermaid content from the export (#3359).
const hf = (value: string): string => sanitize(value, EXPORT_DOMPURIFY_CONFIG) as string

const createTableHeader = (header: HeaderFooterPart, headerFooterStyled?: boolean): string => {
  const { type, left = '', center = '', right = '' } = header
  const headerClass =
    `page-header ${(type === 1 ? 'single' : '') + styledClass(headerFooterStyled)}`
      .replace(/\s+/g, ' ')
      .trim()
  return `<thead class="${headerClass}"><tr><th>
  <div class="hf-container">
    <div class="header-content-left">${hf(left)}</div>
    <div class="header-content">${hf(center)}</div>
    <div class="header-content-right">${hf(right)}</div>
  </div>
</th></tr></thead>`
}

const createRealFooter = (footer: HeaderFooterPart, headerFooterStyled?: boolean): string => {
  const { type, left = '', center = '', right = '' } = footer
  const footerClass =
    `page-footer ${(type === 1 ? 'single' : '') + styledClass(headerFooterStyled)}`
      .replace(/\s+/g, ' ')
      .trim()
  return `<div class="${footerClass}">
  <div class="hf-container">
    <div class="footer-content-left">${hf(left)}</div>
    <div class="footer-content">${hf(center)}</div>
    <div class="footer-content-right">${hf(right)}</div>
  </div>
</div>`
}

const createTableBody = (article: string): string =>
  `<tbody><tr><td>
  <div class="main-container">
    ${article}
  </div>
</td></tr></tbody>`

// Match a standalone `[TOC]` line (mirrors legacy marked TOC block token).
const TOC_REG = /^ {0,3}\[TOC\] *$/im

// Match the `src="…"` of an <img> tag in the (already sanitized, double-quoted)
// engine output, so relative image paths can be rewritten to absolute `file://`
// URLs. A string rewrite avoids re-serializing the whole article DOM (which
// holds rendered KaTeX / diagram SVG).
const IMG_SRC_REG = /(<img\b[^>]*?\ssrc=")([^"]*)(")/gi

/**
 * Rewrite relative / absolute-local `<img src>` to absolute `file://` URLs so a
 * saved styled-HTML document still resolves its images after it is moved out of
 * the source folder (legacy muyajs `correctImageSrc` parity, issue 230). Remote
 * URLs and `data:` URIs are left untouched. Idempotent: a `file://` src is left
 * as-is, so the PDF / print path (which rewrites again via printService) is a
 * no-op the second time.
 */
const rewriteImageSrcs = (html: string): string =>
  html.replace(IMG_SRC_REG, (match, pre: string, src: string, post: string) => {
    const resolved = resolveLocalImageSrc(src)
    return resolved === src ? match : `${pre}${resolved}${post}`
  })

// Match the `href="…"` of an <a> tag in the (already sanitized, double-quoted)
// engine output, so relative local links are rewritten to absolute `file://`
// URLs the same way images are.
const ANCHOR_HREF_REG = /(<a\b[^>]*?\shref=")([^"]*)(")/gi

/**
 * Rewrite relative / absolute-local `<a href>` to absolute `file://` URLs so a
 * link to a local file still resolves after the saved document is moved out of
 * the source folder (#1688). Remote URLs, `mailto:`/`data:` schemes and in-page
 * fragment anchors are left untouched.
 */
const rewriteAnchorHrefs = (html: string): string =>
  html.replace(ANCHOR_HREF_REG, (match, pre: string, href: string, post: string) => {
    const resolved = resolveLocalLinkHref(href)
    return resolved === href ? match : `${pre}${resolved}${post}`
  })

/**
 * Build a styled, standalone HTML document equivalent to legacy muyajs
 * `exportStyledHTML`. Renders markdown through the new engine, injects the TOC
 * at the `[TOC]` marker, and — when a header/footer is supplied — wraps the
 * article in the page-container table for paged PDF / print export.
 */
export const exportStyledHTML = async (
  muya: Muya,
  markdown: string,
  options: ExportStyledHtmlOptions = {}
): Promise<string> => {
  const { title = '', toc = '', header, footer, headerFooterStyled, dir, frames = [] } = options
  let { extraCss = '' } = options

  // The header/footer page table needs its own stylesheet — fold it into
  // extraCss (which `generate` injects into <head>) up front so we only render
  // the document once.
  const appendHeaderFooter = !!header || !!footer
  if (appendHeaderFooter) {
    extraCss = extraCss ? HEADER_FOOTER_CSS + extraCss : HEADER_FOOTER_CSS
  }

  // Render the engine's full HTML document. We re-extract its <article> body so
  // we can inject the TOC / header-footer, then re-emit the document shell.
  const fullDoc = await new MarkdownToHtml(markdown, muya).generate({
    title,
    extraCSS: extraCss,
    dir
  })

  const articleMatch = /<article class="markdown-body">([\s\S]*)<\/article>/.exec(fullDoc)
  let article = articleMatch ? articleMatch[1] : fullDoc

  // Resolve relative image paths to absolute file:// URLs so the saved document
  // still shows its images when opened from a different folder (issue 230).
  article = rewriteImageSrcs(article)
  // Same for relative local links so they still resolve after the document is
  // moved out of the source folder (#1688).
  article = rewriteAnchorHrefs(article)

  // Inject the TOC at the `[TOC]` marker (legacy behaviour: only appears when
  // the document explicitly contains `[TOC]`). The marker is rendered as a
  // paragraph by marked, so replace the rendered `<p>[TOC]</p>` first, falling
  // back to a raw `[TOC]` if present.
  // 替换串一律给函数而不是字符串：`String.replace` 会把替换串里的 `$$` 折成 `$`、
  // `$&` 折成整个匹配，而这里的替换内容是文档正文（含标题文本、内嵌块源码）——实测
  // 原型里的 `var $$ = …` 被折成 `var $ = …`，帧内脚本当场 TypeError，表格一行都渲染不出来。
  if (toc) {
    if (/<p>\s*\[TOC\]\s*<\/p>/i.test(article)) {
      article = article.replace(/<p>\s*\[TOC\]\s*<\/p>/i, () => toc)
    } else if (TOC_REG.test(article)) {
      article = article.replace(TOC_REG, () => toc)
    }
  }

  // 「活的」内嵌块：标记 div 补上沙箱 iframe（必须在净化之后）。
  article = injectLiveFrames(article, frames)

  let bodyHtml: string
  if (!appendHeaderFooter) {
    bodyHtml = `<article class="markdown-body">${article}</article>`
  } else {
    let output = HF_TABLE_START
    if (header) output += createTableHeader(header, headerFooterStyled)
    if (footer) {
      output += HF_TABLE_FOOTER
      output = createRealFooter(footer, headerFooterStyled) + output
    }
    output += createTableBody(`<article class="markdown-body">${article}</article>`)
    output += HF_TABLE_END
    bodyHtml = output
  }

  // Re-emit the engine document shell with the (possibly augmented) body.
  // 替换串必须是函数：`bodyHtml` 是正文原文，字符串替换会把里面的 `$$` 折成 `$`。
  let out = fullDoc.replace(/<body>[\s\S]*<\/body>/, () => `<body>\n  ${bodyHtml}\n</body>`)

  // 「活的」内嵌块在导出页里也要能缩放/拖拽：控件样式与脚本跟 iframe 一样，在引擎净化
  // **之后**注入（脚本是我们自己的代码，不经过 markdown，也就不会被 DOMPurify 剥掉）。
  // 没有帧就不加任何东西，普通导出物里不留死代码。
  if (frames.length) {
    out = out.replace('</head>', () => `<style>${buildFrameControlsStyle()}</style>\n</head>`)
    // 脚本放 <head>：正文里如果混进未闭合的标记（实测 payload 逃出 srcdoc 的情况），
    // 解析器会把 body 里它之后的内容整段当文本吞掉，放在 head 才能活下来。
    out = out.replace('</head>', () => `<script>${buildFrameControlsScript()}</script>\n</head>`)
  }

  return out
}
