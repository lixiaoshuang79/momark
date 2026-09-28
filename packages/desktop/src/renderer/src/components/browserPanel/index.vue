<template>
  <aside
    class="bpanel"
    :class="{
      collapsed: !bpanelOpen,
      'drop-ok': dragState === 'over'
    }"
    :style="panelStyle"
    aria-label="右侧浏览器面板"
    @dragover="onDragOver"
    @dragleave="onDragLeave"
    @drop="onDrop"
  >
    <div class="bp-inner">
      <div class="bp-body">
        <!-- 顶部 2px 墨蓝进度线（任何激活页加载中即显示，滑动动画） -->
        <div class="bp-track" :class="{ show: activePageLoading }" />

        <!-- 三种内容常驻挂载（v-show）：切换网页/文档/标注、收起再展开面板
             都不影响里面的内容与状态（网页滚动/登录态、预览文档保持）。 -->
        <url-mode v-show="activeTab === 'url'" />
        <doc-mode v-show="activeTab === 'doc'" ref="docModeRef" />
        <annotation-mode v-show="activeTab === 'annotation'" />
      </div>

      <!-- 底部条按 tab 各归其位：网址 = 40px 导航条；文档 = 「打开文件… /
           新建文件」（36px 顶部 hairline，两按钮左右等分）；标注 = 面板自带
           底条（annotationMode.vue 内），所以这里两套都收起。 -->
      <nav-bar v-show="activeTab === 'url'" />
      <div v-show="activeTab === 'doc'" class="bp-doc-actions">
        <button class="bp-openfile" @click="openDocFile">
          <mo-icon name="i-folder" />
          打开文件…
        </button>
        <button class="bp-openfile" @click="newDocFile">
          <mo-icon name="i-file" />
          新建文件
        </button>
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
import MoIcon from '@/components/icons/MoIcon.vue'
import { useBrowserPanelStore } from '@/store/browserPanel'
import { usePreferencesStore } from '@/store/preferences'
import { useSplitStore } from '@/store/split'
import { useWorkspaceStore } from '@/store/workspace'
import UrlMode from './urlMode.vue'
import DocMode from './docMode.vue'
import AnnotationMode from './annotationMode.vue'
import NavBar from './navBar.vue'
import QuickPhraseSettings from '@/components/quickPhraseSettings.vue'
import { useAnnotationStore } from '@/store/annotation'

/**
 * 右侧浏览器面板容器（PHASE2-SPEC §5 / STATE-MACHINE BpState）：
 * 宽 288px（默认收起 0，.42s --ease-panel 显式宽度动画）、左缘 .5px 发丝线；
 * 分屏文档态 min(480px,60%)；win-body 挂 .panel-open（由 app.vue 统一挂载）。
 * 面板整体是标签拖放目标（.drop-ok = 2px dashed accent outline）。
 */

const bpStore = useBrowserPanelStore()
const splitStore = useSplitStore()
const workspaceStore = useWorkspaceStore()
const preferencesStore = usePreferencesStore()

const { open: bpanelOpen, activeTab, urlPages, activePageId, dragState } = storeToRefs(bpStore)
const { panelWidthPx } = storeToRefs(workspaceStore)

// 偏好关掉标注 → 若正停在标注 tab，退回它压住的那个模式（数据保留，重新
// 打开偏好即原样恢复；见方案 §5.1 偏好三件套）。
watch(
  () => preferencesStore.annotationEnabled,
  (enabled) => {
    if (enabled === false && bpStore.annotationsTab) bpStore.SET_TAB(bpStore.mode)
  }
)

const docModeRef = ref<InstanceType<typeof DocMode> | null>(null)

const panelStyle = computed(() => ({
  width: bpanelOpen.value ? `${panelWidthPx.value}px` : '0px',
  // round18：面板宽度的 CSS 变量——Dock 落点的网址栏要按面板宽度撑开
  // （它挂在 34px 的 Dock 项里，百分比量不到面板宽）。
  '--panel-w': `${panelWidthPx.value}px`
}))

const activePageLoading = computed(() => {
  const page = urlPages.value.find((p) => p.id === activePageId.value)
  return !!page && page.loading
})

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
  // round11 通知精简（用户拍板）：重复拖入已在分屏的文件不弹 toast，
  // 投放区/右侧面板本身已呈现该文件，用户可自行看见。
  splitStore.DRAG_TO_SPLIT(id)
  splitStore.dragTabId = null
}

const openDocFile = () => {
  docModeRef.value?.openFile()
}

const newDocFile = () => {
  docModeRef.value?.newFile()
}

// ══ 飞点（原型动效 #22/#23，feat/quick-phrases）══
// 卡片保存成功（引擎事件 muya-annotation-saved → annotation store 的 savedPulse）
// 且**标注面板没开着**时，从保存按钮（origin，视口坐标）飞一个 8px 墨蓝圆点到
// 标签栏「标注」徽标：弧线（顶点高 36px）460ms，末段淡出；到达后徽标弹跳
// （bpModes 监听 badgePulse 播 1→1.22→1）。标注面板正开着时互斥——那一路由
// annotationMode 的「新条目入场」承接（#24）。
const annotationStore = useAnnotationStore()

const FLY_DURATION = 460
const FLY_APEX = 36
const REDUCED_MOTION =
  typeof window.matchMedia === 'function' &&
  window.matchMedia('(prefers-reduced-motion: reduce)').matches

/**
 * 飞点落点：`.bp-mode-badge` 是 `v-if="uncopied"`，可能不存在；面板收起时整排
 * tab 都缩在 18px 的收起态里（不可见），此时不播（兜底 1）。徽标在但不可量
 * （极端布局）时退到「标注」tab 按钮本身（兜底 2）；两者都没有就放弃。
 */
const flyTargetFor = (): HTMLElement | null => {
  const modes = document.querySelector<HTMLElement>('.bp-modes.shown')
  if (!modes) return null
  const badge = modes.querySelector<HTMLElement>('.bp-mode-ann .bp-mode-badge')
  if (badge && badge.getBoundingClientRect().width > 0) return badge
  return modes.querySelector<HTMLElement>('.bp-mode-ann')
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
  // 关键帧写成结构类型而不是 `Keyframe[]`：.vue 的 ESLint 作用域不认 DOM 全局类型
  // （结构上可赋给 WAAPI 的 Keyframe），少一条 no-undef 噪音。
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
    if (!pulse || !pulse.origin || REDUCED_MOTION) return
    // 标注面板正开着：新条目在面板里入场（#24），不飞
    if (bpanelOpen.value && activeTab.value === 'annotation') return
    // 等一帧：徽标计数由 annotation-change 驱动的重渲染落地后才量得到
    nextTick(() => {
      const origin = pulse.origin
      if (origin) playFlyDot(origin)
    })
  }
)

onMounted(() => {
  bpStore.LISTEN()
})

onBeforeUnmount(() => {
  bpStore.STOP_LISTENING()
})
</script>
