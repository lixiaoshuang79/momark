<template>
  <!-- 原型 .bp-doc：无标题行、无空态提示——有内容渲染 .wysiwyg 等价体，
       空态就是空白画布 + 底部「打开文件…」条。 -->
  <div class="bp-doc">
    <div v-if="hasContent" class="markdown-body" v-html="previewHtml" />
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { storeToRefs } from 'pinia'
import { useWorkspaceStore } from '@/store/workspace'
import { useBrowserPanelStore } from '@/store/browserPanel'
import { renderMarkdownPreview } from '@/util/browserPanel'

/**
 * 文档模式（PHASE2-SPEC §5）：分屏第二文档 = split.tabId 对应文档的实时预览；
 * 「打开文件…」= docPath 的静态预览。两者都走 引擎 MarkdownToHtml →
 * DOMPurify（FORBID iframe/object/embed/form/input/button），图片相对路径
 * 按文档目录解析。排版完全复刻原型 .wysiwyg（browserPanel.css）。
 */

const workspaceStore = useWorkspaceStore()
const bpStore = useBrowserPanelStore()
const { docPath } = storeToRefs(bpStore)
const { splitDocTab } = storeToRefs(workspaceStore)

const previewHtml = ref('')
const pickedMarkdown = ref<{ path: string; markdown: string } | null>(null)

const hasContent = computed(() => !!splitDocTab.value || !!docPath.value)

const docBaseDir = (path: string | null): string => (path ? window.path.dirname(path) : '')

const renderSplitDoc = async () => {
  const tab = splitDocTab.value
  if (!tab) return
  previewHtml.value = await renderMarkdownPreview(tab.markdown, docBaseDir(tab.pathname))
}

const renderPickedDoc = async (path: string) => {
  const content = pickedMarkdown.value?.path === path ? pickedMarkdown.value.markdown : ''
  previewHtml.value = await renderMarkdownPreview(content, docBaseDir(path))
}

// 分屏文档实时跟随编辑器内容（贴标高亮/滚动不保留，仅内容同步）。
watch(
  () => [splitDocTab.value?.id, splitDocTab.value?.markdown] as const,
  () => {
    if (splitDocTab.value) renderSplitDoc().catch(() => {})
  },
  { immediate: true }
)

watch(
  docPath,
  (path) => {
    if (path) renderPickedDoc(path).catch(() => {})
    else {
      previewHtml.value = ''
    }
  },
  { immediate: true }
)

// 「打开文件…」由 index.vue 底部条调用：主进程系统对话框 → 读文件 → 预览。
const openFile = async () => {
  const result = await window.bp.pickDoc()
  if (!result) return
  pickedMarkdown.value = result
  bpStore.SET_DOC_PATH(result.path)
}

defineExpose({ openFile })
</script>
