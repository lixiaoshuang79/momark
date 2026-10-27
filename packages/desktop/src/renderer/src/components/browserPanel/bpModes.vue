<template>
  <div
    v-if="!turboMode || showAnnotation"
    class="bp-modes"
    :class="{ shown: shown, three: showAnnotation && !turboMode, turbo: turboMode }"
    role="tablist"
    aria-label="面板模式"
  >
    <span class="bp-slider" :class="sliderPos" aria-hidden="true" />
    <button
      v-if="!turboMode"
      role="tab"
      :aria-selected="activeTab === 'url'"
      :class="{ on: activeTab === 'url' }"
      title="网页模式"
      @click.stop="select('url')"
    >
      <mo-icon name="i-globe" />
      网页
    </button>
    <button
      role="tab"
      :aria-selected="activeTab === 'doc'"
      :class="{ on: activeTab === 'doc' }"
      title="文档模式"
      @click.stop="select('doc')"
    >
      <mo-icon name="i-doc" />
      文档
    </button>
    <button
      v-if="showAnnotation"
      role="tab"
      class="bp-mode-ann"
      :aria-selected="activeTab === 'annotation'"
      :class="{ on: activeTab === 'annotation' }"
      :title="t('annotation.tabPanel')"
      @click.stop="select('annotation')"
    >
      <!-- 气泡+笔：与既有 14px 线性图标同规格（无 moSymbols 资源，就地内联） -->
      <svg
        class="ann-ic"
        width="14"
        height="14"
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        stroke-width="1.35"
        stroke-linejoin="round"
        stroke-linecap="round"
      >
        <path
          d="M2.2 4.1c0-1 .8-1.8 1.8-1.8h8c1 0 1.8.8 1.8 1.8v5c0 1-.8 1.8-1.8 1.8H6.6l-3 2.6v-2.6h-.6c-.5 0-.8-.4-.8-.8z"
        />
        <path d="M5.4 6.2h5.2M5.4 8.4h3.2" />
      </svg>
      {{ t('annotation.tab') }}
      <span v-if="uncopied" ref="badgeEl" class="bp-mode-badge">{{ uncopied }}</span>
    </button>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { storeToRefs } from 'pinia'
import MoIcon from '@/components/icons/MoIcon.vue'
import { t } from '../../i18n'
import { prefersReducedMotion, useAnnotationStore } from '@/store/annotation'
import { useBrowserPanelStore, type BpActiveTab } from '@/store/browserPanel'
import { usePreferencesStore } from '@/store/preferences'

// 网址/文档选择器（PHASE2-SPEC §5）：紧跟开关之后，无独立头部行。
// 容器 18px scaleX(.18) → 生长回弹；各 tab 错峰滑入（延迟 .08/.14/.20s）。
// shown 由面板开合驱动（面板打开后才可交互）。
//
// feat/annotations：追加第三个 tab「标注」。三档几何（方案 §5.1）——
// 容器 170px → 255px、滑块 calc(50% - 3px) → calc(33.333% - 3px)、第三档位
// translateX(calc(200% + 4px))。这套几何只在 `three` 类下生效，偏好关闭
// （只剩两个 tab）时退回原来的两档尺寸——因此覆盖规则写在本组件而不是
// 全局 browserPanel.css 里。
//
// 极速模式：网页档整个移除。文档变成第一档、标注第二档；标注偏好也关掉时
// 只剩文档一档，选择器整体不渲染（没有可切换的档位）。
defineProps<{
  shown: boolean
}>()

const bpStore = useBrowserPanelStore()
const annotationStore = useAnnotationStore()
const preferencesStore = usePreferencesStore()
const { activeTab, turboMode } = storeToRefs(bpStore)

const showAnnotation = computed(() => preferencesStore.annotationEnabled !== false)
const uncopied = computed(() => annotationStore.uncopiedCount)

// ── 徽标弹跳（原型动效 #23，feat/quick-phrases）────────────────────────
// 飞点到达时由 annotation store 的 badgePulse 触发：1→1.22→1（300ms 回弹）。
// 「0→1 条」意味着徽标本身刚出现，从 .5 长起来与飞点到达衔接（设计如此）。
const badgeEl = ref<HTMLElement | null>(null)
let appearedAt = 0

watch(uncopied, (value, previous) => {
  if (previous === 0 && value > 0) appearedAt = Date.now()
})

watch(
  () => annotationStore.badgePulse,
  () => {
    // 系统开了「减少动态效果」就不弹：飞点已经跳过，这里再弹一下反而更跳脱
    if (prefersReducedMotion()) return
    nextTick(() => {
      const el = badgeEl.value
      if (!el) return
      const from = Date.now() - appearedAt < 2000 ? 0.5 : 1
      el.animate(
        [{ transform: `scale(${from})` }, { transform: 'scale(1.22)' }, { transform: 'scale(1)' }],
        { duration: 300, easing: 'cubic-bezier(0.18, 1.28, 0.36, 1)' }
      )
    })
  }
)

const sliderPos = computed(() => {
  // doc 档沿用全局 `.bp-slider.right`（100% + 2px = 滑块宽 + 档间 gap）；
  // 三档下滑块窄了，同样的公式依然成立，只有第三档需要新位置。
  // 极速模式没有网页档：文档变成第一档，标注是第二档。
  if (activeTab.value === 'url') return ''
  if (turboMode.value) return activeTab.value === 'annotation' ? 'turbo-ann' : ''
  return activeTab.value === 'annotation' ? 'pos-ann' : 'right'
})

const select = (next: BpActiveTab) => {
  if (activeTab.value !== next) bpStore.SET_TAB(next)
}
</script>

<style>
/* ── 三档（feat/annotations）：容器加宽、滑块三等分 ──
   覆盖全局 .bp-modes/.bp-slider 的两档几何；用 `.three` 前缀压过基础规则
   （特异性更高，不依赖样式注入顺序）。 */
.bp-modes.three.shown {
  width: 255px;
}
.bp-modes.three .bp-slider {
  width: calc(33.333% - 3px);
}
.bp-modes.three .bp-slider.pos-ann {
  transform: translateX(calc(200% + 4px));
}
.bp-modes.three.shown button:nth-child(4) {
  transition-delay: 0.2s;
}

/* 三档下强制**严格等宽**（`flex-basis: 0`）：全局的 `flex: 1 0 auto` 按内容
   定基准，内容多的「标注」（多一枚计数徽标）会被撑宽——实测 76 / 76 / 94，
   而滑块仍是 33.333% 的固定几何，两者错位，看起来就是"布局失去平衡"。
   内距与图标/文字间距同时收紧一档，给徽标留出空间。 */
.bp-modes.three button {
  flex: 1 1 0;
  gap: 4px;
  padding: 5px 6px;
}

/* 极速模式：网页档整个移除，文档/标注变成两档；文档在左、标注在右。 */
.bp-modes.turbo .bp-slider.turbo-ann {
  transform: translateX(calc(100% + 2px));
}

.bp-mode-ann .bp-mode-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  box-sizing: border-box;
  min-width: 14px;
  height: 14px;
  padding: 0 3px;
  border-radius: 7px;
  background: var(--accent);
  color: var(--accent-on);
  font: 500 9.5px/1 var(--font-mono);
  text-align: center;
  letter-spacing: 0;
}
</style>
