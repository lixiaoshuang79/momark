import { computed } from 'vue'
import { defineStore } from 'pinia'
import { useEditorStore } from './editor'
import { useSplitStore } from './split'
import { useBrowserPanelStore } from './browserPanel'

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

  // 左侧标签集合：分屏 doc 已被拆出的文档不参与（互斥由推导保证）。
  const visibleTabs = computed(() => editorStore.tabs.filter((t) => t.id !== splitStore.tabId))

  const scene = computed<WorkspaceScene>(() => {
    if (splitStore.active) {
      if (splitStore.kind === 'doc') return 'split-doc'
      return bpStore.urlPages.length >= 2 ? 'split-urlN' : 'split-url1'
    }
    return visibleTabs.value.length >= 2 ? 'multi' : 'single'
  })

  // PHASE2-SPEC §10：single 物理移除标签栏整行，multi/split-* 均渲染。
  const tabbarVisible = computed(() => scene.value !== 'single')

  const splitDocTab = computed(() => {
    if (splitStore.kind !== 'doc' || !splitStore.tabId) return null
    return editorStore.tabs.find((t) => t.id === splitStore.tabId) ?? null
  })

  // 面板宽度：分屏激活用 split.width（240~60%）；网页模式用 bp.urlWidth
  // （分隔线可拖动，默认 288px）。拖拽中由分隔线实时写入。
  const panelWidthPx = computed<number>(() => {
    if (splitStore.active) return splitStore.width
    return bpStore.urlWidth
  })

  return {
    visibleTabs,
    scene,
    tabbarVisible,
    splitDocTab,
    panelWidthPx
  }
})
