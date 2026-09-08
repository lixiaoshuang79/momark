<template>
  <div class="crumb" :class="{ 'single-doc': isSingleDoc, 'split-doc': scene === 'split-doc' }">
    <div class="crumb-main">
      <span class="cdot" :class="{ show: !isSaved }" />
      <span class="path" :title="fullPathDisplay">{{ fullPathDisplay }}</span>
    </div>

    <!-- 单文档态：只显示文件名（路径已在标题栏，不得重复） -->
    <span v-if="isSingleDoc" class="docname">{{ filename }}</span>

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

    <!-- 右栏开关：仅单文档态（标签栏整行不渲染），多文档/分屏态由标签栏
         的 .tb-toggle 承接 —— 每个场景只有一个开启按钮。 -->
    <button
      v-if="isSingleDoc"
      class="crumb-pbtn"
      :class="{ rolled: bpanelOpen }"
      :title="t('sideBar.rightPanelTitle')"
      @click.stop="toggleBpPanel"
    >
      <mo-icon :name="bpanelOpen ? 'i-x' : 'i-panel'" />
    </button>

    <!-- 网址/文档选择器：紧跟开关之后（PHASE2-SPEC §5）——单文档态由面包屑行渲染，
         多文档/分屏态由标签栏的 bp-modes 承接。 -->
    <bp-modes v-if="isSingleDoc" :shown="bpanelOpen" />
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { storeToRefs } from 'pinia'
import { useEditorStore } from '@/store/editor'
import { useWorkspaceStore } from '@/store/workspace'
import { useBrowserPanelStore } from '@/store/browserPanel'
import MoIcon from '@/components/icons/MoIcon.vue'
import BpModes from '@/components/browserPanel/bpModes.vue'
import bus from '@/bus'
import { t } from '../../i18n'

// 面包屑行（PHASE2-SPEC §1：28px）：
// - multi：路径+文件名（左侧）+ 右栏开关；
// - single：只显示文件名（路径已在标题栏，不重复）+ 右栏开关；
// - split-doc：左路径 + 右文档名 bp-docname（可拖回标签栏）。
const editorStore = useEditorStore()
const workspaceStore = useWorkspaceStore()
const bpStore = useBrowserPanelStore()

const { currentFile } = storeToRefs(editorStore)
const { scene, splitDocTab } = storeToRefs(workspaceStore)
const { open: bpanelOpen } = storeToRefs(bpStore)

const isSingleDoc = computed(() => scene.value === 'single')

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
  return `${dir} › ${filename.value}`
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
  return `${display} › ${tab.filename}`
})

const toggleBpPanel = () => {
  bpStore.TOGGLE_PANEL()
}

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
.crumb.single-doc .crumb-main {
  display: none;
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
.docname {
  display: none;
  white-space: nowrap;
  color: var(--muted);
}
.crumb.single-doc .docname {
  display: inline;
}
.crumb-pbtn {
  display: flex;
  width: 26px;
  height: 22px;
  align-items: center;
  justify-content: center;
  margin-left: auto;
  /* 右距交给其后的 bp-modes（容器 gap 8px 提供间距）；
     panel 关闭时 bp-modes 仍以 18px 收起态存在 */
  margin-right: 0;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--muted);
  cursor: pointer;
  transition:
    background 0.15s ease,
    color 0.15s ease;
}
/* 原型：面包屑行开关图标 13px */
.crumb-pbtn svg {
  width: 13px;
  height: 13px;
}
.crumb-pbtn:hover {
  background: var(--hover);
  color: var(--ink);
}
/* bp-docname / rolled 状态样式走全局 browserPanel.css（宽度动画等跨组件） */
</style>
