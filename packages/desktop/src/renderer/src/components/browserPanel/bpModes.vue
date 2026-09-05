<template>
  <div class="bp-modes" :class="{ shown: shown }" role="tablist" aria-label="面板模式">
    <button
      role="tab"
      :aria-selected="mode === 'url'"
      :class="{ on: mode === 'url' }"
      title="网址模式"
      @click.stop="select('url')"
    >
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5">
        <circle cx="8" cy="8" r="6" />
        <path d="M2 8h12M8 2c2 3.3 2 8.7 0 12M8 2c-2 3.3-2 8.7 0 12" />
      </svg>
      网址
    </button>
    <button
      role="tab"
      :aria-selected="mode === 'doc'"
      :class="{ on: mode === 'doc' }"
      title="文档模式"
      @click.stop="select('doc')"
    >
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5">
        <path d="M3 1.5h7l3 3v10H3z" />
        <path d="M10 1.5v3h3M5.5 8h5M5.5 10.5h5" />
      </svg>
      文档
    </button>
  </div>
</template>

<script setup lang="ts">
import { storeToRefs } from 'pinia'
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
