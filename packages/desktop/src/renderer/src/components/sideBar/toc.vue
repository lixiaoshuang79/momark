<template>
  <div class="side-bar-toc">
    <div v-if="listToc.length" class="toc-list">
      <div
        v-for="(item, index) of listToc"
        :key="typeof item.slug === 'string' ? item.slug : `toc-${index}`"
        class="sb-row"
        :class="[
          `lv${tocLevel(item)}`,
          { sel: typeof item.slug === 'string' && item.slug.length > 0 && item.slug === activeSlug }
        ]"
        :title="String(item.content ?? '')"
        @click="handleClick(item)"
        @mousedown.prevent
      >
        <span class="label">{{ item.content }}</span>
      </div>
    </div>
    <div v-else class="sb-empty">
      <span>{{ t('sideBar.toc.empty') }}</span>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useEditorStore } from '@/store/editor'
import bus from '../../bus'
import { useI18n } from 'vue-i18n'

const { t } = useI18n()

const editorStore = useEditorStore()

// H1-H6 标题树（引擎 getTOC 平铺列表，按 lvl 缩进分级；现有 tocNavigation 机制保留：
// 点击仍走 scroll-to-header 总线，由 editor 定位滚动，不抢编辑区焦点）。
const listToc = computed(() => editorStore.listToc)

const tocLevel = (item: { lvl?: number | null }): number => Math.min(Math.max(item.lvl ?? 1, 1), 6)

// 当前标题高亮：光标移动/滚动时 editor 通过 'toc::active-slug' 同步当前标题 slug。
const activeSlug = ref<string | null>(null)

const handleActiveSlug = (slug: unknown): void => {
  activeSlug.value = typeof slug === 'string' && slug.length > 0 ? slug : null
}

const handleClick = (item: { slug?: unknown }): void => {
  // editor.vue 以 slug 构建选择器定位标题——无 slug（不可锚定标题）时直接忽略。
  if (typeof item.slug !== 'string' || item.slug.length === 0) return
  bus.emit('scroll-to-header', item.slug)
}

onMounted(() => {
  bus.on('toc::active-slug', handleActiveSlug)
  // 侧栏与编辑器挂载顺序不定（编辑区可能后挂载），主动请求一次当前高亮。
  bus.emit('toc::request-active')
})

onBeforeUnmount(() => {
  bus.off('toc::active-slug', handleActiveSlug)
})
</script>

<style scoped>
.side-bar-toc {
  height: 100%;
  overflow-x: hidden;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
}

.toc-list {
  display: flex;
  flex-direction: column;
}

.sb-row {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 32px;
  padding: 0 8px;
  border-radius: 8px;
  color: var(--ink);
  font-size: var(--f12);
  cursor: pointer;
  margin-bottom: 1px;
  transition: background 0.15s ease;
}

.sb-row:hover {
  background: var(--hover);
}

/* 当前标题高亮：--selected 底 */
.sb-row.sel {
  background: var(--selected);
}

.sb-row .label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 缩进分级：lv2 = 30px（规格），逐级 +22px */
.sb-row.lv2 {
  padding-left: 30px;
  color: var(--muted);
}
.sb-row.lv3 {
  padding-left: 52px;
  color: var(--muted);
}
.sb-row.lv4 {
  padding-left: 74px;
  color: var(--muted);
}
.sb-row.lv5 {
  padding-left: 96px;
  color: var(--muted);
}
.sb-row.lv6 {
  padding-left: 118px;
  color: var(--muted);
}

.sb-empty {
  padding: 16px 8px;
  font-size: var(--f11);
  color: var(--faint);
}
</style>
