<template>
  <!-- 面包屑行（PHASE2-SPEC §1：28px）：仅 multi / split-doc 场景渲染；
       single 场景整行不渲染（路径居中显示在标题栏，右栏开关+选择器移至标题栏右侧）。 -->
  <div class="crumb" :class="{ 'split-doc': scene === 'split-doc' }">
    <div class="crumb-main">
      <span class="cdot" :class="{ show: !isSaved }" />
      <span class="path" :title="fullPathDisplay">{{ fullPathDisplay }}</span>
    </div>

    <!-- 分屏右侧文档标题（状态点+路径，可拖回标签栏，PHASE2-SPEC §3.4/§10） -->
    <span
      v-if="splitDocTab"
      class="bp-docname"
      draggable="true"
      title="拖回标签栏"
      @dragstart="onDocnameDragStart"
      @dragend="onDocnameDragEnd"
    >
      <span class="cdot" />
      <span class="path">{{ splitDocDisplay }}</span>
    </span>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { storeToRefs } from 'pinia'
import { useEditorStore } from '@/store/editor'
import { useWorkspaceStore } from '@/store/workspace'
import bus from '@/bus'

// 面包屑行（PHASE2-SPEC §1：28px）：
// - multi：路径+文件名（左侧），右栏开关在标签栏 .tb-toggle；
// - split-doc：左路径 + 右文档名 bp-docname（可拖回标签栏）；
// - single：整行不渲染。
const editorStore = useEditorStore()
const workspaceStore = useWorkspaceStore()

const { currentFile } = storeToRefs(editorStore)
const { scene, splitDocTab } = storeToRefs(workspaceStore)

const filename = computed(() => currentFile.value?.filename ?? '')
const isSaved = computed(() => currentFile.value?.isSaved ?? true)

const dirDisplay = computed(() => {
  const pathname = currentFile.value?.pathname ?? ''
  if (!pathname) return ''
  const dir = window.path.dirname(pathname)
  if (!dir || dir === '.') return ''
  const sep = window.path.sep
  const home = window.marktext?.env?.HOME as string | undefined
  if (home && (dir === home || dir.startsWith(home + sep))) {
    return '~' + dir.slice(home.length)
  }
  return dir
})

const fullPathDisplay = computed(() => {
  const dir = dirDisplay.value
  if (!dir) return filename.value
  return `${dir} / ${filename.value}`
})

const splitDocDisplay = computed(() => {
  const tab = splitDocTab.value
  if (!tab) return ''
  const dir = tab.pathname ? window.path.dirname(tab.pathname) : ''
  if (!dir || dir === '.') return tab.filename
  const sep = window.path.sep
  const home = window.marktext?.env?.HOME as string | undefined
  const display =
    home && (dir === home || dir.startsWith(home + sep)) ? '~' + dir.slice(home.length) : dir
  return `${display} / ${tab.filename}`
})

// 拖回标签栏：dragstart 时 tabstrip 挂 .return-target（tabs.vue 监听总线），
// 并置 window 标记让 app.vue 的全局 dragover 放行内部 drop。
const onDocnameDragStart = (event: DragEvent) => {
  const id = splitDocTab.value?.id ?? ''
  event.dataTransfer?.setData('text/plain', id)
  event.dataTransfer!.effectAllowed = 'move'
  window.__momarkReturnDrag = true
  bus.emit('split:return-drag-start')
}

const onDocnameDragEnd = () => {
  window.__momarkReturnDrag = false
  bus.emit('split:return-drag-end')
}
</script>

<style scoped>
.crumb {
  flex: none;
  height: 28px;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 16px;
  background: var(--bg);
  border-bottom: 1px solid var(--line);
  font-size: var(--f11);
  line-height: 1.45;
  color: var(--muted);
  position: relative;
  box-sizing: border-box;
}
.crumb-main {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.crumb.split-doc .crumb-main {
  max-width: calc(50% - 24px);
}
.crumb .cdot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--accent);
  flex: none;
  display: none;
}
.crumb .cdot.show {
  display: block;
}
.crumb-main .path {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
/* bp-docname 状态样式走全局 browserPanel.css（宽度动画等跨组件） */
</style>
