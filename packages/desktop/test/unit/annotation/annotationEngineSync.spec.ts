import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

/**
 * 标注面板「引擎指针残留」回归。
 *
 * 事故链（用户实测：标注后正文有 ①② 角标，右侧面板 0 条，落盘也是空表）：
 * 1. 右栏分屏文档拿到焦点 → annotation store 的 engine 换成右栏 Muya；
 * 2. 分屏还回标签栏：`RETURN_SPLIT_TO_TABS()` **先**把 `docFocused` 置 false，
 *    右栏编辑器卸载时按旧条件跳过了「交还主编辑器」→ store 仍指着即将销毁的
 *    右栏引擎；
 * 3. 之后在左编辑器标注，`annotation-change` 触发 `syncFromEngine()`，按 store
 *    指针读到的是**空表**，面板永远不更新，还把这空表写盘。
 *
 * 两道修复各钉一条：事件附带引擎（syncFromEngine 的 engineHint），以及卸载时
 * 无条件交还（e2e 层验证，不在本 spec）。
 */

const DIRS: string[] = []
const tempDir = (): string => {
  const dir = mkdtempSync(path.join(tmpdir(), 'mt-ann-engine-'))
  DIRS.push(dir)
  return dir
}

vi.hoisted(() => {
  const w = globalThis as unknown as {
    window?: {
      path?: { sep: string; dirname: (p: string) => string }
      electron?: {
        ipcRenderer: {
          invoke: Mock
          send: (...a: unknown[]) => void
          on: (...a: unknown[]) => void
        }
        clipboard: { writeText: (s: string) => void }
      }
    }
  }
  w.window ??= {}
  w.window.path ??= { sep: '/', dirname: (p: string) => p }
  w.window.electron ??= {
    ipcRenderer: { invoke: vi.fn(), send: () => {}, on: () => {} },
    clipboard: { writeText: () => {} }
  }
})

vi.mock('@/services/notification', () => ({
  default: { notify: vi.fn(), name: 'notify' }
}))
vi.mock('@/store/preferences', () => ({
  usePreferencesStore: () => ({ annotationEnabled: true })
}))
vi.mock('@/store/browserPanel', () => ({
  useBrowserPanelStore: () => ({ activeTab: 'annotation', SET_TAB: vi.fn() })
}))

import AnnotationStore from 'main_renderer/annotationStore'
import { useAnnotationStore } from '@/store/annotation'
import type { IAnnotation, IAnnotationAnchor } from '@shared/types/ipc'

const anchor = (quote: string): IAnnotationAnchor => ({
  ranges: [{ blockPath: [0], blockName: 'paragraph.content', start: 0, end: quote.length }],
  quote,
  prefix: '',
  suffix: '',
  blockText: quote,
  beforeBlockText: '',
  afterBlockText: '',
  blockPath: [0],
  headingPath: ['第一章']
})

const ann = (id: string, note: string): IAnnotation => ({
  id,
  anchor: anchor('原文'),
  note,
  copied: false,
  archived: false,
  anchorState: 'anchored',
  createdAt: 1,
  updatedAt: 1
})

const DOC = '/tmp/docs/PRD.md'

/** 一个够用的引擎桩：store 只用到 list / getExport / setAnnotations / setEnabled / setQuickPhrases。 */
const engineWith = (list: IAnnotation[]) => ({
  annotation: {
    list: () => list,
    getExport: () =>
      list
        .filter((a) => !a.archived)
        .map((a, index) => ({
          index: index + 1,
          headingPath: [...a.anchor.headingPath],
          quote: a.anchor.quote,
          blockText: a.anchor.blockText,
          note: a.note,
          orphaned: a.anchorState === 'orphaned',
          fragment: false,
          global: false
        })),
    setAnnotations: vi.fn(),
    setEnabled: vi.fn(),
    setQuickPhrases: vi.fn()
  },
  eventCenter: { subscribe: vi.fn(), unsubscribe: vi.fn(), off: vi.fn(), emit: vi.fn() }
})

let realStore: InstanceType<typeof AnnotationStore>

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  realStore = new AnnotationStore({ annotationStorePath: tempDir() })
  ;(window.electron.ipcRenderer.invoke as Mock).mockImplementation(
    async (channel: string, payload: never) => {
      if (channel === 'mt::annotation::load') return realStore.load(payload)
      if (channel === 'mt::annotation::save') return realStore.save(payload)
      return undefined
    }
  )
})

afterEach(() => {
  for (const dir of DIRS.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('标注 store 的引擎指针', () => {
  it('syncFromEngine 读事件发出方的引擎，不读残留的旧引擎', async () => {
    const store = useAnnotationStore()
    const left = engineWith([ann('a1', '左侧标注')])
    const right = engineWith([])

    await store.SWITCH_DOC({ pathname: DOC, tabId: 't1' })
    store.attachEngine(left)
    // 分屏还回后 store 停在右栏引擎上（事故现场）
    store.attachEngine(right)

    // 旧行为：按 store 指针读到右栏的空表 → 面板 0 条
    store.syncFromEngine()
    expect(store.currentDoc!.annotations).toEqual([])

    // 修复：事件带上了发出方（左编辑器），按它回读
    store.syncFromEngine(left)
    expect(store.currentDoc!.annotations.map((a) => a.id)).toEqual(['a1'])
    expect(store.currentList.map((a) => a.note)).toEqual(['左侧标注'])
  })
})
