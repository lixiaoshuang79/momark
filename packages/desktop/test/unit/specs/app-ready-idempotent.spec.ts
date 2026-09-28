import { beforeEach, describe, expect, it, vi } from 'vitest'

// ────────────────────────────────────────────────────────────────────────────
// P3 主进程（App 生命周期）的行为断言。
//
// 旧实现里 macOS 的 activate（点 dock）直接调 `ready()`，而 `ready()` 不是幂等
// 的：每跑一次就重复注册 `broadcast-preferences-changed` / `nativeTheme#updated`
// 监听、重复接管缩放快捷键、重复把 `args._` 里的启动文件塞进待打开队列（每次
// 点 dock 都重开一遍启动文件）。现在拆成「一次性初始化」+「建窗」。
// ────────────────────────────────────────────────────────────────────────────

const mocks = vi.hoisted(() => {
  const appHandlers = new Map<string, (...args: unknown[]) => unknown>()
  return {
    appHandlers,
    installPanelZoomKeyRouting: vi.fn(),
    installBrowserPanelSecurity: vi.fn(),
    onInternalChannel: vi.fn(),
    setLanguage: vi.fn(),
    selectTheme: vi.fn(),
    registerKeyboardListeners: vi.fn(),
    registerSpellcheckerListeners: vi.fn(),
    nativeThemeOn: vi.fn(),
    nativeThemeOnce: vi.fn(),
    clearBufferStores: vi.fn(),
    createdWindows: [] as Array<{ kind: string; args: unknown[] }>
  }
})

vi.mock('electron', () => ({
  app: {
    on: vi.fn((event: string, handler: (...args: unknown[]) => unknown) => {
      mocks.appHandlers.set(event, handler)
      return undefined
    }),
    commandLine: { appendSwitch: vi.fn() },
    dock: { setMenu: vi.fn() },
    setJumpList: vi.fn(),
    isReady: vi.fn(() => true),
    getLocale: vi.fn(() => 'zh-CN'),
    getPath: vi.fn(() => '/tmp'),
    getRecentDocuments: vi.fn(() => []),
    getVersion: vi.fn(() => '1.5.0')
  },
  BrowserWindow: { fromWebContents: () => null, getAllWindows: () => [] },
  clipboard: { writeText: vi.fn() },
  dialog: { showOpenDialog: vi.fn(), showMessageBox: vi.fn(), showErrorBox: vi.fn() },
  ipcMain: { on: vi.fn(), handle: vi.fn(), emit: vi.fn() },
  nativeTheme: {
    on: mocks.nativeThemeOn,
    once: mocks.nativeThemeOnce,
    themeSource: 'system',
    shouldUseDarkColors: false
  },
  shell: { trashItem: vi.fn() }
}))

vi.mock('electron-log', () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn() }
}))

vi.mock('main_renderer/browserPanel', () => ({
  installPanelZoomKeyRouting: mocks.installPanelZoomKeyRouting,
  installBrowserPanelSecurity: mocks.installBrowserPanelSecurity
}))
vi.mock('main_renderer/utils/internalIpc', () => ({
  onInternalChannel: mocks.onInternalChannel
}))
vi.mock('main_renderer/i18n', () => ({
  setLanguage: mocks.setLanguage,
  t: (key: string) => key
}))
vi.mock('main_renderer/menu/actions/theme', () => ({ selectTheme: mocks.selectTheme }))
vi.mock('main_renderer/menu/templates', () => ({ dockMenu: {} }))
vi.mock('main_renderer/keyboard', () => ({
  registerKeyboardListeners: mocks.registerKeyboardListeners
}))
vi.mock('main_renderer/spellchecker', () => ({
  default: mocks.registerSpellcheckerListeners
}))
vi.mock('main_renderer/utils/imagePathAutoComplement', () => ({ watchers: new Map() }))
vi.mock('main_renderer/app/nativeTheme', () => ({
  getNativeThemeSource: () => 'system',
  isDarkApplicationTheme: () => false
}))
// 路径归一化：真实实现会去磁盘上核对（存在性/扩展名），单测里只要形状对得上。
vi.mock('main_renderer/filesystem', () => ({ normalizeAndResolvePath: (p: string) => p }))
vi.mock('main_renderer/filesystem/markdown', () => ({
  normalizeMarkdownPath: (p: string) => (p.endsWith('.md') ? { path: p, isDir: false } : null)
}))

const windowStub = (kind: string) =>
  class {
    id = 1
    type = kind
    browserWindow = { webContents: { send: vi.fn() } }
    createWindow = (...args: unknown[]): void => {
      mocks.createdWindows.push({ kind, args })
    }
  }

vi.mock('main_renderer/windows/editor', () => ({ default: windowStub('editor') }))
vi.mock('main_renderer/windows/welcome', () => ({ default: windowStub('welcome') }))
vi.mock('main_renderer/windows/setting', () => ({ default: windowStub('setting') }))
vi.mock('main_renderer/windows/about', () => ({ default: windowStub('about') }))

const { default: App } = await import('main_renderer/app')

const makeAccessor = (preferences: Record<string, unknown> = {}) => {
  const windows = new Map<number, unknown>()
  return {
    preferences: {
      getItem: vi.fn((key: string) => preferences[key]),
      getAll: vi.fn(() => ({ startUpAction: 'blank', theme: 'claude-light', ...preferences })),
      setItem: vi.fn(),
      setItems: vi.fn()
    },
    editorBufferStore: { clearBufferStoresWithAllSaved: mocks.clearBufferStores },
    keybindings: { setAcceleratorInterceptor: vi.fn() },
    menu: { setActiveWindow: vi.fn(), getRecentlyUsedDocuments: vi.fn(() => []) },
    dataCenter: { getItem: vi.fn() },
    windowManager: {
      windows,
      add: vi.fn((win: { id: number }) => windows.set(win.id, win)),
      get: vi.fn((id: number) => windows.get(id)),
      get windowCount() {
        return windows.size
      },
      getWindowsByType: vi.fn(() => []),
      getActiveWindow: vi.fn(() => undefined),
      getActiveEditorId: vi.fn(() => (windows.size ? 1 : null)),
      findBestWindowToOpenIn: vi.fn((files: string[]) => [
        { windowId: null, fileList: [...files] }
      ]),
      forceCloseById: vi.fn(),
      closeWatcher: vi.fn()
    }
  }
}

const countWindows = (kind: string): number =>
  mocks.createdWindows.filter((w) => w.kind === kind).length

beforeEach(() => {
  vi.clearAllMocks()
  mocks.appHandlers.clear()
  mocks.createdWindows.length = 0
})

describe('P3 — ready 的初始化与建窗拆开', () => {
  it('重复 ready() 只做一次初始化，但每次都建窗', () => {
    const app = new App(makeAccessor() as never, { _: [] })
    app.init()

    app.ready()
    app.ready()

    expect(mocks.installPanelZoomKeyRouting).toHaveBeenCalledTimes(1)
    expect(
      mocks.onInternalChannel.mock.calls.filter((c) => c[0] === 'broadcast-preferences-changed')
    ).toHaveLength(1)
    expect(mocks.nativeThemeOn).toHaveBeenCalledTimes(1)
    // 建窗部分每次都要跑（第二次是「欢迎页」）
    expect(countWindows('welcome')).toBe(2)
  })

  it('activate（点 dock）只建窗：不再重复接管快捷键/注册监听', () => {
    const accessor = makeAccessor()
    const app = new App(accessor as never, { _: [] })
    app.init()
    app.ready()

    const activate = mocks.appHandlers.get('activate')
    expect(activate).toBeTypeOf('function')

    // 关掉所有窗口（macOS 保持应用存活）→ 每次点 dock 都应该建出一个窗口
    accessor.windowManager.windows.clear()
    activate!()
    accessor.windowManager.windows.clear()
    activate!()

    expect(mocks.installPanelZoomKeyRouting).toHaveBeenCalledTimes(1)
    expect(
      mocks.onInternalChannel.mock.calls.filter((c) => c[0] === 'broadcast-preferences-changed')
    ).toHaveLength(1)
    expect(mocks.nativeThemeOn).toHaveBeenCalledTimes(1)
    // ready 建了 1 个 + 两次 activate 各建 1 个
    expect(countWindows('welcome')).toBe(3)
  })

  it('有窗口时不重复建窗（activate 的原有条件）', () => {
    const app = new App(makeAccessor() as never, { _: [] })
    app.init()
    app.ready()
    expect(countWindows('welcome')).toBe(1)

    const activate = mocks.appHandlers.get('activate')
    // 第一个窗口已在 windowManager 里 → windowCount > 0 → 不建
    activate!()

    expect(countWindows('welcome')).toBe(1)
  })

  it('CLI 启动文件只打开一次（旧实现每次 activate 都重开一遍）', () => {
    const accessor = makeAccessor()
    const app = new App(accessor as never, { _: ['/tmp/startup.md'] })
    app.init()

    app.ready()
    app.ready()
    accessor.windowManager.windows.clear()
    mocks.appHandlers.get('activate')!()

    // 承重断言：启动文件只在第一次 ready 时进过待打开队列
    expect(countWindows('editor')).toBe(1)
  })
})
