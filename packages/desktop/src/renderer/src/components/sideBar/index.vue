<template>
  <!-- 开合动效：外层宽度 0↔288px 以 --ease-panel（.22,1,.36,1 零过冲非线性）
       过渡，与右侧面板完全一致；内层 dock-panel 悬浮卡片随宽度显隐。 -->
  <div class="side-bar" :class="{ open: showSideBar }">
    <div class="sb-inner">
      <!-- 顶部「大纲 / 文件」双 tab：白色滑块在选中项间滑动（回弹缓动，非线性），
           按钮自身不再换底，仅滑块位移 + 文字颜色过渡。 -->
      <div class="sb-tabs" role="tablist">
        <span class="sb-slider" :class="{ right: activeTab === 'files' }" aria-hidden="true" />
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
import { t } from '../../i18n'

import Tree from './tree.vue'
import Toc from './toc.vue'

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
/* 展开 288px 卡片化侧栏（dock-panel 规格，与右侧面板一致）：
   画布（--bg）透出，本体 = 悬浮卡片（白底、.5px 发丝边、13px 圆角、轻投影），
   距窗口左/上/下缘 10px、贴内容侧。收起 = 宽度 0（常驻挂载，无 rail 残留）。
   开合 = 纯显式宽度动画（--ease-panel 非线性零过冲，时长与右侧面板一致
   .42s——用户要求左右开合效果保持一致）。 */
.side-bar {
  display: flex;
  flex-shrink: 0;
  flex-grow: 0;
  width: 0;
  min-width: 0;
  height: 100%;
  position: relative;
  color: var(--ink);
  user-select: none;
  background: transparent;
  overflow: hidden;
  transition: width 0.42s var(--ease-panel);
}
.side-bar.open {
  width: var(--sidebar-w);
  min-width: var(--sidebar-w);
}

.sb-inner {
  width: auto;
  align-self: stretch;
  min-width: 0;
  box-sizing: border-box;
  margin: 10px 0 10px 10px;
  background: var(--surface-2);
  border: 0.5px solid var(--line);
  border-radius: 13px;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.08);
  overflow: hidden;
  display: flex;
  flex-direction: column;
  padding: 10px 8px 12px;
}
[data-theme='dark'] .sb-inner {
  border-color: rgba(255, 255, 255, 0.12);
  box-shadow: 0 2px 10px rgba(0, 0, 0, 0.45);
}

.sb-tabs {
  display: flex;
  gap: 2px;
  background: var(--hover);
  border-radius: 8px;
  padding: 2px;
  margin-bottom: 10px;
  flex: none;
  position: relative;
}

/* 滑动滑块：尺寸=单个按钮，在 padding/gap 内平移；回弹缓动（非线性，
   超越终点后回弹的弹簧手感）。按钮内容 z-index 在滑块之上。 */
.sb-slider {
  position: absolute;
  top: 2px;
  left: 2px;
  width: calc(50% - 3px);
  height: calc(100% - 4px);
  background: var(--surface-2);
  border-radius: 6px;
  box-shadow: 0 0 0 1px var(--line);
  transition: transform 0.34s cubic-bezier(0.3, 1.35, 0.4, 1);
  z-index: 0;
}

[data-theme='dark'] .sb-slider {
  box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.12);
}

.sb-slider.right {
  transform: translateX(calc(100% + 2px));
}

.sb-tabs button {
  position: relative;
  z-index: 1;
  flex: 1;
  border: none;
  background: transparent;
  color: var(--muted);
  font-size: var(--f11);
  line-height: 1.45;
  padding: 5px 0;
  border-radius: 6px;
  cursor: pointer;
  transition: color 0.15s ease;
}

.sb-tabs button.on {
  color: var(--ink);
  font-weight: 600;
}

.sb-sec {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
</style>
