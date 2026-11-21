// 标题轨的纯逻辑：条目归一化、横线长度、行距、当前标题判定、悬停行、浮层夹取。
// 组件只负责量 DOM 与动画，所有「算哪一条、放哪」都在这里，便于单测。

export interface RailItem {
  index: number
  text: string
  /** 原始标题级别 1–6。 */
  level: number
  /** 相对文档最浅一级的深度 0–5：只有 H2/H3 的文档，H2 画成最长的那一档。 */
  depth: number
  /** 主编辑器 `scroll-to-header` 用的 slug；源码模式的条目没有。 */
  slug: string | null
}

interface TocLike {
  content?: unknown
  lvl?: unknown
  slug?: unknown
}

const clampLevel = (lvl: unknown): number => {
  const n = Number(lvl)
  if (!Number.isFinite(n)) return 1
  return Math.min(6, Math.max(1, Math.round(n)))
}

export const toRailItems = (toc: ReadonlyArray<TocLike>): RailItem[] => {
  if (!toc.length) return []
  const levels = toc.map((item) => clampLevel(item.lvl))
  const top = Math.min(...levels)
  return toc.map((item, index) => {
    const raw = typeof item.content === 'string' ? item.content : String(item.content ?? '')
    const text = raw.replace(/\s+/g, ' ').trim()
    return {
      index,
      text,
      level: levels[index]!,
      depth: Math.min(5, levels[index]! - top),
      slug: typeof item.slug === 'string' && item.slug.length > 0 ? item.slug : null
    }
  })
}

/** 横线长度（px）：越深越短，第 0 档 20px，往下每档递减、最短 5px。 */
const DASH_WIDTHS = [20, 15, 11, 8, 6, 5] as const
export const dashWidth = (depth: number): number =>
  DASH_WIDTHS[Math.min(DASH_WIDTHS.length - 1, Math.max(0, Math.floor(depth)))]!

/** 横线模式的行距上下限（px）：标题少时疏朗，多时压到 5px 仍可分辨。 */
export const DASH_PITCH_MAX = 12
export const DASH_PITCH_MIN = 5
/** 常驻完整标题时的行高（px）。 */
export const PINNED_ROW = 28

export interface RailPitch {
  pitch: number
  /** 压到最小行距仍放不下：轨道内部滚动、跟随当前标题。 */
  overflow: boolean
}

export const railPitch = (count: number, available: number): RailPitch => {
  if (count <= 0 || !(available > 0)) return { pitch: DASH_PITCH_MAX, overflow: false }
  const fit = Math.floor((available / count) * 10) / 10
  if (fit >= DASH_PITCH_MAX) return { pitch: DASH_PITCH_MAX, overflow: false }
  if (fit >= DASH_PITCH_MIN) return { pitch: fit, overflow: false }
  return { pitch: DASH_PITCH_MIN, overflow: true }
}

/** 常驻模式的栏宽：随窗宽 20%，夹在 188–248px。 */
export const pinnedRailWidth = (viewportWidth: number): number =>
  Math.round(Math.min(248, Math.max(188, viewportWidth * 0.2)))
export const DASH_RAIL_WIDTH = 48

/**
 * 阅读线在窗口坐标里的纵向位置（px）：取主编辑器「揭示」落点 STANDAR_Y（320，见
 * editorWithTabs/editor.vue）再往下 24px——点标题轨跳过去的那个标题，顶边正好落在
 * 阅读线上方，立刻算作「当前」。
 */
export const READING_LINE_Y = 344

export interface ActiveHeadingInput {
  count: number
  /** 第 i 个标题顶边相对滚动容器可视区顶边的距离（px，可为负）；须随 i 不减。 */
  topOf: (i: number) => number
  scrollTop: number
  viewportHeight: number
  scrollHeight: number
  /** 阅读线：可视区顶边往下多少 px 算「正在读」。 */
  probeOffset: number
}

/**
 * 当前标题 = 顶边已越过阅读线的最后一个标题；还没读到第一个标题时为 -1。
 *
 * 接近文末时阅读线逐渐下移到可视区底边：最后几节往往不足一屏，阅读线固定不动的话
 * 滚到底也轮不到它们。下移只发生在最后半屏的滚动距离内，按剩余距离线性插值，
 * 所以指示线不会在到底那一刻突然跳格。
 */
export const resolveActiveHeading = ({
  count,
  topOf,
  scrollTop,
  viewportHeight,
  scrollHeight,
  probeOffset
}: ActiveHeadingInput): number => {
  if (count <= 0 || !(viewportHeight > 0)) return -1
  const maxScroll = scrollHeight - viewportHeight
  const base = Math.min(Math.max(0, probeOffset), viewportHeight)
  let probe = base
  if (maxScroll > 0) {
    const ramp = Math.min(viewportHeight * 0.5, maxScroll)
    const remaining = Math.max(0, maxScroll - scrollTop)
    const t = ramp > 0 ? Math.min(1, Math.max(0, 1 - remaining / ramp)) : 0
    probe = base + (viewportHeight - 2 - base) * t
  }
  let lo = 0
  let hi = count - 1
  let found = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (topOf(mid) <= probe) {
      found = mid
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  return found
}

/** 0–100 的阅读进度；不可滚动的文档视为已读完。 */
export const readingProgress = (
  scrollTop: number,
  scrollHeight: number,
  viewportHeight: number
): number => {
  const maxScroll = scrollHeight - viewportHeight
  if (!(maxScroll > 0)) return 100
  return Math.round(Math.min(1, Math.max(0, scrollTop / maxScroll)) * 100)
}

/** 指针在列表内容坐标里的纵坐标 → 最近的一行。 */
export const rowAt = (y: number, rowHeight: number, count: number): number => {
  if (count <= 0 || !(rowHeight > 0)) return -1
  return Math.min(count - 1, Math.max(0, Math.floor(y / rowHeight)))
}

/** 浮层以 `center` 为中心，夹回 [margin, bound - height - margin]。 */
export const clampLabelTop = (
  center: number,
  height: number,
  bound: number,
  margin = 8
): number => {
  const top = center - height / 2
  const max = bound - height - margin
  if (max < margin) return margin
  return Math.min(max, Math.max(margin, top))
}

/**
 * 轨道内部需要滚到哪，才能让第 `index` 行落在中间安全带里；已在带内返回 null
 * （不动，避免每次切换标题都晃一下）。
 */
export const followScrollTop = (
  index: number,
  rowHeight: number,
  scrollTop: number,
  viewport: number,
  contentHeight: number
): number | null => {
  if (index < 0 || !(viewport > 0)) return null
  const rowTop = index * rowHeight
  const band = Math.min(viewport * 0.25, rowHeight * 4)
  if (rowTop >= scrollTop + band && rowTop + rowHeight <= scrollTop + viewport - band) return null
  const target = rowTop + rowHeight / 2 - viewport / 2
  return Math.round(Math.min(Math.max(0, contentHeight - viewport), Math.max(0, target)))
}
