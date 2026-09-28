import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

// `@/store/editor` reads `window.path` at module load and `window.electron` at
// runtime; stub those surfaces before the hoisted imports run.
vi.hoisted(() => {
  const w = globalThis as unknown as {
    window?: {
      path?: { sep: string; dirname: (p: string) => string }
      electron?: {
        clipboard: { writeText: (s: string) => void }
        ipcRenderer: {
          send: (...a: unknown[]) => void
          on: (...a: unknown[]) => void
          invoke: (...a: unknown[]) => Promise<unknown>
        }
      }
    }
  }
  w.window ??= {}
  w.window.path ??= { sep: '/', dirname: (p: string) => p }
  w.window.electron ??= {
    clipboard: { writeText: () => {} },
    ipcRenderer: { send: () => {}, on: () => {}, invoke: () => Promise.resolve(true) }
  }
})

vi.mock('@/services/notification', () => ({
  default: { notify: vi.fn(), name: 'notify' }
}))

import { useEditorStore } from '@/store/editor'

// P2（按键路径瘦身）——两处 store 侧的证据：
//
// 1) 引擎自写标记：editor.vue 的左右双开同步 watch 原先每按一次键都要
//    `getMarkdown()` 整篇序列化一次再比字符串（`json-change` 已经序列化过一次）。
//    现在引擎侧写完 store 后打一个「这份 markdown 是我写的」标记，watch 命中即
//    跳过。这里钉住：引擎写完能命中、规整口径一致、别的来源（源码模式/右栏）不命中。
//
// 2) PUSH_TAB_DERIVED_STATS：字数/TOC 从每键同步改为防抖到空闲后单独推送，语义
//    与原来 `LISTEN_FOR_CONTENT_CHANGE` 里的分支一致（只认当前标签的 TOC、
//    equal 短路）。

const seedTab = (over: Record<string, unknown> = {}) => ({
  id: 'tab-1',
  filename: 'a.md',
  // pathname 留空：不进自动保存分支（`HANDLE_AUTO_SAVE` 需要 pathname），
  // 本组用例只验证标记与派生量。
  pathname: '',
  markdown: 'hello',
  isSaved: false,
  encoding: { encoding: 'utf8', isBom: false },
  lineEnding: 'lf',
  adjustLineEndingOnSave: false,
  trimTrailingNewline: 2,
  cursor: null,
  wordCount: { word: 0, paragraph: 0, character: 0, all: 0 },
  muyaIndexCursor: null,
  scrollTop: 0,
  notifications: [],
  history: { stack: [], index: 0, lastEditIndex: -1, lastInitIndex: -1 },
  ...over
})

const seedStore = (tabOver: Record<string, unknown> = {}) => {
  const store = useEditorStore()
  const tab = seedTab(tabOver)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  store.tabs = [tab as any]
  store.currentFile = tab as never
  store.updateTabIdToIndex()
  return { store, tab }
}

describe('editor store — engine own-write marker (P2 key path)', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
  })

  it('marks the engine write so the sync watch can skip re-serializing the document', () => {
    const { store, tab } = seedStore()

    // 引擎侧（editor.vue 的 json-change）带 `fromEngine` 走内容变更管线。
    store.LISTEN_FOR_CONTENT_CHANGE({ id: tab.id, markdown: 'hello world\n', fromEngine: true })

    expect(store.tabs[0]!.markdown).toBe('hello world\n')
    // watch 的判定：store 里这份就是引擎自己写的 → 直接跳过（0 次 getMarkdown）。
    expect(store.IS_ENGINE_OWN_WRITE(tab.id, store.tabs[0]!.markdown)).toBe(true)
  })

  it('normalizes trailing newlines exactly like the content pipeline (opt=0 file)', () => {
    const { store, tab } = seedStore({ trimTrailingNewline: 0 })

    store.LISTEN_FOR_CONTENT_CHANGE({
      id: tab.id,
      markdown: 'no trailing newline\n\n',
      fromEngine: true
    })

    // 管线把末尾换行规整掉了；标记记的是同一个规整值（写在 `tab.markdown` 赋值
    // 之后），否则 opt=0/1 的文件上标记永远不命中、watch 又退回每键一次全量序列化。
    expect(store.tabs[0]!.markdown).toBe('no trailing newline')
    expect(store.IS_ENGINE_OWN_WRITE(tab.id, 'no trailing newline')).toBe(true)
  })

  it('does not mark writes coming from other sources (source mode / right panel)', () => {
    const { store, tab } = seedStore()

    // 源码模式 / 右栏 docMode 走同一个内容管线但不带 `fromEngine`。
    store.LISTEN_FOR_CONTENT_CHANGE({ id: tab.id, markdown: 'panel edit\n' })

    expect(store.tabs[0]!.markdown).toBe('panel edit\n')
    // 未命中 → watch 仍做字符串兜底比较 / setContent，右栏的编辑照旧同步进左引擎。
    expect(store.IS_ENGINE_OWN_WRITE(tab.id, store.tabs[0]!.markdown)).toBe(false)
  })

  it('does not let a stale mark swallow a later external write', () => {
    const { store, tab } = seedStore()

    store.LISTEN_FOR_CONTENT_CHANGE({
      id: tab.id,
      markdown: 'engine version\n',
      fromEngine: true
    })
    expect(store.IS_ENGINE_OWN_WRITE(tab.id, tab.markdown)).toBe(true)

    // 右栏随后改成了别的内容 → 标记不再命中。
    store.LISTEN_FOR_CONTENT_CHANGE({ id: tab.id, markdown: 'right panel version\n' })
    expect(store.IS_ENGINE_OWN_WRITE(tab.id, store.tabs[0]!.markdown)).toBe(false)
  })

  it('drops the mark when the tab closes (no unbounded growth over a session)', () => {
    const { store, tab } = seedStore()

    store.LISTEN_FOR_CONTENT_CHANGE({ id: tab.id, markdown: 'x', fromEngine: true })
    store.FORCE_CLOSE_TAB(store.tabs[0]!)

    expect(store.IS_ENGINE_OWN_WRITE(tab.id, 'x')).toBe(false)
  })
})

describe('editor store — PUSH_TAB_DERIVED_STATS (deferred word count / TOC)', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
  })

  const toc = [
    { lvl: 1, content: 'Title', slug: 'uid-1', githubSlug: 'title' },
    { lvl: 2, content: 'Sub', slug: 'uid-2', githubSlug: 'sub' }
  ]

  it('stores the word count and the TOC of the current tab', () => {
    const { store, tab } = seedStore()
    const wordCount = { word: 12, paragraph: 3, character: 40, all: 48 }

    store.PUSH_TAB_DERIVED_STATS({ id: tab.id, wordCount, toc })

    expect(store.tabs[0]!.wordCount).toEqual(wordCount)
    expect(store.listToc).toEqual(toc)
    // `listToTree` 把 `content` 搬到 `label` 上，并按 `lvl` 嵌套（lvl 2 挂在 lvl 1 下）。
    expect(store.toc.map((node) => node.label)).toEqual(['Title'])
    expect(store.toc[0]!.children.map((node) => node.label)).toEqual(['Sub'])
  })

  it('ignores the TOC of a tab that is no longer current, but still counts its words', () => {
    const { store, tab } = seedStore()
    // 空闲窗口内切了标签：目录属于别的文档，不能顶掉当前文档的大纲。
    store.currentFile = { id: 'other-tab' } as never
    const wordCount = { word: 7, paragraph: 1, character: 30, all: 31 }

    store.PUSH_TAB_DERIVED_STATS({ id: tab.id, wordCount, toc })

    expect(store.tabs[0]!.wordCount).toEqual(wordCount)
    expect(store.listToc).toEqual([])
  })

  it('short-circuits an unchanged TOC (no tree rebuild)', () => {
    const { store, tab } = seedStore()
    store.PUSH_TAB_DERIVED_STATS({ id: tab.id, toc })
    const treeAfterFirst = store.toc

    store.PUSH_TAB_DERIVED_STATS({ id: tab.id, toc: toc.map((item) => ({ ...item })) })

    // equal 短路：内容相同就不重建树（引用不变），与 LISTEN_FOR_CONTENT_CHANGE 同款。
    expect(store.toc).toBe(treeAfterFirst)
  })

  it('ignores an unknown tab id', () => {
    const { store } = seedStore()
    store.PUSH_TAB_DERIVED_STATS({
      id: 'tab-closed',
      wordCount: { word: 99, paragraph: 1, character: 99, all: 99 },
      toc
    })
    expect(store.tabs[0]!.wordCount).toEqual({ word: 0, paragraph: 0, character: 0, all: 0 })
    expect(store.listToc).toEqual([])
  })
})
