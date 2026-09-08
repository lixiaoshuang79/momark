import { ref } from 'vue'
import { defineStore } from 'pinia'
import notice from '@/services/notification'
import { useEditorStore } from './editor'
import { useBrowserPanelStore } from './browserPanel'

/**
 * 拖拽分屏状态（STATE-MACHINE §1 SplitState，PHASE2-SPEC §3）。
 *
 * 实现说明：被拖出的文档保留在 editorStore.tabs 中（自动保存/文件监听/编辑
 * 历史不丢失），场景派生与标签栏渲染按 split.tabId 过滤 —— 从左侧标签集合
 * 的语义上「移除」，同时互斥由场景推导保证（同一文档不得同时出现在两侧）。
 * 拖回标签栏时无需重建编辑器实例，直接 UPDATE_CURRENT_FILE 激活即可。
 */

export type SplitKind = 'doc' | 'url'

export const useSplitStore = defineStore('split', () => {
  const active = ref(false)
  const kind = ref<SplitKind>('doc')
  const tabId = ref<string | null>(null)
  const width = ref(240)
  // 拖拽中的标签 id（tab dragstart → 投放区/面板 drop 的瞬时 UI 状态，
  // 不入 SplitState 持久语义；dragend 清空）。
  const dragTabId = ref<string | null>(null)
  // 分隔线拖动中（win-body 挂 .dragging-split，禁用面板宽度过渡 + 全局 col-resize）。
  const draggingSplit = ref(false)

  function SET_KIND(next: SplitKind): void {
    kind.value = next
  }

  /**
   * 标签拖入分屏（STATE-MACHINE dragToSplit）：
   * 已在右屏 → 返回 false（blocked，投放区 dropEffect none）；
   * 右屏已有其它文档 → 先静默还回，再开新文档窗格 min(480px, 60%)。
   */
  function DRAG_TO_SPLIT(id: string, opts?: { keepCurrent?: boolean }): boolean {
    const editorStore = useEditorStore()
    const bpStore = useBrowserPanelStore()

    if (active.value && tabId.value === id) return false
    const tab = editorStore.tabs.find((t) => t.id === id)
    if (!tab) return false

    if (active.value && kind.value === 'doc' && tabId.value) {
      RETURN_SPLIT_TO_TABS(false)
    }

    const index = editorStore.tabs.findIndex((t) => t.id === id)
    active.value = true
    kind.value = 'doc'
    tabId.value = id
    width.value = Math.max(240, Math.min(480, window.innerWidth * 0.6))

    bpStore.SET_OPEN(true)
    bpStore.SET_MODE('doc')

    // 若拖出的是活动标签：左编辑器落到相邻标签（原型 takeTabIntoSplit 语义）；
    // 无可落标签（唯一标签被拖出）→ 左编辑区空出（与 CLOSE_TABS 的空态一致），
    // 避免同一文档同时出现在两侧。
    // keepCurrent（右栏「打开文件…」路径）：保持当前标签在左编辑器，
    // 右栏同步实时预览（编辑+预览对照）。
    if (editorStore.currentFile?.id === id && !opts?.keepCurrent) {
      const visible = editorStore.tabs.filter((t) => t.id !== id)
      const next = visible[Math.min(index, visible.length - 1)] ?? null
      if (next) {
        editorStore.UPDATE_CURRENT_FILE(next)
      } else {
        editorStore.currentFile = null
        window.DIRNAME = ''
      }
    }
    notice.notify({
      message: `已分栏：${tab.filename} · 拖动中央分隔线调整两栏宽度`,
      type: 'primary',
      time: 2500
    })
    return true
  }

  /**
   * 文档拖回标签栏（STATE-MACHINE returnSplitToTabs）：
   * 回标签集合为活动标签、面板收起；showToast 控制 toast
   * 「已将『xx』拖回标签栏」（分隔线 ≥90% 关闭时为静默还回）。
   */
  function RETURN_SPLIT_TO_TABS(showToast: boolean = true): void {
    const editorStore = useEditorStore()
    const bpStore = useBrowserPanelStore()
    const id = tabId.value
    const tab = id ? editorStore.tabs.find((t) => t.id === id) : null
    if (tab) {
      // UPDATE_CURRENT_FILE 在 tabs 中缺该文档时会重新推入并激活。
      editorStore.UPDATE_CURRENT_FILE(tab)
      if (showToast) {
        notice.notify({
          message: `已将「${tab.filename}」拖回标签栏`,
          type: 'primary',
          time: 2000
        })
      }
    }
    active.value = false
    kind.value = 'doc'
    tabId.value = null
    bpStore.SET_OPEN(false)
  }

  /**
   * 分隔线拖动（STATE-MACHINE setSplitWidth）：
   * 240px ≤ 右栏 ≤ 60% 窗宽；拖到 ≥90% 窗宽自动关闭分屏。
   */
  function SET_SPLIT_WIDTH(widthPx: number): void {
    const winWidth = window.innerWidth
    if (widthPx >= winWidth * 0.9) {
      RETURN_SPLIT_TO_TABS(false)
      return
    }
    width.value = Math.round(Math.max(240, Math.min(widthPx, winWidth * 0.6)))
  }

  // 关闭分屏（右栏开关收起等路径），文档静默还回。
  function CLOSE_SPLIT(): void {
    RETURN_SPLIT_TO_TABS(false)
  }

  return {
    active,
    kind,
    tabId,
    width,
    dragTabId,
    draggingSplit,
    SET_KIND,
    DRAG_TO_SPLIT,
    RETURN_SPLIT_TO_TABS,
    SET_SPLIT_WIDTH,
    CLOSE_SPLIT
  }
})
