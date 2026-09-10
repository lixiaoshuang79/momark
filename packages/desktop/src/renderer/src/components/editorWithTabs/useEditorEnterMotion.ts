import { onBeforeUnmount } from 'vue'

export interface EditorEnterMotionOptions {
  stiffness?: number
  damping?: number
  mass?: number
  distance?: number
  fadeMs?: number
  maxMs?: number
}

/**
 * 正文切换回弹动效（round10 调研定案，round11 三改方向）：
 * 手写 rAF 弹簧、零依赖，只动 transform/opacity（合成器属性——
 * 不触发布局与 element-resize-detector），作用目标是编辑器外层
 * .editor-wrapper（绝不碰 Muya 的 .editor-component 根节点）。
 * round11 四调（用户拍板「是左右回弹，不是上下跳」）：
 * ①方向=横向 translateX——新标签在旧标签右侧 → 内容从右滑入
 *   （起跳 +distance、到位后向左轻弹 ≈5.5px 回正）；在左侧 →
 *   从左滑入（镜像）。滑入/回弹全程被父级 .container 的
 *   overflow:hidden 裁剪在编辑区盒内，与左右侧栏零交集；
 * ②弹簧 ζ≈0.49（k=420/c=20/m=1）过冲 = 32×e^(-πζ/√(1-ζ²)) ≈5.5px，
 *   收敛 ≈650ms；淡入 0.15→1 共 220ms；不再缩放（横滑+缩放会互相
 *   干扰观感）。
 * 积分用欠阻尼解析解（与帧率无关，低帧率下幅度不漂移）。
 * 打断策略：pointerdown/keydown → cancel() 一帧落位终态，绝不打运动靶子；
 * prefers-reduced-motion 直接跳过。
 */
export function useEditorEnterMotion(
  getEl: () => HTMLElement | null,
  opts: EditorEnterMotionOptions = {}
): { play: (direction?: 'left' | 'right') => void; cancel: () => void } {
  const { stiffness = 420, damping = 20, mass = 1, distance = 32, fadeMs = 220, maxMs = 800 } = opts

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

  const play = (direction: 'left' | 'right' = 'right'): void => {
    const el = getEl()
    if (!el || reducedMotion) return
    // 连点切换防累积：上次动画立即落位再重新起跳。
    cancel()
    finished = false
    // 横向起跳：新内容从进入侧滑入（right=右侧进入起跳 +distance）。
    const sign = direction === 'left' ? -1 : 1
    el.style.transition = 'none'
    el.style.willChange = 'transform, opacity'
    el.style.opacity = '0.15'
    el.style.transform = `translate3d(${sign * distance}px, 0, 0)`

    // 双 rAF：确保起始帧已提交，起始值与首动画帧不会被浏览器合并。
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (finished) return
        el.style.transition = `opacity ${fadeMs}ms ease-out`
        el.style.opacity = '1'

        const start = performance.now()
        // round11：解析弹簧（欠阻尼闭合解）替代欧拉数值积分——
        // 半隐式欧拉在大 dt（低帧率/采样卡顿）下会放大过冲，解析解与
        // 帧率无关、幅度严格等于理论值：ζ≈0.49 时过冲 ≈5.5px，回弹肉眼清晰。
        const w0 = Math.sqrt(stiffness / mass)
        const zeta = damping / (2 * Math.sqrt(stiffness * mass))
        const wd = w0 * Math.sqrt(Math.max(0, 1 - zeta * zeta))
        const sinCoef = (zeta * w0) / Math.max(wd, 0.0001)
        const tick = (now: number): void => {
          if (finished) return
          const tSec = Math.max(0, (now - start) / 1000)
          const decay = Math.exp(-zeta * w0 * tSec)
          const p = 1 - decay * (Math.cos(wd * tSec) + sinCoef * Math.sin(wd * tSec))
          // 横向弹簧：x 由起跳侧收敛到 0，过冲段反向（到位后轻弹回正）。
          const x = sign * distance * (1 - p)
          el.style.transform = `translate3d(${x}px, 0, 0)`
          // 结束判定用固定时长（解析解全程稳定，ratio 不漂移）：
          // ≈650ms 覆盖「32px 主体行程 + ≈5.5px 单次明显过冲 + 回落近零」，
          // 不允许用 |p-1| 提前判停——p 在 t≈140ms 会先穿过 1 附近，过早
          // 判停会截断过冲段，回弹感就没了。
          if (tSec * 1000 > 650 || now - start > maxMs) {
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
