/**
 * IPC channel contract — single source of truth for renderer↔main messaging.
 *
 * Four channel categories:
 *   - IpcInvokeChannels      : renderer → main, returns Promise<T>
 *   - IpcSendChannels        : renderer → main, fire-and-forget
 *   - IpcSyncChannels        : renderer → main, synchronous
 *   - IpcMainEventChannels   : main → renderer, push events (renderer .on)
 *
 * Channel names are typed strictly; argument and return shapes are
 * intentionally permissive (`unknown[]` / `unknown`) during the migration.
 * Concrete types tighten as each handler/caller converts in commits 5–8.
 *
 * To register a new channel:
 *   1. Add an entry to the appropriate interface here.
 *   2. Wire the handler in src/main (ipcMain.handle / ipcMain.on / webContents.send).
 *   3. Wire the caller via the typed preload bridge in src/preload/index.ts.
 */

import type { IKeyboardLayoutInfo, IKeyboardMapping } from 'native-keymap'
import type {
  MarkdownDocument,
  TabOptions,
  BootstrapEditorConfig,
  PageOptions,
  ExportType,
  SaveOptions,
  SerializedStat,
  LineEnding,
  FileChangeDetail,
  UnsavedFile
} from './files'
import type { BufferedState as BufferedStateType } from './bufferedState'
import type { MenuTemplate, MenuPopupPosition } from './menu'

// =================================================================
// Invoke channels (renderer → main, returns Promise<T>)
// =================================================================

export interface IpcInvokeChannels {
  'mt::ask-for-image-path': { args: []; ret: string[] }
  'mt::boot-info-async': { args: []; ret: BootInfo }
  // ── 右侧浏览器面板（PHASE2-SPEC §5，webview 主方案，见 main/browserPanel.ts）──
  // 主进程校验 URL（http/https）后分配页面 id；渲染层再创建 <webview> 实例。
  'bp:createPage': { args: [url: string]; ret: string }
  // 渲染层在 webview dom-ready 后把 getWebContentsId() 回注册给主进程，
  // 主进程据此把 pageId 映射到 guest webContents（分区统一 persist:panel，
  // 不能按分区区分页面）。
  'bp:register': { args: [id: string, webContentsId: number]; ret: void }
  'bp:closePage': { args: [id: string]; ret: void }
  'bp:activate': { args: [id: string]; ret: void }
  'bp:back': { args: [id: string]; ret: void }
  'bp:forward': { args: [id: string]; ret: void }
  'bp:reload': { args: [id: string]; ret: void }
  'bp:getState': { args: [id: string]; ret: BpPageState }
  // round16：PC / 移动端样式切换（底部工具栏按钮）。
  'bp:setDeviceMode': { args: [id: string, mode: 'pc' | 'mobile']; ret: boolean }
  // 地址栏外开箭头（PHASE2-SPEC §5）：仅 http(s) 才允许 shell.openExternal。
  'bp:openExternal': { args: [url: string]; ret: boolean }
  // 文档模式「打开文件…」：主进程弹系统对话框并读回 Markdown 文本。
  'bp:pickDoc': { args: []; ret: { path: string; markdown: string } | null }
  // 文档模式按路径直读：最近打开列表点击后直接在右侧面板预览。
  'bp:readDoc': { args: [path: string]; ret: { path: string; markdown: string } | null }
  // round11 Chrome 登录态打通：渲染层就绪后拉取 FDA 授权引导状态。
  'bp:chrome-cookie-guide-state': { args: []; ret: { shouldShow: boolean } }
  'mt::clipboard::guess-file-path': { args: []; ret: string | null }
  'mt::clipboard::read-text': { args: []; ret: string }
  'mt::cmd::exists': { args: [name: string]; ret: boolean }
  'mt::fonts::list': { args: []; ret: string[] }
  'mt::fs-trash-item': { args: [pathname: string]; ret: void }
  'mt::fs::copy': { args: [src: string, dest: string]; ret: void }
  'mt::fs::empty-dir': { args: [path: string]; ret: void }
  'mt::fs::ensure-dir': { args: [path: string]; ret: void }
  'mt::fs::is-directory': { args: [path: string]; ret: boolean }
  'mt::fs::is-executable': { args: [path: string]; ret: boolean }
  'mt::fs::is-file': { args: [path: string]; ret: boolean }
  'mt::fs::move': { args: [src: string, dest: string]; ret: void }
  'mt::fs::output-file': { args: [path: string, data: string | Uint8Array]; ret: void }
  'mt::fs::path-exists': { args: [path: string]; ret: boolean }
  'mt::fs::read-file': { args: [path: string, encoding?: string]; ret: string | Uint8Array }
  'mt::fs::readdir': { args: [path: string]; ret: string[] }
  'mt::fs::stat': { args: [path: string]; ret: SerializedStat }
  'mt::fs::unlink': { args: [path: string]; ret: void }
  'mt::fs::write-file': { args: [path: string, data: string | Uint8Array]; ret: void }
  'mt::i18n::is-supported': { args: [lang: string]; ret: boolean }
  'mt::i18n::load': { args: [language: string]; ret: Record<string, unknown> }
  'mt::i18n::supported': { args: []; ret: string[] }
  'mt::keybinding-get-keyboard-info': { args: []; ret: KeyboardInfo }
  'mt::keybinding-get-pref-keybindings': {
    args: []
    ret: { defaultKeybindings: Map<string, string>; userKeybindings: Map<string, string> }
  }
  'mt::keybinding-save-user-keybindings': { args: [bindings: unknown]; ret: boolean }
  'mt::paths::is-image': { args: [path: string]; ret: boolean }
  'mt::rg::start': { args: [req: unknown]; ret: { searchId: string } }
  'mt::shell::open-external': { args: [url: string]; ret: void }
  'mt::shell::open-path': { args: [fullPath: string]; ret: string }
  'mt::spellchecker-get-available-dictionaries': { args: []; ret: string[] }
  'mt::spellchecker-get-custom-dictionary-words': { args: []; ret: string[] }
  'mt::welcome::recents': {
    args: []
    ret: Array<{ path: string; name: string; dirname: string; mtime: number }>
  }
  'mt::spellchecker-remove-word': { args: [word: string]; ret: boolean }
  'mt::spellchecker-set-enabled': { args: [enabled: boolean]; ret: void }
  'mt::spellchecker-switch-language': { args: [language: string]; ret: void }
  'mt::uploader::upload': { args: [req: unknown]; ret: unknown }
  'mt::win::is-fullscreen': { args: []; ret: boolean }
  'mt::win::is-maximized': { args: []; ret: boolean }
  // Main derives the BrowserWindow via BrowserWindow.fromWebContents(e.sender);
  // no need to pass windowId. Payload is the editor+project+layout snapshot.
  'update-buffer-state': { args: [payload: unknown]; ret: void }
}

// =================================================================
// Send channels (renderer → main, fire-and-forget)
// =================================================================

export interface IpcSendChannels {
  'app-create-editor-window': [config?: unknown]
  'app-create-about-window': []
  'app-create-settings-window': []
  // round11 Chrome 登录态打通：引导 toast 已展示（主进程落一次性标志）。
  'mt::chrome-cookie-guide-mark-shown': []
  'app-open-directory-by-id': [windowId: number, dirPath: string]
  'app-open-file-by-id': [windowId: number, filePath: string, options?: unknown]
  'app-open-files-by-id': [windowId: number, filePaths: string[], options?: unknown]
  'app-open-markdown-by-id': [windowId: number, markdown: string, options?: unknown]
  'broadcast-preferences-changed': [partial: unknown]
  'broadcast-user-data-changed': [partial: unknown]
  'menu-add-recently-used': [filePath: string]
  'menu-clear-recently-used': []
  'mt::add-recently-used-document': [filePath: string]
  'mt::welcome::new-doc': []
  'mt::welcome::open-file': []
  'mt::welcome::open-folder': []
  'mt::welcome::open-recent': [filePath: string]
  'mt::app-try-quit': []
  'mt::ask-for-image-auto-path': [payload: unknown]
  'mt::ask-for-modify-image-folder-path': [imagePath?: string]
  'mt::ask-for-open-project-in-sidebar': []
  'mt::ask-for-user-data': []
  'mt::ask-for-user-preference': []
  'mt::clipboard::write-text': [text: string]
  'mt::close-window': []
  'mt::close-window-confirm': [unsavedFiles: UnsavedFile[]]
  'mt::cmd-close-window': []
  'mt::cmd-import-file': []
  'mt::cmd-new-editor-window': []
  'mt::cmd-open-file': []
  'mt::cmd-open-folder': []
  'mt::cmd-toggle-autosave': []
  'mt::editor-selection-changed': [windowId: number, state: unknown]
  'mt::format-link-click': [payload: { data: unknown; dirname: string }]
  'mt::get-current-language': []
  'mt::handle-renderer-error': [error: unknown]
  'mt::keybinding-debug-dump-keyboard-info': []
  'mt::make-screenshot': []
  'mt::menu::popup': [template: MenuTemplate, position?: MenuPopupPosition]
  'mt::menu::popup-application': [position?: MenuPopupPosition]
  'mt::open-file': [filePath: string, options?: unknown]
  'mt::open-file-by-window-id': [windowId: number, filePath: string, options?: unknown]
  'mt::open-keybindings-config': []
  'mt::open-setting-window': []
  'mt::rename': [
    payload: { id: string; pathname: string; newPathname: string; currentFile?: unknown }
  ]
  'mt::request-keybindings': []
  'mt::set-editor-format-menus-enabled': [windowId: number, enabled: boolean]
  'mt::response-export': [
    payload: {
      type: ExportType
      title: string
      content: string
      filename: string
      pathname: string
      pageOptions: PageOptions
      headerTemplate?: string
      footerTemplate?: string
    }
  ]
  'mt::response-file-move-to': [payload: { id: string; pathname: string }]
  'mt::response-file-save': [
    id: string,
    filename: string,
    pathname: string,
    markdown: string,
    options: SaveOptions,
    defaultPath: string
  ]
  'mt::response-file-save-as': [
    id: string,
    filename: string,
    pathname: string,
    markdown: string,
    options: SaveOptions,
    defaultPath: string
  ]
  'mt::response-print': []
  'mt::export-cancel': []
  'mt::rg::cancel': [searchId: string]
  'mt::save-and-close-tabs': [tabs: unknown[]]
  'mt::save-tabs': [tabs: unknown[]]
  'mt::select-default-directory-to-open': []
  'mt::set-user-data': [partial: unknown]
  'mt::set-user-preference': [partial: unknown]
  'mt::shell::open-external': [url: string]
  'mt::shell::show-item': [fullPath: string]
  'mt::update-format-menu': [windowId: number, state: Record<string, boolean>]
  'mt::update-line-ending-menu': [windowId: number, lineEnding: LineEnding]
  'mt::update-sidebar-menu': [windowId: number, visible: boolean]
  'mt::view-layout-changed': [windowId: number, layout: unknown]
  'mt::win::close': []
  'mt::win::maximize': []
  'mt::win::minimize': []
  'mt::win::set-fullscreen': [flag: boolean]
  'mt::win::toggle-fullscreen': []
  'mt::win::toggle-maximize': []
  'mt::win::unmaximize': []
  'mt::window-add-file-path': [filePath: string]
  'mt::window-initialized': []
  'mt::window-tab-closed': [pathname: string]
  'mt::window-toggle-always-on-top': []
  'mt::window::drop': [payload: unknown]
  // guest 页面发起 window.open / target=_blank（http/https）→ 渲染层在面板内新建
  // Dock 页（setWindowOpenHandler 已 deny 掉原生新窗口）。
  'bp:new-window-request': [payload: { url: string; fromPageId: string | null }]
  // guest 拿到键盘焦点时按下的缩放快捷键（Cmd/Ctrl + = / - / 0）：宿主菜单加速键
  // 在 guest 内不生效，主进程只做「按键 → 意图」翻译，缩放由渲染层执行（与工具栏
  // 「适应宽度」共用同一条 applyZoom 路径）。
  'bp:zoom-command': [payload: { pageId: string; action: BpZoomAction }]
  // round18：面板输入上下文（渲染层推送）。主进程据此判定 Cmd +=/-/0 的归属：
  // 面板正在展示网页且光标不在编辑器里 → 这三个键做网页缩放，不再落到文档上
  // （它们在墨记里本是段落标题升降级）。
  'bp:setInputContext': [
    payload: {
      open: boolean
      mode: 'url' | 'doc'
      activePageId: string | null
      editorFocused: boolean
    }
  ]
  'screen-capture': [payload: unknown]
  'set-image-folder-path': [path: string]
  'set-user-preference': [partial: unknown]
  'watcher-unwatch-all-by-id': [windowId: number]
  'watcher-unwatch-directory': [windowId: number, path: string]
  'watcher-unwatch-file': [windowId: number, path: string]
  'watcher-watch-directory': [windowId: number, path: string]
  'watcher-watch-file': [windowId: number, path: string]
  'window-add-file-path': [windowId: number, filePath: string]
  'window-change-file-path': [windowId: number, oldPath: string, newPath: string]
  'window-close-by-id': [windowId: number]
  'window-file-saved': [windowId: number, tabId: string]
  'window-reload-by-id': [windowId: number]
  'window-toggle-always-on-top': [windowId: number]
}

// =================================================================
// Sync channels (synchronous renderer → main)
// =================================================================

export interface IpcSyncChannels {
  'mt::boot-info': { args: []; ret: BootInfo }
  'mt::paths::is-same-sync': { args: [a: string, b: string]; ret: boolean }
}

// =================================================================
// Push events (main → renderer, listened on ipcRenderer.on)
// =================================================================

export interface IpcMainEventChannels {
  'language-changed': [language: string]
  'mt::ask-for-close': []
  'mt::bootstrap-editor': [config: BootstrapEditorConfig]
  'mt::cm-copy-as-html': []
  'mt::cm-copy-as-rich': []
  'mt::cm-insert-paragraph': [direction: 'before' | 'after']
  'mt::cm-paste-as-plain-text': []
  'mt::current-language': [language: string]
  'mt::editor-ask-file-save': []
  'mt::editor-ask-file-save-as': []
  'mt::editor-close-tab': [tabId?: string]
  'mt::editor-edit-action': [action: string]
  'mt::editor-format-action': [payload: { type: string }]
  'mt::editor-move-file': []
  'mt::editor-paragraph-action': [payload: { type: string }]
  'mt::editor-rename-file': []
  'mt::execute-command-by-id': [commandId: string]
  'mt::export-failure': [payload: { message: string; canceled?: boolean }]
  'mt::export-progress': [payload: { phase: string; percent: number | null }]
  'mt::export-success': [payload: { type: string; filePath: string }]
  'mt::file-saved': [tabId: string]
  'mt::force-close-tabs-by-id': [tabIds: string[]]
  'mt::invalidate-image-cache': []
  'mt::keybindings-response': [bindings: unknown]
  'mt::load-state': [state: BufferedStateType]
  'mt::menu::click': [menuId: string]
  'mt::menu::closed': []
  'mt::new-untitled-tab': [selected?: boolean, markdown?: string]
  'mt::open-directory': [directoryPath: string]
  'mt::open-new-tab': [
    markdownDocument: MarkdownDocument | null,
    options?: TabOptions,
    selected?: boolean
  ]
  'mt::pandoc-not-exists': [opts: Record<string, unknown>]
  'mt::print-service-clearup': []
  'mt::rg::cancelled': [payload: unknown]
  'mt::rg::done': [payload: unknown]
  'mt::rg::error': [payload: unknown]
  'mt::rg::match': [payload: unknown]
  'mt::rg::progress': [payload: unknown]
  'mt::screenshot-captured': [filePath: string]
  'mt::set-line-ending': [lineEnding: LineEnding]
  'mt::set-pathname': [payload: { id: string; pathname: string; filename: string }]
  'mt::set-view-layout': [layout: unknown]
  'mt::show-command-palette': []
  'mt::show-export-dialog': [type: ExportType]
  'mt::show-notification': [payload: unknown]
  'mt::spelling-replace-misspelling': [payload: unknown]
  'mt::spelling-show-switch-language': []
  'mt::switch-tab-by-file_path': [filePath: string]
  'mt::switch-tab-by-index': [index: number]
  'mt::tab-save-failure': [tabId: string, message: string]
  'mt::tab-saved': [tabId: string]
  'mt::tabs-cycle-left': []
  'mt::tabs-cycle-right': []
  'mt::toggle-view-layout-entry': [entry: string]
  'mt::toggle-view-mode-entry': [entry: string]
  'mt::update-file': [payload: { type: 'add' | 'change' | 'unlink'; change: FileChangeDetail }]
  'mt::update-object-tree': [payload: unknown]
  'mt::user-preference': [partial: unknown]
  'mt::window-active-status': [active: boolean]
  'mt::window-enter-full-screen': []
  'mt::window-leave-full-screen': []
  'mt::window-maximize': []
  'mt::window-unmaximize': []
  'mt::window-zoom': [zoomLevel: number]
  'settings::change-tab': [tab: string]
}

// =================================================================
// Auxiliary types
// =================================================================

/**
 * Snapshot of the active OS keyboard layout, returned by
 * `mt::keybinding-get-keyboard-info`. Mirrors the runtime shape produced
 * by `native-keymap` (see `src/main/keyboard/index.ts#getKeyboardInfo`).
 */
export interface KeyboardInfo {
  layout: IKeyboardLayoutInfo
  keymap: IKeyboardMapping
}

/**
 * 浏览器面板单页状态快照（bp:getState 返回；STATE-MACHINE §1 WebPage 的主进程侧视图）。
 * canGoBack/canGoForward 来自 webContents.navigationHistory（Electron ≥ 32）。
 */
export interface BpPageState {
  canGoBack: boolean
  canGoForward: boolean
  url: string
  title: string
  loading: boolean
  error: string | null
  deviceMode: 'pc' | 'mobile'
}

/**
 * 网页面板缩放意图：in=放大、out=缩小、reset=回到 100%。
 * guest 内的键盘快捷键与工具栏按钮都归一到这三个动作。
 */
export type BpZoomAction = 'in' | 'out' | 'reset'

export interface BootInfo {
  platform: NodeJS.Platform
  arch: string
  versions: Record<string, string>
  env: Record<string, string>
  paths: {
    resources: string
    userData: string
    cwd: string
    ripgrepBinary: string
  }
  MARKDOWN_INCLUSIONS: string[]
}

// =================================================================
// Helper types for the preload bridge generic wrappers
// =================================================================

export type InvokeArgs<K extends keyof IpcInvokeChannels> = IpcInvokeChannels[K]['args']
export type InvokeRet<K extends keyof IpcInvokeChannels> = IpcInvokeChannels[K]['ret']

export type SyncArgs<K extends keyof IpcSyncChannels> = IpcSyncChannels[K]['args']
export type SyncRet<K extends keyof IpcSyncChannels> = IpcSyncChannels[K]['ret']

export type SendArgs<K extends keyof IpcSendChannels> = IpcSendChannels[K]

export type EventArgs<K extends keyof IpcMainEventChannels> = IpcMainEventChannels[K]
