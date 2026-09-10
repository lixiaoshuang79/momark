<template>
  <!-- round11：导航按钮（后退/前进/刷新）上移至顶部 bp-tools（对齐参考
       gallery browser-tools），本行只保留地址栏 + 外开。 -->
  <div class="bp-browserbar">
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
 * 底部 40px 导航条（PHASE2-SPEC §5）：地址栏（不透明白底、不自动聚焦；
 * hover 显示外开箭头）。导航按钮已上移至顶部 bp-tools（round11）。
 */

const bpStore = useBrowserPanelStore()
const { urlPages, activePageId } = storeToRefs(bpStore)

const locationEl = ref<HTMLInputElement | null>(null)
const locationText = ref('')

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
  if (!id) return
  try {
    const state = await window.bp.getState(id)
    if (state.url) locationText.value = state.url
  } catch {
    /* 忽略：地址栏保持上次输入 */
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
