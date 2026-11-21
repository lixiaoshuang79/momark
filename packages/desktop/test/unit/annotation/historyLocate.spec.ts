import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick } from 'vue'

/**
 * 历史条目定位 + 历史检视的可见性 / 成本（feat/annotation-history-compare 第二轮）：
 * - 点历史条目 → 交给引擎 reveal()；非精确位置、找不到、全局备注、引擎未就绪都有明确提示；
 * - 当前列表的 locate() 对归档条目改走 reveal（不再弹「已在历史中定位」）；
 * - 检视只在历史**真正可见**（历史子视图 + 右栏展开 + 标注 tab）时进行，
 *   切走 tab / 收起右栏即撤掉计时器与在途分片；
 * - 检视分片让出主线程，展开着的轮次优先；比对结果按检视对象记忆。
 */

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
    ipcRenderer: { invoke: vi.fn(async () => undefined), send: () => {}, on: () => {} },
    clipboard: { writeText: () => {} }
  }
})

vi.mock('@/services/notification', () => ({
  default: { notify: vi.fn(), name: 'notify' }
}))
vi.mock('@/store/preferences', () => ({
  usePreferencesStore: () => ({ annotationEnabled: true })
}))
vi.mock('@/store/browserPanel', async () => {
  const { reactive } = await import('vue')
  const panel = reactive({ open: true, activeTab: 'annotation', SET_TAB: () => {} })
  return { useBrowserPanelStore: () => panel, __panel: panel }
})

import notice from '@/services/notification'
import { t } from '@/i18n'
import * as browserPanel from '@/store/browserPanel'
import { useAnnotationStore } from '@/store/annotation'
import type { IAnnotation, IAnnotationInspection, IAnnotationSnapshot } from '@shared/types/ipc'

const panel = (browserPanel as unknown as { __panel: { open: boolean; activeTab: string } }).__panel
const notify = notice.notify as unknown as Mock

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
    headingPath: []
  },
  note: '改一下',
  copied: true,
  round: 1,
  archived: true,
  archivedAt: 100,
  anchorState: 'anchored',
  origin: snap(),
  createdAt: 1,
  updatedAt: 1,
  ...overrides
})

const located = (id: string): IAnnotationInspection => ({
  id,
  match: 'located',
  snapshot: snap({ text: '改了', plain: '改了' }),
  ranges: []
})

interface Harness {
  store: ReturnType<typeof useAnnotationStore>
  inspect: Mock
  reveal: Mock
  clearReveal: Mock
  emit: (event: string) => void
}

async function setup(list: IAnnotation[], extra: Record<string, unknown> = {}): Promise<Harness> {
  const store = useAnnotationStore()
  const listeners = new Map<string, Array<() => void>>()
  const inspect = vi.fn((ids: string[]) => ids.map(located))
  const reveal = vi.fn()
  const clearReveal = vi.fn()
  const engine = {
    annotation: {
      list: () => list,
      getExport: () => [],
      inspect,
      reveal,
      clearReveal,
      setAnnotations: vi.fn(),
      setEnabled: vi.fn(),
      setQuickPhrases: vi.fn(),
      ...extra
    },
    eventCenter: {
      subscribe: (event: string, listener: () => void) => {
        listeners.set(event, [...(listeners.get(event) ?? []), listener])
      },
      off: vi.fn()
    }
  }
  await store.SWITCH_DOC({ pathname: DOC, tabId: 't1' })
  store.docs[DOC]!.annotations = list
  store.attachEngine(engine)
  return {
    store,
    inspect,
    reveal,
    clearReveal,
    emit: (event) => listeners.get(event)?.forEach((listener) => listener())
  }
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  panel.open = true
  panel.activeTab = 'annotation'
})

afterEach(() => {
  vi.useRealTimers()
})

// ═══════════════════════════════════════════════════════════════════
describe('历史条目定位', () => {
  it('命中：交给引擎 reveal（平滑滚动），不弹提示；卡片短暂标为已定位，「现在」顺带刷新', async () => {
    vi.useFakeTimers()
    const { store, reveal } = await setup([ann('h1')])
    const inspection = located('h1')
    reveal.mockReturnValue({ id: 'h1', status: 'range', inspection })

    expect(store.revealHistory('h1')).toBe('range')

    expect(reveal).toHaveBeenCalledWith('h1', { smooth: true })
    expect(notify).not.toHaveBeenCalled()
    expect(store.historyFocusId).toBe('h1')
    expect(store.historyNow.h1).toBe(inspection)
    vi.advanceTimersByTime(3600)
    expect(store.historyFocusId).toBeNull()
  })

  it.each([
    ['block', 'annotation.locate.block'],
    ['context', 'annotation.locate.context'],
    ['near', 'annotation.locate.near'],
    ['none', 'annotation.locate.none']
  ])('%s：给出对应的明确提示（不静默）', async (status, key) => {
    const { store, reveal } = await setup([ann('h1')])
    reveal.mockReturnValue({ id: 'h1', status, inspection: null })

    expect(store.revealHistory('h1')).toBe(status)
    expect(notify).toHaveBeenCalledTimes(1)
    expect(notify.mock.calls[0]![0]).toMatchObject({ message: t(key) })
    expect(t(key)).not.toBe(key) // 文案真的存在，不是把 key 原样弹给用户
  })

  it('全局备注：不问引擎，直接说明没有正文位置', async () => {
    const { store, reveal } = await setup([ann('g', { global: true })])
    expect(store.revealHistory('g')).toBe('global')
    expect(reveal).not.toHaveBeenCalled()
    expect(notify.mock.calls[0]![0]).toMatchObject({ message: t('annotation.locate.global') })
  })

  it('引擎未就绪 / 旧引擎没有 reveal：提示稍后再试', async () => {
    const { store } = await setup([ann('h1')], { reveal: undefined })
    expect(store.revealHistory('h1')).toBeNull()
    expect(notify.mock.calls[0]![0]).toMatchObject({ message: t('annotation.toast.engineMissing') })
  })

  it('当前列表的 locate() 对归档条目改走 reveal，不再弹「已在历史中定位」', async () => {
    const { store, reveal } = await setup([ann('h1')])
    reveal.mockReturnValue({ id: 'h1', status: 'range', inspection: null })
    store.locate('h1')
    expect(reveal).toHaveBeenCalledTimes(1)
    expect(notify).not.toHaveBeenCalled()
  })

  it('切换文档：收掉正文里的闪烁与卡片的已定位态', async () => {
    const { store, reveal, clearReveal } = await setup([ann('h1')])
    reveal.mockReturnValue({ id: 'h1', status: 'range', inspection: null })
    store.revealHistory('h1')
    await store.SWITCH_DOC({ pathname: '/tmp/docs/另一篇.md', tabId: 't2' })
    await nextTick()
    expect(clearReveal).toHaveBeenCalled()
    expect(store.historyFocusId).toBeNull()
  })
})

// ═══════════════════════════════════════════════════════════════════
describe('历史检视只在真正可见时进行', () => {
  it('停在历史子视图、但右栏切到网页 / 收起：不检视，正文变化也不排计时器', async () => {
    vi.useFakeTimers()
    const { store, inspect, emit } = await setup([ann('h1')])

    panel.activeTab = 'url'
    store.SET_HISTORY_VIEW(true)
    expect(store.historyVisible).toBe(false)
    expect(inspect).not.toHaveBeenCalled()
    emit('json-change')
    vi.advanceTimersByTime(5000)
    expect(inspect).not.toHaveBeenCalled()

    // 回到标注 tab → 立即检视一次
    panel.activeTab = 'annotation'
    await nextTick()
    expect(inspect).toHaveBeenCalledTimes(1)

    // 收起右栏 → 已经排上的刷新也撤掉
    emit('json-change')
    panel.open = false
    await nextTick()
    vi.advanceTimersByTime(5000)
    expect(inspect).toHaveBeenCalledTimes(1)
  })

  it('可见时：正文变化 600ms 后重新检视', async () => {
    vi.useFakeTimers()
    const { store, inspect, emit } = await setup([ann('h1')])
    store.SET_HISTORY_VIEW(true)
    expect(inspect).toHaveBeenCalledTimes(1)
    emit('json-change')
    vi.advanceTimersByTime(599)
    expect(inspect).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(1)
    expect(inspect).toHaveBeenCalledTimes(2)
  })
})

// ═══════════════════════════════════════════════════════════════════
describe('历史检视的成本', () => {
  it('分片让出主线程；中途隐藏历史，剩下的分片不再执行', async () => {
    vi.useFakeTimers()
    let clock = 0
    vi.spyOn(performance, 'now').mockImplementation(() => clock)
    const list = Array.from({ length: 40 }, (_, i) => ann(`h${i}`))
    const { store, inspect } = await setup(list)
    inspect.mockImplementation((ids: string[]) => {
      clock += 5 // 每批 5ms → 一片（12ms 预算）做 3 批
      return ids.map(located)
    })

    store.SET_HISTORY_VIEW(true)
    expect(inspect).toHaveBeenCalledTimes(3)
    expect(Object.keys(store.historyNow)).toHaveLength(12)

    vi.advanceTimersByTime(0)
    expect(inspect).toHaveBeenCalledTimes(6)

    store.SET_HISTORY_VIEW(false)
    vi.runAllTimers()
    expect(inspect).toHaveBeenCalledTimes(6)
  })

  it('展开着的轮次先检视', async () => {
    const list = [
      ann('r1', { round: 1, archivedAt: 100 }),
      ann('r2', { round: 2, archivedAt: 200 }),
      ann('r3', { round: 3, archivedAt: 300 })
    ]
    const { store, inspect } = await setup(list)
    store.SET_HISTORY_OPEN_ROUNDS([1])
    store.SET_HISTORY_VIEW(true)
    const order = inspect.mock.calls.flatMap((call) => call[0] as string[])
    expect(order[0]).toBe('r1')
    expect(order).toHaveLength(3)
  })

  it('引擎返回同一个检视对象时，比对结果直接复用（不重跑 diff）', async () => {
    const list = [ann('h1')]
    const { store, inspect } = await setup(list)
    const fixed = located('h1')
    inspect.mockImplementation(() => [fixed])
    store.SET_HISTORY_VIEW(true)
    const first = store.historyCompareGroups[0]!.items[0]!
    store.refreshHistoryNow()
    const second = store.historyCompareGroups[0]!.items[0]!
    expect(second).toBe(first)
    expect(first.status).toBe('changed')

    inspect.mockImplementation(() => [located('h1')])
    store.refreshHistoryNow()
    expect(store.historyCompareGroups[0]!.items[0]).not.toBe(first)
  })

  it('旧条目（无 origin）的反推快照按锚点记忆：多次刷新是同一个对象', async () => {
    const list = [ann('old', { origin: undefined })]
    const { store } = await setup(list)
    store.SET_HISTORY_VIEW(true)
    const first = store.historyCompareGroups[0]!.items[0]!.origin
    store.refreshHistoryNow()
    expect(first?.legacy).toBe(true)
    expect(store.historyCompareGroups[0]!.items[0]!.origin).toBe(first)
  })
})
