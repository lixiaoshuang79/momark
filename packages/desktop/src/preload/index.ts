// Sandboxed preload: only `electron` can be required, and only a tiny subset of
// `process` is available (platform, versions, env). Everything else lives in
// the main process and is reached via IPC.
//
// All IPC traffic is funneled through the typed generics in
// `@shared/types/ipc` so channel names, argument tuples and return shapes
// are checked at the call site.

import { contextBridge, ipcRenderer, webFrame, webUtils } from 'electron'
import type { IpcRendererEvent } from 'electron'
import pathe from 'pathe'

import type {
  IpcInvokeChannels,
  IpcSendChannels,
  IpcSyncChannels,
  IpcMainEventChannels,
  BpZoomAction,
  BootInfo
} from '@shared/types/ipc'

type RendererEventListener<K extends keyof IpcMainEventChannels> = (
  event: IpcRendererEvent,
  ...args: IpcMainEventChannels[K]
) => void

const invoke = <K extends keyof IpcInvokeChannels>(
  channel: K,
  ...args: IpcInvokeChannels[K]['args']
): Promise<IpcInvokeChannels[K]['ret']> => ipcRenderer.invoke(channel, ...args)

const send = <K extends keyof IpcSendChannels>(channel: K, ...args: IpcSendChannels[K]): void =>
  ipcRenderer.send(channel, ...args)

// One synchronous handshake at startup so the renderer can read platform/env
// without an `await` from inside Vue computed properties etc.
const bootInfo = ipcRenderer.sendSync('mt::boot-info') as BootInfo | undefined

const ipcWrapper = {
  send,
  sendSync: <K extends keyof IpcSyncChannels>(
    channel: K,
    ...args: IpcSyncChannels[K]['args']
  ): IpcSyncChannels[K]['ret'] => ipcRenderer.sendSync(channel, ...args),
  invoke,
  on: <K extends keyof IpcMainEventChannels>(
    channel: K,
    listener: RendererEventListener<K>
  ): (() => void) => {
    const subscription = (event: IpcRendererEvent, ...args: unknown[]): void => {
      listener(event, ...(args as IpcMainEventChannels[K]))
    }
    ipcRenderer.on(channel, subscription)
    return () => ipcRenderer.removeListener(channel, subscription)
  },
  once: <K extends keyof IpcMainEventChannels>(
    channel: K,
    listener: RendererEventListener<K>
  ): (() => void) => {
    const subscription = (event: IpcRendererEvent, ...args: unknown[]): void => {
      listener(event, ...(args as IpcMainEventChannels[K]))
    }
    ipcRenderer.once(channel, subscription)
    return () => ipcRenderer.removeListener(channel, subscription)
  },
  removeAllListeners: (channel: keyof IpcMainEventChannels | string): void => {
    ipcRenderer.removeAllListeners(channel as string)
  }
}

const shellAPI = {
  openExternal: (url: string) => invoke('mt::shell::open-external', url),
  showItemInFolder: (fullPath: string) => send('mt::shell::show-item', fullPath),
  openPath: (fullPath: string) => invoke('mt::shell::open-path', fullPath)
}

const clipboardAPI = {
  writeText: (text: string) => send('mt::clipboard::write-text', text),
  readText: () => invoke('mt::clipboard::read-text'),
  guessFilePath: () => invoke('mt::clipboard::guess-file-path')
}

const webFrameAPI = {
  setZoomFactor: (factor: number): void => {
    if (typeof factor === 'number' && factor > 0) webFrame.setZoomFactor(factor)
  },
  setZoomLevel: (level: number): void => {
    if (typeof level === 'number') webFrame.setZoomLevel(level)
  }
}

const webUtilsAPI = {
  getPathForFile: (file: File): string => webUtils.getPathForFile(file)
}

const windowControlAPI = {
  minimize: () => send('mt::win::minimize'),
  maximize: () => send('mt::win::maximize'),
  unmaximize: () => send('mt::win::unmaximize'),
  toggleMaximize: () => send('mt::win::toggle-maximize'),
  close: () => send('mt::win::close'),
  setFullScreen: (flag: boolean) => send('mt::win::set-fullscreen', flag),
  toggleFullScreen: () => send('mt::win::toggle-fullscreen'),
  isMaximized: () => invoke('mt::win::is-maximized'),
  isFullScreen: () => invoke('mt::win::is-fullscreen'),
  popupMenu: (template: unknown, position?: { x: number; y: number }) =>
    send('mt::menu::popup', template as never, position),
  popupApplicationMenu: (position?: { x: number; y: number }) =>
    send('mt::menu::popup-application', position)
}

// These three predicates are pure path-string operations: implementing them
// in the preload keeps them synchronous so existing call sites like
// `tabs.find(t => isSamePathSync(t.pathname, ...))` keep returning the right
// item instead of a truthy Promise.
const MARKDOWN_EXTENSIONS = [
  'markdown',
  'mdown',
  'mkdn',
  'md',
  'mkd',
  'mdwn',
  'mdtxt',
  'mdtext',
  'mdx',
  'text',
  'txt'
] as const

const hasMarkdownExtension = (filename: string): boolean => {
  if (!filename || typeof filename !== 'string') return false
  return MARKDOWN_EXTENSIONS.some((ext) => filename.toLowerCase().endsWith(`.${ext}`))
}

const isChildOfDirectory = (dir: string, child: string): boolean => {
  if (!dir || !child) return false
  const relative = pathe.relative(dir, child)
  return !!relative && !relative.startsWith('..') && !pathe.isAbsolute(relative)
}

const isSamePathSync = (pathA: string, pathB: string, isNormalized: boolean = false): boolean => {
  if (!pathA || !pathB) return false
  const a = isNormalized ? pathA : pathe.normalize(pathA)
  const b = isNormalized ? pathB : pathe.normalize(pathB)
  if (a.length !== b.length) return false
  if (a === b) return true
  if (a.toLowerCase() === b.toLowerCase()) {
    // Case-insensitive filesystem fallback — block briefly on a sync IPC
    // because callers (tab matching) need a boolean answer right now.
    try {
      return ipcRenderer.sendSync('mt::paths::is-same-sync', a, b)
    } catch {
      return false
    }
  }
  return false
}

const fileUtilsAPI = {
  isFile: (p: string) => invoke('mt::fs::is-file', p),
  isDirectory: (p: string) => invoke('mt::fs::is-directory', p),
  emptyDir: (p: string) => invoke('mt::fs::empty-dir', p),
  copy: (src: string, dest: string) => invoke('mt::fs::copy', src, dest),
  ensureDir: (p: string) => invoke('mt::fs::ensure-dir', p),
  outputFile: (p: string, data: string | Uint8Array) => invoke('mt::fs::output-file', p, data),
  move: (src: string, dest: string) => invoke('mt::fs::move', src, dest),
  stat: (p: string) => invoke('mt::fs::stat', p),
  writeFile: (p: string, data: string | Uint8Array) => invoke('mt::fs::write-file', p, data),
  readFile: (p: string, encoding?: string) => invoke('mt::fs::read-file', p, encoding),
  pathExists: (p: string) => invoke('mt::fs::path-exists', p),
  unlink: (p: string) => invoke('mt::fs::unlink', p),
  readdir: (p: string) => invoke('mt::fs::readdir', p),
  isExecutable: (p: string) => invoke('mt::fs::is-executable', p),
  // Pure-string predicates — synchronous, no IPC for the common case.
  isChildOfDirectory,
  hasMarkdownExtension,
  isSamePathSync,
  // isImageFile needs an fs.statSync; keep it async via IPC.
  isImageFile: (p: string) => invoke('mt::paths::is-image', p),
  MARKDOWN_INCLUSIONS: bootInfo?.MARKDOWN_INCLUSIONS || []
}

const commandAPI = {
  exists: (name: string) => invoke('mt::cmd::exists', name)
}

const i18nAPI = {
  loadTranslations: (language: string) => invoke('mt::i18n::load', language)
}

type RipgrepHandler = (payload: unknown) => void
const ripgrepAPI = {
  start: (req: unknown) => invoke('mt::rg::start', req),
  cancel: (searchId: string) => send('mt::rg::cancel', searchId),
  onMatch: (handler: RipgrepHandler) => {
    const sub = (_e: IpcRendererEvent, payload: unknown) => handler(payload)
    ipcRenderer.on('mt::rg::match', sub)
    return () => ipcRenderer.removeListener('mt::rg::match', sub)
  },
  onProgress: (handler: RipgrepHandler) => {
    const sub = (_e: IpcRendererEvent, payload: unknown) => handler(payload)
    ipcRenderer.on('mt::rg::progress', sub)
    return () => ipcRenderer.removeListener('mt::rg::progress', sub)
  },
  onDone: (handler: RipgrepHandler) => {
    const sub = (_e: IpcRendererEvent, payload: unknown) => handler(payload)
    ipcRenderer.on('mt::rg::done', sub)
    return () => ipcRenderer.removeListener('mt::rg::done', sub)
  },
  onError: (handler: RipgrepHandler) => {
    const sub = (_e: IpcRendererEvent, payload: unknown) => handler(payload)
    ipcRenderer.on('mt::rg::error', sub)
    return () => ipcRenderer.removeListener('mt::rg::error', sub)
  },
  onCancelled: (handler: RipgrepHandler) => {
    const sub = (_e: IpcRendererEvent, payload: unknown) => handler(payload)
    ipcRenderer.on('mt::rg::cancelled', sub)
    return () => ipcRenderer.removeListener('mt::rg::cancelled', sub)
  }
}

const uploaderAPI = {
  uploadImage: (req: unknown) => invoke('mt::uploader::upload', req)
}

const fontsAPI = {
  list: () => invoke('mt::fonts::list')
}

// 右侧浏览器面板（PHASE2-SPEC §5）：白名单桥接。webview 元素本身由渲染层
// 创建；主进程经 bp:* 通道校验 URL、映射 guest webContents 并执行导航。
const bpAPI = {
  createPage: (url: string) => invoke('bp:createPage', url),
  register: (id: string, webContentsId: number) => invoke('bp:register', id, webContentsId),
  closePage: (id: string) => invoke('bp:closePage', id),
  activate: (id: string) => invoke('bp:activate', id),
  back: (id: string) => invoke('bp:back', id),
  forward: (id: string) => invoke('bp:forward', id),
  reload: (id: string) => invoke('bp:reload', id),
  setDeviceMode: (id: string, mode: 'pc' | 'mobile') => invoke('bp:setDeviceMode', id, mode),
  getState: (id: string) => invoke('bp:getState', id),
  // round18：面板输入上下文（面板开合/模式/激活页/编辑器焦点）。主进程据它
  // 判定缩放快捷键归属，避免 Cmd +=/-/0 落到左侧文档的段落标题快捷键上。
  setInputContext: (ctx: {
    open: boolean
    mode: 'url' | 'doc'
    activePageId: string | null
    editorFocused: boolean
  }) => send('bp:setInputContext', ctx),
  openExternal: (url: string) => invoke('bp:openExternal', url),
  pickDoc: () => invoke('bp:pickDoc'),
  readDoc: (path: string) => invoke('bp:readDoc', path),
  onNewWindowRequest: (
    handler: (payload: { url: string; fromPageId: string | null }) => void
  ): (() => void) => {
    const subscription = (
      _event: IpcRendererEvent,
      payload: { url: string; fromPageId: string | null }
    ): void => {
      handler(payload)
    }
    ipcRenderer.on('bp:new-window-request', subscription)
    return () => ipcRenderer.removeListener('bp:new-window-request', subscription)
  },
  onZoomCommand: (
    handler: (payload: { pageId: string; action: BpZoomAction }) => void
  ): (() => void) => {
    const subscription = (
      _event: IpcRendererEvent,
      payload: { pageId: string; action: BpZoomAction }
    ): void => {
      handler(payload)
    }
    ipcRenderer.on('bp:zoom-command', subscription)
    return () => ipcRenderer.removeListener('bp:zoom-command', subscription)
  }
}

const electronAPI = {
  ipcRenderer: ipcWrapper,
  shell: shellAPI,
  clipboard: clipboardAPI,
  webFrame: webFrameAPI,
  webUtils: webUtilsAPI,
  process: {
    platform: bootInfo?.platform || process.platform,
    arch: bootInfo?.arch,
    versions: bootInfo?.versions || {},
    env: bootInfo?.env || {},
    resourcesPath: bootInfo?.paths?.resources,
    cwd: bootInfo?.paths?.cwd
  },
  paths: bootInfo?.paths || {},
  windowControl: windowControlAPI
}

// Expose a Node-`path`-compatible API to the renderer. `pathe` is a
// cross-platform reimplementation that always uses `/` separators and works
// inside a sandboxed renderer.
const pathAPI = {
  basename: (...args: Parameters<typeof pathe.basename>) => pathe.basename(...args),
  dirname: (...args: Parameters<typeof pathe.dirname>) => pathe.dirname(...args),
  extname: (...args: Parameters<typeof pathe.extname>) => pathe.extname(...args),
  join: (...args: string[]) => pathe.join(...args),
  resolve: (...args: string[]) => pathe.resolve(...args),
  relative: (...args: Parameters<typeof pathe.relative>) => pathe.relative(...args),
  isAbsolute: (...args: Parameters<typeof pathe.isAbsolute>) => pathe.isAbsolute(...args),
  normalize: (...args: Parameters<typeof pathe.normalize>) => pathe.normalize(...args),
  parse: (...args: Parameters<typeof pathe.parse>) => pathe.parse(...args),
  format: (...args: Parameters<typeof pathe.format>) => pathe.format(...args),
  sep: pathe.sep,
  delimiter: pathe.delimiter
  // Note: `pathe.posix` / `pathe.win32` are intentionally not exposed.
  // Each contains a self-reference (`pathe.posix.posix === pathe.posix`),
  // which breaks structured cloning inside `contextBridge.exposeInMainWorld`.
  // No code in this repo reads `window.path.posix` / `window.path.win32`.
}

// Bundled third-party packages occasionally read `process.platform` at module
// load time (e.g. @hfelix/electron-localshortcut/src/utils.js). Expose a
// minimal browser-safe `process` global so those imports don't throw before
// the Vue app can mount.
const processShim = {
  platform: bootInfo?.platform || process.platform,
  arch: bootInfo?.arch,
  versions: bootInfo?.versions || {},
  env: bootInfo?.env || {},
  resourcesPath: bootInfo?.paths?.resources,
  cwd: () => bootInfo?.paths?.cwd,
  // Some libraries call `process.nextTick`; map it to the microtask queue.
  nextTick: (fn: (...args: unknown[]) => void, ...args: unknown[]) =>
    Promise.resolve().then(() => fn(...args))
}

try {
  contextBridge.exposeInMainWorld('electron', electronAPI)
  contextBridge.exposeInMainWorld('process', processShim)
  contextBridge.exposeInMainWorld('rgPath', bootInfo?.paths?.ripgrepBinary || '')
  contextBridge.exposeInMainWorld('fileUtils', fileUtilsAPI)
  contextBridge.exposeInMainWorld('path', pathAPI)
  contextBridge.exposeInMainWorld('commandExists', commandAPI)
  contextBridge.exposeInMainWorld('i18nUtils', i18nAPI)
  contextBridge.exposeInMainWorld('ripgrep', ripgrepAPI)
  contextBridge.exposeInMainWorld('uploader', uploaderAPI)
  contextBridge.exposeInMainWorld('fonts', fontsAPI)
  contextBridge.exposeInMainWorld('bp', bpAPI)
} catch (error) {
  console.error(error)
}
