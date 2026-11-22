<template>
  <aside
    ref="panelEl"
    class="bpanel"
    :class="{
      collapsed: !bpanelOpen,
      overlay: panelOverlay,
      'drop-ok': dragState === 'over'
    }"
    :style="panelStyle"
    :aria-label="t('rightPanel.label')"
    :aria-hidden="!bpanelOpen"
    :inert="!bpanelOpen || undefined"
    @dragover="onDragOver"
    @dragleave="onDragLeave"
    @drop="onDrop"
    @keydown.esc="onEsc"
  >
    <div ref="innerEl" class="bp-inner">
      <bp-head :entering="entering" />
      <!-- 头部下方 2px 墨蓝进度线（任何激活页加载中即显示） -->
      <div class="bp-track" :class="{ show: activePageLoading }" />

      <!-- 三个 pane 常驻挂载（v-show）：切换 tab、收起再展开都不影响里面的内容与
           状态（网页登录态/滚动、分屏文档）。极速模式例外：网页 pane 整块卸载，
           保证一个 <webview> 都不留。切换时按 tab 顺序水平进出（共享 X 轴）。 -->
      <div class="rp-panes">
        <section
          v-if="!turboMode"
          v-show="isShown('url')"
          id="rp-pane-url"
          ref="paneUrl"
          class="rp-pane"
          role="tabpanel"
          aria-labelledby="rp-tab-url"
        >
          <url-mode />
        </section>
        <section
          v-show="isShown('doc')"
          id="rp-pane-doc"
          ref="paneDoc"
          class="rp-pane"
          role="tabpanel"
          aria-labelledby="rp-tab-doc"
        >
          <doc-mode />
        </section>
        <section
          v-show="isShown('annotation')"
          id="rp-pane-annotation"
          ref="paneAnn"
          class="rp-pane"
          role="tabpanel"
          aria-labelledby="rp-tab-annotation"
        >
          <annotation-mode />
        </section>
      </div>

      <!-- 拖标签进面板：虚线投放框 -->
      <div class="rp-dropov" aria-hidden="true">
        <div>
          <b>{{ t('rightPanel.drop.title', { name: dragName }) }}</b>
          <span>{{ t('rightPanel.drop.sub') }}</span>
        </div>
      </div>
    </div>

    <!-- 常用语设置弹窗（本窗口模态，teleport 到 body；由标注 store 的
         quickPhraseSettingsOpen 驱动，引擎卡片 ⚙ 打开） -->
    <quick-phrase-settings />
  </aside>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, onBeforeUnmount, ref, watch } from 'vue'
import { storeToRefs } from 'pinia'
import { t } from '../../i18n'
import { useBrowserPanelStore, type BpActiveTab } from '@/store/browserPanel'
import { useEditorStore } from '@/store/editor'
import { usePreferencesStore } from '@/store/preferences'
import { useSplitStore } from '@/store/split'
import { useWorkspaceStore } from '@/store/workspace'
import BpHead from './bpHead.vue'
import UrlMode from './urlMode.vue'
import DocMode from './docMode.vue'
import AnnotationMode from './annotationMode.vue'
import QuickPhraseSettings from '@/components/quickPhraseSettings.vue'
import { prefersReducedMotion, useAnnotationStore } from '@/store/annotation'
import bus from '../../bus'
import './rightPanel.css'

/**
 * 右侧栏容器（feat/right-panel-redesign，DESIGN-NOTES §3；round3）：
 * 宽度 = workspace.panelWidthPx（按比例派生）；收起宽 0。面板贴窗口右缘与底缘，
 * 内容固定在目标宽度、钉在右侧——开合时只有左缘移动，内容原地揭开 / 盖上，
 * 不平移、不重排。窄窗下 .overlay 浮在正文上方。
 * 面板整体是标签拖放目标（.drop-ok 显示虚线投放框）。
 */

const bpStore = useBrowserPanelStore()
const splitStore = useSplitStore()
const workspaceStore = useWorkspaceStore()
const preferencesStore = usePreferencesStore()
const editorStore = useEditorStore()

const {
  open: bpanelOpen,
  activeTab,
  urlPages,
  activePageId,
  dragState,
  turboMode
} = storeToRefs(bpStore)
const { panelWidthPx, panelOverlay } = storeToRefs(workspaceStore)

// 偏好关掉标注 → 若正停在标注 tab，退回它压住的那个模式（数据保留，重新
// 打开偏好即原样恢复；见方案 §5.1 偏好三件套）。
watch(
  () => preferencesStore.annotationEnabled,
  (enabled) => {
    if (enabled === false && bpStore.annotationsTab) bpStore.SET_TAB(bpStore.mode)
  }
)

const panelEl = ref<HTMLElement | null>(null)
const innerEl = ref<HTMLElement | null>(null)

const panelStyle = computed(() => ({
  width: bpanelOpen.value ? `${panelWidthPx.value}px` : '0px',
  '--panel-w': `${panelWidthPx.value}px`
}))

const activePageLoading = computed(() => {
  if (activeTab.value !== 'url') return false
  const page = urlPages.value.find((p) => p.id === activePageId.value)
  return !!page && page.loading
})

const dragName = computed(() => {
  const id = splitStore.dragTabId
  const tab = id ? editorStore.tabs.find((item) => item.id === id) : null
  return tab?.filename ?? ''
})

// ══ tab 内容切换：共享 X 轴（DESIGN-NOTES §3.3）══
// 旧内容朝反方向退 14px、130ms 淡出；新内容从切换方向 28px 外滑入，300ms，延迟 60ms。
const ORDER: BpActiveTab[] = ['url', 'doc', 'annotation']
const paneUrl = ref<HTMLElement | null>(null)
const paneDoc = ref<HTMLElement | null>(null)
const paneAnn = ref<HTMLElement | null>(null)
const paneOf = (tab: BpActiveTab): HTMLElement | null =>
  tab === 'url' ? paneUrl.value : tab === 'doc' ? paneDoc.value : paneAnn.value

const leaving = ref<BpActiveTab | null>(null)
const isShown = (tab: BpActiveTab): boolean => activeTab.value === tab || leaving.value === tab

let leaveAnim: Animation | null = null
watch(activeTab, async (to, from) => {
  leaveAnim?.cancel()
  leaveAnim = null
  if (!bpanelOpen.value || !from || from === to) {
    leaving.value = null
    return
  }
  const reduced = prefersReducedMotion()
  const dir = ORDER.indexOf(to) > ORDER.indexOf(from) ? 1 : -1
  leaving.value = from
  await nextTick()
  const outEl = paneOf(from)
  const inEl = paneOf(to)
  inEl?.animate(
    reduced
      ? [{ opacity: 0 }, { opacity: 1 }]
      : [
          { opacity: 0, transform: `translateX(${28 * dir}px)` },
          { opacity: 1, transform: 'none' }
        ],
    {
      duration: reduced ? 120 : 300,
      delay: reduced ? 0 : 60,
      easing: 'cubic-bezier(0.2, 0, 0, 1)',
      fill: 'backwards'
    }
  )
  if (!outEl) {
    leaving.value = null
    return
  }
  const anim = outEl.animate(
    reduced
      ? [{ opacity: 1 }, { opacity: 0 }]
      : [
          { opacity: 1, transform: 'none' },
          { opacity: 0, transform: `translateX(${-14 * dir}px)` }
        ],
    { duration: reduced ? 120 : 130, easing: 'cubic-bezier(0.4, 0, 1, 1)', fill: 'forwards' }
  )
  leaveAnim = anim
  const done = (): void => {
    if (leaveAnim === anim) leaveAnim = null
    if (leaving.value === from) leaving.value = null
    anim.cancel()
  }
  anim.onfinish = done
  anim.oncancel = () => {
    if (leaving.value === from) leaving.value = null
  }
})

// ══ 开合节奏（round3）══
// 打开：列宽 0 → 目标（CSS，340ms），内容钉在右侧不动，被左缘原地揭开。头部
// （三个 tab + 开关）完全不动；只有当前 pane 的正文在揭开过程中淡入（不位移），
// 避免空白的大块先露出来。收起：不做内容动画，左缘向右收回、把内容盖上（260ms）；
// 焦点在面板里则还给开关按钮。
const entering = ref(false)
let enterTimer: ReturnType<typeof setTimeout> | null = null
const playOpen = (): void => {
  if (prefersReducedMotion()) return
  entering.value = true
  if (enterTimer) clearTimeout(enterTimer)
  enterTimer = setTimeout(() => {
    entering.value = false
    enterTimer = null
  }, 400)
  paneOf(activeTab.value)?.animate([{ opacity: 0 }, { opacity: 1 }], {
    duration: 240,
    delay: 50,
    easing: 'cubic-bezier(0.2, 0, 0, 1)',
    fill: 'backwards'
  })
}

watch(bpanelOpen, (isOpen) => {
  if (isOpen) {
    nextTick(playOpen)
    return
  }
  leaving.value = null
  const active = document.activeElement
  if (active && panelEl.value?.contains(active)) {
    document.querySelector<HTMLElement>('.win-body > .panel-toggle')?.focus()
  }
})

// 浮层模式下 Esc 收起（停靠模式下 Esc 留给面板内部，如地址栏取消编辑）。
const onEsc = (event: KeyboardEvent): void => {
  if (!panelOverlay.value || event.defaultPrevented) return
  bpStore.SET_OPEN(false)
}

// ══ 拖放目标：整个面板可接收标签 drop ══
const onDragOver = (event: DragEvent) => {
  if (!splitStore.dragTabId) return
  event.preventDefault()
  event.dataTransfer!.dropEffect = 'move'
  bpStore.SET_DRAG_STATE('over')
}

const onDragLeave = (event: DragEvent) => {
  if (!(event.currentTarget as HTMLElement).contains(event.relatedTarget as Node)) {
    bpStore.SET_DRAG_STATE('none')
  }
}

const onDrop = (event: DragEvent) => {
  event.preventDefault()
  bpStore.SET_DRAG_STATE('none')
  const id = splitStore.dragTabId
  if (!id) return
  // round11 通知精简（用户拍板）：重复拖入已在分屏的文件不弹 toast。
  splitStore.DRAG_TO_SPLIT(id)
  splitStore.dragTabId = null
}

// ══ 新标注的反馈落点（DESIGN-NOTES §3.4 标注，三种情况互斥）══
// 面板收起：圆点飞到开关图标（开关弹跳并出现小点）；面板打开但不在标注 tab：
// 飞到标注徽标（徽标弹跳）；正在看标注 tab：不飞，卡片直接在列表里入场。
const annotationStore = useAnnotationStore()

const FLY_DURATION = 460
const FLY_APEX = 36

const flyTargetFor = (): HTMLElement | null => {
  if (!bpanelOpen.value) {
    return document.querySelector<HTMLElement>('.win-body > .panel-toggle')
  }
  const tab = document.querySelector<HTMLElement>('.rp-head .rp-tab-annotation')
  if (!tab) return null
  const badge = tab.querySelector<HTMLElement>('.rp-badge')
  if (badge && badge.getBoundingClientRect().width > 0) return badge
  return tab
}

const playFlyDot = (origin: { x: number; y: number }): void => {
  const target = flyTargetFor()
  if (!target) return
  const rect = target.getBoundingClientRect()
  if (!rect.width && !rect.height) return
  const to = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }

  const dot = document.createElement('div')
  dot.setAttribute('aria-hidden', 'true')
  dot.style.cssText =
    `position:fixed;left:${origin.x}px;top:${origin.y}px;width:8px;height:8px;` +
    'margin:-4px 0 0 -4px;border-radius:50%;background:var(--accent);' +
    'pointer-events:none;z-index:2500;will-change:transform,opacity'
  document.body.appendChild(dot)

  // 二次贝塞尔采样成关键帧：控制点抬到直线中点上方 2×顶点高，
  // 曲线在中点的偏离量正好是 36px（弧顶）。只动 transform/opacity。
  const STEPS = 18
  const ctrlX = (origin.x + to.x) / 2
  const ctrlY = (origin.y + to.y) / 2 - FLY_APEX * 2
  const keyframes: Array<{ offset: number; transform: string; opacity: number }> = []
  for (let i = 0; i <= STEPS; i += 1) {
    const p = i / STEPS
    const inv = 1 - p
    const x = inv * inv * origin.x + 2 * inv * p * ctrlX + p * p * to.x
    const y = inv * inv * origin.y + 2 * inv * p * ctrlY + p * p * to.y
    keyframes.push({
      offset: p,
      transform: `translate(${x - origin.x}px, ${y - origin.y}px) scale(${1 - 0.4 * p})`,
      // 最后 80ms 淡出（80/460 ≈ 17%）
      opacity: p > 0.83 ? Math.max(0, 1 - (p - 0.83) / 0.17) : 1
    })
  }

  const anim = dot.animate(keyframes, { duration: FLY_DURATION, easing: 'linear' })
  const finish = (): void => {
    dot.remove()
  }
  anim.onfinish = () => {
    finish()
    annotationStore.PULSE_BADGE()
  }
  anim.oncancel = finish
}

watch(
  () => annotationStore.savedPulse,
  (pulse) => {
    if (!pulse || !pulse.origin || prefersReducedMotion()) return
    // 标注面板正开着：新条目在面板里入场（#24），不飞
    if (bpanelOpen.value && activeTab.value === 'annotation') return
    // 等一帧：徽标计数由 annotation-change 驱动的重渲染落地后才量得到
    nextTick(() => {
      const origin = pulse.origin
      if (origin) playFlyDot(origin)
    })
  }
)

// 菜单 / 快捷键（⌥⌘\、⌥⌘1/2/3）与开关右键菜单统一走 bus。
const onToggleBus = (): void => bpStore.TOGGLE_PANEL()
const onOpenToBus = (tab: unknown): void => {
  if (tab === 'url' || tab === 'doc' || tab === 'annotation') bpStore.OPEN_TO_TAB(tab)
}

onMounted(() => {
  bpStore.LISTEN()
  bus.on('right-panel:toggle', onToggleBus)
  bus.on('right-panel:open-to', onOpenToBus)
})

onBeforeUnmount(() => {
  bpStore.STOP_LISTENING()
  bus.off('right-panel:toggle', onToggleBus)
  bus.off('right-panel:open-to', onOpenToBus)
  if (enterTimer) clearTimeout(enterTimer)
})
</script>
