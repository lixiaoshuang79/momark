<template>
  <!-- 开合动效：外层宽度 0↔288px 以 --ease-panel（.22,1,.36,1 零过冲非线性）
       过渡，与右侧面板完全一致；内层 dock-panel 悬浮卡片随宽度显隐。 -->
  <div class="side-bar" :class="{ open: showSideBar }">
    <div class="sb-inner">
      <!-- 顶部「大纲 / 文件」双 tab：白色滑块在选中项间滑动（回弹缓动，非线性），
           按钮自身不再换底，仅滑块位移 + 文字颜色过渡。round11：行尾补「关闭」
           按钮，对齐参考 gallery dock-head 的 close。 -->
      <div class="sb-tabs" role="tablist">
        <div class="sb-tabseg">
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
        <button
          class="sb-close"
          :title="t('sideBar.tabs.closePanel')"
          :aria-label="t('sideBar.tabs.closePanel')"
          @click="closeSideBar"
        >
          <mo-icon name="i-close" />
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
import MoIcon from '@/components/icons/MoIcon.vue'

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

// round11：行尾「关闭」按钮收起侧栏（对齐参考 gallery dock-head close）。
const closeSideBar = (): void => {
  layoutStore.SET_LAYOUT({ showSideBar: false })
}
</script>

<style scoped>
/* 展开 288px 卡片化侧栏（与右侧面板完全同构）：
   画布（--bg）透出，本体 = 悬浮卡片（白底、13px 圆角、轻投影，无边框更简洁），
   距窗口左/上/下缘 10px、贴内容侧。收起 = 宽度 0（常驻挂载，无 rail 残留）。
   开合 = 纯显式宽度动画（--ease-panel 非线性零过冲，时长与右侧面板一致
   .42s——用户要求左右开合效果保持一致）。
   ⚠️ 必须 flex-direction: column：sb-inner 用 width:auto + align-self:stretch
   撑满横向空间（与右栏 .bp-inner 同构）。缺这一行时主轴是 row，width:auto
   塌缩成内容宽度 → 切换大纲/文件时侧栏宽度大幅缩水（用户反馈 bug）。 */
.side-bar {
  display: flex;
  flex-direction: column;
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
}

.sb-inner {
  width: auto;
  align-self: stretch;
  /* 高度不做内容自适应：列容器内 flex:1 撑满窗口高度（与右栏卡片一致，
     用户拍板——否则卡片会缩成内容高度的一小块）。 */
  flex: 1 1 auto;
  min-width: 0;
  min-height: 0;
  box-sizing: border-box;
  margin: 10px 0 10px 10px;
  background: var(--surface-2);
  /* 用户拍板：去掉发丝边框，只留投影+圆角，整体更简洁 */
  border-radius: 13px;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.08);
  overflow: hidden;
  display: flex;
  flex-direction: column;
  padding: 10px 8px 12px;
}
[data-theme='dark'] .sb-inner {
  /* round11（用户拍板「深色下两个侧边栏特别丑」）：深色不再用「浅灰卡片
     +投影」浮层——改融入式：surface-1 底（比画布只亮半阶）+ 发丝描边，
     层次靠描边与选中高亮建立，与右栏 .bp-inner 同构。 */
  background: var(--surface-1);
  box-shadow: 0 0 0 1px var(--line);
}

.sb-tabs {
  display: flex;
  align-items: center;
  gap: 2px;
  background: var(--hover);
  border-radius: 8px;
  padding: 2px;
  margin-bottom: 10px;
  flex: none;
  position: relative;
}

/* round11：tab 分段容器（滑块 50% 以此为基准，关闭按钮不占滑块行程） */
.sb-tabseg {
  position: relative;
  flex: 1;
  display: flex;
  min-width: 0;
}

/* round11：行尾「关闭」按钮（参考 gallery dock-head 27px 圆角 hover） */
.sb-close {
  width: 27px;
  height: 27px;
  flex: none;
  display: grid;
  place-items: center;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--muted);
  cursor: pointer;
  transition:
    background 0.15s ease,
    color 0.15s ease;
}

.sb-close:hover {
  background: var(--hover);
  color: var(--ink);
}

.sb-close svg {
  width: 14px;
  height: 14px;
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
  /* round11：深色下滑块不再用亮卡片（surface-2）——用白 9% 浮层（Claude 分段
     控件选中态），与融入式侧栏整体协调。 */
  background: var(--selected);
  box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.12);
}

.sb-slider.right {
  transform: translateX(calc(100% + 2px));
}

.sb-tabseg button {
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

.sb-tabseg button.on {
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
