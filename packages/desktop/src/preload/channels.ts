/**
 * 渲染层 ↔ 主进程的**通道白名单**（A-12 / webSecurity 恢复）。
 *
 * 为什么放在 preload：preload 是页面脚本能碰到的唯一 IPC 入口。桥接层过去
 * 直接把 channel 字符串转给 `ipcRenderer`，等于把「任意通道调用」做完一次 XSS
 * 就送给攻击者——主进程注册的每个通道都可被调用，包括内部事件通道。这里把
 * 契约（`@shared/types/ipc` 的四个接口）落成运行时集合，未知通道一律拒绝。
 *
 * 完整性由编译器兜底：文件末尾的类型断言要求四个数组与四个接口的键**完全相等**
 * （少一个 → `vue-tsc` 报错，多一个 → 同样报错），所以不存在「漏一个就是功能断」
 * 的静默风险。新增通道时照 `@shared/types/ipc` 的注释走：接口加键 + 这里加字面量。
 */

import type {
  IpcInvokeChannels,
  IpcSendChannels,
  IpcSyncChannels,
  IpcMainEventChannels
} from '@shared/types/ipc'

/** `ipcRenderer.invoke` 允许的通道（renderer → main，带返回值）。 */
export const INVOKE_CHANNELS = [
  // renderer → main（invoke）
  'bp:activate',
  'bp:back',
  'bp:chrome-cookie-guide-state',
  'bp:closePage',
  'bp:createPage',
  'bp:forward',
  'bp:getState',
  'bp:openExternal',
  'bp:pickDoc',
  'bp:readDoc',
  'bp:register',
  'bp:reload',
  'bp:setDeviceMode',
  'mt::annotation::load',
  'mt::annotation::migrate-path',
  'mt::annotation::save',
  'mt::update-check',
  'mt::update-download',
  'mt::update-install',
  'mt::update-open-release',
  'mt::ask-for-image-path',
  'mt::boot-info-async',
  'mt::clipboard::guess-file-path',
  'mt::clipboard::read-text',
  'mt::cmd::exists',
  'mt::export::rasterize-html-frame',
  'mt::fonts::list',
  'mt::fs-trash-item',
  'mt::fs::copy',
  'mt::fs::empty-dir',
  'mt::fs::ensure-dir',
  'mt::fs::is-directory',
  'mt::fs::is-executable',
  'mt::fs::is-file',
  'mt::fs::move',
  'mt::fs::output-file',
  'mt::fs::path-exists',
  'mt::fs::read-file',
  'mt::fs::readdir',
  'mt::fs::stat',
  'mt::fs::unlink',
  'mt::fs::write-file',
  'mt::i18n::is-supported',
  'mt::i18n::load',
  'mt::i18n::supported',
  'mt::keybinding-get-keyboard-info',
  'mt::keybinding-get-pref-keybindings',
  'mt::keybinding-save-user-keybindings',
  'mt::paths::is-image',
  'mt::rg::start',
  'mt::shell::open-external',
  'mt::shell::open-path',
  'mt::spellchecker-get-available-dictionaries',
  'mt::spellchecker-get-custom-dictionary-words',
  'mt::spellchecker-remove-word',
  'mt::spellchecker-set-enabled',
  'mt::spellchecker-switch-language',
  'mt::uploader::upload',
  'mt::welcome::recents',
  'mt::win::is-fullscreen',
  'mt::win::is-maximized',
  'update-buffer-state'
] as const

/** `ipcRenderer.send` 允许的通道（renderer → main，无返回值）。 */
export const SEND_CHANNELS = [
  // renderer → main（send）
  'app-create-about-window',
  'app-create-editor-window',
  'app-create-settings-window',
  'app-open-directory-by-id',
  'app-open-file-by-id',
  'app-open-files-by-id',
  'app-open-markdown-by-id',
  'bp:new-window-request',
  'bp:setInputContext',
  'bp:zoom-command',
  'broadcast-preferences-changed',
  'broadcast-user-data-changed',
  'menu-add-recently-used',
  'menu-clear-recently-used',
  'mt::add-recently-used-document',
  'mt::app-try-quit',
  'mt::ask-for-image-auto-path',
  'mt::ask-for-modify-image-folder-path',
  'mt::ask-for-open-project-in-sidebar',
  'mt::ask-for-user-data',
  'mt::ask-for-user-preference',
  'mt::chrome-cookie-guide-mark-shown',
  'mt::clipboard::write-text',
  'mt::close-window',
  'mt::close-window-confirm',
  'mt::cmd-close-window',
  'mt::cmd-import-file',
  'mt::cmd-new-editor-window',
  'mt::cmd-open-file',
  'mt::cmd-open-folder',
  'mt::cmd-toggle-autosave',
  'mt::editor-selection-changed',
  'mt::export-cancel',
  'mt::format-link-click',
  'mt::get-current-language',
  'mt::handle-renderer-error',
  'mt::keybinding-debug-dump-keyboard-info',
  'mt::make-screenshot',
  'mt::menu::popup',
  'mt::menu::popup-application',
  'mt::open-file',
  'mt::open-file-by-window-id',
  'mt::open-keybindings-config',
  'mt::open-setting-window',
  'mt::rename',
  'mt::request-keybindings',
  'mt::response-export',
  'mt::response-file-move-to',
  'mt::response-file-save',
  'mt::response-file-save-as',
  'mt::response-print',
  'mt::rg::cancel',
  'mt::save-and-close-tabs',
  'mt::save-tabs',
  'mt::select-default-directory-to-open',
  'mt::set-editor-format-menus-enabled',
  'mt::set-user-data',
  'mt::set-user-preference',
  'mt::shell::open-external',
  'mt::shell::show-item',
  'mt::update-format-menu',
  'mt::update-line-ending-menu',
  'mt::update-sidebar-menu',
  'mt::view-layout-changed',
  'mt::welcome::new-doc',
  'mt::welcome::open-file',
  'mt::welcome::open-folder',
  'mt::welcome::open-recent',
  'mt::win::close',
  'mt::win::maximize',
  'mt::win::minimize',
  'mt::win::set-fullscreen',
  'mt::win::toggle-fullscreen',
  'mt::win::toggle-maximize',
  'mt::win::unmaximize',
  'mt::window-add-file-path',
  'mt::window-initialized',
  'mt::window-tab-closed',
  'mt::window-toggle-always-on-top',
  'mt::window::drop',
  'screen-capture',
  'set-image-folder-path',
  'set-user-preference',
  'watcher-unwatch-all-by-id',
  'watcher-unwatch-directory',
  'watcher-unwatch-file',
  'watcher-watch-directory',
  'watcher-watch-file',
  'window-add-file-path',
  'window-change-file-path',
  'window-close-by-id',
  'window-file-saved',
  'window-reload-by-id',
  'window-toggle-always-on-top'
] as const

/** `ipcRenderer.sendSync` 允许的通道（同步阻塞，必须极少）。 */
export const SYNC_CHANNELS = [
  // renderer → main（sendSync）
  'mt::boot-info',
  'mt::paths::is-same-sync'
] as const

/** 允许渲染层 `on` / `once` 订阅的主进程推送通道。 */
export const EVENT_CHANNELS = [
  // main → renderer（on/once）
  'language-changed',
  'mt::ask-for-close',
  'mt::bootstrap-editor',
  'mt::cm-copy-as-html',
  'mt::cm-copy-as-rich',
  'mt::cm-insert-paragraph',
  'mt::cm-paste-as-plain-text',
  'mt::current-language',
  'mt::editor-ask-file-save',
  'mt::editor-ask-file-save-as',
  'mt::editor-close-tab',
  'mt::editor-edit-action',
  'mt::editor-format-action',
  'mt::editor-move-file',
  'mt::editor-paragraph-action',
  'mt::editor-rename-file',
  'mt::execute-command-by-id',
  'mt::export-failure',
  'mt::export-progress',
  'mt::export-success',
  'mt::file-saved',
  'mt::force-close-tabs-by-id',
  'mt::invalidate-image-cache',
  'mt::keybindings-response',
  'mt::load-state',
  'mt::menu::click',
  'mt::menu::closed',
  'mt::new-untitled-tab',
  'mt::open-directory',
  'mt::open-new-tab',
  'mt::pandoc-not-exists',
  'mt::print-service-clearup',
  'mt::rg::cancelled',
  'mt::rg::done',
  'mt::rg::error',
  'mt::rg::match',
  'mt::rg::progress',
  'mt::screenshot-captured',
  'mt::set-line-ending',
  'mt::set-pathname',
  'mt::set-view-layout',
  'mt::show-command-palette',
  'mt::show-export-dialog',
  'mt::show-notification',
  'mt::spelling-replace-misspelling',
  'mt::spelling-show-switch-language',
  'mt::switch-tab-by-file_path',
  'mt::switch-tab-by-index',
  'mt::tab-save-failure',
  'mt::tab-saved',
  'mt::tabs-cycle-left',
  'mt::tabs-cycle-right',
  'mt::toggle-view-layout-entry',
  'mt::toggle-view-mode-entry',
  'mt::update-progress',
  'mt::update-file',
  'mt::update-object-tree',
  'mt::user-preference',
  'mt::window-active-status',
  'mt::window-enter-full-screen',
  'mt::window-leave-full-screen',
  'mt::window-maximize',
  'mt::window-unmaximize',
  'mt::window-zoom',
  'settings::change-tab'
] as const

export const INVOKE_CHANNEL_SET: ReadonlySet<string> = new Set(INVOKE_CHANNELS)
export const SEND_CHANNEL_SET: ReadonlySet<string> = new Set(SEND_CHANNELS)
export const SYNC_CHANNEL_SET: ReadonlySet<string> = new Set(SYNC_CHANNELS)
export const EVENT_CHANNEL_SET: ReadonlySet<string> = new Set(EVENT_CHANNELS)

export const isInvokeChannel = (channel: string): boolean => INVOKE_CHANNEL_SET.has(channel)
export const isSendChannel = (channel: string): boolean => SEND_CHANNEL_SET.has(channel)
export const isSyncChannel = (channel: string): boolean => SYNC_CHANNEL_SET.has(channel)
export const isEventChannel = (channel: string): boolean => EVENT_CHANNEL_SET.has(channel)

// ── 完整性断言（编译期）──────────────────────────────────────────────
// `Equal<A, B>` 只在两个类型逐字相等时为 true；`Expect<T extends true>` 在
// 不满足时把错误落在这一行上。这四个断言就是「白名单 == 通道契约」的证明。
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false
type Expect<T extends true> = T

type InvokeListMatches = Expect<Equal<keyof IpcInvokeChannels, (typeof INVOKE_CHANNELS)[number]>>
type SendListMatches = Expect<Equal<keyof IpcSendChannels, (typeof SEND_CHANNELS)[number]>>
type SyncListMatches = Expect<Equal<keyof IpcSyncChannels, (typeof SYNC_CHANNELS)[number]>>
type EventListMatches = Expect<Equal<keyof IpcMainEventChannels, (typeof EVENT_CHANNELS)[number]>>

// 让「断言类型」不被 noUnusedLocals 之类的规则判为死代码：导出一个只读别名。
export type { InvokeListMatches, SendListMatches, SyncListMatches, EventListMatches }
