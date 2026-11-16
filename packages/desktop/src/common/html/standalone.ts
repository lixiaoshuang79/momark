/**
 * HTML 块源码 → 独立 .html 文件内容。
 *
 * HTML 块存进 .md 时 `<!DOCTYPE>` 被剥掉了（否则 html 块会断成两半），块前一行
 * 还可能带尺寸标记 `<!--momark-frame …-->`；独立文件要去掉标记、补回 doctype，
 * 浏览器才按标准模式渲染。
 */
export const toStandaloneHtml = (html: string): string => {
  const source = html.replace(/^\s*<!--momark-frame[^>]*-->\s*\n?/, '')
  return /^\s*<!doctype/i.test(source) ? source : `<!DOCTYPE html>\n${source}`
}
