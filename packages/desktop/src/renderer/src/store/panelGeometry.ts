/**
 * 右侧栏宽度几何（feat/right-panel-redesign，DESIGN-NOTES §1）。
 *
 *   面板宽 = clamp(最小值, 比例 × 可用宽, 最大值)
 *   最大值 = min(60% 可用宽, 可用宽 − 480)      ← 永远给正文留 480px
 *
 * 「可用宽」= 窗宽 − 标题轨占用宽（左右分屏要对半时，两侧平分的是同一块区域，
 * 沿用 round8「左右平等」的口径）。记住的是比例不是像素：窗口变大变小都按
 * 比例重算，再过一遍上下限。面板比例与分屏比例分开存。
 *
 * 窄窗保护：可用宽 − 280 < 480（约窗宽 < 760）时面板改为浮层，盖在正文上方，
 * 正文宽度不变。
 *
 * 这里只有纯函数，没有响应式状态，便于单测。
 */

export type PanelKind = 'panel' | 'split'

export const DEFAULT_PANEL_RATIO = 0.3
export const DEFAULT_SPLIT_RATIO = 0.5

export const PANEL_LIMITS = {
  panelMin: 280,
  splitMin: 360,
  editorMin: 480,
  maxFrac: 0.6,
  // 浮层模式下面板左侧至少露出的正文宽度（能看到正文、能点回去）。
  overlayKeep: 56,
  // 吸附距离与软边界阻尼
  snapDistance: 10,
  softDamping: 0.18,
  softMaxOvershoot: 14
} as const

// 比例的合法区间：落盘值来自偏好文件，可能被手改或来自更老的版本。
const RATIO_MIN = 0.05
const RATIO_MAX = 0.95

export const defaultRatioFor = (kind: PanelKind): number =>
  kind === 'split' ? DEFAULT_SPLIT_RATIO : DEFAULT_PANEL_RATIO

/** 偏好里读出的比例：不是有限数或越界就退回默认值，绝不让 UI 拿到 NaN。 */
export const sanitizeRatio = (value: unknown, kind: PanelKind): number => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return defaultRatioFor(kind)
  if (value < RATIO_MIN || value > RATIO_MAX) return defaultRatioFor(kind)
  return value
}

export interface PanelBounds {
  min: number
  max: number
  overlay: boolean
}

export const isOverlayWidth = (avail: number): boolean =>
  avail - PANEL_LIMITS.panelMin < PANEL_LIMITS.editorMin

export const panelBounds = (avail: number, kind: PanelKind): PanelBounds => {
  const safeAvail = Math.max(0, Number.isFinite(avail) ? avail : 0)
  const kindMin = kind === 'split' ? PANEL_LIMITS.splitMin : PANEL_LIMITS.panelMin
  if (isOverlayWidth(safeAvail)) {
    const max = Math.max(0, safeAvail - PANEL_LIMITS.overlayKeep)
    return { min: Math.min(PANEL_LIMITS.panelMin, max), max, overlay: true }
  }
  const max = Math.floor(
    Math.min(PANEL_LIMITS.maxFrac * safeAvail, safeAvail - PANEL_LIMITS.editorMin)
  )
  // 分屏的 360 下限在窄一些的窗口里会超过最大值：以最大值为准，但不低于 280。
  const min = Math.max(PANEL_LIMITS.panelMin, Math.min(kindMin, max))
  return { min, max: Math.max(min, max), overlay: false }
}

export const clampWidth = (px: number, bounds: PanelBounds): number =>
  Math.round(Math.max(bounds.min, Math.min(bounds.max, px)))

export interface PanelGeometry extends PanelBounds {
  width: number
}

export const panelGeometry = (ratio: number, avail: number, kind: PanelKind): PanelGeometry => {
  const bounds = panelBounds(avail, kind)
  const width = clampWidth(sanitizeRatio(ratio, kind) * avail, bounds)
  return { ...bounds, width }
}

/** 拖完 / 键盘调整后要落盘的比例（四舍五入到千分位，避免偏好里一长串小数）。 */
export const ratioFromWidth = (px: number, avail: number, kind: PanelKind): number => {
  if (!(avail > 0) || !Number.isFinite(px)) return defaultRatioFor(kind)
  const ratio = Math.round((px / avail) * 1000) / 1000
  return Math.max(RATIO_MIN, Math.min(RATIO_MAX, ratio))
}

export type SnapId = 'third' | 'half' | 'default'

export interface SnapLine {
  id: SnapId
  px: number
}

/** ⅓ / ½ / 默认 三条吸附参考线（只保留落在上下限之内的）。 */
export const snapLines = (avail: number, kind: PanelKind, bounds: PanelBounds): SnapLine[] => {
  const lines: SnapLine[] = [
    { id: 'third', px: Math.round(avail / 3) },
    { id: 'half', px: Math.round(avail / 2) },
    { id: 'default', px: Math.round(defaultRatioFor(kind) * avail) }
  ]
  const seen = new Set<number>()
  return lines.filter((line) => {
    if (line.px < bounds.min || line.px > bounds.max) return false
    // 分屏默认就是 ½：重合的线只留一条（先到的 ½ 优先）
    if (seen.has(line.px)) return false
    seen.add(line.px)
    return true
  })
}

export type LimitReason = 'min' | 'max' | 'editor' | null

export interface DragResult {
  /** 拖动中面板实际显示的宽度（含软边界阻尼） */
  px: number
  /** 松手后要落定的宽度（已夹回上下限） */
  settle: number
  snapped: SnapId | null
  limit: LimitReason
}

/**
 * 拖动中的宽度：先吸附（10px 内），再软边界——越过上下限后按 0.18 倍阻尼继续
 * 跟手，最多多走 14px，松手回弹到边界。`limit` 说明是哪条边界（气泡文案用）。
 */
export const dragWidth = (
  raw: number,
  avail: number,
  kind: PanelKind,
  bounds: PanelBounds = panelBounds(avail, kind)
): DragResult => {
  let px = raw
  let snapped: SnapId | null = null
  for (const line of snapLines(avail, kind, bounds)) {
    if (Math.abs(raw - line.px) <= PANEL_LIMITS.snapDistance) {
      px = line.px
      snapped = line.id
      break
    }
  }
  const soft = (over: number): number =>
    Math.min(PANEL_LIMITS.softMaxOvershoot, over * PANEL_LIMITS.softDamping)
  if (px < bounds.min) {
    return {
      px: Math.round(bounds.min - soft(bounds.min - px)),
      settle: bounds.min,
      snapped: null,
      limit: 'min'
    }
  }
  if (px > bounds.max) {
    // 最大值由哪一条决定：60% 还是「给正文留 480」
    const byEditor = bounds.overlay || avail - PANEL_LIMITS.editorMin < PANEL_LIMITS.maxFrac * avail
    return {
      px: Math.round(bounds.max + soft(px - bounds.max)),
      settle: bounds.max,
      snapped: null,
      limit: byEditor ? 'editor' : 'max'
    }
  }
  const rounded = Math.round(px)
  return { px: rounded, settle: rounded, snapped, limit: null }
}

/** 键盘步进：←/→ 每次 16px，⇧ 加速到 64px。← 是变宽（分隔线往左走）。 */
export const KEY_STEP = 16
export const KEY_STEP_FAST = 64
