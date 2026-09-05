<template>
  <div class="url-dock" :class="{ on: pages.length >= 2 }" aria-label="网页 Dock">
    <button
      v-for="page of pages"
      :key="page.id"
      type="button"
      class="ud-item"
      :class="{ sel: page.id === activePageId }"
      :title="page.title"
      @click.stop="activate(page.id)"
    >
      <span class="ud-ic">
        <img v-if="page.favicon" :src="page.favicon" alt="" />
        <span v-else class="ud-letter">{{ letterOf(page) }}</span>
      </span>
      <span class="ud-bubble">{{ page.url }}</span>
    </button>
    <button type="button" class="ud-add" title="新增网页" @click.stop="openAddr">
      <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.6">
        <path d="M7 2v10M2 7h10" />
      </svg>
    </button>
  </div>
</template>

<script setup lang="ts">
import { useBrowserPanelStore } from '@/store/browserPanel'

// 网址右缘 Dock（PHASE2-SPEC §5）：≥2 页显示；34×34 圆角 9px 底 --ud-bg；
// hover translateX(-3px) scale(1.08) + HUD 气泡；当前=白底 1.5px 墨蓝边；
// 相邻项 scale(.96)；末尾虚线 + 新增（展开网址栏）。
defineProps<{
  pages: import('@/store/browserPanel').WebPage[]
  activePageId: string | null
}>()

const bpStore = useBrowserPanelStore()

const activate = (id: string) => {
  bpStore.ACTIVATE_PAGE(id)
}

const openAddr = () => {
  bpStore.SET_DOCK_ADDR_OPEN(true)
}

const letterOf = (page: { url: string; title: string }): string => {
  const host = page.url.replace(/^https?:\/\//, '').split('/')[0]
  const base = host || page.title || '?'
  return base.charAt(0).toUpperCase()
}
</script>
