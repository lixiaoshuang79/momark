// MoMark 字体三层体系（见任务 8 规格）：
//   ① Anthropic / AnthropicSerif（可变字重，本地文件已 gitignore，仅开发机可用；
//      缺文件时 font-family 链自动落到 ②）；
//   ② OFL 开源替代 Geist（sans）+ Newsreader（serif，已入库提交）；
//   ③ 系统/CJK 回退：PingFang SC / Songti SC。
//
// 注入方式：不用 css 文件的相对 url()——dev 下 vite 把 css 以 <style> 注入，
// url() 按「页面基址」解析，`../fonts/x` 会解析到错误的 /fonts/x 而 404
// （曾导致全 app 回退字体渲染）。`new URL(..., import.meta.url)` 在 dev 指向
// 源文件 URL、build 时由 vite 重写为哈希资产 URL，两端都正确。
// ⚠️ 必须传字面量路径：vite 只静态改写字面量形式；写成变量会导致 build 产物
// 原样保留相对路径、字体文件不入包。
const FACES: Array<{ family: string; weight: string; src: string }> = [
  {
    family: 'Anthropic',
    weight: '300 800',
    src: new URL('../fonts/Anthropic.woff2', import.meta.url).href
  },
  {
    family: 'AnthropicSerif',
    weight: '300 800',
    src: new URL('../fonts/AnthropicSerif.woff2', import.meta.url).href
  },
  {
    family: 'Geist',
    weight: '100 900',
    src: new URL('../fonts/geist.woff2', import.meta.url).href
  },
  {
    family: 'Newsreader',
    weight: '200 800',
    src: new URL('../fonts/newsreader.woff2', import.meta.url).href
  }
]

const css = FACES.map((face) => {
  return (
    `@font-face{font-family:'${face.family}';` +
    `src:url('${face.src}') format('woff2');` +
    `font-weight:${face.weight};font-style:normal;font-display:swap}`
  )
}).join('\n')

const style = document.createElement('style')
style.setAttribute('data-momark-fonts', '')
style.textContent = css
document.head.appendChild(style)
