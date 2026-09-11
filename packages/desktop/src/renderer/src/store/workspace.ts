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

  // 面板宽度：分屏激活用 split.width（240~60%）；网页模式用 bp.urlWidth
  // （分隔线可拖动，默认 288px）。拖拽中由分隔线实时写入。
  const panelWidthPx = computed<number>(() => {
    if (splitStore.active) return splitStore.width
    return bpStore.urlWidth
  })

  return {
    visibleTabs,
    scene,
    splitDocTab,
    panelWidthPx
  }
})
