<template>
  <!-- 右侧栏开关（round2：原地切换）。
       v1 把开关放在标签条最右：面板一开，左列变窄，开关跟着被推左一整列（1440 窗口
       约 418px），旁边再冒出面板头部——像「被顶出去、多了一块」。
       现在开关不属于任何一列：钉在 win-body 右上角（与标签栏同一行），位置永远不变。
       收起时它就是标签条最右的按钮；展开时面板卡片从右侧滑到它的下面，它自然成了
       面板头部最右端的按钮——和左侧标题轨开关一样，按钮不动、内容原地展开。
       同形图标、填充表示开合、未复制标注圆点、右键「打开到…」全部沿用 v1。 -->
  <button
    ref="el"
    class="panel-toggle"
    :class="{ on: open, 'has-dot': dot, dim: single && !open && !dot }"
    :title="title"
    :aria-label="title"
    :aria-pressed="open"
    @click.stop="bpStore.TOGGLE_PANEL()"
    @contextmenu.prevent.stop="openMenu"
  >
    <svg class="pt-icon" viewBox="0 0 16 16" aria-hidden="true">
      <rect x="2" y="3" width="12" height="10" rx="2" />
      <path d="M10 3v10" />
      <path class="pfill" d="M10 3h2a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2h-2z" />
    </svg>
    <i class="tdot" />
  </button>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { storeToRefs } from 'pinia'
import { t } from '../../i18n'
import { isLinux, isOsx } from '@/util'
import { useBrowserPanelStore } from '@/store/browserPanel'
import { usePreferencesStore } from '@/store/preferences'
import { useWorkspaceStore } from '@/store/workspace'
import { useAnnotationStore, prefersReducedMotion } from '@/store/annotation'
import { popupContextMenu } from '../../contextMenu/popupMenu'

const bpStore = useBrowserPanelStore()
const preferencesStore = usePreferencesStore()
const annotationStore = useAnnotationStore()
const { open } = storeToRefs(bpStore)
const { scene } = storeToRefs(useWorkspaceStore())

const el = ref<HTMLElement | null>(null)
const single = computed(() => scene.value === 'single')

const shortcut = (): string => (isOsx ? '⌥⌘\\' : 'Ctrl+Alt+\\')
const annotationOn = computed(() => preferencesStore.annotationEnabled !== false)
const dot = computed(() => !open.value && annotationOn.value && annotationStore.uncopiedCount > 0)
const title = computed(() => {
  if (open.value) return `${t('rightPanel.toggle.close')} ${shortcut()}`
  const base = dot.value
    ? t('rightPanel.toggle.openWithPending', { n: annotationStore.uncopiedCount })
    : t('rightPanel.toggle.open')
  return `${base} ${shortcut()}`
})

const openMenu = (event: MouseEvent): void => {
  const accel = (n: number): string | undefined =>
    isLinux ? undefined : `${isOsx ? 'Command' : 'Ctrl'}+Alt+${n}`
  const items = [
    !bpStore.turboMode && {
      label: t('rightPanel.toggle.openTo', { tab: t('rightPanel.tab.web') }),
      accelerator: accel(1),
      click: () => bpStore.OPEN_TO_TAB('url')
    },
    {
      label: t('rightPanel.toggle.openTo', { tab: t('rightPanel.tab.doc') }),
      accelerator: accel(2),
      click: () => bpStore.OPEN_TO_TAB('doc')
    },
    annotationOn.value && {
      label: t('rightPanel.toggle.openTo', { tab: t('annotation.tab') }),
      accelerator: accel(3),
      click: () => bpStore.OPEN_TO_TAB('annotation')
    },
    open.value && { type: 'separator' },
    open.value && {
      label: t('rightPanel.toggle.close'),
      click: () => bpStore.SET_OPEN(false)
    }
  ].filter(Boolean) as Array<{ label?: string; type?: string; click?: () => void }>
  popupContextMenu(items, { x: event.clientX, y: event.clientY })
}

// 面板收起时新标注的飞点落在开关上：到达后开关弹跳一下
watch(
  () => annotationStore.badgePulse,
  () => {
    if (open.value || prefersReducedMotion()) return
    el.value?.animate(
      [{ transform: 'scale(1)' }, { transform: 'scale(1.16)' }, { transform: 'scale(1)' }],
      { duration: 300, easing: 'cubic-bezier(0.18, 1.28, 0.36, 1)' }
    )
  }
)
</script>

<style scoped>
/* 定位：win-body 右上角、与标签栏同一行（标签栏 40px，按钮 32px，上下各 4px）。
   right 由 --panel-toggle-right 给出（browserPanel.css），展开后正好落在面板
   卡片头部右端、与卡片圆角同心。 */
.panel-toggle {
  position: absolute;
  top: 4px;
  right: var(--panel-toggle-right, 6px);
  z-index: 32;
  width: 32px;
  height: 32px;
  border: none;
  background: transparent;
  border-radius: 8px;
  cursor: pointer;
  display: grid;
  place-items: center;
  color: var(--muted);
  transition:
    background-color 0.22s ease,
    color 0.22s ease,
    opacity 0.22s ease,
    transform 0.16s cubic-bezier(0.2, 0, 0, 1);
}
.panel-toggle:hover {
  background: var(--hover);
  color: var(--ink);
}
.panel-toggle:active {
  transform: scale(0.94);
}
.panel-toggle.on {
  background: color-mix(in oklab, var(--accent) 10%, transparent);
  color: var(--accent);
}
.panel-toggle.on:hover {
  background: color-mix(in oklab, var(--accent) 15%, transparent);
}
/* 单文档态：与标题轨开关一致，低不透明度保简洁，hover / 激活时完全显现 */
.panel-toggle.dim {
  opacity: 0.42;
}
.panel-toggle.dim:hover {
  opacity: 1;
}
.panel-toggle:focus-visible {
  outline: none;
  box-shadow: var(--focus-ring);
}
.pt-icon {
  width: 16px;
  height: 16px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.35;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.pt-icon .pfill {
  fill: currentColor;
  stroke: none;
  transform-box: fill-box;
  transform-origin: right center;
  transform: scaleX(0);
  transition: transform 0.32s var(--ease-panel);
}
.panel-toggle.on .pfill {
  transform: scaleX(1);
}
.tdot {
  position: absolute;
  top: 5px;
  right: 5px;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--accent);
  box-shadow: 0 0 0 2px var(--bg);
  transform: scale(0);
  transition: transform 0.25s var(--ease-panel);
}
.panel-toggle.has-dot .tdot {
  transform: scale(1);
}
@media (prefers-reduced-motion: reduce) {
  .pt-icon .pfill,
  .tdot,
  .panel-toggle {
    transition: none;
  }
}
</style>
