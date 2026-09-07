<template>
  <div class="bp-modes" :class="{ shown: shown }" role="tablist" aria-label="面板模式">
    <span class="bp-slider" :class="{ right: mode === 'doc' }" aria-hidden="true" />
    <button
      role="tab"
      :aria-selected="mode === 'url'"
      :class="{ on: mode === 'url' }"
      title="网页模式"
      @click.stop="select('url')"
    >
      <mo-icon name="i-globe" />
      网页
    </button>
    <button
      role="tab"
      :aria-selected="mode === 'doc'"
      :class="{ on: mode === 'doc' }"
      title="文档模式"
      @click.stop="select('doc')"
    >
      <mo-icon name="i-doc" />
      文档
    </button>
  </div>
</template>

<script setup lang="ts">
import { storeToRefs } from 'pinia'
import MoIcon from '@/components/icons/MoIcon.vue'
import { useBrowserPanelStore } from '@/store/browserPanel'

// 网址/文档选择器（PHASE2-SPEC §5）：紧跟开关之后，无独立头部行。
// 容器 18px scaleX(.18) → 154px 生长回弹；两个 tab 错峰滑入（延迟 .08/.14s）。
// shown 由面板开合驱动（面板打开后才可交互）。
defineProps<{
  shown: boolean
}>()

const bpStore = useBrowserPanelStore()
const { mode } = storeToRefs(bpStore)

const select = (next: 'url' | 'doc') => {
  if (mode.value !== next) bpStore.SET_MODE(next)
}
</script>
