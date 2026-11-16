import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

// html 标签复用文档分屏：「并列查看」/「另存为 .html」把页面建成标签直接放进分屏，
// 左边文档不动；它就是普通标签，可以还回标签栏，右栏换文档时让位。

interface StubTab {
  id: string
  kind: 'markdown' | 'html'
  pathname: string
  filename: string
}

const editorStub = vi.hoisted(() => {
  let seq = 0
  const stub = {
    tabs: [] as StubTab[],
    currentFile: null as StubTab | null,
    UPDATE_CURRENT_FILE: (tab: StubTab) => {
      if (!stub.tabs.includes(tab)) stub.tabs.push(tab)
      stub.currentFile = tab
    },
    NEW_HTML_TAB: vi.fn(
      ({ doc, title }: { doc: { pathname: string; filename: string }; title?: string }) => {
        const tab: StubTab = {
          id: `h${++seq}`,
          kind: 'html',
          pathname: doc.pathname,
          filename: title || doc.filename
        }
        stub.tabs.push(tab)
        return tab.id
      }
    )
  }
  return stub
})
vi.mock('@/store/editor', () => ({ useEditorStore: () => editorStub }))
vi.mock('@/store/layout', () => ({ useLayoutStore: () => ({ effectiveSideBarWidth: 0 }) }))
const notify = vi.hoisted(() => vi.fn())
vi.mock('@/services/notification', () => ({ default: { notify } }))

const ipc = vi.hoisted(() => ({ send: vi.fn(), on: vi.fn(), invoke: vi.fn() }))
vi.hoisted(() => {
  const w = globalThis as unknown as { window: Record<string, unknown> }
  w.window.bp = { closePage: async () => {}, setInputContext: () => {} }
  w.window.electron = { ipcRenderer: ipc }
})

import { useBrowserPanelStore } from '@/store/browserPanel'
import { useSplitStore } from '@/store/split'
import { useWorkspaceStore } from '@/store/workspace'
import { openHtmlBlockSideBySide, saveHtmlBlockAsFile } from '@/util/htmlBlockActions'

const md: StubTab = { id: 't1', kind: 'markdown', pathname: '/docs/prd.md', filename: 'prd.md' }

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  editorStub.tabs = [md]
  editorStub.currentFile = md
})

describe('html tabs in the document split', () => {
  it('「并列查看」opens a snapshot tab in the split and keeps the document on the left', () => {
    const bpStore = useBrowserPanelStore()
    bpStore.SET_OPEN(true)
    bpStore.SET_TAB('annotation')

    openHtmlBlockSideBySide({ title: 'Demo', html: '<p>x</p>' }, 'prd.md')

    expect(editorStub.NEW_HTML_TAB).toHaveBeenCalledWith({
      doc: { pathname: '', filename: 'Demo', html: '<p>x</p>' },
      selected: false,
      title: 'Demo',
      origin: 'prd.md'
    })
    const splitStore = useSplitStore()
    expect(splitStore.active).toBe(true)
    expect(splitStore.kind).toBe('doc')
    expect(useWorkspaceStore().splitDocTab?.kind).toBe('html')
    expect(editorStub.currentFile?.id).toBe('t1')
    expect(bpStore.activeTab).toBe('doc')
  })

  it('an untitled block falls back to "HTML"', () => {
    openHtmlBlockSideBySide({ title: '', html: '<p>x</p>' }, 'prd.md')
    expect(editorStub.tabs.at(-1)?.filename).toBe('HTML')
  })

  it('「另存为 .html」opens the written file side by side', async () => {
    ipc.invoke.mockResolvedValueOnce({
      pathname: '/docs/demo.html',
      filename: 'demo.html',
      html: '<p>x</p>'
    })
    await saveHtmlBlockAsFile({ title: 'Demo', html: '<p>x</p>' }, '/docs/prd.md')

    expect(ipc.invoke).toHaveBeenCalledWith('mt::html::save-as', {
      html: '<p>x</p>',
      title: 'Demo',
      docPathname: '/docs/prd.md'
    })
    expect(notify).toHaveBeenCalledTimes(1)
    expect(useWorkspaceStore().splitDocTab?.pathname).toBe('/docs/demo.html')
    expect(editorStub.currentFile?.id).toBe('t1')
  })

  it('a cancelled save dialog opens nothing', async () => {
    ipc.invoke.mockResolvedValueOnce(null)
    await saveHtmlBlockAsFile({ title: 'Demo', html: '<p>x</p>' }, null)
    expect(editorStub.NEW_HTML_TAB).not.toHaveBeenCalled()
    expect(useSplitStore().active).toBe(false)
  })

  it('returning the split brings the html tab back as the active tab', () => {
    openHtmlBlockSideBySide({ title: 'Demo', html: '<p>x</p>' }, 'prd.md')
    const splitStore = useSplitStore()
    const id = splitStore.tabId
    splitStore.RETURN_SPLIT_TO_TABS()
    expect(splitStore.active).toBe(false)
    expect(editorStub.currentFile?.id).toBe(id)
    expect(editorStub.currentFile?.kind).toBe('html')
  })

  it('opening another page side by side replaces the previous one in the split', () => {
    openHtmlBlockSideBySide({ title: 'A', html: 'a' }, 'prd.md')
    const first = useSplitStore().tabId
    // 先把左边换回文档，模拟用户继续在文档里点第二个块。
    useSplitStore().RETURN_SPLIT_TO_TABS()
    editorStub.currentFile = md
    openHtmlBlockSideBySide({ title: 'B', html: 'b' }, 'prd.md')
    expect(useSplitStore().tabId).not.toBe(first)
    expect(useWorkspaceStore().splitDocTab?.filename).toBe('B')
  })

  it('an html tab dragged from the tab bar goes into the split like a document', () => {
    const id = editorStub.NEW_HTML_TAB({ doc: { pathname: '/p/a.html', filename: 'a.html' } })
    expect(useSplitStore().DRAG_TO_SPLIT(id, { keepCurrent: true })).toBe(true)
    expect(useWorkspaceStore().splitDocTab?.id).toBe(id)
  })
})
