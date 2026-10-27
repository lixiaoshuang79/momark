import { describe, it, expect, vi, beforeEach } from 'vitest'
import { nextTick } from 'vue'
import { createPinia, setActivePinia } from 'pinia'

// 极速模式（turboMode）：右栏网页整体停用、正文链接改走系统浏览器、侧栏 HTML 页
// 不再打开；文档分屏与标注 tab 照常。这里钉住 store 层的契约——组件只按
// `bpStore.turboMode` 卸载网页模式，真正的拦截与降级都在 store 里。

// 分屏 store 只需要标签集合与当前文档；真编辑器 store 会拉起整条文件/IPC 链路。
const editorStub = vi.hoisted(() => ({
  tabs: [] as Array<{ id: string; pathname: string; filename: string }>,
  currentFile: null as { id: string } | null,
  UPDATE_CURRENT_FILE: (tab: { id: string }) => {
    editorStub.currentFile = tab
  }
}))
vi.mock('@/store/editor', () => ({ useEditorStore: () => editorStub }))
vi.mock('@/store/layout', () => ({ useLayoutStore: () => ({ effectiveSideBarWidth: 0 }) }))
vi.mock('@/services/notification', () => ({ default: { notify: vi.fn() } }))

const bp = vi.hoisted(() => {
  let seq = 0
  return {
    createPage: vi.fn(async (_url: string) => `bp-${++seq}`),
    closePage: vi.fn(async (_id: string) => {}),
    openExternal: vi.fn(async (_url: string) => true),
    activate: vi.fn(),
    setDeviceMode: vi.fn(async () => true)
  }
})

vi.hoisted(() => {
  const w = globalThis as unknown as { window: Record<string, unknown> }
  w.window.bp = bp
  w.window.electron = { ipcRenderer: { send: () => {}, on: () => {} } }
})

import { usePreferencesStore } from '@/store/preferences'
import { useBrowserPanelStore } from '@/store/browserPanel'
import { useSplitStore } from '@/store/split'

const setTurbo = async (value: boolean): Promise<void> => {
  usePreferencesStore().SET_USER_PREFERENCE({ turboMode: value })
  await nextTick()
}

// 两个网页 + 面板停在网页模式（用户正开着右栏看网页）。
const openTwoPages = async (): Promise<ReturnType<typeof useBrowserPanelStore>> => {
  const bpStore = useBrowserPanelStore()
  bpStore.OPEN_LINK('https://a.example/')
  await vi.waitFor(() => expect(bpStore.urlPages).toHaveLength(1))
  bpStore.OPEN_LINK('https://b.example/')
  await vi.waitFor(() => expect(bpStore.urlPages).toHaveLength(2))
  return bpStore
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  editorStub.tabs = [
    { id: 't1', pathname: '/docs/a.md', filename: 'a.md' },
    { id: 't2', pathname: '/docs/b.md', filename: 'b.md' }
  ]
  editorStub.currentFile = editorStub.tabs[0]
})

describe('preferences: htmlRenderingEnabled', () => {
  it('turbo mode wins over isHtmlEnabled without rewriting it', () => {
    const prefs = usePreferencesStore()
    expect(prefs.turboMode).toBe(false)
    expect(prefs.htmlRenderingEnabled).toBe(true)

    prefs.SET_USER_PREFERENCE({ turboMode: true })
    expect(prefs.htmlRenderingEnabled).toBe(false)
    expect(prefs.isHtmlEnabled).toBe(true)

    prefs.SET_USER_PREFERENCE({ turboMode: false })
    expect(prefs.htmlRenderingEnabled).toBe(true)

    prefs.SET_USER_PREFERENCE({ isHtmlEnabled: false })
    expect(prefs.htmlRenderingEnabled).toBe(false)
    prefs.SET_USER_PREFERENCE({ turboMode: true })
    prefs.SET_USER_PREFERENCE({ turboMode: false })
    expect(prefs.isHtmlEnabled).toBe(false)
    expect(prefs.htmlRenderingEnabled).toBe(false)
  })
})

describe('browser panel: links', () => {
  it('opens http(s) links in the panel by default', async () => {
    const bpStore = useBrowserPanelStore()
    bpStore.OPEN_LINK('https://example.com/')
    await vi.waitFor(() => expect(bpStore.urlPages).toHaveLength(1))

    expect(bp.createPage).toHaveBeenCalledWith('https://example.com/')
    expect(bp.openExternal).not.toHaveBeenCalled()
    expect(bpStore.open).toBe(true)
    expect(bpStore.mode).toBe('url')
  })

  it('opens links in the default browser in turbo mode and leaves the panel alone', async () => {
    await setTurbo(true)
    const bpStore = useBrowserPanelStore()
    bpStore.OPEN_LINK('https://example.com/')
    await Promise.resolve()

    expect(bp.openExternal).toHaveBeenCalledWith('https://example.com/')
    expect(bp.createPage).not.toHaveBeenCalled()
    expect(bpStore.urlPages).toHaveLength(0)
    expect(bpStore.open).toBe(false)
  })
})

describe('browser panel: entering turbo mode', () => {
  it('closes every page and collapses a panel that only showed web pages', async () => {
    const bpStore = await openTwoPages()
    const ids = bpStore.urlPages.map((p) => p.id)

    await setTurbo(true)

    expect(bp.closePage.mock.calls.map((c) => c[0])).toEqual(ids)
    expect(bpStore.urlPages).toHaveLength(0)
    expect(bpStore.activePageId).toBeNull()
    expect(bpStore.mode).toBe('doc')
    expect(bpStore.open).toBe(false)
  })

  it('applies at startup when the preference arrives after the store exists', async () => {
    const bpStore = useBrowserPanelStore()
    expect(bpStore.mode).toBe('url')
    // 偏好经 mt::user-preference 异步到达（store 早已建好）。
    await setTurbo(true)
    expect(bpStore.mode).toBe('doc')
  })

  it('degrades a URL split to the document split', async () => {
    const bpStore = useBrowserPanelStore()
    const splitStore = useSplitStore()
    splitStore.DRAG_TO_SPLIT('t2', { keepCurrent: true })
    bpStore.OPEN_LINK('https://a.example/')
    await vi.waitFor(() => expect(bpStore.urlPages).toHaveLength(1))
    expect(splitStore.kind).toBe('url')

    await setTurbo(true)

    expect(bpStore.urlPages).toHaveLength(0)
    expect(bpStore.mode).toBe('doc')
    expect(bpStore.open).toBe(true)
    expect(splitStore.active).toBe(true)
    expect(splitStore.kind).toBe('doc')
    expect(splitStore.tabId).toBe('t2')
  })

  it('keeps the annotation tab on top and only swaps the mode underneath', async () => {
    const bpStore = await openTwoPages()
    bpStore.SET_TAB('annotation')

    await setTurbo(true)

    expect(bpStore.urlPages).toHaveLength(0)
    expect(bpStore.activeTab).toBe('annotation')
    expect(bpStore.mode).toBe('doc')
    expect(bpStore.open).toBe(true)
  })

  it('closes the side-panel HTML page and refuses to open a new one', async () => {
    const bpStore = useBrowserPanelStore()
    bpStore.OPEN_HTML_DOC('file:///frame.html', 'Demo', '<script>1</script>')
    expect(bpStore.htmlDoc).not.toBeNull()

    await setTurbo(true)
    expect(bpStore.htmlDoc).toBeNull()
    expect(bpStore.open).toBe(false)

    bpStore.OPEN_HTML_DOC('file:///frame.html', 'Demo', '<script>1</script>')
    expect(bpStore.htmlDoc).toBeNull()
    expect(bpStore.open).toBe(false)
  })

  it('blocks every way back into web mode', async () => {
    await setTurbo(true)
    const bpStore = useBrowserPanelStore()

    expect(await bpStore.ADD_WEB_PAGE('https://example.com/')).toBeNull()
    bpStore.SET_MODE('url')
    expect(bpStore.mode).toBe('doc')
    bpStore.SET_TAB('url')
    expect(bpStore.activeTab).toBe('doc')
    expect(bp.createPage).not.toHaveBeenCalled()
  })

  it('leaves the document split and the annotation tab usable', async () => {
    await setTurbo(true)
    const bpStore = useBrowserPanelStore()
    const splitStore = useSplitStore()

    expect(splitStore.DRAG_TO_SPLIT('t2', { keepCurrent: true })).toBe(true)
    expect(splitStore.kind).toBe('doc')
    expect(bpStore.activeTab).toBe('doc')

    bpStore.SET_TAB('annotation')
    expect(bpStore.activeTab).toBe('annotation')
    bpStore.SET_TAB('doc')
    expect(bpStore.activeTab).toBe('doc')
  })
})

describe('browser panel: leaving turbo mode', () => {
  it('restores the web panel without reopening the closed pages', async () => {
    const bpStore = await openTwoPages()
    await setTurbo(true)
    await setTurbo(false)

    expect(bpStore.urlPages).toHaveLength(0)
    expect(bpStore.mode).toBe('doc')

    bp.createPage.mockClear()
    bpStore.OPEN_LINK('https://c.example/')
    await vi.waitFor(() => expect(bpStore.urlPages).toHaveLength(1))
    expect(bp.createPage).toHaveBeenCalledWith('https://c.example/')
    expect(bpStore.mode).toBe('url')

    bpStore.OPEN_HTML_DOC('file:///frame.html', 'Demo')
    expect(bpStore.htmlDoc?.title).toBe('Demo')
  })
})
