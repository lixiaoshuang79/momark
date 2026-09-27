import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

// F1（保存/关窗数据安全）渲染层回归：
//   · P0-3 文末 `?` 被当换行删掉（`/[\r?\n]+$/` 字符类误写）
//   · P0-4 保存回执竞态：写盘期间的输入被误判为已保存
// 这两个修复都在 `@/store/editor` 里，且都靠「发送时的内容版本 vs 回执版本」对账。

// `@/store/editor` 在模块加载期读 `window.path`，运行时读 `window.electron` /
// `window.fileUtils`——先铺好这些面。
vi.hoisted(() => {
  const w = globalThis as unknown as {
    window?: Record<string, unknown>
  }
  w.window ??= {}
  const win = w.window as Record<string, unknown>
  win.path ??= { sep: '/', dirname: (p: string) => p }
  win.fileUtils ??= { isSamePathSync: () => false }
  win.electron ??= {
    clipboard: { writeText: () => {} },
    ipcRenderer: { send: () => {}, on: () => {}, invoke: () => Promise.resolve() }
  }
})

vi.mock('@/services/notification', () => ({
  default: { notify: vi.fn(), name: 'notify' }
}))

// 回执处理器会顺手把标注迁到路径 key；这里只关心保存状态，标注侧打桩。
vi.mock('@/store/annotation', () => ({
  useAnnotationStore: () => ({
    ADOPT_PATH: vi.fn(() => Promise.resolve()),
    MIGRATE_PATH: vi.fn(() => Promise.resolve()),
    SWITCH_DOC: vi.fn(() => Promise.resolve()),
    flush: vi.fn(() => Promise.resolve())
  })
}))

import { useEditorStore, adjustTrailingNewlines } from '@/store/editor'
import type { IFileState } from '@shared/types/files'

type Handler = (event: unknown, ...args: unknown[]) => void

// 捕获 store 注册的 IPC 处理器（真实 `window.electron.ipcRenderer.on` 是桩）。
function captureHandlers(store: ReturnType<typeof useEditorStore>): Map<string, Handler> {
  const handlers = new Map<string, Handler>()
  ;(window.electron.ipcRenderer as unknown as { on: (ch: string, fn: Handler) => void }).on = (
    ch: string,
    fn: Handler
  ) => {
    handlers.set(ch, fn)
  }
  store.LISTEN_FOR_SET_PATHNAME()
  return handlers
}

function seedTab(
  store: ReturnType<typeof useEditorStore>,
  overrides: {
    history?: IFileState['history']
    isSaved?: boolean
    pathname?: string
    markdown?: string
  } = {}
): IFileState {
  const tab = {
    id: 'tab-1',
    filename: 'note.md',
    pathname: '/tmp/note.md',
    markdown: 'hello',
    isSaved: false,
    encoding: { encoding: 'utf8', isBom: false },
    lineEnding: 'lf',
    adjustLineEndingOnSave: false,
    trimTrailingNewline: 2,
    history: { stack: [{ id: 1 }, { id: 2 }], index: 1, lastEditIndex: 1, lastInitIndex: 0 },
    ...overrides
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any as IFileState
  store.tabs = [tab]
  store.currentFile = tab
  return tab
}

describe('P0-3 — 文末 `?` 不再被当作换行删除', () => {
  it('opt=0（去掉末尾换行）保留末尾的问号', () => {
    expect(adjustTrailingNewlines('Why?', 0)).toBe('Why?')
    expect(adjustTrailingNewlines('Why?\n', 0)).toBe('Why?')
  })

  it('opt=1（保证单个末尾换行）保留问号——修的就是 `?` + 多个换行这条路径', () => {
    expect(adjustTrailingNewlines('Why?\n\n', 1)).toBe('Why?\n')
    expect(adjustTrailingNewlines('Why?\n', 1)).toBe('Why?\n')
    expect(adjustTrailingNewlines('Why?', 1)).toBe('Why?\n')
  })

  it('换行本身仍然照常裁掉（LF / CRLF 混排）', () => {
    expect(adjustTrailingNewlines('a\n\n\n', 0)).toBe('a')
    expect(adjustTrailingNewlines('a\r\n\r\n', 0)).toBe('a')
    expect(adjustTrailingNewlines('a\n\r\n', 0)).toBe('a')
  })

  it('中间的 `?` 与行尾的 `?` 不受影响', () => {
    expect(adjustTrailingNewlines('Why?\nBecause.\n', 0)).toBe('Why?\nBecause.')
    expect(adjustTrailingNewlines('Explain?\n\n\n', 1)).toBe('Explain?\n')
  })
})

describe('P0-4 — 保存回执按内容版本对账', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
  })

  it('回执版本与当前版本一致 → 置 clean 并记下已保存版本', () => {
    const store = useEditorStore()
    const handlers = captureHandlers(store)
    const tab = seedTab(store)

    handlers.get('mt::tab-saved')!({}, 'tab-1', 2)

    expect(tab.isSaved).toBe(true)
    expect(tab.lastSavedHistoryId).toBe(2)
  })

  it('写盘期间用户又改了内容（回执版本已过期）→ 保持脏，绝不记成已保存', () => {
    const store = useEditorStore()
    const handlers = captureHandlers(store)
    // 发起保存时是版本 1，写盘期间用户敲了一个字 → 现在是版本 2。
    const tab = seedTab(store, {
      history: { stack: [{ id: 1 }, { id: 2 }], index: 1, lastEditIndex: 1, lastInitIndex: 0 }
    })

    handlers.get('mt::tab-saved')!({}, 'tab-1', 1)

    expect(tab.isSaved).toBe(false)
    expect(tab.lastSavedHistoryId).toBeUndefined()
  })

  it('没有版本信息的老回执（重命名等通道）保持原行为', () => {
    const store = useEditorStore()
    const handlers = captureHandlers(store)
    const tab = seedTab(store)

    handlers.get('mt::tab-saved')!({}, 'tab-1', undefined)

    expect(tab.isSaved).toBe(true)
    expect(tab.lastSavedHistoryId).toBe(2)
  })

  it('另存为回执（mt::set-pathname 带版本）同样按版本对账', () => {
    const store = useEditorStore()
    const handlers = captureHandlers(store)
    const tab = seedTab(store, { pathname: '' })

    handlers.get('mt::set-pathname')!(
      {},
      { id: 'tab-1', pathname: '/tmp/new.md', filename: 'new.md', version: 2 }
    )

    expect(tab.pathname).toBe('/tmp/new.md')
    expect(tab.isSaved).toBe(true)
    expect(tab.lastSavedHistoryId).toBe(2)

    // 版本对不上（写盘期间又改了）→ 仍是脏的
    const stale = seedTab(store, { pathname: '/tmp/other.md', isSaved: true })
    handlers.get('mt::set-pathname')!(
      {},
      { id: 'tab-1', pathname: '/tmp/other.md', filename: 'other.md', version: 1 }
    )
    expect(stale.isSaved).toBe(false)
  })

  it('FILE_SAVE 把发起时的内容版本一并发出（主进程原样回传）', () => {
    const store = useEditorStore()
    seedTab(store, {
      history: { stack: [{ id: 7 }, { id: 9 }], index: 1, lastEditIndex: 1, lastInitIndex: 0 }
    })
    const sendSpy = vi.spyOn(window.electron.ipcRenderer, 'send')

    store.FILE_SAVE()

    const call = sendSpy.mock.calls.find((c) => c[0] === 'mt::response-file-save')
    expect(call).toBeDefined()
    // send(channel, id, filename, pathname, markdown, options, defaultPath, version)
    expect(call?.[7]).toBe(9)
  })

  it('没有编辑帧（lastEditIndex = -1）时版本取 -1，仍按旧行为置 clean', () => {
    const store = useEditorStore()
    const handlers = captureHandlers(store)
    const tab = seedTab(store, {
      history: { stack: [{ id: 1 }], index: -1, lastEditIndex: -1, lastInitIndex: 0 }
    })

    handlers.get('mt::tab-saved')!({}, 'tab-1', -1)

    expect(tab.isSaved).toBe(true)
    expect(tab.lastSavedHistoryId).toBeUndefined()
  })
})
