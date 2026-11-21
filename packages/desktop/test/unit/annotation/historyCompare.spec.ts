import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

/**
 * 标注历史对比（feat/annotation-history-compare）：
 * - 落盘 v2 → v3 迁移不丢历史、坏的新字段被兜住；
 * - 复制时补拍快照（ensureOrigins）并记下复制序号 sentIndex；
 * - 历史可见时向引擎要「现在」（inspect），按真实比对函数分出已修改 / 未改动 /
 *   整句改写 / 已删除 / 待比对，每轮摘要与排序正确；
 * - 展示文案（块类型标签、差异压缩）。
 */

const DIRS: string[] = []
const tempDir = (): string => {
  const dir = mkdtempSync(path.join(tmpdir(), 'mt-ann-compare-'))
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

import AnnotationStore, {
  ANNOTATION_FILE_VERSION,
  MAX_HISTORY_ROUNDS,
  migrateAnnotationDocument,
  pruneAnnotations
} from 'main_renderer/annotationStore'
import {
  buildHistoryCompare,
  compareHistoryItem,
  sortRoundItems,
  useAnnotationStore
} from '@/store/annotation'
import { compactDiff, snapshotKindLabel } from '@/components/browserPanel/annotationHistoryFormat'
import type {
  AnnotationDocument,
  IAnnotation,
  IAnnotationInspection,
  IAnnotationSnapshot
} from '@shared/types/ipc'

const DOC = '/tmp/docs/样本文档.md'

const snap = (overrides: Partial<IAnnotationSnapshot> = {}): IAnnotationSnapshot => ({
  kind: 'paragraph',
  trail: ['paragraph'],
  markdown: '本版本把首次启动的引导压缩为三步，**不再强制登录**。',
  markStart: 17,
  markEnd: 27,
  text: '**不再强制登录**',
  plain: '不再强制登录',
  capturedAt: 1,
  ...overrides
})

const ann = (id: string, overrides: Partial<IAnnotation> = {}): IAnnotation => ({
  id,
  anchor: {
    ranges: [{ blockPath: [2, 'text'], blockName: 'paragraph.content', start: 17, end: 27 }],
    quote: '**不再强制登录**',
    prefix: '本版本把首次启动的引导压缩为三步，',
    suffix: '。',
    blockText: '本版本把首次启动的引导压缩为三步，**不再强制登录**。',
    beforeBlockText: '',
    afterBlockText: '',
    blockPath: [2, 'text'],
    headingPath: ['星野阅读器', '1. 登录与引导']
  },
  note: '改一下',
  copied: true,
  round: 1,
  sentQuote: '**不再强制登录**',
  archived: true,
  archivedAt: 100,
  anchorState: 'anchored',
  createdAt: 1,
  updatedAt: 1,
  ...overrides
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

// ═══════════════════════════════════════════════════════════════════
describe('落盘版本 v2 → v3', () => {
  it('版本号抬到 3；v2 条目逐字段原样保留（纯加法迁移）', () => {
    const legacy = [ann('a'), ann('b', { global: true }), ann('c', { anchorState: 'orphaned' })]
    const migrated = migrateAnnotationDocument(
      { version: 2, pathname: DOC, round: 3, annotations: legacy } as AnnotationDocument,
      DOC
    )
    expect(ANNOTATION_FILE_VERSION).toBe(3)
    expect(migrated.version).toBe(3)
    expect(migrated.round).toBe(3)
    expect(migrated.annotations).toEqual(legacy)
  })

  it('坏的 origin / sentIndex 被摘掉，条目本身保留', () => {
    const migrated = migrateAnnotationDocument(
      {
        version: 3,
        pathname: DOC,
        round: 2,
        annotations: [
          ann('bad', {
            origin: { kind: 'paragraph' } as unknown as IAnnotationSnapshot,
            sentIndex: -1
          }),
          ann('good', { origin: snap(), sentIndex: 2 })
        ]
      } as AnnotationDocument,
      DOC
    )
    const [bad, good] = migrated.annotations
    expect(bad!.id).toBe('bad')
    expect(bad!.origin).toBeUndefined()
    expect(bad!.sentIndex).toBeUndefined()
    expect(good!.origin).toEqual(snap())
    expect(good!.sentIndex).toBe(2)
  })

  it('从盘上读 v2 文件 → 历史一条不少；再保存写成 v3 且带上新字段', () => {
    const file = realStore.fileForPath(DOC)!
    const legacy = Array.from({ length: 12 }, (_, i) =>
      ann(`r${i}`, { round: (i % 3) + 1, archivedAt: i })
    )
    writeFileSync(
      file,
      JSON.stringify({ version: 2, pathname: DOC, round: 4, annotations: legacy }),
      'utf8'
    )

    const loaded = realStore.load(DOC)
    expect(loaded.version).toBe(3)
    expect(loaded.annotations).toHaveLength(12)

    const next = loaded.annotations.map((a, i) =>
      i === 0 ? { ...a, origin: snap(), sentIndex: 1 } : a
    )
    realStore.save({ pathname: DOC, round: 4, annotations: next })
    const raw = JSON.parse(readFileSync(file, 'utf8')) as AnnotationDocument
    expect(raw.version).toBe(3)
    expect(raw.annotations).toHaveLength(12)
    expect(raw.annotations[0]!.origin).toEqual(snap())
    expect(raw.annotations[0]!.sentIndex).toBe(1)
  })

  it('一次不带 origin 的保存不会抹掉盘上的快照（条目级合并补字段）', () => {
    realStore.save({ pathname: DOC, round: 2, annotations: [ann('a', { origin: snap() })] })
    const { origin: _drop, ...withoutOrigin } = ann('a', { note: '改过备注' })
    realStore.save({ pathname: DOC, round: 2, annotations: [withoutOrigin as IAnnotation] })
    const loaded = realStore.load(DOC)
    expect(loaded.annotations[0]!.note).toBe('改过备注')
    expect(loaded.annotations[0]!.origin).toEqual(snap())
  })

  it('容量上限不变：带快照的历史仍按 20 轮修剪', () => {
    const many = Array.from({ length: MAX_HISTORY_ROUNDS + 3 }, (_, i) =>
      ann(`h${i}`, { round: i + 1, archivedAt: i, origin: snap() })
    )
    const kept = pruneAnnotations(many)
    expect(kept).toHaveLength(MAX_HISTORY_ROUNDS)
    expect(kept.map((a) => a.round)).not.toContain(1)
  })
})

// ═══════════════════════════════════════════════════════════════════
describe('复制：补拍快照 + 记录复制序号', () => {
  it('先 ensureOrigins，再按导出顺序写 sentIndex', async () => {
    const store = useAnnotationStore()
    const pending = [
      ann('x', { copied: false, archived: false, round: undefined, sentQuote: undefined }),
      ann('y', { copied: false, archived: false, round: undefined, sentQuote: undefined })
    ]
    const calls: string[] = []
    const engine = {
      annotation: {
        list: () => pending,
        ensureOrigins: vi.fn(() => {
          calls.push('ensureOrigins')
          return 0
        }),
        // 文档顺序：y 在前
        getExport: vi.fn(() => {
          calls.push('getExport')
          return [pending[1]!, pending[0]!].map((a, index) => ({
            id: a.id,
            index: index + 1,
            headingPath: [],
            quote: a.anchor.quote,
            blockText: a.anchor.blockText,
            note: a.note,
            orphaned: false,
            fragment: false,
            global: false
          }))
        }),
        setAnnotations: vi.fn(),
        setEnabled: vi.fn(),
        setQuickPhrases: vi.fn()
      },
      eventCenter: { subscribe: vi.fn(), off: vi.fn() }
    }

    await store.SWITCH_DOC({ pathname: DOC, tabId: 't1' })
    store.docs[DOC]!.annotations = pending
    store.attachEngine(engine)

    expect(await store.copyAll()).toBe(true)
    expect(calls.slice(0, 2)).toEqual(['ensureOrigins', 'getExport'])
    expect(engine.annotation.ensureOrigins).toHaveBeenCalledWith(['x', 'y'])
    const byId = Object.fromEntries(store.annotations.map((a) => [a.id, a]))
    expect(byId.y!.sentIndex).toBe(1)
    expect(byId.x!.sentIndex).toBe(2)
    expect(byId.x!.archived).toBe(true)
    expect(byId.x!.round).toBe(1)
  })
})

// ═══════════════════════════════════════════════════════════════════
describe('历史对比视图模型', () => {
  const located = (id: string, now: IAnnotationSnapshot): IAnnotationInspection => ({
    id,
    match: 'located',
    snapshot: now
  })

  it('五种状态：已修改（文字 / 格式 / 块）、未改动、整句改写、已删除、待比对', () => {
    const origin = snap()
    const cases: Array<[IAnnotationInspection | undefined, string]> = [
      [located('a', snap()), 'unchanged'],
      [located('a', snap({ text: '不再强制登录', plain: '不再强制登录' })), 'changed'],
      [located('a', snap({ text: '**取消强制登录**', plain: '取消强制登录' })), 'changed'],
      [{ id: 'a', match: 'block', snapshot: snap({ markStart: -1, markEnd: -1 }) }, 'rewritten'],
      [{ id: 'a', match: 'missing', snapshot: null }, 'deleted'],
      [undefined, 'pending']
    ]
    for (const [inspection, status] of cases) {
      expect(compareHistoryItem(ann('a', { origin }), inspection).status).toBe(status)
    }

    const format = compareHistoryItem(
      ann('a', { origin }),
      located('a', snap({ text: '不再强制登录', plain: '不再强制登录' }))
    )
    expect(format.comparison).toMatchObject({ format: true, text: false })

    const block = compareHistoryItem(
      ann('a', { origin: snap({ kind: 'heading', trail: ['atx-heading'], level: 2 }) }),
      located('a', snap({ kind: 'heading', trail: ['atx-heading'], level: 3 }))
    )
    expect(block.comparison).toMatchObject({ status: 'changed', block: true })

    const text = compareHistoryItem(
      ann('a', { origin }),
      located('a', snap({ text: '**取消强制登录**', plain: '取消强制登录' }))
    )
    expect(text.comparison!.diff!.some((s) => s.op === 1 && s.text.includes('取消'))).toBe(true)
  })

  it('段落还在、这一句被删：判删除，但带回所在段落做语境', () => {
    const paragraph = snap({ markdown: '剩下的段落。', markStart: -1, markEnd: -1 })
    const item = compareHistoryItem(ann('d', { origin: snap() }), {
      id: 'd',
      match: 'missing',
      snapshot: paragraph
    })
    expect(item.status).toBe('deleted')
    expect(item.now).toEqual(paragraph)
  })

  it('v2 旧条目（无 origin）按锚点反推「标注时」，仍可比对', () => {
    const item = compareHistoryItem(ann('old'), located('old', snap()))
    expect(item.origin?.legacy).toBe(true)
    expect(item.origin?.markdown).toContain('**不再强制登录**')
    expect(item.status).toBe('unchanged')
  })

  it('全局备注单列，不参与比对', () => {
    expect(compareHistoryItem(ann('g', { global: true }), undefined).status).toBe('global')
  })

  it('每轮按复制序号排序、摘要计数正确', () => {
    const groups = buildHistoryCompare(
      [
        {
          round: 2,
          at: 10,
          items: [
            ann('late', { sentIndex: 3, origin: snap() }),
            ann('first', { sentIndex: 1, origin: snap() }),
            ann('noindex', { origin: snap(), createdAt: 0 }),
            ann('gone', { sentIndex: 2, origin: snap() })
          ]
        }
      ],
      {
        late: located('late', snap()),
        first: located('first', snap({ text: 'x', plain: 'x' })),
        noindex: located('noindex', snap()),
        gone: { id: 'gone', match: 'missing', snapshot: null }
      }
    )
    const [group] = groups
    expect(group!.items.map((i) => i.annotation.id)).toEqual(['first', 'gone', 'late', 'noindex'])
    expect(group!.summary).toMatchObject({ changed: 1, deleted: 1, unchanged: 2 })
    expect(sortRoundItems([]).length).toBe(0)
  })

  it('历史可见时向引擎要「现在」：只问归档的非全局条目，结果进 historyCompareGroups', async () => {
    const store = useAnnotationStore()
    const list = [
      ann('h1', { origin: snap() }),
      ann('h2', { origin: snap(), global: true }),
      ann('live', { archived: false, copied: false })
    ]
    const inspect = vi.fn((ids: string[]) =>
      ids.map((id) => located(id, snap({ text: '改了', plain: '改了' })))
    )
    const engine = {
      annotation: {
        list: () => list,
        getExport: () => [],
        inspect,
        setAnnotations: vi.fn(),
        setEnabled: vi.fn(),
        setQuickPhrases: vi.fn()
      },
      eventCenter: { subscribe: vi.fn(), off: vi.fn() }
    }
    await store.SWITCH_DOC({ pathname: DOC, tabId: 't1' })
    store.docs[DOC]!.annotations = list
    store.attachEngine(engine)

    // 不可见时不检视
    expect(inspect).not.toHaveBeenCalled()
    store.SET_HISTORY_VISIBLE(true)
    expect(inspect).toHaveBeenCalledWith(['h1'])

    const items = store.historyCompareGroups.flatMap((g) => g.items)
    expect(items.find((i) => i.annotation.id === 'h1')!.status).toBe('changed')
    expect(items.find((i) => i.annotation.id === 'h2')!.status).toBe('global')

    store.SET_HISTORY_VISIBLE(false)
  })

  it('引擎没挂载 → 待比对（面板仍能显示标注时的样子）', async () => {
    const store = useAnnotationStore()
    await store.SWITCH_DOC({ pathname: DOC, tabId: 't1' })
    store.docs[DOC]!.annotations = [ann('h1', { origin: snap() })]
    store.SET_HISTORY_VISIBLE(true)
    const [item] = store.historyCompareGroups[0]!.items
    expect(item!.status).toBe('pending')
    expect(item!.origin).toEqual(snap())
    store.SET_HISTORY_VISIBLE(false)
  })
})

// ═══════════════════════════════════════════════════════════════════
describe('展示文案', () => {
  it('块类型标签', () => {
    expect(snapshotKindLabel(snap({ kind: 'heading', trail: ['atx-heading'], level: 2 }))).toBe(
      'Heading H2'
    )
    expect(
      snapshotKindLabel(snap({ kind: 'list', trail: ['order-list', 'list-item', 'paragraph'] }))
    ).toBe('Numbered list')
    expect(
      snapshotKindLabel(
        snap({ kind: 'list', trail: ['block-quote', 'bullet-list', 'list-item', 'paragraph'] })
      )
    ).toBe('Quote › List')
    expect(
      snapshotKindLabel(
        snap({
          kind: 'table',
          trail: ['table', 'table.row', 'table.cell'],
          cell: { row: 2, col: 1 }
        })
      )
    ).toBe('Table · row 2')
    expect(snapshotKindLabel(snap({ kind: 'code', trail: ['code-block'], lang: 'ts' }))).toBe(
      'Code block · ts'
    )
    // v2 反推的段落：容器未知，不出标签；强制时给「段落」
    expect(snapshotKindLabel(snap({ legacy: true }))).toBe('')
    expect(snapshotKindLabel(snap({ legacy: true }), true)).toBe('Paragraph')
    expect(snapshotKindLabel(null)).toBe('')
  })

  it('差异压缩：长的相同片段只留贴近改动的头尾', () => {
    const long = '一'.repeat(60)
    const out = compactDiff([
      { op: 0, text: long },
      { op: -1, text: '旧' },
      { op: 1, text: '新' },
      { op: 0, text: long }
    ])
    expect(out[0]!.text.startsWith('…')).toBe(true)
    expect(out[3]!.text.endsWith('…')).toBe(true)
    expect(out[1]).toEqual({ op: -1, text: '旧' })
    expect(compactDiff([{ op: 0, text: 'same' }])).toEqual([])
    expect(compactDiff(null)).toEqual([])
  })
})
