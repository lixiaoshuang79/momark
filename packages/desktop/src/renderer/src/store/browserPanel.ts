import { ref, watch } from 'vue'
import { defineStore } from 'pinia'
import notice from '@/services/notification'
import type { BpZoomAction } from '@shared/types/ipc'
import { useSplitStore } from './split'

/**
 * 右侧浏览器面板状态（STATE-MACHINE §1 BpState，PHASE2-SPEC §5）。
 * 网址模式每页一个 <webview> 实例（partition=persist:panel），页面实例保活
 * 由渲染层 DOM 合成负责（display 切换保留登录态/滚动/历史），主进程只做
 * attach 校验与安全收紧。
 */

export interface WebPage {
  id: string
  url: string
  title: string
  favicon: string | null
  loading: boolean
  error: string | null
  // round17：页面缩放（1 = 100%）。快捷键、工具栏与「适应宽度」共用这一份状态。
  zoom: number
  // 「适应宽度」开关：打开后由 webview 组件按内容实际宽度反算 zoom。
  // 用户手动缩放（快捷键/工具栏）会关掉它，避免自动值覆盖手动意图。
  fitWidth: boolean
}

export type BpMode = 'url' | 'doc'
export type BpDragState = 'none' | 'over' | 'blocked'

// 缩放钳位与步进：几何递进 ×1.1。下限取 0.2 而非编辑器 HTML 块的 0.5——
// 面板只有 ~288px 宽，固定 1200px 宽的后台页要完整显示必须能缩到 ~0.25。
// 0.25 是 Blink 页面缩放的硬下限（实测 setZoomFactor(0.2/0.22/0.24) 一律按
// 0.25 渲染，getZoomFactor 却回显传入值），写更小的数只会让显示百分比撒谎。
export const ZOOM_MIN = 0.25
export const ZOOM_MAX = 3
const ZOOM_STEP = 1.1
const clampZoom = (value: number): number =>
  Math.round(Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, value)) * 1000) / 1000

// 地址输入判断（report 3.md §4）：已有协议直接加载；域名样式/IP/localhost
// 自动补 https://；其余转 Google 搜索。
export const resolveInput = (raw: string): string | null => {
  const t = raw.trim()
  if (!t) return null
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(t)) return t
  if (/^localhost(:\d+)?([/?#].*)?$/i.test(t)) return `https://${t}`
  const noSpace = !/\s/.test(t)
  const hasDot = t.includes('.') && !t.endsWith('.')
  const isIp = /^\d{1,3}(\.\d{1,3}){3}(:\d+)?([/?#].*)?$/.test(t)
  if (noSpace && (hasDot || isIp)) return `https://${t}`
  return `https://www.google.com/search?q=${encodeURIComponent(t)}`
}

export const useBrowserPanelStore = defineStore('browserPanel', () => {
  const open = ref(false)
  const mode = ref<BpMode>('url')
  const urlPages = ref<WebPage[]>([])
  const activePageId = ref<string | null>(null)
  const dockAddrOpen = ref(false)
  const dragState = ref<BpDragState>('none')
  // 网页模式面板宽度（分隔线可拖动，240px ≤ w ≤ 60% 窗宽；会话内保持，
  // 不落盘，重启回 288px 默认）。文档分屏的宽度归 split.width 管。
  const urlWidth = ref(288)

  // round16（用户拍板）：网页 PC / 移动端样式。面板级状态——切换作用于
  // 当前激活页（主进程换 UA + reload），新建页沿用当前模式。
  const deviceMode = ref<'pc' | 'mobile'>('pc')

  let unlistenNewWindow: (() => void) | null = null
  let unlistenZoomCommand: (() => void) | null = null
  let unlistenInputContext: (() => void) | null = null

  function SET_URL_WIDTH(value: number): void {
    const win = window.innerWidth
    const min = 240
    const max = Math.max(min, win * 0.6)
    urlWidth.value = Math.round(Math.max(min, Math.min(max, value)))
  }

  function SET_OPEN(value: boolean): void {
    open.value = value
    if (!value) {
      dragState.value = 'none'
      dockAddrOpen.value = false
    }
  }

  // 右栏开关只做视觉收起/展开：不影响面板内的内容与状态——
  // 分屏文档、网页、预览文档在收起后保持（用户拍板：关闭右侧边栏
  // 或切换网页/文档模式都不影响里面的内容和状态）。分屏的关闭走
  // 顶栏右文档名 × / 拖回标签栏。
  function TOGGLE_PANEL(): void {
    SET_OPEN(!open.value)
  }

  function SET_MODE(next: BpMode): void {
    mode.value = next
    const splitStore = useSplitStore()
    if (splitStore.active) {
      // 分屏激活时，网址/文档切换同时驱动 SplitState.kind
      // （split-url1 / split-urlN 场景推导，STATE-MACHINE §1）。
      splitStore.SET_KIND(next === 'url' ? 'url' : 'doc')
    }
  }

  // 新建网页实例：主进程校验 URL 并分配 id，渲染层随后创建 <webview>。
  async function ADD_WEB_PAGE(input: string): Promise<string | null> {
    const target = resolveInput(input)
    if (!target) return null
    try {
      const id = await window.bp.createPage(target)
      urlPages.value.push({
        id,
        url: target,
        title: target,
        favicon: null,
        loading: true,
        error: null,
        // 新页默认开启「适应宽度」：窄面板里固定宽度站点会要求左右滑动，
        // 自适应站点量不到溢出、不会被缩放（因子保持 1）。
        zoom: 1,
        fitWidth: true
      })
      activePageId.value = id
      // round18：新建页后收起搜索栏（单页↔多页切换时「+ / 搜索栏」控件会换
      // 落点，展开态跨落点复用会留下一个凭空展开的搜索栏）。
      dockAddrOpen.value = false
      // 面板处于移动端模式时，新页沿用当前模式（attach 后主进程换 UA）。
      if (deviceMode.value === 'mobile') await window.bp.setDeviceMode(id, 'mobile')
      return id
    } catch {
      notice.notify({ message: '无法打开网址（仅支持 http/https）', type: 'error', time: 2500 })
      return null
    }
  }

  // round16：PC / 移动端样式切换（底部工具栏按钮）。切换只作用于当前
  // 激活页；主进程 setUserAgent + reload，页面按新 UA 重排。
  async function TOGGLE_DEVICE_MODE(): Promise<void> {
    const id = activePageId.value
    if (!id) return
    const next: 'pc' | 'mobile' = deviceMode.value === 'pc' ? 'mobile' : 'pc'
    const ok = await window.bp.setDeviceMode(id, next)
    if (ok) {
      deviceMode.value = next
      UPDATE_PAGE_STATE(id, { loading: true, error: null })
    }
  }

  function ACTIVATE_PAGE(id: string): void {
    if (!urlPages.value.some((p) => p.id === id)) return
    activePageId.value = id
    if (urlPages.value.length <= 1) dockAddrOpen.value = false
    window.bp.activate(id)
  }

  async function CLOSE_PAGE(id: string): Promise<void> {
    const index = urlPages.value.findIndex((p) => p.id === id)
    if (index === -1) return
    urlPages.value.splice(index, 1)
    window.bp.closePage(id)
    // round18：页数变化会换「+ / 搜索栏」的落点，顺手收起展开态（同上）。
    dockAddrOpen.value = false
    if (activePageId.value === id) {
      const next = urlPages.value[Math.min(index, urlPages.value.length - 1)] ?? null
      activePageId.value = next ? next.id : null
    }
  }

  // webview DOM 事件（did-start-loading / did-fail-load 等）回写页面状态。
  function UPDATE_PAGE_STATE(id: string, partial: Partial<WebPage>): void {
    const page = urlPages.value.find((p) => p.id === id)
    if (!page) return
    Object.assign(page, partial)
  }

  function SET_DOCK_ADDR_OPEN(value: boolean): void {
    dockAddrOpen.value = value
  }

  // ── 缩放（round17）────────────────────────────────────────────────
  // 状态唯一来源在这里：键盘快捷键（主进程翻译成意图后回传）、工具栏
  // 按钮、「适应宽度」的反算结果最终都落到 page.zoom，由 webviewPage.vue
  // 单点执行 setZoomFactor。

  function SET_PAGE_ZOOM(id: string, factor: number): void {
    const page = urlPages.value.find((p) => p.id === id)
    if (!page) return
    page.zoom = clampZoom(factor)
  }

  function SET_FIT_WIDTH(id: string, value: boolean): void {
    const page = urlPages.value.find((p) => p.id === id)
    if (!page) return
    page.fitWidth = value
  }

  // 缩放浮标（HUD）：只在用户主动操作时出现——「适应宽度」的自动反算不打扰。
  // seq 用于同文案连续触发时也能重置组件的隐藏计时器。
  const zoomHint = ref<{ text: string; seq: number } | null>(null)
  let zoomHintSeq = 0

  function SHOW_ZOOM_HINT(text: string): void {
    zoomHint.value = { text, seq: ++zoomHintSeq }
  }

  // 手动缩放（快捷键 / 工具栏）：一旦手动介入就关掉「适应宽度」，
  // 否则下一次反算会把手动值覆盖掉（round15 HTML 块缩放的同一教训）。
  function APPLY_ZOOM_ACTION(id: string, action: BpZoomAction): void {
    const page = urlPages.value.find((p) => p.id === id)
    if (!page) return
    if (action === 'reset') {
      page.fitWidth = false
      page.zoom = 1
      SHOW_ZOOM_HINT('100%')
      return
    }
    page.fitWidth = false
    const next = action === 'in' ? page.zoom * ZOOM_STEP : page.zoom / ZOOM_STEP
    page.zoom = clampZoom(next)
    SHOW_ZOOM_HINT(`${Math.round(page.zoom * 100)}%`)
  }

  function TOGGLE_FIT_WIDTH(): void {
    const id = activePageId.value
    if (!id) return
    const page = urlPages.value.find((p) => p.id === id)
    if (!page) return
    page.fitWidth = !page.fitWidth
    // 开：先出「适应宽度 开」，组件量完宽度后会把浮标细化成「适应宽度 · 78%」。
    SHOW_ZOOM_HINT(page.fitWidth ? '适应宽度' : '适应宽度 · 关')
  }

  // ── 文档模式的 HTML 渲染页 ────────────────────────────────────────────
  // 编辑器内嵌 HTML 块的工具条「在侧栏打开」落点：右栏文档模式下以
  // sandbox iframe（与编辑器内嵌同一隔离等级，不透明源）渲染该页面。
  // 与分屏 md 文档互斥（docMode 内容区同一时刻只显示一种内容），
  // 打开/新建文档时由 docMode 清空。
  interface HtmlDocView {
    src: string
    title: string
    // 块源码：侧栏 iframe 与编辑器内嵌用的是同一个引导页空壳，必须由父窗口
    // 投递源码（协议另一端在 src/renderer/public/html-frame.html）。
    html?: string
  }

  const htmlDoc = ref<HtmlDocView | null>(null)

  function OPEN_HTML_DOC(src: string, title: string, html = ''): void {
    SET_OPEN(true)
    SET_MODE('doc')
    htmlDoc.value = { src, title, html }
  }

  function CLOSE_HTML_DOC(): void {
    htmlDoc.value = null
  }

  function SET_DRAG_STATE(value: BpDragState): void {
    dragState.value = value
  }

  // 地址栏外开箭头：仅 http(s) 允许 shell.openExternal（主进程二次校验）。
  // round11 通知精简（用户拍板）：新窗口在系统浏览器即时可见，
  // 「已在默认浏览器中打开」toast 属打扰，已移除。
  async function OPEN_EXTERNAL(url: string): Promise<void> {
    await window.bp.openExternal(url)
  }

  // round18：把「面板输入上下文」推给主进程，供缩放快捷键归属判定使用。
  // 判定规则（主进程 browserPanel.ts）：面板正在展示网页 + 光标不在编辑器里
  // → Cmd +=/-/0 归网页缩放；光标在编辑器里 → 保留原有段落快捷键语义。
  // 只推 4 个布尔/字符串，不参与渲染，也不进任何持久化。
  function installInputContextPush(): () => void {
    const isEditorFocused = (): boolean => {
      const el = document.activeElement as HTMLElement | null
      if (!el || !el.closest('.editor-component')) return false
      // 面板内的文档预览编辑器不算「在写文档」。
      return !el.closest('.bpanel')
    }
    const push = (): void => {
      window.bp.setInputContext({
        open: open.value,
        mode: mode.value,
        activePageId: activePageId.value,
        editorFocused: isEditorFocused()
      })
    }
    // focusout 触发时焦点还没落到新元素上（activeElement 仍是旧值），延一帧再读。
    const pushAfterFocusMove = (): void => {
      window.setTimeout(push, 0)
    }
    const stopWatch = watch([open, mode, activePageId], push)
    document.addEventListener('focusin', push)
    document.addEventListener('focusout', pushAfterFocusMove)
    push()
    return () => {
      stopWatch()
      document.removeEventListener('focusin', push)
      document.removeEventListener('focusout', pushAfterFocusMove)
    }
  }

  // guest 内 window.open / target=_blank（http/https）→ 面板内新建 Dock 页。
  // round17：外加 guest 内的缩放快捷键（主进程 before-input-event 翻译后回传）。
  function LISTEN(): void {
    if (unlistenNewWindow) return
    unlistenNewWindow = window.bp.onNewWindowRequest(({ url }) => {
      ADD_WEB_PAGE(url)
    })
    unlistenZoomCommand = window.bp.onZoomCommand(({ pageId, action }) => {
      APPLY_ZOOM_ACTION(pageId, action)
    })
    unlistenInputContext = installInputContextPush()
  }

  function STOP_LISTENING(): void {
    unlistenNewWindow?.()
    unlistenNewWindow = null
    unlistenZoomCommand?.()
    unlistenZoomCommand = null
    unlistenInputContext?.()
    unlistenInputContext = null
  }

  return {
    open,
    mode,
    urlPages,
    activePageId,
    dockAddrOpen,
    dragState,
    urlWidth,
    htmlDoc,
    deviceMode,
    SET_OPEN,
    TOGGLE_PANEL,
    SET_MODE,
    ADD_WEB_PAGE,
    ACTIVATE_PAGE,
    CLOSE_PAGE,
    UPDATE_PAGE_STATE,
    SET_DOCK_ADDR_OPEN,
    SET_PAGE_ZOOM,
    SET_FIT_WIDTH,
    APPLY_ZOOM_ACTION,
    TOGGLE_FIT_WIDTH,
    SHOW_ZOOM_HINT,
    zoomHint,
    SET_DRAG_STATE,
    SET_URL_WIDTH,
    OPEN_HTML_DOC,
    CLOSE_HTML_DOC,
    OPEN_EXTERNAL,
    LISTEN,
    STOP_LISTENING,
    TOGGLE_DEVICE_MODE
  }
})
