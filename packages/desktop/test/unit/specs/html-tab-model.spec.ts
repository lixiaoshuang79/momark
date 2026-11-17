import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

// html 文件作为只读标签进 editorStore.tabs：去重、只读守卫（保存 / 保存全部 /
// 磁盘变更不置脏）、源码不进标签状态、标注脱离与引擎停放（html ↔ md 往返不重装引擎）。

vi.hoisted(() => {
  const w = globalThis as unknown as { window: Record<string, unknown> }
  w.window.path = { sep: '/', dirname: (p: string) => p.slice(0, p.lastIndexOf('/')) || '/' }
  w.window.fileUtils = { isSamePathSync: (a: string, b: string) => !!a && a === b }
  w.window.electron = {
    clipboard: { writeText: () => {} },
    ipcRenderer: { send: vi.fn(), on: vi.fn(), invoke: vi.fn(() => Promise.resolve(null)) }
  }
})

vi.mock('@/services/notification', () => ({ default: { notify: vi.fn(), name: 'notify' } }))
vi.mock('@/store/bufferedState', () => ({
  debouncedSendBufferedState: vi.fn(),
  sendBufferedState: vi.fn()
}))
vi.mock('@/store/preferences', () => ({ usePreferencesStore: () => ({ autoSave: false }) }))
vi.mock('@/store/layout', () => ({
  useLayoutStore: () => ({ SET_LAYOUT: vi.fn(), DISPATCH_LAYOUT_MENU_ITEMS: vi.fn() })
}))
const annotation = vi.hoisted(() => ({
  SWITCH_DOC: vi.fn(),
  DETACH_DOC: vi.fn(),
  flush: vi.fn()
}))
vi.mock('@/store/annotation', () => ({ useAnnotationStore: () => annotation }))
const htmlTabs = vi.hoisted(() => ({
  SET_SOURCE: vi.fn(() => Promise.resolve()),
  RELOAD: vi.fn(),
  DROP: vi.fn()
}))
vi.mock('@/store/htmlTabs', () => ({ useHtmlTabsStore: () => htmlTabs }))

import bus from '@/bus'
import { useEditorStore } from '@/store/editor'
import { createDocumentState, isHtmlTab } from '@/store/help'

const ipc = window.electron.ipcRenderer as unknown as { send: Mock; on: Mock }
const doc = { pathname: '/p/proto.html', filename: 'proto.html', html: '<p>hi</p>' }

const seedMarkdown = (store: ReturnType<typeof useEditorStore>) => {
  const md = createDocumentState({ pathname: '/p/prd.md', filename: 'prd.md', markdown: '# PRD' })
  store.UPDATE_CURRENT_FILE(md)
  return md
}

const fileChanged = () =>
  (bus.emit as unknown as Mock).mock.calls.filter((c) => c[0] === 'file-changed')

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  vi.spyOn(bus, 'emit')
})

describe('NEW_HTML_TAB', () => {
  it('opens a read-only tab whose source stays outside the tab state', () => {
    const store = useEditorStore()
    seedMarkdown(store)
    const id = store.NEW_HTML_TAB({ doc })
    const tab = store.tabs.find((t) => t.id === id)!

    expect(isHtmlTab(tab)).toBe(true)
    expect(tab).toMatchObject({
      pathname: '/p/proto.html',
      filename: 'proto.html',
      isSaved: true,
      markdown: ''
    })
    expect(JSON.stringify(tab)).not.toContain('<p>hi</p>')
    expect(htmlTabs.SET_SOURCE).toHaveBeenCalledWith(id, doc, undefined)
    expect(store.currentFile?.id).toBe(id)
    expect(ipc.send).toHaveBeenCalledWith('mt::window-add-file-path', '/p/proto.html')
  })

  it('switches to the existing tab instead of opening the same file twice', () => {
    const store = useEditorStore()
    const md = seedMarkdown(store)
    const id = store.NEW_HTML_TAB({ doc, selected: false })
    expect(store.currentFile?.id).toBe(md.id)

    expect(store.NEW_HTML_TAB({ doc })).toBe(id)
    expect(store.tabs.filter((t) => isHtmlTab(t))).toHaveLength(1)
    expect(store.currentFile?.id).toBe(id)
  })

  it('block snapshots (no path) always get a new tab, titled by the caller', () => {
    const store = useEditorStore()
    seedMarkdown(store)
    const snap = { pathname: '', filename: '', html: '<p>x</p>' }
    const a = store.NEW_HTML_TAB({ doc: snap, selected: false, title: 'Demo', origin: 'prd.md' })
    const b = store.NEW_HTML_TAB({ doc: snap, selected: false, title: 'Demo', origin: 'prd.md' })
    expect(a).not.toBe(b)
    // 快照标题来自页面 <title>，没有后缀；与同排的 .md 标签对齐，统一补 .html。
    expect(store.tabs.find((t) => t.id === a)?.filename).toBe('Demo.html')
    expect(htmlTabs.SET_SOURCE).toHaveBeenCalledWith(a, snap, 'prd.md')
    expect(ipc.send).not.toHaveBeenCalledWith('mt::window-add-file-path', '')
  })

  it('replaces the blank untitled tab only when the html tab takes focus', () => {
    const store = useEditorStore()
    store.UPDATE_CURRENT_FILE(createDocumentState({ filename: 'Untitled-1' }))
    store.NEW_HTML_TAB({ doc: { ...doc, pathname: '/p/b.html' }, selected: false })
    expect(store.tabs).toHaveLength(2)

    store.NEW_HTML_TAB({ doc })
    expect(store.tabs.some((t) => t.filename === 'Untitled-1')).toBe(false)
  })
})

describe('read-only guards', () => {
  it('save and save-as are no-ops on an html tab', () => {
    const store = useEditorStore()
    store.NEW_HTML_TAB({ doc })
    ipc.send.mockClear()
    store.FILE_SAVE()
    store.FILE_SAVE_AS()
    expect(ipc.send).not.toHaveBeenCalled()
  })

  it('save-all and close-all never ask to save an html tab', () => {
    const store = useEditorStore()
    store.NEW_HTML_TAB({ doc })
    ipc.send.mockClear()
    store.ASK_FOR_SAVE_ALL(true)
    expect(ipc.send).not.toHaveBeenCalledWith('mt::save-and-close-tabs', expect.anything())
    expect(store.tabs).toHaveLength(0)
    expect(htmlTabs.DROP).toHaveBeenCalledTimes(1)
  })

  it('a change on disk shows a reload banner and never marks the tab dirty', () => {
    const store = useEditorStore()
    const id = store.NEW_HTML_TAB({ doc })
    const notify = vi.spyOn(store, 'pushTabNotification').mockImplementation(() => {})
    store.LISTEN_FOR_FILE_CHANGE()
    const handler = ipc.on.mock.calls.find((c) => c[0] === 'mt::update-file')![1]

    handler(null, {
      type: 'change',
      change: { pathname: '/p/proto.html', kind: 'html', mtimeMs: 1 }
    })
    const tab = store.tabs.find((t) => t.id === id)!
    expect(tab.isSaved).toBe(true)
    expect(notify).toHaveBeenCalledTimes(1)
    const banner = notify.mock.calls[0][0] as {
      showConfirm?: boolean
      action?: (ok: boolean) => void
    }
    banner.action?.(true)
    expect(htmlTabs.RELOAD).toHaveBeenCalledWith(id)

    handler(null, { type: 'unlink', change: { pathname: '/p/proto.html' } })
    expect(tab.isSaved).toBe(true)
    expect(notify).toHaveBeenCalledTimes(2)
  })

  it('closing an html tab drops its source and releases the file watcher', () => {
    const store = useEditorStore()
    const md = seedMarkdown(store)
    store.NEW_HTML_TAB({ doc })
    store.FORCE_CLOSE_TAB(store.currentFile!)
    expect(htmlTabs.DROP).toHaveBeenCalledTimes(1)
    expect(annotation.flush).not.toHaveBeenCalled()
    expect(ipc.send).toHaveBeenCalledWith('mt::window-tab-closed', '/p/proto.html')
    expect(store.currentFile?.id).toBe(md.id)
  })
})

describe('engine and annotation handoff', () => {
  it('entering an html tab detaches annotations and clears the TOC without touching the engine', () => {
    const store = useEditorStore()
    seedMarkdown(store)
    store.listToc = [{ content: 'PRD', lvl: 1, slug: 'prd' }] as never
    ;(bus.emit as unknown as Mock).mockClear()

    store.NEW_HTML_TAB({ doc })
    expect(annotation.DETACH_DOC).toHaveBeenCalledTimes(1)
    expect(store.listToc).toEqual([])
    expect(fileChanged()).toHaveLength(0)
  })

  it('returning to the unchanged markdown restores its TOC and skips reloading the engine', () => {
    const store = useEditorStore()
    const md = seedMarkdown(store)
    const toc = [{ content: 'PRD', lvl: 1, slug: 'prd' }]
    store.listToc = toc as never
    store.NEW_HTML_TAB({ doc })
    ;(bus.emit as unknown as Mock).mockClear()

    store.UPDATE_CURRENT_FILE(md)
    expect(fileChanged()).toHaveLength(0)
    expect(store.listToc).toEqual(toc)
    expect(annotation.SWITCH_DOC).toHaveBeenLastCalledWith({ pathname: '/p/prd.md', tabId: md.id })
  })

  it('going to a different markdown from an html tab reloads the engine', () => {
    const store = useEditorStore()
    seedMarkdown(store)
    const other = createDocumentState({
      pathname: '/p/other.md',
      filename: 'other.md',
      markdown: 'x'
    })
    store.tabs.push(other)
    store.NEW_HTML_TAB({ doc })
    ;(bus.emit as unknown as Mock).mockClear()

    store.UPDATE_CURRENT_FILE(other)
    expect(fileChanged()).toHaveLength(1)
    expect(fileChanged()[0][1]).toMatchObject({ id: other.id, markdown: 'x' })
  })

  it('leaving an html tab does not flush the engine into it', () => {
    const store = useEditorStore()
    const md = seedMarkdown(store)
    store.NEW_HTML_TAB({ doc })
    ;(bus.emit as unknown as Mock).mockClear()
    store.UPDATE_CURRENT_FILE(md)
    expect(
      (bus.emit as unknown as Mock).mock.calls.some((c) => c[0] === 'flush-active-editor')
    ).toBe(false)
  })
})
