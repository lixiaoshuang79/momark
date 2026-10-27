import { describe, expect, it, vi } from 'vitest'

// 极速模式的主进程兜底：渲染层已经不建网页，主进程再拒掉 webview 挂载与
// bp:createPage，保证这个模式下不会冒出任何 guest 进程。

const state = vi.hoisted(() => ({
  appOn: vi.fn(),
  handle: vi.fn(),
  on: vi.fn()
}))

vi.mock('electron', () => ({
  app: {
    on: state.appOn,
    whenReady: () => new Promise(() => {}),
    getPath: () => '/tmp'
  },
  dialog: { showOpenDialog: vi.fn() },
  ipcMain: { handle: state.handle, on: state.on },
  session: { fromPartition: () => ({}) },
  shell: { openExternal: vi.fn() },
  BrowserWindow: { fromWebContents: () => null }
}))

const { installBrowserPanelSecurity, registerBrowserPanelIpc } =
  await import('main_renderer/browserPanel')

let turbo = false
installBrowserPanelSecurity(() => turbo)
registerBrowserPanelIpc()

type AttachHandler = (
  event: { preventDefault: () => void },
  webPreferences: Record<string, unknown>,
  params: Record<string, unknown>
) => void

// 模拟一个编辑器宿主窗口被创建，取出它注册的 will-attach-webview 处理器。
const editorWillAttach = (): AttachHandler => {
  const created = state.appOn.mock.calls.find(([name]) => name === 'web-contents-created')
  expect(created).toBeTruthy()
  const listeners = new Map<string, AttachHandler>()
  const contents = {
    id: 7,
    getType: () => 'window',
    getURL: () => 'file:///index.html#/editor',
    on: (name: string, fn: AttachHandler) => listeners.set(name, fn),
    setWindowOpenHandler: vi.fn()
  }
  created![1]({}, contents)
  return listeners.get('will-attach-webview')!
}

const tryAttach = (): boolean => {
  const event = { preventDefault: vi.fn() }
  editorWillAttach()(event, {}, { src: 'https://example.com/' })
  return event.preventDefault.mock.calls.length === 0
}

const createPage = (url: string) => {
  const call = state.handle.mock.calls.find(([channel]) => channel === 'bp:createPage')
  return (call![1] as (e: unknown, u: string) => string)({ sender: { id: 7 } }, url)
}

describe('browser panel main-process turbo guard', () => {
  it('lets the editor attach webviews while turbo mode is off', () => {
    turbo = false
    expect(tryAttach()).toBe(true)
    expect(createPage('https://example.com/')).toMatch(/^bp-/)
  })

  it('rejects webview attach and page creation while turbo mode is on', () => {
    turbo = true
    expect(tryAttach()).toBe(false)
    expect(() => createPage('https://example.com/')).toThrow(/turbo mode/)
  })

  it('reads the preference on every call, so turning it off applies immediately', () => {
    turbo = true
    expect(tryAttach()).toBe(false)
    turbo = false
    expect(tryAttach()).toBe(true)
  })
})
