import './transitions.css'

// 标签切换内容动效（PHASE2-SPEC §2，参数与原型 transitionDocument/animateDocumentLines 同源）：
// - 行粒度 = 编辑器渲染出的块级节点（H1-H6/p/列表/引用/代码块等主内容块）；
// - 旧内容逐行滑出、新内容逐行分层滑入，真实位移 + 回落；
// - 可中断：每次切换递增 motion token，超时回调校验 token 不符即放弃；
// - prefers-reduced-motion 直接切换不播动画。

let motionToken = 0
let activeOverlay: HTMLElement | null = null

// 参与计行的主内容块标签。div 兼容引擎的表格/脚注等容器块。
const BLOCK_TAGS = new Set([
  'P',
  'H1',
  'H2',
  'H3',
  'H4',
  'H5',
  'H6',
  'UL',
  'OL',
  'BLOCKQUOTE',
  'PRE',
  'TABLE',
  'HR',
  'FIGURE',
  'DIV'
])

export interface CapturedLine {
  el: HTMLElement
  left: number
  top: number
  width: number
}

export const prefersReducedMotion = (): boolean => {
  return (
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  )
}

/**
 * 在内容被替换前调用：记录每行的渲染位置（相对滚动容器内容原点），
 * 供覆盖层在内容切换后原样摆放旧行。调用后节点会被引擎 detach，
 * 因此矩形必须在此刻快照。
 */
export const captureBlockLines = (
  scroller: HTMLElement | null,
  container: HTMLElement | null
): CapturedLine[] => {
  if (!scroller || !container) return []
  const scrollerRect = scroller.getBoundingClientRect()
  const scrollerStyle = getComputedStyle(scroller)
  const borderLeft = parseFloat(scrollerStyle.borderLeftWidth || '0')
  const borderTop = parseFloat(scrollerStyle.borderTopWidth || '0')
  const scrollLeft = scroller.scrollLeft
  const scrollTop = scroller.scrollTop

  return Array.from(container.children)
    .filter((el): el is HTMLElement => el instanceof HTMLElement && BLOCK_TAGS.has(el.tagName))
    .map((el) => {
      const rect = el.getBoundingClientRect()
      return {
        el,
        left: rect.left - scrollerRect.left - borderLeft + scrollLeft,
        top: rect.top - scrollerRect.top - borderTop + scrollTop,
        width: rect.width
      }
    })
}

const clearLineAnimation = (el: HTMLElement): void => {
  el.classList.remove('doc-line-enter', 'doc-line-exit')
  el.style.removeProperty('--line-x')
  el.style.removeProperty('--line-duration')
  el.style.removeProperty('--line-out-x')
  el.style.removeProperty('--line-out-duration')
  el.style.removeProperty('--line-delay')
}

const removeActiveOverlay = (): void => {
  if (activeOverlay) {
    activeOverlay.remove()
    activeOverlay = null
  }
}

/**
 * 在新内容已经渲染进 `linesContainer` 之后调用：
 * 旧行以绝对定位覆盖层的形式逐行滑出，新行逐层滑入。
 */
export const runDocumentTransition = (opts: {
  scroller: HTMLElement | null
  linesContainer: HTMLElement | null
  oldLines: CapturedLine[]
  direction: 1 | -1
}): void => {
  const { scroller, linesContainer, oldLines, direction } = opts
  const token = ++motionToken

  // 打断上一轮未完成的切换动画。
  removeActiveOverlay()

  const newLines = captureBlockLines(scroller, linesContainer)
  if (!scroller || (!oldLines.length && !newLines.length)) {
    return
  }

  if (prefersReducedMotion()) {
    return
  }

  if (oldLines.length) {
    const overlay = document.createElement('div')
    // 复用 .mu-container 类名，让旧行的 p/h/列表等排版规则在覆盖层里继续生效
    // （引擎 CSS 均以 .mu-container 为作用域）；覆盖层自身的重置规则见 transitions.css。
    overlay.className = 'mu-container doc-swap-overlay'
    scroller.appendChild(overlay)
    activeOverlay = overlay

    let outEnd = 0
    oldLines.forEach(({ el, left, top, width }, index) => {
      const length = (el.textContent || '').trim().length
      const distance = 120 + Math.min(150, length * 1.35)
      const duration = 180 + Math.min(60, length * 0.8)
      const delay = Math.min(index * 8, 200) + (length % 4) * 4
      outEnd = Math.max(outEnd, duration + delay)
      // 清理上一轮被打断的入场动画残留（class 与 CSS 变量），避免与退场冲突。
      clearLineAnimation(el)
      el.style.position = 'absolute'
      el.style.left = `${left}px`
      el.style.top = `${top}px`
      el.style.width = `${width}px`
      el.style.margin = '0'
      el.style.setProperty('--line-out-x', `${-direction * distance}px`)
      el.style.setProperty('--line-out-duration', `${duration}ms`)
      el.style.setProperty('--line-delay', `${delay}ms`)
      overlay.appendChild(el)
      el.classList.add('doc-line-exit')
    })

    setTimeout(() => {
      if (token !== motionToken) return
      removeActiveOverlay()
    }, outEnd + 90)
  }

  newLines.forEach(({ el }, index) => {
    const length = (el.textContent || '').trim().length
    const distance = 120 + Math.min(170, length * 1.5)
    // 入场压缩到 320-420ms、错峰封顶 300ms：总预算 <500ms（MD3 时序表），
    // 逐行 560-920ms 的老参数在长文档上拖沓且掉帧。
    const duration = 320 + Math.min(100, length * 0.9)
    const delay = Math.min(index * 14, 300) + (length % 6) * 4
    el.style.setProperty('--line-x', `${direction * distance}px`)
    el.style.setProperty('--line-duration', `${duration}ms`)
    el.style.setProperty('--line-delay', `${delay}ms`)
    el.classList.add('doc-line-enter')
    setTimeout(
      () => {
        if (token !== motionToken) return
        clearLineAnimation(el)
      },
      duration + delay + 80
    )
  })
}
