import { afterEach, describe, expect, it, vi } from 'vitest'

// `@/util/pdf`（被 `exportHtml` 间接引入）与导出包装层都要经 preload 桥拿
// `window.path` / `window.DIRNAME`，在 hoisted import 之前先补上。
vi.hoisted(() => {
  const w = globalThis as unknown as {
    window?: {
      path?: {
        sep: string
        join?: (...parts: string[]) => string
        resolve?: (...parts: string[]) => string
      }
      DIRNAME?: string
    }
  }
  w.window ??= {}
  w.window.path ??= {
    sep: '/',
    join: (...parts: string[]) => parts.join('/'),
    resolve: (...parts: string[]) => parts.join('/')
  }
  w.window.DIRNAME = '/docs'
})

import {
  buildFrameControlsScript,
  buildFrameControlsStyle,
  buildLiveFrame,
  buildLivePlaceholder,
  LIVE_FRAME_BLEED_CLASS,
  LIVE_FRAME_BLEED_PAD,
  LIVE_FRAME_CLASS_PREFIX
} from '@/util/exportLiveFrame'
import { exportStyledHTML } from '@/util/exportHtml'

afterEach(() => {
  document.body.innerHTML = ''
})

// 导出物里的「活的」内嵌 HTML 块：标记 div + 沙箱 iframe，再补上一套与编辑器同款的
// 交互控件（悬停工具条 / 右下角拖拽手柄）。这里钉住三件事：
//   1. 脚本的选择器与缩放补偿写法（页面缩放语义，不是把外框拉大）；
//   2. CSS 里工具条与手柄的类名与显隐；
//   3. `exportStyledHTML` 只在有帧时注入控件 —— 普通导出物不留死代码。
describe('buildFrameControlsScript', () => {
  const script = buildFrameControlsScript()

  it('按 momark-export-frame- 前缀找容器，并认序号类名', () => {
    expect(script).toContain("var PREFIX = 'momark-export-frame-'")
    expect(script).toContain(LIVE_FRAME_CLASS_PREFIX)
    expect(script).toMatch(/new RegExp\([^)]*PREFIX/)
    expect(script).toContain("shell.querySelector('iframe')")
  })

  it('缩放写 CSS zoom，并把布局尺寸补偿成 宽/zoom、高/zoom（页面缩放语义）', () => {
    expect(script).toContain('frame.style.zoom = String(zoom)')
    expect(script).toContain("frame.style.width = curW / zoom + 'px'")
    expect(script).toContain("frame.style.height = curH / zoom + 'px'")
    // 外壳（标记 div）拿的是未补偿的视口尺寸，所以视觉外框不随缩放变化。
    expect(script).toContain("shell.style.width = curW + 'px'")
    expect(script).toContain("shell.style.height = curH + 'px'")
    expect(script).toContain("shell.style.overflow = 'hidden'")
  })

  it('常量与编辑器一致：0.5~2、步长 0.1、最小 240×160', () => {
    expect(script).toContain('ZOOM_MIN = 0.5')
    expect(script).toContain('ZOOM_MAX = 2')
    expect(script).toContain('ZOOM_STEP = 0.1')
    expect(script).toContain('MIN_WIDTH = 240')
    expect(script).toContain('MIN_HEIGHT = 160')
  })

  // 老写法把上限写成 `shell.style.maxWidth = '100%'` —— 那是**正文栏**的宽度，
  // 于是块永远拉不出文字栏，两侧留一大片空白。上限必须是页面可用宽度。
  it('上限按页面宽度算，不再把块钉在正文栏里', () => {
    expect(script).toContain('function pageMaxWidth()')
    expect(script).toContain('document.documentElement.clientWidth')
    expect(script).toContain('viewport - BLEED_PAD * 2')
    expect(script).not.toContain("shell.style.maxWidth = '100%'")
    expect(script).toContain('Math.min(pageMaxWidth()')
  })

  it('等 DOM 就绪再跑，并兼容 readyState 已过 loading 的情况', () => {
    expect(script).toContain("document.readyState === 'loading'")
    expect(script).toContain("document.addEventListener('DOMContentLoaded', boot)")
  })

  /**
   * 把导出物里的样子搬进 jsdom：一个标记 div 外壳 + 一个填满它的 iframe。
   * jsdom 不做布局，所以直接钉住外壳的 rect —— 脚本量到的就是导出时写死的显示尺寸。
   */
  const mountFrame = (width: number, height: number, index = 0): HTMLIFrameElement => {
    const shell = document.createElement('div')
    shell.className = `${LIVE_FRAME_CLASS_PREFIX}${index}`
    shell.setAttribute(
      'style',
      `width:${width}px;max-width:100%;height:${height}px;overflow:hidden`
    )
    const frame = document.createElement('iframe')
    frame.setAttribute('style', 'display:block;width:100%;height:100%;border:0')
    shell.appendChild(frame)
    document.body.appendChild(shell)
    shell.getBoundingClientRect = () => ({ width, height }) as unknown as DOMRect
    return frame
  }

  /** 等脚本的双 rAF 跑完（它用两帧等首帧布局落定）。 */
  const settled = (): Promise<void> =>
    new Promise((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
    })

  it('能跑起来，且一个页面里的多个块各自独立', async () => {
    const frames = [mountFrame(800, 400, 0), mountFrame(600, 300, 1)]

    // eslint-disable-next-line no-new-func
    new Function(script)()
    await settled()

    frames.forEach((frame, index) => {
      const shell = frame.parentElement as HTMLElement
      const toolbar = shell.querySelector(`.${LIVE_FRAME_CLASS_PREFIX}toolbar`)
      expect(shell.className).toBe(`${LIVE_FRAME_CLASS_PREFIX}${index}`)
      expect(toolbar).not.toBeNull()
      expect(toolbar?.querySelectorAll('button').length).toBe(2)
      expect(shell.querySelector(`.${LIVE_FRAME_CLASS_PREFIX}resizer`)).not.toBeNull()
      // 初始 100%：iframe 按外壳的显示尺寸布局，zoom=1。
      expect(frame.style.zoom).toBe('1')
      expect(frame.style.width).toBe(`${index === 0 ? 800 : 600}px`)
    })
  })

  it('工具条 − / 百分比 / + 真的改 zoom，百分比点击复位 100%', async () => {
    const frame = mountFrame(800, 400)
    // eslint-disable-next-line no-new-func
    new Function(script)()
    await settled()

    const shell = frame.parentElement as HTMLElement
    const toolbar = shell.querySelector(`.${LIVE_FRAME_CLASS_PREFIX}toolbar`) as HTMLElement
    const [minus, plus] = [...toolbar.querySelectorAll('button')]
    const pct = toolbar.querySelector(`.${LIVE_FRAME_CLASS_PREFIX}zoom`) as HTMLElement

    const click = (el: Element): void => {
      el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    }

    click(plus)
    expect(pct.textContent).toBe('110%')
    expect(Number(frame.style.zoom)).toBeCloseTo(1.1, 5)
    // 补偿后的布局尺寸：外框仍是 800，内层视口缩到 800/1.1。
    expect(frame.style.width).toBe(`${800 / 1.1}px`)
    expect(shell.style.width).toBe('800px')

    click(minus)
    expect(pct.textContent).toBe('100%')
    expect(Number(frame.style.zoom)).toBeCloseTo(1, 5)

    click(plus)
    click(plus)
    expect(pct.textContent).toBe('121%')
    click(pct)
    expect(pct.textContent).toBe('100%')
    expect(frame.style.width).toBe('800px')
  })

  it('拖拽手柄按视口尺寸改大小，并夹在 240×160 以上', async () => {
    const frame = mountFrame(800, 400)
    // eslint-disable-next-line no-new-func
    new Function(script)()
    await settled()

    const shell = frame.parentElement as HTMLElement
    const resizer = shell.querySelector(`.${LIVE_FRAME_CLASS_PREFIX}resizer`) as HTMLElement
    const drag = (type: string, clientX: number, clientY: number): void => {
      resizer.dispatchEvent(new MouseEvent(type, { bubbles: true, clientX, clientY }))
    }

    drag('pointerdown', 100, 100)
    drag('pointermove', 180, 160)
    expect(shell.style.width).toBe('880px')
    expect(shell.style.height).toBe('460px')

    // 再往左上拖过头：两个方向都被夹到最小视口 240×160。
    drag('pointerdown', 100, 100)
    drag('pointermove', -1000, -1000)
    expect(shell.style.width).toBe('240px')
    expect(shell.style.height).toBe('160px')
  })

  // 正文栏是给文字排版的（导出页 980px 居中），块不该被它卡住：上限是页面可用宽度，
  // 比正文栏宽时自己居中（否则只往右下溢出，看着像排版坏了）。
  it('宽度上限是页面宽度而不是正文栏，且超出正文栏后自动居中', async () => {
    const frame = mountFrame(800, 400)
    // jsdom 不做布局，clientWidth 恒为 0：把「视口 1200 / 正文栏 860」钉出来。
    Object.defineProperty(document.documentElement, 'clientWidth', {
      value: 1200,
      configurable: true
    })
    Object.defineProperty(document.body, 'clientWidth', { value: 860, configurable: true })
    // eslint-disable-next-line no-new-func
    new Function(script)()
    await settled()

    const shell = frame.parentElement as HTMLElement
    const resizer = shell.querySelector(`.${LIVE_FRAME_CLASS_PREFIX}resizer`) as HTMLElement
    const drag = (type: string, clientX: number, clientY: number): void => {
      resizer.dispatchEvent(new MouseEvent(type, { bubbles: true, clientX, clientY }))
    }

    // 一路往右拖到底：夹在 视口 1200 - 两侧边距。
    drag('pointerdown', 100, 100)
    drag('pointermove', 5000, 100)
    expect(shell.style.width).toBe(`${1200 - LIVE_FRAME_BLEED_PAD * 2}px`)
    // 比正文栏（860）宽 → 按中线居中（50% 是正文栏的一半）。
    expect(shell.style.marginLeft).toBe(`calc(50% - ${(1200 - LIVE_FRAME_BLEED_PAD * 2) / 2}px)`)
    expect(shell.style.marginRight).toBe(shell.style.marginLeft)

    // 拖回正文栏以内 → 交还给正文栏，margin 清掉。
    drag('pointerdown', 100, 100)
    drag('pointermove', -1000, 100)
    expect(shell.style.width).toBe('240px')
    expect(shell.style.marginLeft).toBe('')
    expect(shell.style.marginRight).toBe('')
  })
})

describe('buildFrameControlsStyle', () => {
  const css = buildFrameControlsStyle()

  it('覆盖工具条、缩放百分比、手柄与外壳定位', () => {
    expect(css).toContain(`.${LIVE_FRAME_CLASS_PREFIX}toolbar`)
    expect(css).toContain(`.${LIVE_FRAME_CLASS_PREFIX}zoom`)
    expect(css).toContain(`.${LIVE_FRAME_CLASS_PREFIX}resizer`)
    // 外壳 = 标记 div 自身（类名 momark-export-frame-<序号>）。
    expect(css).toContain(`div[class^="${LIVE_FRAME_CLASS_PREFIX}"]`)
    expect(css).toContain('position: relative')
  })

  it('「跟随布局」的块铺满页面：出血规则排在壳规则之后（同特异性靠顺序取胜）', () => {
    const bleed = new RegExp(`div\\.${LIVE_FRAME_BLEED_CLASS}\\s*\\{([^}]*)\\}`, 'g')
    const blocks = [...css.matchAll(bleed)].map((m) => m[1])
    const rule = blocks.find((b) => b.includes('100vw'))
    expect(rule).toBeTruthy()
    expect(rule).toContain(`width: calc(100vw - ${LIVE_FRAME_BLEED_PAD * 2}px)`)
    expect(rule).toContain(`max-width: calc(100vw - ${LIVE_FRAME_BLEED_PAD * 2}px)`)
    // 跳出居中正文栏：左边界 = 页面左边界 + 边距。
    expect(rule).toContain(`margin-left: calc(50% - 50vw + ${LIVE_FRAME_BLEED_PAD}px)`)
    // 位置：出血规则必须在外壳规则之后，否则被 margin/width 覆盖掉。
    expect(css.indexOf(`div.${LIVE_FRAME_BLEED_CLASS}`)).toBeGreaterThan(
      css.indexOf(`div[class^="${LIVE_FRAME_CLASS_PREFIX}"]`)
    )
  })

  it('工具条与手柄默认隐藏、悬停才出现', () => {
    expect(css).toMatch(
      new RegExp(`\\.${LIVE_FRAME_CLASS_PREFIX}toolbar\\s*\\{[^}]*display:\\s*none`)
    )
    expect(css).toMatch(
      new RegExp(`\\.${LIVE_FRAME_CLASS_PREFIX}resizer\\s*\\{[^}]*display:\\s*none`)
    )
    // 外壳类名以序号结尾、没有独立的「外壳类」，所以悬停也用同一个属性选择器。
    // 必须带 `>` 的后代作用域：外壳规则（div[class^=…]）也会命中工具条与手柄，
    // 不加这一层特异性，控件的 position/display 会被外壳规则覆盖（实测点不到的根因）。
    const shellHover = `div[class^="${LIVE_FRAME_CLASS_PREFIX}"]:hover >`
    expect(css).toContain(`${shellHover} .${LIVE_FRAME_CLASS_PREFIX}toolbar`)
    expect(css).toContain(`${shellHover} .${LIVE_FRAME_CLASS_PREFIX}resizer`)
    // 悬停规则里工具条是 flex，手柄是 block。
    expect(css).toMatch(
      new RegExp(
        `${shellHover.replace(/[[\]^"$]/g, '\\$&')} \\.${LIVE_FRAME_CLASS_PREFIX}toolbar\\s*\\{\\s*display:\\s*flex`
      )
    )
    // 只挂一个「外壳类」的路子是错的（标记 div 身上只有带序号的类名）。
    expect(css).not.toContain(`.${LIVE_FRAME_CLASS_PREFIX}:hover`)
  })

  it('手柄贴右下角、nwse-resize 光标，并且不抢指针事件', () => {
    // 手柄的类名会出现在多条规则里（悬停显示、本体样式），取声明了光标的那条。
    const resizer = [
      ...css.matchAll(new RegExp(`\\.${LIVE_FRAME_CLASS_PREFIX}resizer\\s*\\{([^}]*)\\}`, 'g'))
    ]
      .map((m) => m[1])
      .find((block) => block.includes('nwse-resize'))
    expect(resizer).toBeTruthy()
    expect(resizer).toContain('cursor: nwse-resize')
    expect(resizer).toContain('right: -3px')
    expect(resizer).toContain('bottom: -3px')
    expect(resizer).toContain('touch-action: none')
  })
})

describe('exportStyledHTML — 控件注入', () => {
  const NO_MUYA = null as unknown as Parameters<typeof exportStyledHTML>[0]
  const placeholder = `<div class="${LIVE_FRAME_CLASS_PREFIX}0" style="width:800px;max-width:100%;height:400px;overflow:hidden"></div>`

  it('有帧时：控件 CSS 与脚本都注入到 </head> 前（正文解析出问题时 head 里的才活得下来）', async () => {
    const out = await exportStyledHTML(NO_MUYA, `${placeholder}\n`, {
      frames: [buildLiveFrame('<div><script>document.title = "hi"</script></div>')]
    })

    expect(out).toContain(`.${LIVE_FRAME_CLASS_PREFIX}toolbar`)
    expect(out).toContain(`.${LIVE_FRAME_CLASS_PREFIX}resizer`)
    expect(out).toContain(`<script>${buildFrameControlsScript()}</script>`)
    // 脚本在 </head> 之前注入：正文里万一混进未闭合标记，body 里它之后的内容会被解析器
    // 整段吞掉，放 head 才活得下来（实测过真实的坑）。
    const scriptAt = out.indexOf('<script>')
    expect(scriptAt).toBeGreaterThan(0)
    expect(scriptAt).toBeLessThan(out.indexOf('</head>'))
    expect(out).toContain('<article class="markdown-body">')
    expect((out.match(/<\/body>/g) || []).length).toBe(1)
    // iframe 照旧注入（控件不改变帧本身）。
    expect(out).toContain('<iframe sandbox="allow-scripts allow-same-origin')
  })

  it('没有帧时：控件一个字节都不注入（普通导出不留死代码）', async () => {
    const out = await exportStyledHTML(NO_MUYA, '# Hi\n\ntext', {})

    expect(out).not.toContain(LIVE_FRAME_CLASS_PREFIX)
    expect(out).not.toContain('<script>')
  })
})
