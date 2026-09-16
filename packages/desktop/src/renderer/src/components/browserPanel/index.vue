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

        <!-- 两种模式内容常驻挂载（v-show）：切换网页/文档、收起再展开面板
             都不影响里面的内容与状态（网页滚动/登录态、预览文档保持）。 -->
        <url-mode v-show="mode === 'url'" />
        <doc-mode v-show="mode === 'doc'" ref="docModeRef" />
      </div>

      <!-- 底部：网址模式 = 40px 导航条；文档模式 = 「打开文件… / 新建文件」
           （36px 顶部 hairline，两按钮左右等分） -->
      <nav-bar v-show="mode === 'url'" />
      <div v-show="mode === 'doc'" class="bp-doc-actions">
        <button class="bp-openfile" @click="openDocFile">
          <mo-icon name="i-folder" />
          打开文件…
        </button>
        <button class="bp-openfile" @click="newDocFile">
          <mo-icon name="i-file" />
          新建文件
        </button>
      </div>
    </div>
  </aside>
</template>

<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, ref } from 'vue'
import { storeToRefs } from 'pinia'
import MoIcon from '@/components/icons/MoIcon.vue'
import { useBrowserPanelStore } from '@/store/browserPanel'
import { useSplitStore } from '@/store/split'
import { useWorkspaceStore } from '@/store/workspace'
import UrlMode from './urlMode.vue'
import DocMode from './docMode.vue'
import NavBar from './navBar.vue'

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
  width: bpanelOpen.value ? `${panelWidthPx.value}px` : '0px',
  // round18：面板宽度的 CSS 变量——Dock 落点的网址栏要按面板宽度撑开
  // （它挂在 34px 的 Dock 项里，百分比量不到面板宽）。
  '--panel-w': `${panelWidthPx.value}px`
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
  // round11 通知精简（用户拍板）：重复拖入已在分屏的文件不弹 toast，
  // 投放区/右侧面板本身已呈现该文件，用户可自行看见。
  splitStore.DRAG_TO_SPLIT(id)
  splitStore.dragTabId = null
}

const openDocFile = () => {
  docModeRef.value?.openFile()
}

const newDocFile = () => {
  docModeRef.value?.newFile()
}

onMounted(() => {
  bpStore.LISTEN()
})

onBeforeUnmount(() => {
  bpStore.STOP_LISTENING()
})
</script>
