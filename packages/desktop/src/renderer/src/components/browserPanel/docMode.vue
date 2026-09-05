<template>
  <div class="bp-doc">
    <!-- 未选择文档空态（PHASE2-SPEC §5 文案） -->
    <div v-if="!hasContent" class="bp-doc-hint">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
        <path d="M7 2.5h7l4 4v15H7z" />
        <path d="M14 2.5v4h4M9.5 12h6M9.5 15.5h6" />
      </svg>
      <p>
        从顶部标签栏拖一个标签到这里<br />
        即可双屏对照两个文档/网页
      </p>
    </div>
    <template v-else>
      <div v-if="title" class="bp-doc-title" :title="title">
        {{ title }}
      </div>
      <!-- 引擎 MarkdownToHtml → DOMPurify 清洗 → 注入（report 3.md §6） -->
      <div class="markdown-body" v-html="previewHtml" />
    </template>
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
 * 按文档目录解析。
 */

const workspaceStore = useWorkspaceStore()
const bpStore = useBrowserPanelStore()
const { docPath } = storeToRefs(bpStore)
const { splitDocTab } = storeToRefs(workspaceStore)

const previewHtml = ref('')
const title = ref('')
const pickedMarkdown = ref<{ path: string; markdown: string } | null>(null)

const hasContent = computed(() => !!splitDocTab.value || !!docPath.value)

const docBaseDir = (path: string | null): string => (path ? window.path.dirname(path) : '')

const renderSplitDoc = async () => {
  const tab = splitDocTab.value
  if (!tab) return
  title.value = tab.pathname ? `${window.path.basename(tab.pathname)}` : tab.filename || ''
  previewHtml.value = await renderMarkdownPreview(tab.markdown, docBaseDir(tab.pathname))
}

const renderPickedDoc = async (path: string) => {
  title.value = window.path.basename(path)
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
      title.value = ''
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
