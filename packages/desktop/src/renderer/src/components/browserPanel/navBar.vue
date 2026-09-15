<template>
  <div class="bp-browserbar">
    <button title="后退" :disabled="!canGoBack" @click="goBack">
      <mo-icon name="i-chev-left" />
    </button>
    <button title="前进" :disabled="!canGoForward" @click="goForward">
      <mo-icon name="i-chev-right" />
    </button>
    <button title="重新加载" @click="reload">
      <mo-icon name="i-refresh" />
    </button>
    <button
      class="bp-device"
      :title="deviceMode === 'pc' ? '切换为移动端样式' : '切换为 PC 样式'"
      :aria-label="deviceMode === 'pc' ? '切换为移动端样式' : '切换为 PC 样式'"
      @click="toggleDeviceMode"
    >
      <mo-icon :name="deviceMode === 'pc' ? 'i-monitor' : 'i-phone'" />
    </button>
    <!-- round17：适应宽度。文字按钮而非图标——面板只有 288px，宽度状态本身
         就是最有用的信息（开着显示「适应」，关着显示当前比例）。 -->
    <button
      class="bp-fit"
      :class="{ on: !!activePage?.fitWidth }"
      :title="fitTitle"
      :aria-label="fitTitle"
      :disabled="!activePage"
      @click="toggleFitWidth"
    >
      {{ fitLabel }}
    </button>
    <span class="bp-location-wrap">
      <input
        ref="locationEl"
        v-model="locationText"
        aria-label="网址"
        spellcheck="false"
        @keydown.enter.prevent="locationGo"
      />
      <button
        class="bp-external"
        title="在默认浏览器中打开"
        aria-label="在默认浏览器中打开"
        @click.stop="openExternal"
      >
        <mo-icon name="i-external" />
      </button>
    </span>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { storeToRefs } from 'pinia'
import MoIcon from '@/components/icons/MoIcon.vue'
import { useBrowserPanelStore, resolveInput } from '@/store/browserPanel'

/**
 * 底部 40px 导航条（PHASE2-SPEC §5）：后退/前进/刷新 + 地址栏
 * （不透明白底、不自动聚焦；hover 显示外开箭头）。
 * 前进后退按钮状态来自 bp:getState（navigationHistory，Electron ≥ 32）。
 */

const bpStore = useBrowserPanelStore()
const { urlPages, activePageId, deviceMode } = storeToRefs(bpStore)

const locationEl = ref<HTMLInputElement | null>(null)
const locationText = ref('')
const canGoBack = ref(false)
const canGoForward = ref(false)

const activePage = computed(() => urlPages.value.find((p) => p.id === activePageId.value) ?? null)

// 同步地址栏显示：activePage.url（did-navigate 会更新它）。
watch(
  () => activePage.value?.url,
  (url) => {
    if (url) locationText.value = url
  },
  { immediate: true }
)

const refreshNavState = async () => {
  const id = activePageId.value
  if (!id) {
    canGoBack.value = false
    canGoForward.value = false
    return
  }
  try {
    const state = await window.bp.getState(id)
    canGoBack.value = state.canGoBack
    canGoForward.value = state.canGoForward
    if (state.url) locationText.value = state.url
  } catch {
    canGoBack.value = false
    canGoForward.value = false
  }
}

// 激活页切换 / 加载结束 / 导航完成时刷新前进后退可用性。
watch(
  () => [activePageId.value, activePage.value?.loading, activePage.value?.url] as const,
  () => {
    refreshNavState()
  },
  { immediate: true }
)

const goBack = () => {
  if (activePageId.value) window.bp.back(activePageId.value)
}

const goForward = () => {
  if (activePageId.value) window.bp.forward(activePageId.value)
}

const reload = () => {
  const id = activePageId.value
  if (!id) return
  bpStore.UPDATE_PAGE_STATE(id, { loading: true, error: null })
  window.bp.reload(id)
}

// round16：PC / 移动端样式切换（无激活页时静默忽略）。
const toggleDeviceMode = () => {
  bpStore.TOGGLE_DEVICE_MODE()
}

// round17：适应面板宽度。开着时由 webview 组件量内容宽度反算 zoom，
// 手动缩放（Cmd +/-）会自动关掉它并回到百分比显示。
const zoomPct = computed(() => Math.round((activePage.value?.zoom ?? 1) * 100))
const fitLabel = computed(() => (activePage.value?.fitWidth ? '适应' : `${zoomPct.value}%`))
const fitTitle = computed(() =>
  activePage.value?.fitWidth
    ? `适应面板宽度：开（当前 ${zoomPct.value}%）· 点击关闭`
    : `当前 ${zoomPct.value}% · 点击适应面板宽度`
)
const toggleFitWidth = () => {
  bpStore.TOGGLE_FIT_WIDTH()
}

// 回车导航当前激活页（地址栏输入 → 智能判断 URL vs 搜索）；
// 尚无任何页面时（activePageId 为空）用输入创建第一页。
const locationGo = () => {
  const id = activePageId.value
  const target = resolveInput(locationText.value)
  if (!target) return
  if (!id) {
    bpStore.ADD_WEB_PAGE(locationText.value).catch(() => {})
    locationText.value = ''
    return
  }
  bpStore.UPDATE_PAGE_STATE(id, { url: target, loading: true, error: null })
}

// 外开箭头：仅 http(s)，主进程 bp:openExternal 二次校验（report 3.md §5.4）。
const openExternal = () => {
  const url = resolveInput(locationText.value)
  if (!url) return
  bpStore.OPEN_EXTERNAL(url).catch(() => {})
}

defineExpose({ refreshNavState })
</script>
