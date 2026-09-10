<template>
  <!-- round11：对齐参考 gallery .browser-panel 的 browser-tools——43px 顶部工具条
       （后退/前进/刷新 + 关闭），导航按钮自原底部 navBar 上移。 -->
  <div class="bp-tools">
    <template v-if="mode === 'url'">
      <button :title="t('browserPanel.tools.back')" :disabled="!canGoBack" @click="goBack">
        <mo-icon name="i-chev-left" />
      </button>
      <button :title="t('browserPanel.tools.forward')" :disabled="!canGoForward" @click="goForward">
        <mo-icon name="i-chev-right" />
      </button>
      <button :title="t('browserPanel.tools.reload')" @click="reload">
        <mo-icon name="i-refresh" />
      </button>
    </template>
    <template v-else>
      <b class="bp-dochead">{{ t('browserPanel.docTitle') }}</b>
    </template>
    <span class="grow" />
    <button
      class="bp-close"
      :title="t('browserPanel.closePanel')"
      :aria-label="t('browserPanel.closePanel')"
      @click="closePanel"
    >
      <mo-icon name="i-close" />
    </button>
  </div>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue'
import { storeToRefs } from 'pinia'
import MoIcon from '@/components/icons/MoIcon.vue'
import { useBrowserPanelStore } from '@/store/browserPanel'
import { t } from '../../i18n'

/**
 * 右栏顶部工具条（PHASE2-SPEC §5 导航能力 + 参考 gallery browser-tools）：
 * 后退/前进/刷新 27px 圆角按钮（disabled 半透明）+ 行尾关闭面板按钮。
 * 前进后退按钮状态来自 bp:getState（navigationHistory，Electron ≥ 32）。
 */

const bpStore = useBrowserPanelStore()
const { urlPages, activePageId, mode } = storeToRefs(bpStore)

const canGoBack = ref(false)
const canGoForward = ref(false)

const refreshNavState = async () => {
  const id = activePageId.value
  if (!id) {
    canGoBack.value = false
    canGoForward.value = false
    return
  }
  try {
    const state = await window.bp.getState(id)
    canGoBack.value = !!state.canGoBack
    canGoForward.value = !!state.canGoForward
  } catch {
    canGoBack.value = false
    canGoForward.value = false
  }
}

watch(
  () => [activePageId.value, urlPages.value.map((p) => p.loading).join(',')],
  () => {
    refreshNavState().catch(() => {})
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

const closePanel = () => {
  bpStore.SET_OPEN(false)
}
</script>

<style scoped>
.bp-tools {
  height: 43px;
  min-height: 43px;
  flex: none;
  display: flex;
  align-items: center;
  padding: 0 9px;
  gap: 1px;
}

.bp-tools button {
  width: 27px;
  height: 27px;
  flex: none;
  display: grid;
  place-items: center;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--muted);
  cursor: pointer;
  transition:
    background 0.15s ease,
    color 0.15s ease;
}

.bp-tools button:hover {
  background: var(--hover);
  color: var(--ink);
}

.bp-tools button:disabled {
  opacity: 0.32;
  cursor: default;
}

.bp-tools button:disabled:hover {
  background: none;
}

.bp-tools svg {
  width: 15px;
  height: 15px;
}

.bp-tools .grow {
  flex: 1;
}

.bp-tools .bp-dochead {
  font-size: 15px;
  font-weight: 540;
  color: var(--ink);
  padding-left: 3px;
}
</style>
