<template>
  <div class="url-dock" :class="{ on: pages.length >= 2 }" aria-label="网页 Dock">
    <button
      v-for="page of pages"
      :key="page.id"
      type="button"
      class="ud-item"
      :class="{ sel: page.id === activePageId, hoverpin: hoverId === page.id }"
      :title="page.title"
      @click.stop="activate(page.id)"
      @mouseenter="pinHover(page.id)"
      @mouseleave="scheduleUnpin"
    >
      <span class="ud-ic">
        <img v-if="page.favicon" :src="page.favicon" alt="" />
        <span v-else class="ud-letter">{{ letterOf(page) }}</span>
      </span>
      <!-- hover 出现的关闭按钮：图标左侧小圆钮，hover 该项才出现 -->
      <span
        role="button"
        class="ud-close"
        title="关闭该网页"
        @click.stop="close(page.id)"
        @mouseenter="cancelUnpin"
        @mouseleave="scheduleUnpin"
      >
        <mo-icon name="i-x" />
      </span>
    </button>
    <!-- round18：Dock 末尾的「+」= 同一个「+ / 搜索栏」控件（dock 落点）：
         hover 就地展开搜索栏、右缘与 + 对齐（旧实现只有 click 且展开在右上角）。 -->
    <addr-wrap variant="dock" />
  </div>
</template>

<script setup lang="ts">
import { ref, onBeforeUnmount } from 'vue'
import MoIcon from '@/components/icons/MoIcon.vue'
import AddrWrap from './addrWrap.vue'
import { useBrowserPanelStore } from '@/store/browserPanel'

// 网址右缘 Dock（PHASE2-SPEC §5）：≥2 页显示；34×34 圆角 9px 底 --ud-bg；
// hover translateX(-3px) scale(1.08)；当前=白底 1.5px 墨蓝边；
// hover scale(.96)；末尾是「+ / 搜索栏」控件（round18：hover 就地展开，见 addrWrap
// 的 dock 落点）；每项 hover 出现关闭 ×
// （网址气泡已取消：底部有网址栏，不再冗余展示）。
// hover 驻留：× 位于图标盒之外，纯 CSS :hover 会让鼠标在移向 × 的途中
// 瞬间收起、× 点不到 —— 改为 JS 状态（hoverpin）：移出图标后延迟 260ms
// 收起，期间鼠标进入 ×（或回到图标）即取消收起，保证「图标 ↔ ×」
// 整个区域移动时 × 保持可点。
defineProps<{
  pages: import('@/store/browserPanel').WebPage[]
  activePageId: string | null
}>()

const bpStore = useBrowserPanelStore()

const hoverId = ref<string | null>(null)
let unpinTimer: ReturnType<typeof setTimeout> | null = null

const pinHover = (id: string) => {
  cancelUnpin()
  hoverId.value = id
}

const scheduleUnpin = () => {
  cancelUnpin()
  unpinTimer = setTimeout(() => {
    hoverId.value = null
  }, 260)
}

const cancelUnpin = () => {
  if (unpinTimer) {
    clearTimeout(unpinTimer)
    unpinTimer = null
  }
}

onBeforeUnmount(cancelUnpin)

const activate = (id: string) => {
  bpStore.ACTIVATE_PAGE(id)
}

const close = (id: string) => {
  bpStore.CLOSE_PAGE(id)
}

const letterOf = (page: { url: string; title: string }): string => {
  const host = page.url.replace(/^https?:\/\//, '').split('/')[0]
  const base = host || page.title || '?'
  return base.charAt(0).toUpperCase()
}
</script>
