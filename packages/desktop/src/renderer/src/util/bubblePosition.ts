/**
 * 浮层（目前是「粘贴 html 文件」的二选一气泡）的落点计算。
 *
 * 抽成纯函数的原因：这块几何**必须能单测**——曾经的实现直接 `Math.min(rect.left, …)`，
 * 而空文档里 collapsed range 会给一个 0×0、位置在 (0,0) 的矩形，于是气泡被贴到窗口
 * 左上角、压在标签栏上（用户 2026-09-16 截图指出）。把「锚点是否可用」「越界怎么收」
 * 「放不下要不要翻到上方」都写死在这里，编辑器只负责量尺寸和赋值。
 */

export interface RectLike {
  left: number
  top: number
  right: number
  bottom: number
  width: number
  height: number
}

export interface Size {
  width: number
  height: number
}

export interface BubblePlacement {
  x: number
  y: number
  /** 是否翻到了锚点上方（锚点太靠下、下方放不下时）。 */
  above: boolean
}

/** 量不到真实尺寸时的估算值，用于首帧定位（随后会用实测尺寸纠正）。 */
export const DEFAULT_BUBBLE_SIZE: Size = { width: 300, height: 150 }

/**
 * 锚点矩形是否真的描述了光标位置。
 *
 * 空文档 / 未聚焦时，`getRangeAt(0).getBoundingClientRect()` 返回 0×0 且位于原点的
 * 矩形——那不代表「光标在窗口左上角」，而是「没有几何信息」，必须走兜底位置。
 */
export const isUsableAnchor = (rect: RectLike | null | undefined): rect is RectLike => {
  if (!rect) return false

  // 折叠光标宽 0 高 >0；选区宽高都 >0。两者都可接受，全 0 就是退化。
  if (rect.width <= 0 && rect.height <= 0) return false

  // 退化矩形几乎总在原点：正文字段落有内边距，不会正好落在 (0,0)。
  return rect.left !== 0 || rect.top !== 0
}

/**
 * 算气泡落点。
 *
 * - `anchor`：光标/选区矩形，不可用（空文档、选区不在编辑器里）时退到编辑区左上角；
 * - `bounds`：允许占用的区域，取**编辑区**而非整个窗口，这样永远不会盖住标签栏/标题栏；
 * - `bubble`：气泡实测尺寸；`margin` 是离边界的呼吸位，`gap` 是与光标行的间距。
 */
export const placeBubble = (options: {
  anchor?: RectLike | null
  bounds: RectLike
  bubble?: Size
  gap?: number
  margin?: number
}): BubblePlacement => {
  const { anchor, bounds, bubble = DEFAULT_BUBBLE_SIZE, gap = 8, margin = 8 } = options

  const minX = bounds.left + margin
  const minY = bounds.top + margin
  // 空间不足时 max 可能小于 min（编辑区比气泡还小），用 max 兜住，保证仍落在区内。
  const maxX = Math.max(minX, bounds.right - bubble.width - margin)
  const maxY = Math.max(minY, bounds.bottom - bubble.height - margin)

  const clampX = (value: number) => Math.round(Math.min(Math.max(value, minX), maxX))

  if (!isUsableAnchor(anchor)) return { x: clampX(minX), y: Math.round(minY), above: false }

  const x = clampX(anchor.left)

  const below = anchor.bottom + gap
  if (below + bubble.height <= bounds.bottom - margin)
    return { x, y: Math.round(Math.min(Math.max(below, minY), maxY)), above: false }

  const above = anchor.top - bubble.height - gap
  if (above >= minY) return { x, y: Math.round(above), above: true }

  // 上下都放不下（编辑区太矮）：收在区内底部，不越界。
  return { x, y: Math.round(maxY), above: false }
}
