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
 * 文档开头：阅读线固定在 ~344px 深处的话，刚打开（scrollTop = 0）就会越过开头挤在
 * 一起的前几个标题，当前标题直接落到第三个。所以在最开始的 `base` px 滚动距离内，
 * 阅读线从「第一个标题的顶边」线性下移回原位：顶部时当前恰好是第一个，往下滚时
 * 依次轮到后面的标题。只在第一个标题本来就在阅读线之上时生效——阅读线只会被
 * 提上去、不会被拉下来，开头有一屏以上引言的文档照旧是 -1。
 *
 * 接近文末时阅读线逐渐下移到可视区底边：最后几节往往不足一屏，阅读线固定不动的话
 * 滚到底也轮不到它们。下移只发生在最后半屏的滚动距离内，按剩余距离线性插值，
 * 所以指示线不会在到底那一刻突然跳格。
 *
 * 两段插值都让「阅读线在内容里的位置」随 scrollTop 单调不减，当前标题只会前进。
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
  // 开头一段：scrollTop < base 时才读第一个标题（远离开头不多读，保持 O(log n)）。
  if (base > 0 && scrollTop < base) {
    const first = topOf(0) + Math.max(0, scrollTop)
    if (first < base) {
      // +1：亚像素误差下第一个标题也稳稳算进去；相邻标题不可能挤在 1px 内。
      const start = Math.max(0, first) + 1
      probe = start + (base - start) * (Math.max(0, scrollTop) / base)
    }
  }
  if (maxScroll > 0) {
    const ramp = Math.min(viewportHeight * 0.5, maxScroll)
    const remaining = Math.max(0, maxScroll - scrollTop)
    const t = ramp > 0 ? Math.min(1, Math.max(0, 1 - remaining / ramp)) : 0
    probe = probe + (viewportHeight - 2 - probe) * t
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

/** 点击跳转落定后仍保持的目标：`scrollTop` 是落定时正文的滚动位置。 */
export interface JumpHold {
  index: number
  scrollTop: number
}

/**
 * 点击跳转落定后，按滚动位置算出的标题仍可能不是被点的那个：文档开头/文末滚不到
 * 让它落在阅读线上的位置（例如开头点第二个标题，正文根本滚不动）。这时继续显示被
 * 点的那个，直到用户把它滚「过去」：
 * - 正文没动（只是重排、改窗口大小）：保持；
 * - 被点的在算出的之后、用户往下滚：保持，直到算出的追上它；
 * - 被点的在算出的之前、用户往上滚：保持，直到算出的退到它；
 * - 往反方向滚：放开，交回滚动位置。
 * 这样放开那一刻当前标题沿滚动方向连续变化，不会先倒退再前进。
 */
export const keepJumpHold = (hold: JumpHold, computed: number, scrollTop: number): boolean => {
  if (computed === hold.index) return false
  const delta = scrollTop - hold.scrollTop
  if (Math.abs(delta) < 1) return true
  return hold.index > computed ? delta > 0 : delta < 0
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
