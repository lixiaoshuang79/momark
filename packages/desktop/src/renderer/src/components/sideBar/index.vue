<template>
  <div v-show="showSideBar" class="side-bar">
    <div class="sb-inner">
      <!-- 顶部「大纲 / 文件」双 tab 中性胶囊：容器 hover 底圆角 8px；选中=卡片底+hairline 描边+深色文字（不用墨蓝填充） -->
      <div class="sb-tabs" role="tablist">
        <button
          role="tab"
          :aria-selected="activeTab === 'outline'"
          :class="{ on: activeTab === 'outline' }"
          @click="selectTab('outline')"
        >
          {{ t('sideBar.tabs.outline') }}
        </button>
        <button
          role="tab"
          :aria-selected="activeTab === 'files'"
          :class="{ on: activeTab === 'files' }"
          @click="selectTab('files')"
        >
          {{ t('sideBar.tabs.files') }}
        </button>
      </div>

      <!-- 大纲 tab -->
      <div v-show="activeTab === 'outline'" class="sb-sec">
        <toc />
      </div>

      <!-- 文件 tab -->
      <div v-show="activeTab === 'files'" class="sb-sec">
        <tree />
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useLayoutStore } from '@/store/layout'
import { storeToRefs } from 'pinia'
import { useI18n } from 'vue-i18n'

import Tree from './tree.vue'
import Toc from './toc.vue'

const { t } = useI18n()

const layoutStore = useLayoutStore()

const { rightColumn, showSideBar } = storeToRefs(layoutStore)

// MoMark：右栏（rail）已移除。rightColumn 仅保留 toc/files 语义用于 tab 选择，
// 其余历史值（search/''）一律落到文件 tab。
type SideBarTab = 'outline' | 'files'
const activeTab = computed<SideBarTab>(() => (rightColumn.value === 'toc' ? 'outline' : 'files'))

const selectTab = (tab: SideBarTab): void => {
  const column = tab === 'outline' ? 'toc' : 'files'
  if (rightColumn.value !== column) {
    layoutStore.SET_LAYOUT({ rightColumn: column })
  }
}
</script>

<style scoped>
/* 展开 288px 底 --sidebar，右侧 .5px 发丝线；收起 = v-show false，完全无占位（无 45px rail 残留） */
.side-bar {
  display: flex;
  flex-shrink: 0;
  flex-grow: 0;
  width: var(--sidebar-w);
  min-width: var(--sidebar-w);
  height: 100vh;
  position: relative;
  color: var(--ink);
  user-select: none;
  background: var(--sidebar);
  border-right: 0.5px solid var(--line);
}

.sb-inner {
  width: var(--sidebar-w);
  height: 100%;
  padding: 10px 8px 12px;
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
}

.sb-tabs {
  display: flex;
  gap: 2px;
  background: var(--hover);
  border-radius: 8px;
  padding: 2px;
  margin-bottom: 10px;
  flex: none;
}

.sb-tabs button {
  flex: 1;
  border: none;
  background: transparent;
  color: var(--muted);
  font-size: var(--f11);
  padding: 5px 0;
  border-radius: 6px;
  cursor: pointer;
  transition:
    background 0.15s ease,
    color 0.15s ease;
}

.sb-tabs button.on {
  background: var(--surface-2);
  color: var(--ink);
  font-weight: 600;
  box-shadow: 0 0 0 1px var(--line);
}

[data-theme='dark'] .sb-tabs button.on {
  box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.12);
}

.sb-sec {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
</style>
