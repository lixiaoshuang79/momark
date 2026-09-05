<template>
  <aside
    class="bpanel"
    :class="{
      collapsed: !bpanelOpen,
      'drop-ok': dragState === 'over'
    }"
    :style="panelStyle"
    aria-label="右侧浏览器面板"
    @dragover="onDragOver"
    @dragleave="onDragLeave"
    @drop="onDrop"
  >
    <div class="bp-inner">
      <div class="bp-body">
        <!-- 顶部 2px 墨蓝进度线（任何激活页加载中即显示，滑动动画） -->
        <div class="bp-track" :class="{ show: activePageLoading }" />

        <url-mode v-if="mode === 'url'" />
        <doc-mode v-else ref="docModeRef" />
      </div>

      <!-- 底部：网址模式 = 40px 导航条；文档模式 = 「打开文件…」（36px 顶部 hairline） -->
      <nav-bar v-if="mode === 'url'" />
      <button v-else class="bp-openfile" @click="openDocFile">
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5">
          <path d="M2.5 4.5v9h11v-9M2.5 4.5h11M7 4.5V2.5h5l1.5 2" />
        </svg>
        打开文件…
      </button>
    </div>
  </aside>
</template>

<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, ref } from 'vue'
import { storeToRefs } from 'pinia'
import { useBrowserPanelStore } from '@/store/browserPanel'
import { useSplitStore } from '@/store/split'
import { useWorkspaceStore } from '@/store/workspace'
import UrlMode from './urlMode.vue'
import DocMode from './docMode.vue'
import NavBar from './navBar.vue'
import notice from '@/services/notification'

/**
 * 右侧浏览器面板容器（PHASE2-SPEC §5 / STATE-MACHINE BpState）：
 * 宽 288px（默认收起 0，.42s --ease-panel 显式宽度动画）、左缘 .5px 发丝线；
 * 分屏文档态 min(480px,60%)；win-body 挂 .panel-open（由 app.vue 统一挂载）。
 * 面板整体是标签拖放目标（.drop-ok = 2px dashed accent outline）。
 */

const bpStore = useBrowserPanelStore()
const splitStore = useSplitStore()
const workspaceStore = useWorkspaceStore()

const { open: bpanelOpen, mode, urlPages, activePageId, dragState } = storeToRefs(bpStore)
const { panelWidthPx } = storeToRefs(workspaceStore)

const docModeRef = ref<InstanceType<typeof DocMode> | null>(null)

const panelStyle = computed(() => ({
  width: bpanelOpen.value ? `${panelWidthPx.value}px` : '0px'
}))

const activePageLoading = computed(() => {
  const page = urlPages.value.find((p) => p.id === activePageId.value)
  return !!page && page.loading
})

// ══ 拖放目标：整个面板可接收标签 drop ══
const onDragOver = (event: DragEvent) => {
  if (!splitStore.dragTabId) return
  event.preventDefault()
  event.dataTransfer!.dropEffect = 'move'
  bpStore.SET_DRAG_STATE('over')
}

const onDragLeave = (event: DragEvent) => {
  if (!(event.currentTarget as HTMLElement).contains(event.relatedTarget as Node)) {
    bpStore.SET_DRAG_STATE('none')
  }
}

const onDrop = (event: DragEvent) => {
  event.preventDefault()
  bpStore.SET_DRAG_STATE('none')
  const id = splitStore.dragTabId
  if (!id) return
  const ok = splitStore.DRAG_TO_SPLIT(id)
  if (!ok) {
    notice.notify({ message: '该文件已在右侧分屏', type: 'primary', time: 2000 })
  }
  splitStore.dragTabId = null
}

const openDocFile = () => {
  docModeRef.value?.openFile()
}

onMounted(() => {
  bpStore.LISTEN()
})

onBeforeUnmount(() => {
  bpStore.STOP_LISTENING()
})
</script>
