import { computed, shallowRef, type Ref } from 'vue'
import { READING_LINE_Y, type RailItem } from './railModel'

/**
 * 标题轨从「当前在显示的那个主编辑器」取几何：所见即所得用 Muya，源码模式用
 * CodeMirror。两者各自注册一个来源，后注册的优先（源码模式挂在 Muya 之上，卸载时
 * 自动退回 Muya）。分屏右栏的文档编辑器不注册——标题轨只跟随左侧主编辑区。
 */
export interface HeadingSource {
  /** 滚动容器：标题轨监听它的 scroll。 */
  scroller: HTMLElement
  /** 可量到的标题数（与条目顺序一一对应）。 */
  count: () => number
  /** 第 i 个标题顶边相对滚动容器可视区顶边的距离（px）。 */
  topOf: (i: number) => number
  /** 由来源自己给出条目时（源码模式）用它；否则用引擎目录。 */
  items?: Ref<RailItem[]>
  /** 自己处理跳转（源码模式）；返回 false 时退回 `scroll-to-header`。 */
  reveal?: (item: RailItem) => boolean
  /**
   * 阅读线距可视区顶边的距离（px）：顶边越过它的最后一个标题算「当前」。应与该
   * 来源「跳到标题」的落点一致，否则刚点过去的标题会被判成上一个或下一个。
   */
  probeOffset: () => number
  /** 标题集合可能变了（目录更新）：丢掉缓存。 */
  invalidate?: () => void
}

const stack = shallowRef<HeadingSource[]>([])

export const activeHeadingSource = computed<HeadingSource | null>(
  () => stack.value[stack.value.length - 1] ?? null
)

export const registerHeadingSource = (source: HeadingSource): (() => void) => {
  stack.value = [...stack.value, source]
  return () => {
    stack.value = stack.value.filter((s) => s !== source)
  }
}

/**
 * Muya 的标题几何：`.mu-container` 的顶层 h1–h6，与引擎 `getTOC` 枚举的集合一致
 * （见 util/tocNavigation.ts）。节点列表缓存到顶层子节点增删或节点脱离文档为止；
 * 每帧只二分读 log₂N 个标题的 rect。屏外块（content-visibility）的几何是估算值，
 * 但阅读线附近的块都已真实布局，滚动位置与标题位置在同一套坐标里比较，所以判定
 * 「当前标题」不受估算影响。
 */
export const createMuyaHeadingSource = (
  scroller: HTMLElement,
  selector: string
): HeadingSource & { dispose: () => void } => {
  let nodes: HTMLElement[] | null = null
  let observed: Element | null = null
  const observer = new MutationObserver(() => {
    nodes = null
  })

  const collect = (): HTMLElement[] => {
    if (nodes && (nodes.length === 0 || nodes[0]!.isConnected)) return nodes
    nodes = Array.from(scroller.querySelectorAll<HTMLElement>(selector))
    const host = scroller.querySelector('.mu-container')
    if (host && host !== observed) {
      observer.disconnect()
      observer.observe(host, { childList: true })
      observed = host
    }
    return nodes
  }

  return {
    scroller,
    // 大纲跳转把标题放在窗口 y = STANDAR_Y 处，阅读线取其下方一点；至少 64px，至多半屏。
    probeOffset: () =>
      Math.min(
        scroller.clientHeight * 0.5,
        Math.max(64, READING_LINE_Y - scroller.getBoundingClientRect().top)
      ),
    count: () => collect().length,
    topOf: (i) => {
      const list = collect()
      const node = list[i]
      if (!node) return Number.POSITIVE_INFINITY
      if (!node.isConnected) {
        nodes = null
        const fresh = collect()[i]
        return fresh
          ? fresh.getBoundingClientRect().top - scroller.getBoundingClientRect().top
          : Infinity
      }
      return node.getBoundingClientRect().top - scroller.getBoundingClientRect().top
    },
    invalidate: () => {
      nodes = null
    },
    dispose: () => {
      observer.disconnect()
      nodes = null
      observed = null
    }
  }
}
