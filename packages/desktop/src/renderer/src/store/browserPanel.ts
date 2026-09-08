import { ref } from 'vue'
import { defineStore } from 'pinia'
import notice from '@/services/notification'
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
}

export type BpMode = 'url' | 'doc'
export type BpDragState = 'none' | 'over' | 'blocked'

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

  let unlistenNewWindow: (() => void) | null = null

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
        error: null
      })
      activePageId.value = id
      return id
    } catch {
      notice.notify({ message: '无法打开网址（仅支持 http/https）', type: 'error', time: 2500 })
      return null
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

  function SET_DRAG_STATE(value: BpDragState): void {
    dragState.value = value
  }

  // 地址栏外开箭头：仅 http(s) 允许 shell.openExternal（主进程二次校验）。
  async function OPEN_EXTERNAL(url: string): Promise<void> {
    const ok = await window.bp.openExternal(url)
    if (ok) {
      notice.notify({
        message: `已在默认浏览器中打开 ${url.replace(/^https?:\/\//, '').split('/')[0]}`,
        type: 'primary',
        time: 2000
      })
    }
  }

  // guest 内 window.open / target=_blank（http/https）→ 面板内新建 Dock 页。
  function LISTEN(): void {
    if (unlistenNewWindow) return
    unlistenNewWindow = window.bp.onNewWindowRequest(({ url }) => {
      ADD_WEB_PAGE(url)
    })
  }

  function STOP_LISTENING(): void {
    unlistenNewWindow?.()
    unlistenNewWindow = null
  }

  return {
    open,
    mode,
    urlPages,
    activePageId,
    dockAddrOpen,
    dragState,
    urlWidth,
    SET_OPEN,
    TOGGLE_PANEL,
    SET_MODE,
    ADD_WEB_PAGE,
    ACTIVATE_PAGE,
    CLOSE_PAGE,
    UPDATE_PAGE_STATE,
    SET_DOCK_ADDR_OPEN,
    SET_DRAG_STATE,
    SET_URL_WIDTH,
    OPEN_EXTERNAL,
    LISTEN,
    STOP_LISTENING
  }
})
