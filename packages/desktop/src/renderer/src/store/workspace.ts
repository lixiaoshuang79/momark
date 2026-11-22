import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { useEditorStore } from './editor'
import { useSplitStore } from './split'
import { useBrowserPanelStore } from './browserPanel'
import { useLayoutStore } from './layout'
import { usePreferencesStore } from './preferences'
import {
  panelGeometry,
  ratioFromWidth,
  sanitizeRatio,
  defaultRatioFor,
  type PanelKind
} from './panelGeometry'

/**
 * 工作区场景派生（STATE-MACHINE §1）：
 * scene 是派生量，由 tabs(过滤 split.tabId) / split.active / urlPages.length
 * 计算，禁止手工设置。五场景互斥，全部 chrome UI 由它驱动。
 */

export type WorkspaceScene = 'single' | 'multi' | 'split-doc' | 'split-url1' | 'split-urlN'

export const useWorkspaceStore = defineStore('workspace', () => {
  const editorStore = useEditorStore()
  const splitStore = useSplitStore()
  const bpStore = useBrowserPanelStore()
  const layoutStore = useLayoutStore()
  const preferencesStore = usePreferencesStore()

  // 左侧标签集合：分屏 doc 保留在标签栏（round27 用户反馈——拖出唯一
  // 标签分屏时标签条整条空白；保留后点击即把左编辑器切回该文档）。
  const visibleTabs = computed(() => editorStore.tabs)

  // round9（用户拍板）：标签条所有场景常驻渲染（原 PHASE2-SPEC §10 的
  // 「single 隐藏标签栏整行」作废——拖回标签栏后单文档标签需立即可见）。
  const scene = computed<WorkspaceScene>(() => {
    if (splitStore.active) {
      if (splitStore.kind === 'doc') return 'split-doc'
      return bpStore.urlPages.length >= 2 ? 'split-urlN' : 'split-url1'
    }
    return visibleTabs.value.length >= 2 ? 'multi' : 'single'
  })

  const splitDocTab = computed(() => {
    if (splitStore.kind !== 'doc' || !splitStore.tabId) return null
    return editorStore.tabs.find((t) => t.id === splitStore.tabId) ?? null
  })

  // ── 面板宽度（feat/right-panel-redesign，DESIGN-NOTES §1）──────────────
  // 宽度只跟「有没有分屏文档」有关，切 tab 不变。存的是比例（偏好
  // rightPanelRatio / rightSplitRatio），像素是派生值：窗口 resize、标题轨
  // 常驻/横线切换都会按比例重算并重新夹上下限。
  const viewportWidth = ref(typeof window !== 'undefined' ? window.innerWidth : 1280)
  if (typeof window !== 'undefined') {
    window.addEventListener('resize', () => {
      viewportWidth.value = window.innerWidth
    })
  }

  const panelKind = computed<PanelKind>(() => (splitStore.active ? 'split' : 'panel'))
  const panelAvail = computed(() => Math.max(0, viewportWidth.value - layoutStore.railWidth))
  const panelRatio = computed(() =>
    panelKind.value === 'split'
      ? sanitizeRatio(preferencesStore.rightSplitRatio, 'split')
      : sanitizeRatio(preferencesStore.rightPanelRatio, 'panel')
  )
  const geometry = computed(() =>
    panelGeometry(panelRatio.value, panelAvail.value, panelKind.value)
  )

  // 拖动中只改这个临时像素值（不写偏好）；松手才把比例落盘。
  const dragWidthPx = ref<number | null>(null)

  const panelWidthPx = computed<number>(() => dragWidthPx.value ?? geometry.value.width)
  // 窄窗（可用宽 − 280 < 480）：面板浮在正文上方，正文宽度不变。
  const panelOverlay = computed(() => geometry.value.overlay)

  function SET_PANEL_DRAG_WIDTH(px: number | null): void {
    dragWidthPx.value = px === null || !Number.isFinite(px) ? null : Math.round(px)
  }

  function SET_PANEL_RATIO(ratio: number, kind: PanelKind = panelKind.value): void {
    const type = kind === 'split' ? 'rightSplitRatio' : 'rightPanelRatio'
    const value = sanitizeRatio(ratio, kind)
    if (preferencesStore[type] === value) return
    preferencesStore.SET_SINGLE_PREFERENCE({ type, value })
  }

  /** 拖动结束 / 键盘调整：像素 → 比例落盘，临时拖动值清掉。 */
  function COMMIT_PANEL_WIDTH(px: number): void {
    dragWidthPx.value = null
    SET_PANEL_RATIO(ratioFromWidth(px, panelAvail.value, panelKind.value))
  }

  function RESET_PANEL_RATIO(): void {
    dragWidthPx.value = null
    SET_PANEL_RATIO(defaultRatioFor(panelKind.value))
  }

  return {
    visibleTabs,
    scene,
    splitDocTab,
    viewportWidth,
    panelKind,
    panelAvail,
    panelRatio,
    geometry,
    dragWidthPx,
    panelWidthPx,
    panelOverlay,
    SET_PANEL_DRAG_WIDTH,
    SET_PANEL_RATIO,
    COMMIT_PANEL_WIDTH,
    RESET_PANEL_RATIO
  }
})
