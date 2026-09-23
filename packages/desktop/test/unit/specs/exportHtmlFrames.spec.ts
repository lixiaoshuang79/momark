import { describe, expect, it } from 'vitest'
import {
  buildLiveFrame,
  buildLivePlaceholder,
  injectLiveFrames,
  LIVE_FRAME_BLEED_CLASS,
  LIVE_FRAME_CLASS_PREFIX
} from '@/util/exportLiveFrame'

// 导出时那个标记 div 的尺寸写法：用户在编辑器里没调过尺寸的块（跟随布局）不写死像素宽，
// 改由出血 CSS 铺满页面 —— 否则原型会被正文栏（980px 居中）挤成中间一条，两侧全是空白，
// 而且拖拽还被卡住。
describe('buildLivePlaceholder', () => {
  it('跟随布局的块：带出血类名、不写像素宽（宽度交给 CSS 铺满页面）', () => {
    const out = buildLivePlaceholder(1, 800, 420, true)

    expect(out).toContain(`class="${LIVE_FRAME_CLASS_PREFIX}1 ${LIVE_FRAME_BLEED_CLASS}"`)
    expect(out).not.toContain('width:800px')
    expect(out).toContain('height:420px')
    expect(out).toContain('overflow:hidden')
  })

  it('用户调过尺寸的块：按那个像素宽还原，不带出血类名', () => {
    const out = buildLivePlaceholder(0, 800, 420, false)

    expect(out).toContain(`class="${LIVE_FRAME_CLASS_PREFIX}0"`)
    expect(out).not.toContain(LIVE_FRAME_BLEED_CLASS)
    expect(out).toContain('width:800px')
    // 旧写法这里的 max-width:100% 会把块钉在正文栏里（拉不出去），必须不再出现。
    expect(out).not.toContain('max-width:100%')
  })

  it('出血类名不破坏帧注入的序号匹配', () => {
    const placeholder = buildLivePlaceholder(0, 800, 400, true)
    const out = injectLiveFrames(placeholder, [buildLiveFrame('<b>x</b>')])

    expect(out).toContain('<iframe')
    expect(out).toContain(LIVE_FRAME_BLEED_CLASS)
  })
})

// HTML 导出的「活的」内嵌 HTML 块：markdown 里只放一个标记 div，真正的 sandbox iframe
// 在引擎净化**之后**注入（`<iframe>` 不在导出白名单里，写在 markdown 里会被整段删掉）。
// 这里钉住注入的几条事实：标记定位、属性顺序无关、序号对不上时保持原样。
describe('injectLiveFrames', () => {
  const frame = buildLiveFrame('<div id="a">hi</div>')

  it('把标记 div 补上 iframe，div 本身保留（尺寸样式在它身上）', () => {
    const article = `<div class="${LIVE_FRAME_CLASS_PREFIX}0" style="width:960px;height:436px;overflow:hidden"></div>`
    const out = injectLiveFrames(article, [frame])

    // iframe 是补在标记 div 里面的（div 身上的尺寸样式继续管着它）
    expect(out.startsWith(`<div class="${LIVE_FRAME_CLASS_PREFIX}0"`)).toBe(true)
    // 导出物的沙箱比编辑器宽（同源/表单/弹窗/模态框），否则原型的存储与表单交互会抛异常
    expect(out).toContain('<iframe sandbox="allow-scripts allow-same-origin')
    expect(out).toContain('allow-forms')
    expect(out).toContain('allow-popups')
    expect(out).toContain('allow-modals')
    expect(out).toContain('srcdoc="')
    expect(out.trimEnd().endsWith('</div>')).toBe(true)
  })

  it('属性顺序不影响匹配（class 不在最前面也能找到）', () => {
    const article = `<div style="width:100px" class="${LIVE_FRAME_CLASS_PREFIX}0"></div>`
    expect(injectLiveFrames(article, [frame])).toContain('<iframe')
  })

  it('单引号属性也认', () => {
    const article = `<div class='${LIVE_FRAME_CLASS_PREFIX}0'></div>`
    expect(injectLiveFrames(article, [frame])).toContain('<iframe')
  })

  it('按序号各自取自己的片段', () => {
    const a = buildLiveFrame('<b>第一个</b>')
    const b = buildLiveFrame('<b>第二个</b>')
    const article = `<div class="${LIVE_FRAME_CLASS_PREFIX}0"></div>\n<div class="${LIVE_FRAME_CLASS_PREFIX}1"></div>`
    const out = injectLiveFrames(article, [a, b])

    expect(out.indexOf('第一个')).toBeLessThan(out.indexOf('第二个'))
  })

  it('片段缺失时保持原样，不塞半截东西进去', () => {
    const article = `<div class="${LIVE_FRAME_CLASS_PREFIX}3"></div>`
    expect(injectLiveFrames(article, [frame])).toBe(article)
  })

  it('没有片段时完全不碰（PDF / 打印走的是图片形态）', () => {
    const article = `<div class="${LIVE_FRAME_CLASS_PREFIX}0" style="width:10px"></div>`
    expect(injectLiveFrames(article, [])).toBe(article)
  })

  it('不会误伤相似类名（序号后面还有字符就不算标记）', () => {
    const article = `<div class="${LIVE_FRAME_CLASS_PREFIX}0x"></div>`
    expect(injectLiveFrames(article, [frame])).toBe(article)
  })
})

describe('buildLiveFrame', () => {
  it('srcdoc 里的标记全量转义成实体（父文档标记里不出现 <script> 这类序列）', () => {
    const out = buildLiveFrame('<div data-x="1">a & b</div>')

    expect(out).toContain('&amp;')
    expect(out).toContain('&quot;')
    expect(out).toContain('&lt;div data-x=')
    expect(out).toContain('&gt;')
    // 关键：attribute 值里不能再出现真的 `<script`
    expect(out).not.toContain('<div data-x=')
    expect(out).toContain('sandbox="allow-scripts allow-same-origin')
  })
})
