import { ref, watch } from 'vue'
import { defineStore } from 'pinia'
import bus from '../bus'
import { usePreferencesStore } from './preferences'
import { debouncedSendBufferedState } from './bufferedState'

// feat/heading-rail：左侧边栏已移除。文档结构由编辑区左缘的标题轨承担（常驻完整
// 标题是偏好 `headingRailPinned`），同目录文件由「文件夹抽屉」承担（临时浮层，
// 不占布局）。旧缓冲状态 / 旧偏好里的 showSideBar、sideBarWidth、rightColumn、
// sideBarVisibility 一律忽略，不迁移成任何新状态——老用户的「侧栏常开」不该变成
// 「完整标题常驻」，新界面的默认就是只有横线。

interface LayoutPartial {
  showTabBar?: boolean
}

interface SetLayoutOptions {
  scheduleBufferUpdate?: boolean
}

export type LayoutEntry =
  | 'showTabBar'
  | 'headingRailPinned'
  | 'folderDrawer'
  | 'rightPanel'
  | 'rightPanelWeb'
  | 'rightPanelDoc'
  | 'rightPanelAnnotation'

interface BufferedLayout {
  showTabBar: boolean
}

export const createBufferedLayoutState = (state: unknown): BufferedLayout | null => {
  if (!state || typeof state !== 'object') return null
  return { showTabBar: !!(state as LayoutPartial).showTabBar }
}

// 旧侧栏宽度的本地缓存：新界面不再读它，启动时顺手清掉。
const LEGACY_SIDE_BAR_WIDTH_KEY = 'side-bar-width'
try {
  localStorage.removeItem(LEGACY_SIDE_BAR_WIDTH_KEY)
} catch {
  // 私有存储不可用时无所谓，残留的键也不会再被读取。
}

export const useLayoutStore = defineStore('layout', () => {
  const showTabBar = ref(false)
  // 标题轨实际占用的布局宽度（px）：无标题 / html 标签时为 0，横线 48，常驻按窗宽。
  // 由标题轨组件上报（它最清楚当前形态），分屏等宽计算与通知横幅据此避让。
  const railWidth = ref(0)
  const folderDrawerOpen = ref(false)

  function SET_LAYOUT(
    layout: LayoutPartial,
    { scheduleBufferUpdate = true }: SetLayoutOptions = {}
  ): void {
    if (layout.showTabBar !== undefined) showTabBar.value = !!layout.showTabBar
    if (scheduleBufferUpdate) {
      debouncedSendBufferedState()
    }
  }

  function SET_RAIL_WIDTH(width: number): void {
    const next = Number.isFinite(width) ? Math.max(0, Math.round(width)) : 0
    if (railWidth.value !== next) railWidth.value = next
  }

  function SET_HEADING_RAIL_PINNED(pinned: boolean): void {
    const preferencesStore = usePreferencesStore()
    if (preferencesStore.headingRailPinned === pinned) return
    preferencesStore.SET_SINGLE_PREFERENCE({ type: 'headingRailPinned', value: pinned })
  }

  function SET_FOLDER_DRAWER(open: boolean): void {
    folderDrawerOpen.value = open
  }

  function CREATE_BUFFERED_STATE(): BufferedLayout | null {
    return createBufferedLayoutState({ showTabBar: showTabBar.value })
  }

  function RESTORE_BUFFERED_STATE(state: unknown): void {
    const layout = createBufferedLayoutState(state)
    if (!layout) return
    SET_LAYOUT(layout, { scheduleBufferUpdate: false })
    DISPATCH_LAYOUT_MENU_ITEMS()
  }

  function TOGGLE_LAYOUT_ENTRY(entryName: LayoutEntry): void {
    if (entryName === 'showTabBar') {
      showTabBar.value = !showTabBar.value
      debouncedSendBufferedState()
    } else if (entryName === 'headingRailPinned') {
      SET_HEADING_RAIL_PINNED(!usePreferencesStore().headingRailPinned)
    } else if (entryName === 'folderDrawer') {
      folderDrawerOpen.value = !folderDrawerOpen.value
    } else if (entryName === 'rightPanel') {
      // 右侧栏（feat/right-panel-redesign）：菜单 / 快捷键 / 命令面板 → 右侧栏组件
      bus.emit('right-panel:toggle')
    } else if (entryName === 'rightPanelWeb') {
      bus.emit('right-panel:open-to', 'url')
    } else if (entryName === 'rightPanelDoc') {
      bus.emit('right-panel:open-to', 'doc')
    } else if (entryName === 'rightPanelAnnotation') {
      bus.emit('right-panel:open-to', 'annotation')
    }
  }

  function LISTEN_FOR_LAYOUT(): void {
    window.electron.ipcRenderer.on('mt::set-view-layout', (_e, layout) => {
      SET_LAYOUT(layout as unknown as LayoutPartial)
      DISPATCH_LAYOUT_MENU_ITEMS()
    })

    window.electron.ipcRenderer.on('mt::toggle-view-layout-entry', (_e, entryName) => {
      TOGGLE_LAYOUT_ENTRY(entryName as LayoutEntry)
      DISPATCH_LAYOUT_MENU_ITEMS()
    })

    bus.on('view:toggle-layout-entry', (entryName: unknown) => {
      TOGGLE_LAYOUT_ENTRY(entryName as LayoutEntry)
      DISPATCH_LAYOUT_MENU_ITEMS()
    })

    // 偏好在所有窗口间广播：别的窗口切了常驻，本窗口的菜单勾选也要跟上。
    const preferencesStore = usePreferencesStore()
    watch(
      () => preferencesStore.headingRailPinned,
      () => DISPATCH_LAYOUT_MENU_ITEMS()
    )
  }

  function DISPATCH_LAYOUT_MENU_ITEMS(): void {
    const { windowId } = window.marktext?.env ?? {}
    window.electron.ipcRenderer.send('mt::view-layout-changed', Number(windowId), {
      showTabBar: showTabBar.value,
      headingRailPinned: !!usePreferencesStore().headingRailPinned
    })
  }

  return {
    showTabBar,
    railWidth,
    folderDrawerOpen,
    SET_LAYOUT,
    SET_RAIL_WIDTH,
    SET_HEADING_RAIL_PINNED,
    SET_FOLDER_DRAWER,
    CREATE_BUFFERED_STATE,
    RESTORE_BUFFERED_STATE,
    TOGGLE_LAYOUT_ENTRY,
    LISTEN_FOR_LAYOUT,
    DISPATCH_LAYOUT_MENU_ITEMS
  }
})
