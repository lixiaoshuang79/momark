import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick } from 'vue'

/**
 * 外部批量改动后自动切到历史那一轮（feat/annotation-history-compare 第三轮）：
 * - 判定（纯函数）：候选轮次、指纹、阈值、多轮取舍；
 * - store：外部重载前记基线 → 停 1.2s 再评估 → 达标且用户空下来才切右栏；
 *   连续保存合并、累计判定、同会话不重复切、后台文档切回来补评估、偏好关闭、
 *   返回 / 不再自动切换。
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
vi.mock('@/store/preferences', async () => {
  const { reactive } = await import('vue')
  const prefs = reactive({
    annotationEnabled: true,
    annotationAutoHistory: true as boolean,
    annotationQuickPhrases: [] as string[],
    SET_SINGLE_PREFERENCE: (payload: { type: string; value: unknown }) => {
      ;(prefs as Record<string, unknown>)[payload.type] = payload.value
    }
  })
  return { usePreferencesStore: () => prefs, __prefs: prefs }
})
vi.mock('@/store/browserPanel', async () => {
  const { reactive } = await import('vue')
  const panel = reactive({
    open: false,
    activeTab: 'url' as string,
    mode: 'url' as string,
    SET_TAB: (tab: string) => {
      if (tab === 'annotation') {
        panel.open = true
        panel.activeTab = 'annotation'
        return
      }
      panel.activeTab = tab
      panel.mode = tab
    },
    SET_OPEN: (value: boolean) => {
      panel.open = value
    }
  })
  return { useBrowserPanelStore: () => panel, __panel: panel }
})

import notice from '@/services/notification'
import { t } from '@/i18n'
import * as browserPanel from '@/store/browserPanel'
import * as preferences from '@/store/preferences'
import { useAnnotationStore } from '@/store/annotation'
import {
  AUTO_HISTORY_MAX_ITEMS,
  decideAutoHistory,
  inspectionFingerprint,
  isAffected,
  isBatch,
  pickCandidateRounds,
  type AutoHistoryItemInput
} from '@/store/annotationAutoHistory'
import type { IAnnotation, IAnnotationInspection, IAnnotationSnapshot } from '@shared/types/ipc'

const panel = (
  browserPanel as unknown as {
    __panel: { open: boolean; activeTab: string; mode: string }
  }
).__panel
const prefs = (
  preferences as unknown as {
    __prefs: { annotationAutoHistory: boolean; annotationEnabled: boolean }
  }
).__prefs
const notify = notice.notify as unknown as Mock

const DOC = '/tmp/docs/样本文档.md'
const OTHER = '/tmp/docs/另一篇.md'

const snap = (overrides: Partial<IAnnotationSnapshot> = {}): IAnnotationSnapshot => ({
  kind: 'paragraph',
  trail: ['paragraph'],
  markdown: '本版本把首次启动的引导压缩为三步，不再强制登录。',
  markStart: 17,
  markEnd: 23,
  text: '不再强制登录',
  plain: '不再强制登录',
  capturedAt: 1,
  ...overrides
})

const ann = (id: string, overrides: Partial<IAnnotation> = {}): IAnnotation => ({
  id,
  anchor: {
    ranges: [{ blockPath: [2, 'text'], blockName: 'paragraph.content', start: 17, end: 23 }],
    quote: '不再强制登录',
    prefix: '本版本把首次启动的引导压缩为三步，',
    suffix: '。',
    blockText: '本版本把首次启动的引导压缩为三步，不再强制登录。',
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

/** 引擎侧「现在」：未改 / 改字 / 删除 / 仅位置变化。 */
type NowState = 'same' | 'edited' | 'edited2' | 'deleted' | 'moved'
const nowOf = (id: string, state: NowState): IAnnotationInspection => {
  switch (state) {
    case 'same':
      return { id, match: 'located', snapshot: snap(), ranges: [] }
    case 'moved':
      // 前面插了段落：块路径变了，但样子没变
      return { id, match: 'located', snapshot: snap(), ranges: [], blockPath: [40, 'text'] }
    case 'edited':
      return {
        id,
        match: 'located',
        snapshot: snap({
          markdown: '本版本把首次启动的引导压缩为三步，默认不登录。',
          markEnd: 22,
          text: '默认不登录',
          plain: '默认不登录'
        }),
        ranges: []
      }
    case 'edited2':
      return {
        id,
        match: 'located',
        snapshot: snap({
          markdown: '本版本把首次启动的引导压缩为三步，可以不登录。',
          markEnd: 22,
          text: '可以不登录',
          plain: '可以不登录'
        }),
        ranges: []
      }
    case 'deleted':
      return { id, match: 'missing', snapshot: null, ranges: [] }
  }
}

interface Harness {
  store: ReturnType<typeof useAnnotationStore>
  inspect: Mock
  /** 引擎里每条标注「现在」的状态（模拟正文内容）。 */
  doc: Record<string, NowState>
  emit: (event: string) => void
}

async function setup(list: IAnnotation[]): Promise<Harness> {
  const store = useAnnotationStore()
  const listeners = new Map<string, Array<() => void>>()
  const doc: Record<string, NowState> = {}
  for (const a of list) doc[a.id] = 'same'
  const inspect = vi.fn((ids: string[]) => ids.map((id) => nowOf(id, doc[id] ?? 'same')))
  const engine = {
    annotation: {
      list: () => list,
      getExport: () => [],
      inspect,
      reveal: vi.fn(),
      clearReveal: vi.fn(),
      setAnnotations: vi.fn(),
      setEnabled: vi.fn(),
      setQuickPhrases: vi.fn()
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
  inspect.mockClear()
  return {
    store,
    inspect,
    doc,
    emit: (event) => listeners.get(event)?.forEach((listener) => listener())
  }
}

/** 模拟一次外部重载：先告知（基线），再把正文换成新内容。 */
function externalReload(h: Harness, next: Record<string, NowState>, path = DOC): void {
  h.store.NOTE_EXTERNAL_RELOAD(path)
  Object.assign(h.doc, next)
}

const round = (n: number, ids: string[], extra: Partial<IAnnotation> = {}): IAnnotation[] =>
  ids.map((id) => ann(id, { round: n, archivedAt: n * 100, ...extra }))

let hasFocus: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  vi.useFakeTimers()
  panel.open = false
  panel.activeTab = 'url'
  panel.mode = 'url'
  prefs.annotationAutoHistory = true
  prefs.annotationEnabled = true
  hasFocus = vi.spyOn(document, 'hasFocus').mockReturnValue(true)
})

afterEach(() => {
  hasFocus.mockRestore()
  vi.useRealTimers()
})

// ═══════════════════════════════════════════════════════════════════
describe('判定（纯函数）', () => {
  const item = (
    id: string,
    status: AutoHistoryItemInput['status'],
    before: string | undefined,
    after = 'x'
  ): AutoHistoryItemInput => ({ id, status, before, after })

  it('指纹只看「现在的样子」：整体下移不算改动，改字 / 删除算', () => {
    const same = inspectionFingerprint(nowOf('a', 'same'))
    expect(inspectionFingerprint(nowOf('a', 'moved'))).toBe(same)
    expect(inspectionFingerprint(nowOf('a', 'edited'))).not.toBe(same)
    expect(inspectionFingerprint(nowOf('a', 'deleted'))).not.toBe(same)
    expect(inspectionFingerprint(undefined)).toBe('')
  })

  it('候选轮次：跳过第 0 组与全局备注，最多 3 轮，最近一轮总是完整纳入', () => {
    const g = (n: number, count: number, extra: Partial<IAnnotation> = {}) => ({
      round: n,
      items: Array.from({ length: count }, (_, i) => ann(`r${n}-${i}`, { round: n, ...extra }))
    })
    expect(pickCandidateRounds([g(5, 2), g(4, 1), g(3, 1), g(2, 1)]).map((r) => r.round)).toEqual([
      5, 4, 3
    ])
    expect(pickCandidateRounds([g(2, 1), g(0, 3)]).map((r) => r.round)).toEqual([2])
    // 只有全局备注的轮次不参与；其余轮次里的全局备注被剔除
    const mixed = { round: 3, items: [ann('g', { global: true }), ann('a', { round: 3 })] }
    expect(pickCandidateRounds([g(4, 1, { global: true }), mixed])).toEqual([
      { round: 3, items: [mixed.items[1]] }
    ])
    // 条数上限：最近一轮超过上限也整轮纳入，更早的轮次凑不进就停
    const big = g(9, AUTO_HISTORY_MAX_ITEMS + 5)
    expect(pickCandidateRounds([big, g(8, 1)]).map((r) => r.round)).toEqual([9])
    expect(
      pickCandidateRounds([g(9, AUTO_HISTORY_MAX_ITEMS - 1), g(8, 2)]).map((r) => r.round)
    ).toEqual([9])
  })

  it('isAffected：改字 / 整句改写 / 删除算；未改动、仅上下文、待比对不算；有基线时指纹相同不算', () => {
    expect(isAffected(item('a', 'changed', 'old', 'new'))).toBe(true)
    expect(isAffected(item('a', 'rewritten', 'old', 'new'))).toBe(true)
    expect(isAffected(item('a', 'deleted', 'old', 'new'))).toBe(true)
    expect(isAffected(item('a', 'unchanged', 'old', 'new'))).toBe(false)
    expect(isAffected(item('a', 'pending', undefined))).toBe(false)
    expect(isAffected(item('a', 'changed', 'same', 'same'))).toBe(false)
    // 没有基线：按「标注时 vs 现在」兜底
    expect(isAffected(item('a', 'changed', undefined))).toBe(true)
  })

  it('isBatch：≥ 2 条；或这一轮只有 1–2 条且改了 1 条', () => {
    expect(isBatch(2, 20)).toBe(true)
    expect(isBatch(1, 1)).toBe(true)
    expect(isBatch(1, 2)).toBe(true)
    expect(isBatch(1, 3)).toBe(false)
    expect(isBatch(0, 1)).toBe(false)
  })

  it('一条没变、一条被删的两条轮次：切', () => {
    const decision = decideAutoHistory([
      { round: 1, items: [item('a', 'unchanged', 'x'), item('b', 'deleted', 'x', 'y')] }
    ])
    expect(decision).toMatchObject({
      round: 1,
      counts: { changed: 0, rewritten: 0, deleted: 1 },
      affectedIds: ['b'],
      total: 2
    })
  })

  it('大轮里只改了 1 条：不切；全局备注不计入分母', () => {
    expect(
      decideAutoHistory([
        {
          round: 1,
          items: [
            item('a', 'changed', 'x', 'y'),
            item('b', 'unchanged', 'x'),
            item('c', 'unchanged', 'x')
          ]
        }
      ])
    ).toBeNull()
    expect(
      decideAutoHistory([
        {
          round: 1,
          items: [
            item('a', 'changed', 'x', 'y'),
            item('g1', 'global', 'x'),
            item('g2', 'global', 'x')
          ]
        }
      ])
    ).toMatchObject({ round: 1, total: 1 })
  })

  it('多轮达标：切到改动最多的一轮，同条数取较新的；达标轮次都展开', () => {
    const changed = (id: string): AutoHistoryItemInput => item(id, 'changed', 'x', 'y')
    expect(
      decideAutoHistory([
        { round: 5, items: [changed('a'), changed('b')] },
        { round: 4, items: [changed('c'), changed('d'), changed('e')] },
        { round: 3, items: [item('f', 'unchanged', 'x')] }
      ])
    ).toMatchObject({ round: 4, rounds: [5, 4] })
    expect(
      decideAutoHistory([
        { round: 5, items: [changed('a'), changed('b')] },
        { round: 4, items: [changed('c'), changed('d')] }
      ])
    ).toMatchObject({ round: 5, rounds: [5, 4] })
  })
})

// ═══════════════════════════════════════════════════════════════════
describe('外部重载 → 自动切到历史', () => {
  it('agent 改了一轮里的多处：停 1.2s 后切到标注 → 历史，展开并聚焦这一轮', async () => {
    const h = await setup(round(3, ['a', 'b', 'c', 'd']))
    externalReload(h, { a: 'edited', b: 'deleted' })
    // 基线是在正文替换之前同步检视的
    expect(h.inspect).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(1199)
    expect(panel.activeTab).toBe('url')
    vi.advanceTimersByTime(1)

    expect(panel.open).toBe(true)
    expect(panel.activeTab).toBe('annotation')
    expect(h.store.panelViewRequest).toMatchObject({
      view: 'history',
      expandRounds: [3],
      focusRound: 3
    })
    expect(h.store.autoHistory).toMatchObject({
      key: DOC,
      round: 3,
      counts: { changed: 1, rewritten: 0, deleted: 1 },
      total: 4,
      restorable: true,
      previous: { open: false, annotationsTab: false, mode: 'url', view: 'current' }
    })
    expect(h.store.autoHistory!.affectedIds.sort()).toEqual(['a', 'b'])
    // 检视结果顺手交给历史：切过去不先闪「待比对」
    expect(h.store.historyNow.a?.match).toBe('located')
    expect(h.store.historyNow.b?.match).toBe('missing')
  })

  it('只是整体下移（前面插了段落）：不切', async () => {
    const h = await setup(round(1, ['a', 'b']))
    externalReload(h, { a: 'moved', b: 'moved' })
    vi.advanceTimersByTime(5000)
    expect(panel.activeTab).toBe('url')
    expect(h.store.autoHistory).toBeNull()
  })

  it('早就改过的条目（这次没碰）：不重复算，不切', async () => {
    const list = round(2, ['a', 'b', 'c'])
    const h = await setup(list)
    Object.assign(h.doc, { a: 'edited', b: 'edited' }) // 上一次 agent 改的，用户已经看过
    externalReload(h, { c: 'moved' })
    vi.advanceTimersByTime(5000)
    expect(h.store.autoHistory).toBeNull()
    expect(panel.activeTab).toBe('url')
  })

  it('agent 连续保存：合并成一次评估；基线保持第一次保存之前，逐次累计', async () => {
    const h = await setup(round(1, ['a', 'b', 'c', 'd', 'e']))
    externalReload(h, { a: 'edited' })
    vi.advanceTimersByTime(500)
    externalReload(h, { b: 'edited' })
    vi.advanceTimersByTime(500)
    // 只有第一次重载做了基线检视，中间不评估
    expect(h.inspect).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(1200)
    expect(h.store.autoHistory).toMatchObject({ round: 1, counts: { changed: 2 } })
  })

  it('两次保存隔得较远：第一次只改 1 条不切，第二次累计到 2 条再切', async () => {
    const h = await setup(round(1, ['a', 'b', 'c', 'd', 'e']))
    externalReload(h, { a: 'edited' })
    vi.advanceTimersByTime(5000)
    expect(h.store.autoHistory).toBeNull()
    externalReload(h, { b: 'edited' })
    vi.advanceTimersByTime(1200)
    expect(h.store.autoHistory).toMatchObject({ round: 1, counts: { changed: 2 } })
  })

  it('同一会话不对同一轮切第二次；横幅还在时只更新计数', async () => {
    const h = await setup(round(1, ['a', 'b', 'c', 'd']))
    externalReload(h, { a: 'edited', b: 'edited' })
    vi.advanceTimersByTime(1200)
    const seq = h.store.panelViewRequest!.seq
    // 用户回到网页看资料，agent 又改了一处
    panel.activeTab = 'url'
    externalReload(h, { c: 'deleted' })
    vi.advanceTimersByTime(1200)
    expect(h.store.panelViewRequest!.seq).toBe(seq)
    expect(panel.activeTab).toBe('url')
    expect(h.store.autoHistory).toMatchObject({ counts: { changed: 2, deleted: 1 } })
  })

  it('用户正在打字：等 1.5s 没有按键再切', async () => {
    const h = await setup(round(1, ['a', 'b']))
    externalReload(h, { a: 'edited', b: 'edited' })
    vi.advanceTimersByTime(1000)
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'x' }))
    vi.advanceTimersByTime(200) // 评估完成，但 1.5s 内刚按过键
    expect(panel.activeTab).toBe('url')
    vi.advanceTimersByTime(1000)
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'y' }))
    vi.advanceTimersByTime(1499)
    expect(panel.activeTab).toBe('url')
    vi.advanceTimersByTime(1)
    expect(panel.activeTab).toBe('annotation')
  })

  it('按住鼠标拖选 / 输入法组字中：松开后再等空下来', async () => {
    const h = await setup(round(1, ['a', 'b']))
    externalReload(h, { a: 'edited', b: 'edited' })
    window.dispatchEvent(new Event('pointerdown'))
    vi.advanceTimersByTime(10_000)
    expect(panel.activeTab).toBe('url')
    window.dispatchEvent(new Event('pointerup'))
    window.dispatchEvent(new Event('compositionstart'))
    vi.advanceTimersByTime(10_000)
    expect(panel.activeTab).toBe('url')
    window.dispatchEvent(new Event('compositionend'))
    vi.advanceTimersByTime(1500)
    expect(panel.activeTab).toBe('annotation')
  })

  it('窗口在后台（用户在终端里看 agent）：判定先存着，回到墨记那一刻再切', async () => {
    hasFocus.mockReturnValue(false)
    const h = await setup(round(1, ['a', 'b']))
    externalReload(h, { a: 'edited', b: 'edited' })
    vi.advanceTimersByTime(60_000)
    expect(panel.activeTab).toBe('url')
    hasFocus.mockReturnValue(true)
    window.dispatchEvent(new FocusEvent('focus'))
    expect(panel.activeTab).toBe('annotation')
    expect(h.store.autoHistory?.round).toBe(1)
  })

  it('后台文档被外部修改：当时不检视；切过去后补上评估', async () => {
    const h = await setup(round(1, ['a', 'b']))
    // 另一篇在后台被改（引擎里是当前文档，不能拿它做基线）
    h.store.NOTE_EXTERNAL_RELOAD(OTHER)
    vi.advanceTimersByTime(5000)
    expect(h.inspect).not.toHaveBeenCalled()

    // 切到那篇：它的历史里有两条已被改动（没有基线 → 按标注时 vs 现在）
    const otherList = round(2, ['x', 'y'])
    h.store.docs[OTHER] = { round: 3, annotations: otherList, loaded: true }
    h.doc.x = 'edited'
    h.doc.y = 'deleted'
    await h.store.SWITCH_DOC({ pathname: OTHER, tabId: 't2' })
    vi.advanceTimersByTime(1200)
    expect(h.store.autoHistory).toMatchObject({ key: OTHER, round: 2, total: 2 })
  })

  it('评估完成后不再检视：历史不可见时正文变化不触发检视', async () => {
    const h = await setup(round(1, ['a', 'b', 'c']))
    externalReload(h, { a: 'edited' })
    vi.advanceTimersByTime(1200)
    expect(h.store.autoHistory).toBeNull()
    const calls = h.inspect.mock.calls.length
    h.emit('json-change')
    vi.advanceTimersByTime(60_000)
    expect(h.inspect.mock.calls.length).toBe(calls)
  })

  it('偏好关掉：不检视、不切', async () => {
    prefs.annotationAutoHistory = false
    const h = await setup(round(1, ['a', 'b']))
    externalReload(h, { a: 'edited', b: 'edited' })
    vi.advanceTimersByTime(5000)
    expect(h.inspect).not.toHaveBeenCalled()
    expect(panel.activeTab).toBe('url')
  })

  it('未保存文档 / 第 0 组（没复制就归档）：不参与', async () => {
    const h = await setup(round(0, ['a', 'b']))
    externalReload(h, { a: 'edited', b: 'edited' })
    vi.advanceTimersByTime(5000)
    expect(h.store.autoHistory).toBeNull()
    h.store.NOTE_EXTERNAL_RELOAD('untitled:t9')
    vi.advanceTimersByTime(5000)
    expect(h.store.autoHistory).toBeNull()
  })

  it('评估途中切了文档：作废，不会切到上一篇的历史', async () => {
    const h = await setup(round(1, ['a', 'b']))
    externalReload(h, { a: 'edited', b: 'edited' })
    vi.advanceTimersByTime(600)
    await h.store.SWITCH_DOC({ pathname: OTHER, tabId: 't2' })
    vi.advanceTimersByTime(5000)
    expect(panel.activeTab).toBe('url')
    // 切回来：补上评估并切
    await h.store.SWITCH_DOC({ pathname: DOC, tabId: 't1' })
    h.store.docs[DOC]!.annotations = round(1, ['a', 'b'])
    vi.advanceTimersByTime(1200)
    expect(h.store.autoHistory).toMatchObject({ key: DOC, round: 1 })
  })
})

// ═══════════════════════════════════════════════════════════════════
describe('横幅操作', () => {
  async function switched(): Promise<Harness> {
    const h = await setup(round(1, ['a', 'b']))
    externalReload(h, { a: 'edited', b: 'edited' })
    vi.advanceTimersByTime(1200)
    // 面板组件收到请求后切到历史子视图
    h.store.SET_HISTORY_VIEW(true)
    await nextTick()
    return h
  }

  it('返回：右栏恢复到切换之前（收起 / 网页 tab / 当前子视图）', async () => {
    const h = await switched()
    h.store.RESTORE_AUTO_HISTORY()
    expect(h.store.autoHistory).toBeNull()
    expect(panel.open).toBe(false)
    expect(panel.activeTab).toBe('url')
    expect(h.store.panelViewRequest).toMatchObject({ view: 'current' })
  })

  it('原本就停在「标注 → 历史」：不给「返回」', async () => {
    const h = await setup(round(1, ['a', 'b']))
    panel.open = true
    panel.activeTab = 'annotation'
    h.store.SET_HISTORY_VIEW(true)
    await nextTick()
    externalReload(h, { a: 'edited', b: 'edited' })
    vi.advanceTimersByTime(1200)
    expect(h.store.autoHistory).toMatchObject({ restorable: false })
  })

  it('×：只收起横幅；用户自己离开历史视图也收起', async () => {
    const h = await switched()
    h.store.DISMISS_AUTO_HISTORY()
    expect(h.store.autoHistory).toBeNull()
    expect(panel.activeTab).toBe('annotation')

    const again = await setup(round(1, ['a', 'b']))
    externalReload(again, { a: 'edited', b: 'edited' })
    vi.advanceTimersByTime(1200)
    again.store.SET_HISTORY_VIEW(true)
    await nextTick()
    again.store.SET_HISTORY_VIEW(false)
    await nextTick()
    expect(again.store.autoHistory).toBeNull()
  })

  it('不再自动切换：写偏好并提示在哪里重新打开；之后的外部修改不再切', async () => {
    const h = await switched()
    h.store.DISABLE_AUTO_HISTORY()
    expect(prefs.annotationAutoHistory).toBe(false)
    expect(notify.mock.calls.at(-1)![0]).toMatchObject({
      message: t('annotation.autoHistory.disabled')
    })
    expect(t('annotation.autoHistory.disabled')).not.toBe('annotation.autoHistory.disabled')
    panel.activeTab = 'url'
    externalReload(h, { a: 'deleted', b: 'deleted' })
    vi.advanceTimersByTime(5000)
    expect(panel.activeTab).toBe('url')
  })

  it('横幅与偏好文案都存在（中英）', async () => {
    for (const key of [
      'annotation.autoHistory.banner',
      'annotation.autoHistory.restore',
      'annotation.autoHistory.disable',
      'annotation.autoHistory.fresh',
      'preferences.general.annotation.autoHistory',
      'preferences.general.annotation.autoHistoryNotes'
    ]) {
      expect(t(key)).not.toBe(key)
    }
  })
})
