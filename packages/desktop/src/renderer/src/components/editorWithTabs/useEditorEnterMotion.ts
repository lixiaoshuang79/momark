import { onBeforeUnmount } from 'vue'

export interface EditorEnterMotionOptions {
  stiffness?: number
  damping?: number
  mass?: number
  distance?: number
  scaleFrom?: number
  fadeMs?: number
  maxMs?: number
}

/**
 * 正文切换回弹动效（round10 调研定案）：手写 rAF 弹簧、零依赖，只动
 * transform/opacity（合成器属性——不触发布局与 element-resize-detector），
 * 作用目标是编辑器外层 .editor-wrapper（绝不碰 Muya 的 .editor-component
 * 根节点）。手感参数 ζ=0.70（k=400/c=28/m=1）：6px 垂直位移反弹出 ≈4.6%
 * 的肉眼刚可察觉微过冲 + scale 0.992→1 缓升（scale 不过冲）+ 90ms 淡入，
 * 稳定时间 ≈215ms。打断策略：pointerdown/keydown → cancel() 一帧落位终态，
 * 绝不打运动靶子；prefers-reduced-motion 直接跳过。
 */
export function useEditorEnterMotion(
  getEl: () => HTMLElement | null,
  opts: EditorEnterMotionOptions = {}
): { play: () => void; cancel: () => void } {
  const {
    stiffness = 400,
    damping = 28,
    mass = 1,
    distance = 6,
    scaleFrom = 0.992,
    fadeMs = 90,
    maxMs = 600
  } = opts

  const reducedMotion =
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches

  let raf = 0
  let finished = true

  const applyFinal = (): void => {
    const el = getEl()
    if (!el) return
    el.style.transition = ''
    el.style.willChange = ''
    el.style.opacity = ''
    el.style.transform = ''
  }

  const cancel = (): void => {
    if (raf) {
      cancelAnimationFrame(raf)
      raf = 0
    }
    if (!finished) {
      finished = true
      applyFinal()
    }
  }

  const play = (): void => {
    const el = getEl()
    if (!el || reducedMotion) return
    // 连点切换防累积：上次动画立即落位再重新起跳。
    cancel()
    finished = false
    el.style.transition = 'none'
    el.style.willChange = 'transform, opacity'
    el.style.opacity = '0.35'
    el.style.transform = `translate3d(0, ${distance}px, 0) scale(${scaleFrom})`

    // 双 rAF：确保起始帧已提交，起始值与首动画帧不会被浏览器合并。
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (finished) return
        el.style.transition = `opacity ${fadeMs}ms ease-out`
        el.style.opacity = '1'

        const start = performance.now()
        let last = start
        let p = 0
        let v = 0
        const tick = (now: number): void => {
          if (finished) return
          // dt 封顶 50ms（60Hz 下限），时间戳驱动不受帧率波动影响。
          const dt = Math.min(0.05, Math.max(0, (now - last) / 1000))
          last = now
          // 半隐式欧拉弹簧积分（目标位 p = 1、单位质量公式）。
          v += (-stiffness * (p - 1) * dt - damping * v * dt) / mass
          p += v * dt
          const y = distance * (1 - p) // 位移冲过终点再弹回 = 回弹手感
          const s = scaleFrom + (1 - scaleFrom) * Math.min(1, Math.max(0, p))
          el.style.transform = `translate3d(0, ${y}px, 0) scale(${s})`
          if ((Math.abs(p - 1) < 0.01 && Math.abs(v) < 0.02) || now - start > maxMs) {
            finished = true
            raf = 0
            applyFinal()
            return
          }
          raf = requestAnimationFrame(tick)
        }
        raf = requestAnimationFrame(tick)
      })
    })
  }

  onBeforeUnmount(cancel)

  return { play, cancel }
}
