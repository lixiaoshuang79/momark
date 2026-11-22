<template>
  <!-- 文档 pane（feat/right-panel-redesign，DESIGN-NOTES §3.4 文档）：
       有分屏文档时第二行是文件名条（拖拽把手 + 图标 + 文件名 + HTML 只读，可拖回
       标签栏结束分屏；右侧「⇄ 与左侧交换」「× 关闭右侧文档」），下面是编辑器 /
       HTML 页面视图。没有分屏文档时是空态：虚线投放框 + 打开文件… / 新建 + 最近打开。 -->
  <div class="bp-doc">
    <template v-if="splitDocTab">
      <div
        class="rp-sub rp-docbar"
        draggable="true"
        :title="t('rightPanel.doc.dragBack')"
        @dragstart="onBarDragStart"
        @dragend="onBarDragEnd"
      >
        <span class="grip" aria-hidden="true">
          <svg viewBox="0 0 16 16">
            <path d="M6 4h.01M10 4h.01M6 8h.01M10 8h.01M6 12h.01M10 12h.01" />
          </svg>
        </span>
        <mo-icon :name="splitDocTab.kind === 'html' ? 'i-code' : 'i-file'" />
        <span class="name" :title="splitDocTab.pathname || splitDocTab.filename">{{
          splitDocTab.filename
        }}</span>
        <span v-if="splitDocTab.kind === 'html'" class="ro">{{ t('folderDrawer.readOnly') }}</span>
        <span class="sp" />
        <button
          class="rp-ib"
          :title="t('rightPanel.doc.swap')"
          :disabled="!canSwap"
          @click="swapSides"
        >
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <path d="M3 5.5h9.5M10 3l2.5 2.5L10 8M13 10.5H3.5M6 8l-2.5 2.5L6 13" />
          </svg>
        </button>
        <button class="rp-ib" :title="t('rightPanel.doc.close')" @click="closeSplit">
          <mo-icon name="i-x" />
        </button>
      </div>
      <!-- 分屏标签是只读 html 时显示页面视图，否则是该文档的编辑器。 -->
      <div class="rp-docview">
        <html-tab-view v-if="splitDocTab.kind === 'html'" :tab-id="splitDocTab.id" />
        <doc-editor-pane v-else />
      </div>
    </template>
    <div v-else class="rp-docempty">
      <div class="rp-dropbox">
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <path d="M4 3h8a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z" />
          <path d="M8.5 3v10" />
        </svg>
        <b>{{ t('rightPanel.doc.dropTitle') }}</b>
        <span>{{ t('rightPanel.doc.dropSub') }}</span>
      </div>
      <div class="rp-docbtns">
        <button class="rp-btn" @click="openFile">
          <mo-icon name="i-folder" />{{ t('rightPanel.doc.openFile') }}
        </button>
        <button class="rp-btn" @click="newFile">
          <mo-icon name="i-plus" />{{ t('rightPanel.doc.newFile') }}
        </button>
      </div>
      <div class="bp-recents-title">
        {{ t('welcome.recentTitle') }}
      </div>
      <div class="bp-recents">
        <button
          v-for="item in recents"
          :key="item.path"
          class="bp-recent-item"
          :title="item.path"
          @click="openRecent(item.path)"
        >
          <span class="bp-recent-name">{{ item.name }}</span>
          <span class="bp-recent-dir">{{ item.dirname }}</span>
        </button>
        <div v-if="recents.length === 0" class="bp-recents-none">
          {{ t('welcome.noRecentText') }}
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { storeToRefs } from 'pinia'
import { useWorkspaceStore } from '@/store/workspace'
import { useBrowserPanelStore } from '@/store/browserPanel'
import { useEditorStore } from '@/store/editor'
import { useSplitStore } from '@/store/split'
import MoIcon from '@/components/icons/MoIcon.vue'
import bus from '../../bus'
import { t } from '../../i18n'
import DocEditorPane from './docEditorPane.vue'
import HtmlTabView from '../htmlTab/HtmlTabView.vue'
import { openPanelResult, openPathInSplit, type PanelResult } from './openInSplit'

/**
 * 文档模式（PHASE2-SPEC §5，round8 起可编辑）：分屏第二文档 = split.tabId
 * 对应文档的真编辑器；「打开文件…」与最近列表点击 = 建真实文档标签并进入
 * 分屏（keepCurrent：左栏编辑当前文档、右栏编辑分屏文档）。
 */

const workspaceStore = useWorkspaceStore()
const bpStore = useBrowserPanelStore()
const { splitDocTab } = storeToRefs(workspaceStore)

// 空态最近打开列表：主进程系统级最近文档（同欢迎页数据源，≤8 条）。
type RecentItem = { path: string; name: string; dirname: string; mtime: number }
const recents = ref<RecentItem[]>([])

const loadRecents = async () => {
  try {
    recents.value = (await window.electron.ipcRenderer.invoke(
      'mt::welcome::recents'
    )) as RecentItem[]
  } catch {
    recents.value = []
  }
}

onMounted(loadRecents)
// 面板每次切到文档空态时刷新一次最近列表（打开过新文档后不再是旧数据）
watch(
  () => [bpStore.activeTab, bpStore.open, !!splitDocTab.value] as const,
  ([tab, open, has]) => {
    if (tab === 'doc' && open && !has) loadRecents()
  }
)

// 文件名条拖回标签栏：与顶栏右文档名同一套内部拖放（tabs.vue onReturnDrop 落地）。
const onBarDragStart = (event: DragEvent) => {
  const tab = splitDocTab.value
  if (!tab || !useSplitStore().active) return
  event.dataTransfer?.setData('application/x-momark-split-doc', tab.filename)
  if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move'
  window.__momarkReturnDrag = true
  bus.emit('split:return-drag-start')
}
const onBarDragEnd = () => {
  window.__momarkReturnDrag = false
  bus.emit('split:return-drag-end')
}

// ⇄ 与左侧交换：右侧文档到左边编辑，左边当前文档进右侧分屏。
const canSwap = computed(() => {
  const left = useEditorStore().currentFile
  return !!left && !!splitDocTab.value && left.id !== splitDocTab.value.id
})
const swapSides = () => {
  const editorStore = useEditorStore()
  const splitStore = useSplitStore()
  const left = editorStore.currentFile
  const right = splitDocTab.value
  if (!left || !right || left.id === right.id) return
  splitStore.RETURN_SPLIT_TO_TABS()
  splitStore.DRAG_TO_SPLIT(left.id, { keepCurrent: true })
}

// × 关闭右侧文档：文档回左侧标签集合（不关闭文件）。
const closeSplit = () => {
  useSplitStore().RETURN_SPLIT_TO_TABS()
}

// 最近文件点击：直接打开进入分屏（round8 起不再只读预览）。
const openRecent = async (filePath: string) => {
  await openPathInSplit(filePath)
}

// 「打开文件…」由 index.vue 底部条调用：主进程系统对话框 → 读文件 → 建标签进分屏。
const openFile = async () => {
  const result = (await window.bp.pickDoc()) as PanelResult | null
  if (result) await openPanelResult(result)
}

// 「新建文件」由 index.vue 底部条调用：新建未落盘 untitled 标签并直接
// 进入右栏分屏编辑（左栏保持当前文档）；保存时走主 store 的「另存为」
// 对话框选择落盘路径（与左编辑器新建文档同一管线）。
const newFile = () => {
  const editorStore = useEditorStore()
  const splitStore = useSplitStore()

  editorStore.NEW_UNTITLED_TAB({ selected: false })
  const tab = editorStore.tabs[editorStore.tabs.length - 1]
  if (!tab || tab.pathname !== '') return

  bpStore.SET_OPEN(true)
  bpStore.SET_MODE('doc')
  splitStore.DRAG_TO_SPLIT(tab.id, { keepCurrent: true })
}
</script>
