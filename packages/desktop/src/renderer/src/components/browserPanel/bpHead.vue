<template>
  <!-- 面板头部（feat/right-panel-redesign，DESIGN-NOTES §3.3）：铺满面板宽度的分段
       控件「网页 / 文档 / 标注」，与标签栏同高；选中块「拉伸 → 收拢」；只剩一个
       tab 时改为标题。右端留出位置给钉在 win-body 右上角的面板开关（round2：开关
       常驻可见，浮层模式也不会被盖住，原「收起 ›」按钮随之去掉；Esc 仍可收起）。 -->
  <div class="rp-head" :class="{ entering }">
    <div
      v-if="tabs.length > 1"
      ref="segEl"
      class="rp-seg"
      role="tablist"
      :aria-label="t('rightPanel.tabsLabel')"
      :style="{ '--n': tabs.length, '--i': activeIndex }"
      @keydown="onKeydown"
    >
      <span ref="indEl" class="rp-seg-ind" aria-hidden="true" />
      <button
        v-for="(tab, i) of tabs"
        :id="`rp-tab-${tab}`"
        :key="tab"
        role="tab"
        :class="`rp-tab-${tab}`"
        :style="{ '--k': i }"
        :aria-selected="activeTab === tab"
        :aria-controls="`rp-pane-${tab}`"
        :tabindex="activeTab === tab ? 0 : -1"
        :title="`${labelOf(tab)} ${shortcutOf(tab)}`"
        @click="select(tab)"
      >
        <span class="ic">
          <tab-icon :tab="tab" />
          <i v-if="tab === 'url' && webLoadingInBackground" class="spin" />
        </span>
        <span class="lb">{{ labelOf(tab) }}</span>
        <i v-if="tab === 'doc' && splitActive" class="ddot" />
        <span v-if="tab === 'annotation' && uncopied" ref="badgeEl" class="rp-badge">{{
          uncopied
        }}</span>
      </button>
    </div>
    <div v-else-if="tabs.length === 1" class="rp-solo">
      <span class="ic"><tab-icon :tab="tabs[0]!" /></span>
      {{ labelOf(tabs[0]!) }}
      <small>· {{ t('rightPanel.soloHint') }}</small>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, h, nextTick, ref, watch, type FunctionalComponent } from 'vue'
import { storeToRefs } from 'pinia'
import MoIcon from '@/components/icons/MoIcon.vue'
import { t } from '../../i18n'
import { isLinux, isOsx } from '@/util'
import { prefersReducedMotion, useAnnotationStore } from '@/store/annotation'
import { useBrowserPanelStore, type BpActiveTab } from '@/store/browserPanel'
import { usePreferencesStore } from '@/store/preferences'
import { useSplitStore } from '@/store/split'

defineProps<{ entering: boolean }>()

const bpStore = useBrowserPanelStore()
const annotationStore = useAnnotationStore()
const preferencesStore = usePreferencesStore()
const splitStore = useSplitStore()
const { activeTab, turboMode, urlPages, open } = storeToRefs(bpStore)

// 极速模式移除网页 tab；标注关闭移除标注 tab（数据保留）。
const tabs = computed<BpActiveTab[]>(() => {
  const list: BpActiveTab[] = []
  if (!turboMode.value) list.push('url')
  list.push('doc')
  if (preferencesStore.annotationEnabled !== false) list.push('annotation')
  return list
})
const activeIndex = computed(() => Math.max(0, tabs.value.indexOf(activeTab.value)))

const labelOf = (tab: BpActiveTab): string =>
  tab === 'url'
    ? t('rightPanel.tab.web')
    : tab === 'doc'
      ? t('rightPanel.tab.doc')
      : t('annotation.tab')
const shortcutOf = (tab: BpActiveTab): string => {
  const n = tab === 'url' ? 1 : tab === 'doc' ? 2 : 3
  // Linux 上 Ctrl+Alt+1/2/3 已是「标题 1–3」，不设默认键
  if (isLinux) return ''
  return isOsx ? `⌥⌘${n}` : `Ctrl+Alt+${n}`
}

const splitActive = computed(() => splitStore.active)
const uncopied = computed(() => annotationStore.uncopiedCount)
// 后台页面加载中、并且当前不在网页 tab：图标外一圈墨蓝转圈
const webLoadingInBackground = computed(
  () => activeTab.value !== 'url' && urlPages.value.some((p) => p.loading)
)

// 线性 14px 图标（网页 / 文档沿用 MoIcon；标注是气泡+笔，图标资产冻结、就地内联）
const TabIcon: FunctionalComponent<{ tab: BpActiveTab }> = (props) => {
  if (props.tab === 'url') return h(MoIcon, { name: 'i-globe' })
  if (props.tab === 'doc') return h(MoIcon, { name: 'i-doc' })
  return h(
    'svg',
    {
      class: 'ann-ic',
      width: 14,
      height: 14,
      viewBox: '0 0 16 16',
      fill: 'none',
      stroke: 'currentColor',
      'stroke-width': 1.35,
      'stroke-linejoin': 'round',
      'stroke-linecap': 'round'
    },
    [
      h('path', {
        d: 'M2.2 4.1c0-1 .8-1.8 1.8-1.8h8c1 0 1.8.8 1.8 1.8v5c0 1-.8 1.8-1.8 1.8H6.6l-3 2.6v-2.6h-.6c-.5 0-.8-.4-.8-.8z'
      }),
      h('path', { d: 'M5.4 6.2h5.2M5.4 8.4h3.2' })
    ]
  )
}
TabIcon.props = ['tab']

const select = (tab: BpActiveTab): void => {
  if (activeTab.value !== tab) bpStore.SET_TAB(tab)
}

// roving tabindex：←/→/Home/End 切换并自动激活
const segEl = ref<HTMLElement | null>(null)
const onKeydown = (event: KeyboardEvent): void => {
  const list = tabs.value
  const i = activeIndex.value
  let next: BpActiveTab | undefined
  if (event.key === 'ArrowRight') next = list[(i + 1) % list.length]
  else if (event.key === 'ArrowLeft') next = list[(i - 1 + list.length) % list.length]
  else if (event.key === 'Home') next = list[0]
  else if (event.key === 'End') next = list[list.length - 1]
  if (!next) return
  event.preventDefault()
  select(next)
  nextTick(() => segEl.value?.querySelector<HTMLElement>(`#rp-tab-${next}`)?.focus())
}

// ── 选中块「拉伸 → 收拢」（340ms 零过冲）：前沿先到目标，后沿延迟跟上 ──
const indEl = ref<HTMLElement | null>(null)
watch(activeIndex, (to, from) => {
  const el = indEl.value
  const seg = segEl.value
  if (!el || !seg || from === to || !open.value || prefersReducedMotion()) return
  const n = tabs.value.length
  const unit = (seg.clientWidth - 4) / n
  const fromL = from * unit
  const toL = to * unit
  const right = to > from
  // 中间帧：前沿到达目标，后沿只走 22% 的距离
  const midL = right ? fromL + (toL - fromL) * 0.22 : toL
  const midR = right ? toL + unit : fromL + unit + (toL - fromL) * 0.22
  el.animate(
    [
      { left: `${2 + fromL}px`, width: `${unit}px` },
      { left: `${2 + midL}px`, width: `${midR - midL}px`, offset: 0.5 },
      { left: `${2 + toL}px`, width: `${unit}px` }
    ],
    { duration: 340, easing: 'cubic-bezier(0.2, 0, 0, 1)' }
  )
})

// ── 徽标弹跳（新增标注：1 → 1.22 → 1，v1 唯一保留的弹跳）──────────────────
const badgeEl = ref<HTMLElement | HTMLElement[] | null>(null)
let appearedAt = 0
watch(uncopied, (value, previous) => {
  if (previous === 0 && value > 0) appearedAt = Date.now()
})
watch(
  () => annotationStore.badgePulse,
  () => {
    if (prefersReducedMotion() || !open.value) return
    nextTick(() => {
      const raw = badgeEl.value
      const el = Array.isArray(raw) ? raw[0] : raw
      if (!el) return
      const from = Date.now() - appearedAt < 2000 ? 0.5 : 1
      el.animate(
        [{ transform: `scale(${from})` }, { transform: 'scale(1.22)' }, { transform: 'scale(1)' }],
        { duration: 300, easing: 'cubic-bezier(0.18, 1.28, 0.36, 1)' }
      )
    })
  }
)
</script>
