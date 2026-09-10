<template>
  <div
    class="bp-addrwrap"
    :class="{ open: dockAddrOpen }"
    @mouseleave="scheduleCollapse"
    @mouseenter="cancelCollapse"
  >
    <div
      class="bp-plus"
      title="搜索 Google 或输入网址"
      @click.stop="onPlusClick"
      @mouseenter="onPlusEnter"
    >
      <mo-icon class="bp-plus-ic" name="i-plus" />
      <span class="bp-bar">
        <mo-icon class="gicon" name="i-google" />
        <input
          ref="inputEl"
          v-model="inputText"
          placeholder="搜索 Google 或输入网址"
          aria-label="搜索或输入网址"
          @keydown.enter.prevent="go"
          @blur="onInputBlur"
        />
        <button class="bp-go" @click.stop="go">前往</button>
      </span>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, watch, onBeforeUnmount } from 'vue'
import { storeToRefs } from 'pinia'
import MoIcon from '@/components/icons/MoIcon.vue'
import { useBrowserPanelStore } from '@/store/browserPanel'

/**
 * 单页「+」胶囊（PHASE2-SPEC §5）：34×34 卡片底描边 right:6px top:8px；
 * + 与 Google 搜索栏是一个控件的两种状态 —— hover 自动展开为网址栏
 * width min(320px, 100% - 12px)（.46s --ease-grow），移出收起；点击
 * 仍可切换。含 Google 彩 G 图标 + 输入框 + 前往按钮。
 * 输入判断：URL（含协议/域名样式无空格）→ 自动补 https://；否则 Google 搜索。
 */

const bpStore = useBrowserPanelStore()
const { dockAddrOpen } = storeToRefs(bpStore)

const inputEl = ref<HTMLInputElement | null>(null)
const inputText = ref('')
let leaveTimer: ReturnType<typeof setTimeout> | null = null

// hover + 即展开（两个状态一个控件），展开后聚焦输入框。
const onPlusEnter = () => {
  cancelCollapse()
  if (!dockAddrOpen.value) bpStore.SET_DOCK_ADDR_OPEN(true)
  setTimeout(() => inputEl.value?.focus(), 60)
}

const onPlusClick = () => {
  cancelCollapse()
  bpStore.SET_DOCK_ADDR_OPEN(!dockAddrOpen.value)
  if (dockAddrOpen.value) {
    setTimeout(() => inputEl.value?.focus(), 60)
  }
}

const scheduleCollapse = () => {
  cancelCollapse()
  // 正在输入时不收起（保护输入内容）。
  if (inputText.value.trim()) return
  leaveTimer = setTimeout(() => {
    bpStore.SET_DOCK_ADDR_OPEN(false)
  }, 220)
}

// 输入框失焦且为空时收起（点页面别处）。
const onInputBlur = () => {
  scheduleCollapse()
}

const cancelCollapse = () => {
  if (leaveTimer) {
    clearTimeout(leaveTimer)
    leaveTimer = null
  }
}

const go = async () => {
  const raw = inputText.value
  if (!raw.trim()) return
  const pageId = await bpStore.ADD_WEB_PAGE(raw)
  if (!pageId) return
  inputText.value = ''
  bpStore.SET_DOCK_ADDR_OPEN(false)
  // round11 通知精简（用户拍板）：地址栏本身已展示目标网址，
  // 「正在打开/搜索」类 toast 属打扰，已移除。
}

watch(dockAddrOpen, (open) => {
  if (!open) cancelCollapse()
})

onBeforeUnmount(cancelCollapse)
</script>
