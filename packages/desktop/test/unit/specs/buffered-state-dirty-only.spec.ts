import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

// `@/store/editor` transitively imports `@/config`, which reads `window.path.sep`
// at module load (normally injected by the preload bridge), and touches
// `window.electron.*` at runtime. Stub those surfaces before the hoisted imports.
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
import { sendBufferedState } from '@/store/bufferedState'

// P2（全量同步改 dirty 集）：buffer 快照是崩溃恢复用的，已落盘的标签能从磁盘
// 原样重开——把它们的完整 markdown 一起结构化克隆 + IPC 发出去（多标签几十 MB）
// 是纯开销。`CREATE_BUFFERED_STATE()` 现在只发未保存的标签。
//
// 证据分两层：
//   1) 「干净标签的 markdown 一次都没被读过」——用 getter 数读取次数，
//      比只断言输出更强的说法是「连序列化都没发生」。
//   2) 真正走 IPC 的那份载荷（`sendBufferedState` → invoke('update-buffer-state')）
//      里只剩脏标签。

interface SeedTab {
  id: string
  filename: string
  pathname: string
  markdown: string
  isSaved: boolean
}

const seedTab = (over: Partial<SeedTab> = {}): SeedTab => ({
  id: 'tab-1',
  filename: 'a.md',
  pathname: '/tmp/a.md',
  markdown: 'dirty content',
  isSaved: false,
  ...over
})

// 计数 getter：读一次 `markdown` 记一次，用来证明干净标签没有被序列化。
const countedTab = (tab: SeedTab, counter: { reads: number }) => {
  const target: Record<string, unknown> = { ...tab }
  Object.defineProperty(target, 'markdown', {
    enumerable: true,
    configurable: true,
    get() {
      counter.reads++
      return tab.markdown
    }
  })
  return target
}

const seedStore = (tabs: Array<Record<string, unknown>>, currentId: string) => {
  const store = useEditorStore()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  store.tabs = tabs as any
  store.currentFile = tabs.find((t) => t.id === currentId) as never
  store.updateTabIdToIndex()
  return store
}

describe('buffered state — dirty-only snapshot (P2)', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
  })

  it('serializes only unsaved tabs and never reads a saved tab markdown', () => {
    const cleanReads = { reads: 0 }
    const cleanOtherReads = { reads: 0 }
    const store = seedStore(
      [
        countedTab(seedTab({ id: 'dirty', markdown: 'unsaved!' }), { reads: 0 }),
        countedTab(
          seedTab({ id: 'clean', markdown: 'on disk', isSaved: true, pathname: '/tmp/b.md' }),
          cleanReads
        ),
        countedTab(
          seedTab({ id: 'clean-2', markdown: 'on disk 2', isSaved: true, pathname: '/tmp/c.md' }),
          cleanOtherReads
        )
      ],
      'dirty'
    )

    const buffered = store.CREATE_BUFFERED_STATE()

    expect(buffered?.tabs.map((t) => t.id)).toEqual(['dirty'])
    expect(buffered?.tabs[0]?.markdown).toBe('unsaved!')
    // 关键：干净标签的 markdown 一次都没被读过（没序列化，也就没有 IPC 载荷体积）。
    expect(cleanReads.reads).toBe(0)
    expect(cleanOtherReads.reads).toBe(0)
  })

  it('keeps every tab when one is saved after being dirty (already-sent union shrinks)', () => {
    const store = seedStore(
      [
        countedTab(seedTab({ id: 'a', markdown: 'A' }), { reads: 0 }),
        countedTab(seedTab({ id: 'b', markdown: 'B' }), { reads: 0 })
      ],
      'a'
    )
    expect(store.CREATE_BUFFERED_STATE()?.tabs.map((t) => t.id)).toEqual(['a', 'b'])

    store.tabs[0]!.isSaved = true
    expect(store.CREATE_BUFFERED_STATE()?.tabs.map((t) => t.id)).toEqual(['b'])

    store.tabs[1]!.isSaved = true
    // 全部落盘 → 空表，主进程 `tabs.every(isSaved)`（空数组恒真）照旧删掉 buffer
    // 文件，清理启发式不受影响。
    expect(store.CREATE_BUFFERED_STATE()?.tabs).toEqual([])
  })

  it('sends the dirty-only snapshot over the buffer IPC channel', async () => {
    const invokeSpy = vi.spyOn(window.electron.ipcRenderer, 'invoke').mockResolvedValue(true)
    const store = seedStore(
      [
        countedTab(seedTab({ id: 'dirty', markdown: 'unsaved!' }), { reads: 0 }),
        countedTab(
          seedTab({ id: 'clean', markdown: 'on disk', isSaved: true, pathname: '/tmp/b.md' }),
          { reads: 0 }
        )
      ],
      'dirty'
    )

    await sendBufferedState()

    const call = invokeSpy.mock.calls.find((c) => c[0] === 'update-buffer-state')
    expect(call).toBeDefined()
    // `createBufferedState()` 把编辑器快照展开在顶层（主进程按 `buffer.tabs` 读）。
    const payload = call?.[1] as { tabs: Array<{ id: string }> }
    expect(payload.tabs.map((t) => t.id)).toEqual(['dirty'])
    expect(store.tabs).toHaveLength(2)
  })

  it('still restores a FULL snapshot (filter is send-side only)', () => {
    // 读侧（RESTORE_BUFFERED_STATE）拿到的可能是老版本写下的完整快照，或未来
    // 重新启用的恢复链路载荷——绝不能因为「只发脏标签」而丢掉已保存的标签。
    const store = seedStore([], '')
    store.RESTORE_BUFFERED_STATE({
      editor: {
        currentFileId: 'tab-1',
        tabs: [
          seedTab({ id: 'tab-1', markdown: 'saved doc', isSaved: true }),
          seedTab({ id: 'tab-2', markdown: 'other doc', isSaved: true })
        ],
        restoreWarnings: []
      }
    })

    expect(store.tabs.map((t) => t.markdown)).toEqual(['saved doc', 'other doc'])
  })
})
