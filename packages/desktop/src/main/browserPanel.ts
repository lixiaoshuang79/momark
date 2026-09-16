/**
 * 右侧浏览器面板主进程模块（PHASE2-SPEC §5 + research/reports/3.md 安全清单）。
 *
 * 职责边界（10.task.txt A.6）：
 *   - webview 由渲染层创建（DOM 合成），主进程只做 attach 校验与安全收紧，
 *     不引入 WebContentsView。
 *   - 全局 will-attach-webview 策略：仅 MoMark 编辑器宿主窗口允许挂载；
 *     src 必须是 http(s)；partition 统一为 persist:panel；强制注入安全
 *     webPreferences（sandbox / contextIsolation、不开 allowpopups、禁 Node）。
 *   - did-attach-webview 后对 guest 上锁：setWindowOpenHandler（新窗口一律
 *     面板内新建 Dock 页）、will-navigate / will-redirect 拦截非 http(s)。
 *   - persist:panel 分区 setPermissionRequestHandler 默认全拒；
 *     certificate-error 一律 callback(false)（显示不安全页）。
 *   - bp:* IPC：createPage/closePage/activate/back/forward/reload/getState，
 *     前进后退用 webContents.navigationHistory（Electron ≥ 32）。
 */

import { app, dialog, ipcMain, session, shell, BrowserWindow } from 'electron'
import type { Event, Input, WebContents, WebPreferences } from 'electron'
import log from 'electron-log'
import crypto from 'crypto'
import fs from 'fs/promises'
import {
  tryImportChromeCookies,
  getChromeCookieGuideState,
  markChromeCookieGuideShown
} from './chromeCookieSync'
import type { BpZoomAction } from '@shared/types/ipc'
import {
  panelOwnsZoomKey,
  zoomActionForCommand,
  type PanelInputContext
} from './browserPanelKeyRouting'

// ── 常量 ─────────────────────────────────────────────────────────────

export const BP_PARTITION = 'persist:panel'

const HTTP_URL_REG = /^https?:\/\//i

const MARKDOWN_FILTERS = [
  {
    name: 'Markdown',
    extensions: ['md', 'markdown', 'mdown', 'mkdn', 'mkd', 'mdwn', 'mdtxt', 'mdtext', 'mdx', 'txt']
  }
]

const isHttpUrl = (url: unknown): url is string => typeof url === 'string' && HTTP_URL_REG.test(url)

// round17：guest 缩放快捷键识别。Cmd（mac）/ Ctrl（其他平台）+ =、-、0；
// 主键盘与小键盘都接受（浏览器约定：Cmd+= 与 Cmd+Shift+= 同为放大）。
const zoomActionForInput = (input: Input): BpZoomAction | null => {
  if (input.type !== 'keyDown') return null
  const modifier = process.platform === 'darwin' ? input.meta : input.control
  if (!modifier) return null
  switch (input.key) {
    case '=':
    case '+':
    case 'Add':
      return 'in'
    case '-':
    case '_':
    case 'Subtract':
      return 'out'
    case '0':
      return 'reset'
    default:
      return null
  }
}

// 移动端 UA：iPhone Safari（用户拍板 round16 新功能——网页模式底部工具栏
// 可切换 PC / 移动端样式；setUserAgent 后必须 reload 才生效）。
export const MOBILE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1'

// 编辑器宿主窗口判定：MoMark 是 hash 路由 SPA，编辑器页为 #/editor，
// 设置窗口为 #/preference。仅编辑器窗口允许挂载面板 webview。
const isEditorHostContents = (contents: WebContents): boolean => {
  if (contents.getType() !== 'window') return false
  const url = contents.getURL()
  return /#\/editor(?:\?|$)/.test(url)
}

// ── 页面注册表（pageId → guest webContents）────────────────────────

interface BpPageRecord {
  id: string
  url: string
  hostWebContentsId: number
  webContentsId: number | null
}

interface GuestRuntimeState {
  loading: boolean
  error: string | null
  url: string
  title: string
  deviceMode: 'pc' | 'mobile'
}

const pageRecords = new Map<string, BpPageRecord>()
// guest 的运行时状态（did-attach-webview 起持续跟踪；-3 ERR_ABORTED 忽略）
const guestStates = new Map<number, GuestRuntimeState>()
// attach 时尚未 bp:register 的 guest 与宿主对应关系
const pendingGuests = new Map<number, { host: WebContents; guest: WebContents }>()
// round16：guest 的 PC/移动端切换函数（closure 持有 originalUa 派生逻辑）
const deviceModeAppliers = new Map<number, (mode: 'pc' | 'mobile') => void>()

// round18：面板输入上下文与缩放键归属判定（纯逻辑见 browserPanelKeyRouting.ts）
const panelInputContexts = new Map<number, PanelInputContext>()

/**
 * 缩放快捷键归属判定（由 Keybindings 的抢占钩子在命令执行前调用）。
 * 命中返回 true：意图已转交网页缩放，原命令不再执行。
 */
export const maybeRoutePanelZoomKey = (win: BrowserWindow, commandId: string): boolean => {
  const action = zoomActionForCommand(commandId)
  if (!action) return false
  if (!win || win.isDestroyed()) return false
  if (!panelOwnsZoomKey(panelInputContexts.get(win.webContents.id))) return false
  const ctx = panelInputContexts.get(win.webContents.id)
  win.webContents.send('bp:zoom-command', { pageId: ctx!.activePageId, action })
  return true
}

/**
 * 装上面板对缩放快捷键的抢占（app ready 时调用一次）。
 */
export const installPanelZoomKeyRouting = (keybindings: {
  setAcceleratorInterceptor: (
    fn: ((id: string, accelerator: string, win: BrowserWindow) => boolean) | null
  ) => void
}): void => {
  keybindings.setAcceleratorInterceptor((id, _accelerator, win) => maybeRoutePanelZoomKey(win, id))
}

const freshRuntimeState = (): GuestRuntimeState => ({
  loading: false,
  error: null,
  url: '',
  title: '',
  deviceMode: 'pc'
})

// ── guest 上锁（did-attach-webview）─────────────────────────────────

const hardenGuest = (host: WebContents, guest: WebContents): void => {
  const guestId = guest.id
  pendingGuests.set(guestId, { host, guest })
  if (!guestStates.has(guestId)) guestStates.set(guestId, freshRuntimeState())
  const st = guestStates.get(guestId) ?? freshRuntimeState()

  // round13（用户反馈「figma 半天加载不出来」）：根因=figma 文件页走
  // CloudFront WAF，识别 Electron/产品名 UA 直接 403（页面白屏）。
  // 剥离 UA 里的 Electron/墨记 标识，伪装成同内核标准 Chrome——
  // 实测：带 Electron 标识的 UA 请求 403、纯 Chrome UA 301 正常。
  // round16：原始 UA 留存一份，PC/移动端切换时从它派生（setUserAgent
  // 后再 getUserAgent 返回的是已替换值，重复剥离会丢失基准）。
  const originalUa = guest.getUserAgent()
  const cleanUa = originalUa.replace(/\sElectron\/[\d.]+/g, '').replace(/\s墨记\/[\d.]+/g, '')
  const uaByMode = (mode: 'pc' | 'mobile') => (mode === 'mobile' ? MOBILE_UA : cleanUa)
  guest.setUserAgent(cleanUa)
  st.deviceMode = 'pc'

  // round16：PC / 移动端样式切换。setUserAgent 只影响后续请求，
  // 当前页面内容不会变化，切换后 reload 让站点按新 UA 重排。
  const applyDeviceMode = (mode: 'pc' | 'mobile'): void => {
    if (st.deviceMode === mode) return
    st.deviceMode = mode
    guest.setUserAgent(uaByMode(mode))
    if (!guest.isDestroyed()) guest.reload()
  }
  deviceModeAppliers.set(guestId, applyDeviceMode)

  // 新窗口请求：http(s) → 面板内新建 Dock 页（渲染层监听 bp:new-window-request），
  // 其余一律拒绝。外开系统浏览器只走底部地址栏箭头（bp:openExternal）。
  guest.setWindowOpenHandler(({ url }) => {
    if (isHttpUrl(url)) {
      const fromPageId =
        [...pageRecords.values()].find((r) => r.webContentsId === guestId)?.id ?? null
      host.send('bp:new-window-request', { url, fromPageId })
    }
    return { action: 'deny' }
  })

  // 导航限制：拦截一切非 http(s) 目标（含 file://、自定义协议跳转）。
  guest.on('will-navigate', (event: Event, url: string) => {
    if (!isHttpUrl(url)) event.preventDefault()
  })
  guest.on('will-redirect', (event: Event, url: string) => {
    if (!isHttpUrl(url)) event.preventDefault()
  })

  // 运行时状态跟踪（供 bp:getState；renderer 侧 UI 同时用 webview DOM 事件）。
  guest.on('did-start-loading', () => {
    st.loading = true
    st.error = null
  })
  guest.on('did-stop-loading', () => {
    st.loading = false
  })
  guest.on('did-fail-load', (_e, errorCode, errorDescription, _validatedURL, isMainFrame) => {
    if (!isMainFrame) return
    if (errorCode === -3) return // ERR_ABORTED：用户中断/新导航，忽略
    st.loading = false
    st.error = errorDescription || String(errorCode)
  })
  guest.on('did-navigate', (_e, url) => {
    st.url = url
    st.error = null
  })
  // round17（用户反馈「登录后底部网址还是 /login」）：SPA 的路由切换走
  // history.pushState/replaceState，只触发 did-navigate-in-page，不触发
  // did-navigate——漏听它会让 st.url 停留在上一个整页导航的地址，
  // 从而经 bp:getState 把过期 URL 回灌给地址栏。
  guest.on('did-navigate-in-page', (_e, url, isMainFrame) => {
    if (!isMainFrame) return
    st.url = url
  })
  // round17：guest 内的缩放快捷键。webview 标签不暴露 before-input-event，
  // 只有主进程的 webContents 能拿到；菜单加速键在 guest 聚焦时同样不生效。
  // 这里只做「按键 → 意图」翻译并转交渲染层，缩放状态由渲染层统一持有。
  // round18：定位不到页面时**不再吞键**（旧实现无条件 preventDefault 后
  // 找不到 pageId 就丢弃，表现为「按了完全没反应」）——优先按 guest 映射，
  // 退而用宿主的面板激活页；两者都没有就放行给页面自己处理。
  guest.on('before-input-event', (event, input) => {
    const action = zoomActionForInput(input)
    if (!action) return
    const pageId =
      [...pageRecords.values()].find((r) => r.webContentsId === guestId)?.id ??
      panelInputContexts.get(host.id)?.activePageId ??
      null
    if (!pageId) return
    event.preventDefault()
    host.send('bp:zoom-command', { pageId, action })
  })
  guest.on('page-title-updated', (_e, title) => {
    st.title = title
  })
  guest.on('destroyed', () => {
    pendingGuests.delete(guestId)
    guestStates.delete(guestId)
    deviceModeAppliers.delete(guestId)
    for (const [pageId, record] of pageRecords) {
      if (record.webContentsId === guestId) pageRecords.delete(pageId)
    }
  })
}

const resolveGuest = (pageId: string, sender: WebContents): WebContents | null => {
  const record = pageRecords.get(pageId)
  if (!record) return null
  // 只有创建该页的宿主窗口能控制它。
  if (record.hostWebContentsId !== sender.id) return null
  if (record.webContentsId === null) return null
  return pendingGuests.get(record.webContentsId)?.guest ?? null
}

// ── webview 安全策略（web-contents-created）────────────────────────

export const installBrowserPanelSecurity = (): void => {
  app.on('web-contents-created', (_event, contents) => {
    if (contents.getType() === 'window') {
      // 宿主窗口（编辑器 / 设置）：仅编辑器允许挂载面板 webview。
      contents.on(
        'will-attach-webview',
        (event: Event, webPreferences: WebPreferences, params: Record<string, unknown>) => {
          if (!isEditorHostContents(contents)) {
            event.preventDefault()
            return
          }
          const src = params.src as unknown
          if (!isHttpUrl(src)) {
            log.warn('[browserPanel] rejected non-http(s) webview src:', String(src))
            event.preventDefault()
            return
          }
          // 分区统一 persist:panel（共享 cookie jar，登录态跨重启保留）。
          // 双保险：params.partition（webview 属性层）+ webPreferences.session
          // （偏好层）都指向同一分区，防止 attach 时序差异导致分区不一致。
          params.partition = BP_PARTITION
          webPreferences.session = session.fromPartition(BP_PARTITION)
          // 强制注入安全 webPreferences（report 3.md §5.3）：不可比宿主更宽松。
          // allowpopups 不在 WebPreferences 公开类型中（webview 元素属性 → guest
          // preferences 的运行时键），经类型断言写入 false。
          const prefs = webPreferences as WebPreferences & { allowpopups?: boolean }
          // 剥离 guest preload（官方安全示例：删除 webPreferences.preload，
          // 防渲染层被 XSS 后注入任意 preload 脚本）。
          delete prefs.preload
          if (params.preload !== undefined) params.preload = undefined
          prefs.sandbox = true
          prefs.contextIsolation = true
          prefs.nodeIntegration = false
          prefs.nodeIntegrationInSubFrames = false
          prefs.webSecurity = true
          prefs.allowpopups = false
          prefs.webviewTag = false // guest 内不允许再嵌套 webview
        }
      )
      contents.on('did-attach-webview', (_event: Event, guest: WebContents) => {
        hardenGuest(contents, guest)
      })
      // 宿主 SPA 不导航；任何导航尝试一律拦截。
      contents.on('will-navigate', (event: Event) => {
        event.preventDefault()
      })
      // round18：宿主窗口销毁后清掉它的输入上下文（避免 id 复用读到旧面板状态）。
      contents.on('destroyed', () => {
        panelInputContexts.delete(contents.id)
      })
      contents.setWindowOpenHandler(() => ({ action: 'deny' }))
    } else if (contents.getType() === 'webview') {
      // guest 内容：安全兜底——不允许 guest 再挂载 webview（webviewTag 已关）。
      contents.on('will-attach-webview', (event: Event) => {
        event.preventDefault()
      })
    }
  })

  // 证书错误一律拒绝（显示「连接不安全」失败态，不放行任何证书）。
  app.on('certificate-error', (_event, _webContents, _url, _error, _certificate, callback) => {
    // eslint-disable-next-line n/no-callback-literal -- Electron 契约：布尔值=是否信任证书，非 error-first 回调
    callback(false)
  })

  // persist:panel 分区：权限请求默认全拒（摄像头/麦克风/地理位置/通知）。
  // session 只能在 app ready 之后取用（过早调用会抛
  // "Session can only be received when app is ready"），故挂到 whenReady。
  app.whenReady().then(() => {
    const panelSession = session.fromPartition(BP_PARTITION)
    panelSession.setPermissionRequestHandler((_webContents, permission, callback) => {
      log.info('[browserPanel] permission denied by default:', permission)
      // eslint-disable-next-line n/no-callback-literal -- Electron 契约：布尔值=是否授权，非 error-first 回调
      callback(false)
    })
    panelSession.setPermissionCheckHandler((_webContents, permission) => {
      return permission === 'clipboard-sanitized-write'
    })
    // 下载仅放行 http(s)（report 3.md §5.9：默认拦截非 http(s)）。
    panelSession.on('will-download', (_event, item) => {
      if (!isHttpUrl(item.getURL())) item.cancel()
    })

    // round11 新功能（用户拍板）：启动时把 Chrome 登录 cookie 导入面板分区
    // （已登录站点免重新输密码）。TCC 挡住时静默等待——引导改由渲染层
    // 就绪后经 bp:chrome-cookie-guide-state 拉取（首启是欢迎页，推式会丢）。
    tryImportChromeCookies()
      .then((result) => {
        log.info('[browserPanel] chrome cookie import result:', result)
      })
      .catch(() => {})
  })

  // 渲染层就绪后拉取：Chrome 数据被 TCC 挡住且未引导过 → 弹一次性授权引导。
  ipcMain.handle('bp:chrome-cookie-guide-state', () => getChromeCookieGuideState())

  // 引导已展示（用户点掉引导 toast 后落标志，重启后不再打扰）。
  ipcMain.on('mt::chrome-cookie-guide-mark-shown', () => {
    markChromeCookieGuideShown()
  })
}

// ── IPC 注册 ────────────────────────────────────────────────────────

export const registerBrowserPanelIpc = (): void => {
  // round18：面板输入上下文（渲染层在「面板开合 / 模式 / 激活页 / 编辑器焦点」
  // 变化时推送）。只为缩放快捷键归属判定服务，不参与任何渲染。
  ipcMain.on('bp:setInputContext', (event, payload: PanelInputContext) => {
    if (!payload || typeof payload !== 'object') return
    panelInputContexts.set(event.sender.id, {
      open: !!payload.open,
      mode: payload.mode === 'doc' ? 'doc' : 'url',
      activePageId: typeof payload.activePageId === 'string' ? payload.activePageId : null,
      editorFocused: !!payload.editorFocused
    })
  })

  ipcMain.handle('bp:createPage', (event, url: string) => {
    if (!isHttpUrl(url)) {
      log.warn('[browserPanel] bp:createPage rejected:', url)
      throw new Error('Only http(s) URLs can be opened in the browser panel.')
    }
    const id = `bp-${crypto.randomUUID()}`
    pageRecords.set(id, {
      id,
      url,
      hostWebContentsId: event.sender.id,
      webContentsId: null
    })
    return id
  })

  ipcMain.handle('bp:register', (event, id: string, webContentsId: number) => {
    const record = pageRecords.get(id)
    if (!record || record.hostWebContentsId !== event.sender.id) return
    const entry = pendingGuests.get(webContentsId)
    if (!entry) return
    const { guest } = entry
    record.webContentsId = guest.id
    if (!guestStates.has(guest.id)) guestStates.set(guest.id, freshRuntimeState())
  })

  ipcMain.handle('bp:closePage', (event, id: string) => {
    const guest = resolveGuest(id, event.sender)
    pageRecords.delete(id)
    if (guest && !guest.isDestroyed()) {
      try {
        guest.close()
      } catch (error) {
        log.error('[browserPanel] close guest failed:', error)
      }
    }
  })

  ipcMain.handle('bp:activate', (event, id: string) => {
    const guest = resolveGuest(id, event.sender)
    if (guest && !guest.isDestroyed()) guest.focus()
  })

  ipcMain.handle('bp:back', (event, id: string) => {
    const guest = resolveGuest(id, event.sender)
    if (!guest || guest.isDestroyed()) return
    if (guest.navigationHistory.canGoBack()) guest.navigationHistory.goBack()
  })

  ipcMain.handle('bp:forward', (event, id: string) => {
    const guest = resolveGuest(id, event.sender)
    if (!guest || guest.isDestroyed()) return
    if (guest.navigationHistory.canGoForward()) guest.navigationHistory.goForward()
  })

  ipcMain.handle('bp:reload', (event, id: string) => {
    const guest = resolveGuest(id, event.sender)
    if (guest && !guest.isDestroyed()) guest.reload()
  })

  // round16：PC / 移动端样式切换（navBar 底部工具栏按钮）。
  ipcMain.handle('bp:setDeviceMode', (event, id: string, mode: unknown) => {
    if (mode !== 'pc' && mode !== 'mobile') return false
    const guest = resolveGuest(id, event.sender)
    if (!guest || guest.isDestroyed()) return false
    deviceModeAppliers.get(guest.id)?.(mode)
    return true
  })

  ipcMain.handle('bp:getState', (event, id: string) => {
    const record = pageRecords.get(id)
    const guest = resolveGuest(id, event.sender)
    const fallback = {
      canGoBack: false,
      canGoForward: false,
      url: record?.url ?? '',
      title: '',
      loading: false,
      error: null,
      deviceMode: 'pc' as 'pc' | 'mobile'
    }
    if (!guest || guest.isDestroyed()) return fallback
    const st = guestStates.get(guest.id) ?? freshRuntimeState()
    let canGoBack = false
    let canGoForward = false
    try {
      canGoBack = guest.navigationHistory.canGoBack()
      canGoForward = guest.navigationHistory.canGoForward()
    } catch {
      // navigationHistory 在极早/已销毁窗口可能抛错，退回禁用态。
    }
    return {
      canGoBack,
      canGoForward,
      // round17：guest 自己的实时 URL 优先——st.url 只在导航事件里被写，
      // 任何事件缺口（如被拦掉的路由）都会让旧值永久覆盖真实地址。
      url: guest.getURL() || st.url || record?.url || '',
      title: st.title || guest.getTitle(),
      loading: st.loading || guest.isLoading(),
      error: st.error,
      deviceMode: st.deviceMode
    }
  })

  ipcMain.handle('bp:openExternal', async (_event, url: string) => {
    if (!isHttpUrl(url)) return false
    try {
      await shell.openExternal(url)
      return true
    } catch (error) {
      log.error('[browserPanel] openExternal failed:', error)
      return false
    }
  })

  ipcMain.handle('bp:pickDoc', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return null
    const { canceled, filePaths } = await dialog.showOpenDialog(win, {
      title: '打开 Markdown 文件',
      properties: ['openFile'],
      filters: MARKDOWN_FILTERS
    })
    if (canceled || filePaths.length === 0) return null
    const filePath = filePaths[0]
    try {
      const markdown = await fs.readFile(filePath, 'utf-8')
      return { path: filePath, markdown }
    } catch (error) {
      log.error('[browserPanel] read doc failed:', error)
      return null
    }
  })

  // 最近打开列表点击：按路径直读并在右侧面板文档模式预览（不建标签）。
  ipcMain.handle('bp:readDoc', async (_event, filePath: string) => {
    if (typeof filePath !== 'string' || !filePath) return null
    try {
      const markdown = await fs.readFile(filePath, 'utf-8')
      return { path: filePath, markdown }
    } catch (error) {
      log.error('[browserPanel] readDoc failed:', error)
      return null
    }
  })
}
