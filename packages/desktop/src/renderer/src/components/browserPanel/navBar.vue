<template>
  <div class="bp-browserbar">
    <button title="后退" :disabled="!canGoBack" @click="goBack">
      <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.6">
        <path d="M9 2.5 4.5 7 9 11.5" />
      </svg>
    </button>
    <button title="前进" :disabled="!canGoForward" @click="goForward">
      <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.6">
        <path d="M5 2.5 9.5 7 5 11.5" />
      </svg>
    </button>
    <button title="重新加载" @click="reload">
      <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.6">
        <path d="M11.5 7a4.5 4.5 0 1 1-1.32-3.18M11.5 1.5v3h-3" />
      </svg>
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
        <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.4">
          <path
            d="M6 3H3.5A1.5 1.5 0 0 0 2 4.5v6A1.5 1.5 0 0 0 3.5 12h6a1.5 1.5 0 0 0 1.5-1.5V8M8 2h4v4M12 2 6.5 7.5"
          />
        </svg>
      </button>
    </span>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { storeToRefs } from 'pinia'
import { useBrowserPanelStore, resolveInput } from '@/store/browserPanel'

/**
 * 底部 40px 导航条（PHASE2-SPEC §5）：后退/前进/刷新 + 地址栏
 * （不透明白底、不自动聚焦；hover 显示外开箭头）。
 * 前进后退按钮状态来自 bp:getState（navigationHistory，Electron ≥ 32）。
 */

const bpStore = useBrowserPanelStore()
const { urlPages, activePageId } = storeToRefs(bpStore)

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

// 回车导航当前激活页（地址栏输入 → 智能判断 URL vs 搜索）。
const locationGo = () => {
  const id = activePageId.value
  if (!id) return
  const target = resolveInput(locationText.value)
  if (!target) return
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
