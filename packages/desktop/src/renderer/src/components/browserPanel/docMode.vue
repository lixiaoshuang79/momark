<template>
  <!-- round8：右栏文档从只读预览升级为真 Muya 编辑器（用户拍板：右侧文档
       需可编辑、表格渲染与左侧一致）。分屏文档 = split.tabId 对应文档的
       编辑器实例（docEditorPane）；无分屏 = 最近打开列表（点击直接建标签
       进分屏编辑）+ 底部「打开文件…」条。 -->
  <div class="bp-doc">
    <!-- round11（用户拍板）：右栏顶部不再显示文件名胶囊（round10 的
         bp-doc-head 可见条被否掉）；保留同高透明占位，使左右边栏的
         文档内容开始线仍水平一致。 -->
    <div v-if="hasContent" class="bp-doc-head" />
    <doc-editor-pane v-if="hasContent" />
    <div v-else class="bp-doc-empty">
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
import { computed, onMounted, ref } from 'vue'
import { storeToRefs } from 'pinia'
import { useWorkspaceStore } from '@/store/workspace'
import { useBrowserPanelStore } from '@/store/browserPanel'
import { useEditorStore } from '@/store/editor'
import { useSplitStore } from '@/store/split'
import { t } from '../../i18n'
import DocEditorPane from './docEditorPane.vue'

/**
 * 文档模式（PHASE2-SPEC §5，round8 起可编辑）：分屏第二文档 = split.tabId
 * 对应文档的真编辑器；「打开文件…」与最近列表点击 = 建真实文档标签并进入
 * 分屏（keepCurrent：左栏编辑当前文档、右栏编辑分屏文档）。
 */

const workspaceStore = useWorkspaceStore()
const bpStore = useBrowserPanelStore()
const { splitDocTab } = storeToRefs(workspaceStore)

const hasContent = computed(() => !!splitDocTab.value)

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

// 建真实文档标签并进入分屏（左栏保持当前文档，右栏编辑新文档）。
// round10（用户拍板）：文件已打开也允许进分屏——同一文档左右同开、
// 任一侧编辑另一侧实时同步（allowSame）。
const openFileByPath = async (path: string, markdown: string) => {
  const editorStore = useEditorStore()
  const splitStore = useSplitStore()

  // 文件已在标签集合：直接进分屏。若该文档已在右屏（分屏中），
  // 左栏也切到它，实现左右同文档双开。
  const existing = editorStore.tabs.find((t) => window.fileUtils.isSamePathSync(t.pathname, path))
  if (existing) {
    bpStore.SET_OPEN(true)
    bpStore.SET_MODE('doc')
    if (splitStore.active && splitStore.tabId === existing.id) {
      editorStore.UPDATE_CURRENT_FILE(existing)
    } else {
      splitStore.DRAG_TO_SPLIT(existing.id, { allowSame: true })
    }
    return
  }

  // 记住打开前的当前文档；全局无当前文档时才让新标签激活（左栏空态）。
  const prev = editorStore.currentFile
  editorStore.NEW_TAB_WITH_CONTENT({
    markdownDocument: {
      markdown,
      filename: window.path.basename(path),
      pathname: path,
      encoding: 'utf8',
      lineEnding: 'lf',
      adjustLineEndingOnSave: true,
      trimTrailingNewline: false,
      isMixedLineEndings: false
    } as never,
    selected: prev == null
  })

  const tab = editorStore.tabs.find((t) => window.fileUtils.isSamePathSync(t.pathname, path))
  if (!tab) return

  bpStore.SET_OPEN(true)
  bpStore.SET_MODE('doc')
  splitStore.DRAG_TO_SPLIT(tab.id, { keepCurrent: prev != null })
}

// 最近文件点击：直接打开进入分屏编辑（round8 起不再只读预览）。
const openRecent = async (filePath: string) => {
  try {
    const result = (await window.bp.readDoc(filePath)) as {
      path: string
      markdown: string
    } | null
    if (result) {
      await openFileByPath(result.path, result.markdown ?? '')
    }
  } catch {
    // 读取失败保持空态。
  }
}

// 「打开文件…」由 index.vue 底部条调用：主进程系统对话框 → 读文件 → 建标签进分屏。
const openFile = async () => {
  const result = await window.bp.pickDoc()
  if (!result) return
  await openFileByPath(result.path, result.markdown ?? '')
}

defineExpose({ openFile })
</script>
