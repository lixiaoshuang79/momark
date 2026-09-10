import { onBeforeUnmount } from 'vue'

export interface EditorEnterMotionOptions {
  /** 滑入行程（px）。 */
  distance?: number
  /** 滑入时长（ms），back 缓动自带反向过冲（≈行程的 17%）。 */
  slideMs?: number
  /** 淡入时长（ms）。 */
  fadeMs?: number
  /** 兜底清理定时（ms）。 */
  maxMs?: number
}

/**
 * 正文切换左右回弹动效（round11 六调定稿）：CSS transition + back 缓动，
 * 合成器线程驱动——不依赖主线程 rAF，标签切换链路里
 * UPDATE_CURRENT_FILE 的 flushActiveEditor 同步阻塞（实测 ~380ms）期间
 * 动画由合成器按真实时间推进，恢复后画面已自然滑入回弹，无僵帧、
 * 无「起跳瞬间被第一帧清零」的 rAF 老毛病。
 *
 * 行为（用户六轮反馈收敛）：
 * - 左右横向：新标签在旧标签右侧 → 内容从右滑入（+distance 起跳），
 *   到位后反向轻弹（back 缓动过冲 ≈5.5px）回正；在左侧 → 镜像。
 * - 字动、底不动：wrapper 无背景，画布底色由外层静态提供。
 * - 不越界：全程被父级 .container 的 overflow:hidden 裁剪在编辑区内。
 * - 起跳在点击瞬间同步提交（tabs.vue 派发事件），内容替换发生在
 *   flush 期间，transition 时钟从样式提交后的首帧起算，天然衔接。
 *
 * 打断策略：pointerdown/keydown → cancel() 一帧落位终态；
 * prefers-reduced-motion 直接跳过。
 */
export function useEditorEnterMotion(
  getEl: () => HTMLElement | null,
  opts: EditorEnterMotionOptions = {}
): { play: (direction?: 'left' | 'right') => void; cancel: () => void } {
  const { distance = 32, slideMs = 420, fadeMs = 220, maxMs = 800 } = opts

  const reducedMotion =
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches

  let cleanupTimer = 0

  const clearPendingCleanup = (): void => {
    if (cleanupTimer) {
      window.clearTimeout(cleanupTimer)
      cleanupTimer = 0
    }
  }

  const applyFinal = (): void => {
    clearPendingCleanup()
    const el = getEl()
    if (!el) return
    el.style.transition = ''
    el.style.willChange = ''
    el.style.opacity = ''
    el.style.transform = ''
  }

  const cancel = (): void => {
    applyFinal()
  }

  const play = (direction: 'left' | 'right' = 'right'): void => {
    const el = getEl()
    if (!el || reducedMotion) return
    // 连点切换防累积：上次动画立即落位再重新起跳。
    cancel()
    const sign = direction === 'left' ? -1 : 1

    // 1) 提交起跳帧（无 transition，立即生效）。
    el.style.transition = 'none'
    el.style.willChange = 'transform, opacity'
    el.style.opacity = '0.15'
    el.style.transform = `translate3d(${sign * distance}px, 0, 0)`
    // 2) 强制提交，随后同一帧声明 transition 并写终态——合成器从下一帧
    //    开始推进动画。iOS 弹窗级回弹缓动（0.34, 1.75, 0.64, 1.0）过冲
    //    ≈ 行程 18%（32px → ≈5.8px），「滑入 + 反向轻弹回正」手感明确。
    const forceReflow = el.offsetWidth
    if (forceReflow < 0) applyFinal()
    el.style.transition = `transform ${slideMs}ms cubic-bezier(0.34, 1.75, 0.64, 1), opacity ${fadeMs}ms ease-out`
    el.style.opacity = '1'
    el.style.transform = 'translate3d(0, 0, 0)'

    clearPendingCleanup()
    cleanupTimer = window.setTimeout(applyFinal, maxMs)
    // 提前结束（打断/重复触发）也走同一清理，防 transition 残留。
  }

  onBeforeUnmount(applyFinal)

  return { play, cancel }
}
