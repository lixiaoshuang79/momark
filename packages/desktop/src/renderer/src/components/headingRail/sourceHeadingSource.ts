import { shallowRef } from 'vue'
import { listMarkdownHeadings, scrollSourceEditorToLine } from '@/util/sourceModeToc'
import type { IMarkdownHeading } from '@/util/sourceModeToc'
import { registerHeadingSource } from './headingSource'
import { toRailItems, type RailItem } from './railModel'

// CodeMirror 5 没有类型；只用到这几个方法。
interface SourceEditorLike {
  getValue: () => string
  heightAtLine: (line: number, mode: 'window' | 'local' | 'page' | 'div') => number
  setCursor: (
    pos: { line: number; ch: number },
    ch?: number | null,
    options?: { scroll?: boolean }
  ) => void
  on: (event: 'change', handler: () => void) => void
  off: (event: 'change', handler: () => void) => void
}

const RESCAN_MS = 200
// CodeMirror 的行区自带约 50px 上内边距，跳转后标题行顶边落在可视区顶下 ~50px。
const SOURCE_READING_LINE = 88

/**
 * 源码模式的标题轨来源：引擎目录在 CodeMirror 编辑期间不刷新，这里直接从源码扫
 * 标题，内容变化后防抖重扫；跳转直接滚 CodeMirror（`.source-code` 是滚动容器，
 * CodeMirror 自身全高渲染），不经引擎 slug。返回注销函数。
 */
export const attachSourceHeadingSource = (
  cm: SourceEditorLike,
  container: HTMLElement
): (() => void) => {
  const items = shallowRef<RailItem[]>([])
  let headings: IMarkdownHeading[] = []
  let timer: ReturnType<typeof setTimeout> | null = null

  const rescan = (): void => {
    timer = null
    headings = listMarkdownHeadings(cm.getValue())
    items.value = toRailItems(headings.map((h) => ({ content: h.text, lvl: h.level })))
  }
  const schedule = (): void => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(rescan, RESCAN_MS)
  }

  rescan()
  cm.on('change', schedule)
  const unregister = registerHeadingSource({
    scroller: container,
    items,
    // 源码模式跳转把标题行滚到顶边（scrollSourceEditorToLine），阅读线贴近顶边。
    probeOffset: () => SOURCE_READING_LINE,
    count: () => headings.length,
    topOf: (i) => {
      const heading = headings[i]
      if (!heading) return Number.POSITIVE_INFINITY
      return cm.heightAtLine(heading.line, 'window') - container.getBoundingClientRect().top
    },
    reveal: (item) => {
      const heading = headings[item.index]
      if (!heading) return false
      scrollSourceEditorToLine(cm, heading.line, container)
      return true
    }
  })

  return () => {
    unregister()
    cm.off('change', schedule)
    if (timer) clearTimeout(timer)
    timer = null
  }
}
