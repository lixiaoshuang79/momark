<template>
  <!-- 标题轨：编辑区左缘的一列标题横线（横线越短层级越深），墨蓝指示线标出当前
       读到的标题。悬停某条横线，旁边浮出这一条的完整标题；常驻模式下整列展开成
       完整标题。无标题 / html 标签 / 欢迎页时宽度收成 0。 -->
  <nav
    ref="rootRef"
    class="heading-rail"
    :class="{ shown: visible, pinned, morphing, hovering: hoverIndex >= 0 }"
    :style="rootStyle"
    :aria-label="t('headingRail.ariaLabel')"
    :aria-hidden="!visible"
  >
    <div class="hr-head" aria-hidden="true">
      <span class="hr-head-title">{{ t('headingRail.outline') }}</span>
      <span class="hr-head-progress">{{ progress }}%</span>
    </div>
    <div
      ref="listRef"
      class="hr-list"
      role="listbox"
      :tabindex="visible ? 0 : -1"
      :aria-activedescendant="hoverIndex >= 0 ? `hr-row-${hoverIndex}` : undefined"
      @pointermove="onPointerMove"
      @pointerdown="onPointerDown"
      @pointerleave="onPointerLeave"
      @mousedown.prevent
      @click="onClick"
      @wheel.passive="onWheel"
      @focus="onFocus"
      @blur="onBlur"
      @keydown="onKeydown"
      @scroll.passive="onListScroll"
    >
      <div class="hr-rows" :style="{ height: `${rowsHeight}px` }">
        <div
          v-for="item of items"
          :id="`hr-row-${item.index}`"
          :key="item.index"
          class="hr-row"
          role="option"
          :aria-selected="item.index === activeIndex"
          :aria-label="item.text || t('headingRail.untitled')"
          :class="rowClass(item.index)"
          :style="{ '--i': item.index, '--d': item.depth, '--w': `${dashWidth(item.depth)}px` }"
        >
          <span class="hr-dash" />
          <span class="hr-text">{{ item.text || t('headingRail.untitled') }}</span>
        </div>
        <span
          class="hr-indicator"
          :class="{ off: activeIndex < 0, hover: !pinned && hoverIndex === activeIndex }"
          :style="indicatorStyle"
        />
      </div>
    </div>
    <!-- 浮层挂到 body：编辑器的段落徽标（Muya 前置按钮）也在 body 上、z-index 1000，
         留在应用布局里会被它盖住。 -->
    <Teleport to="body">
      <div
        ref="labelRef"
        class="hr-label"
        :class="{ show: labelShown, glide: labelGlide }"
        :style="labelStyle"
        aria-hidden="true"
      >
        <span class="hr-label-lv">H{{ labelItem?.level ?? '' }}</span>
        <span class="hr-label-text">{{ labelItem?.text || t('headingRail.untitled') }}</span>
      </div>
    </Teleport>
  </nav>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { storeToRefs } from 'pinia'
import bus from '../../bus'
import { t } from '../../i18n'
import { useEditorStore } from '@/store/editor'
import { usePreferencesStore } from '@/store/preferences'
import { useLayoutStore } from '@/store/layout'
import { isHtmlTab } from '@/store/help'
import { motionReduced } from '@/util/motion'
import { activeHeadingSource } from './headingSource'
import {
  DASH_RAIL_WIDTH,
  PINNED_ROW,
  clampLabelTop,
  dashWidth,
  followScrollTop,
  pinnedRailWidth,
  railPitch,
  readingProgress,
  resolveActiveHeading,
  rowAt,
  toRailItems,
  type RailItem
} from './railModel'

const editorStore = useEditorStore()
const preferencesStore = usePreferencesStore()
const layoutStore = useLayoutStore()
const { listToc, currentFile } = storeToRefs(editorStore)
const { headingRailPinned } = storeToRefs(preferencesStore)

const rootRef = ref<HTMLElement | null>(null)
const listRef = ref<HTMLElement | null>(null)
const labelRef = ref<HTMLElement | null>(null)

const items = computed<RailItem[]>(() => {
  const own = activeHeadingSource.value?.items?.value
  return own ?? toRailItems(listToc.value)
})

const visible = computed(
  () =>
    !!currentFile.value &&
    currentFile.value.markdown !== undefined &&
    !isHtmlTab(currentFile.value) &&
    !!activeHeadingSource.value &&
    items.value.length > 0
)
const pinned = computed(() => !!headingRailPinned.value)

// ── 尺寸 ──────────────────────────────────────────────────────────────────
const LIST_PAD_TOP = 18
const LIST_PAD_BOTTOM = 24
const viewportWidth = ref(window.innerWidth)
const listHeight = ref(0)

const railWidth = computed(() => {
  if (!visible.value) return 0
  return pinned.value ? pinnedRailWidth(viewportWidth.value) : DASH_RAIL_WIDTH
})
watch(railWidth, (w) => layoutStore.SET_RAIL_WIDTH(w), { immediate: true })

const pitch = computed(() =>
  railPitch(items.value.length, listHeight.value - LIST_PAD_TOP - LIST_PAD_BOTTOM)
)
const rowHeight = computed(() => (pinned.value ? PINNED_ROW : pitch.value.pitch))
const rowsHeight = computed(() => items.value.length * rowHeight.value)

// 切换常驻时行高、栏宽、文字一起过渡；这段时间用更长、统一的时长，指示线与行
// 用同一条缓动同步移动（两者都是行高的线性函数，同缓动同时长即逐帧对齐）。
const MORPH_MS = 420
const morphing = ref(false)
let morphTimer: ReturnType<typeof setTimeout> | null = null
watch(pinned, () => {
  morphing.value = true
  if (morphTimer) clearTimeout(morphTimer)
  morphTimer = setTimeout(() => {
    morphing.value = false
    morphTimer = null
    keepActiveInView()
  }, MORPH_MS + 40)
  hideLabel(true)
})

const rootStyle = computed(() => ({
  width: `${railWidth.value}px`,
  '--hr-row': `${rowHeight.value}px`
}))

// ── 当前标题 ──────────────────────────────────────────────────────────────
const activeIndex = ref(-1)
const progress = ref(0)
// 点击跳转后锁定目标：滚动动画途中会扫过中间的标题，不让指示线一格格跳过去。
// 滚动还在动就顺延（长距离的平滑滚动可能超过 1 秒），停稳后或算到目标即解除。
let jumpLock: { index: number; until: number; deadline: number; lastTop: number } | null = null
const JUMP_LOCK_IDLE_MS = 300
const JUMP_LOCK_MAX_MS = 4000
let lockTimer: ReturnType<typeof setTimeout> | null = null

const measure = (): void => {
  const source = activeHeadingSource.value
  if (!source || !visible.value) return
  const scroller = source.scroller
  const viewportHeight = scroller.clientHeight
  const count = Math.min(source.count(), items.value.length)
  let next = resolveActiveHeading({
    count,
    topOf: source.topOf,
    scrollTop: scroller.scrollTop,
    viewportHeight,
    scrollHeight: scroller.scrollHeight,
    probeOffset: source.probeOffset()
  })
  if (jumpLock) {
    const now = performance.now()
    if (scroller.scrollTop !== jumpLock.lastTop) {
      jumpLock.lastTop = scroller.scrollTop
      jumpLock.until = Math.max(jumpLock.until, now + JUMP_LOCK_IDLE_MS)
    }
    if (next === jumpLock.index || now > jumpLock.until || now > jumpLock.deadline) {
      jumpLock = null
    } else {
      next = jumpLock.index
      // 停稳后不再有滚动事件：到期时自己再算一次。
      if (lockTimer) clearTimeout(lockTimer)
      lockTimer = setTimeout(scheduleMeasure, jumpLock.until - now + 20)
    }
  }
  progress.value = readingProgress(scroller.scrollTop, scroller.scrollHeight, viewportHeight)
  if (next !== activeIndex.value) {
    activeIndex.value = next
    keepActiveInView()
  }
}

let measureRaf: number | null = null
const scheduleMeasure = (): void => {
  if (measureRaf !== null) return
  measureRaf = requestAnimationFrame(() => {
    measureRaf = null
    measure()
  })
}

// 跟随：轨道放不下全部标题时，把当前那一行留在轨道可视带内（悬停时不动，免得
// 用户正指着的那条被滚走）。
const keepActiveInView = (): void => {
  const list = listRef.value
  if (!list || hoverIndex.value >= 0 || morphing.value) return
  const inner = list.clientHeight - LIST_PAD_TOP - LIST_PAD_BOTTOM
  const target = followScrollTop(
    activeIndex.value,
    rowHeight.value,
    list.scrollTop,
    inner,
    rowsHeight.value
  )
  if (target === null) return
  list.scrollTo({ top: target, behavior: motionReduced() ? 'auto' : 'smooth' })
}

const indicatorStyle = computed(() => {
  const index = Math.max(0, activeIndex.value)
  const item = items.value[index]
  const h = rowHeight.value
  if (pinned.value) {
    const barH = 14
    return {
      width: '2px',
      height: `${barH}px`,
      transform: `translate3d(4px, ${index * h + (h - barH) / 2}px, 0)`
    }
  }
  // 比普通横线（2px）粗半档，墨蓝在一列浅灰里一眼可辨。
  return {
    width: `${dashWidth(item?.depth ?? 0)}px`,
    height: '3px',
    transform: `translate3d(14px, ${index * h + h / 2 - 1.5}px, 0)`
  }
})

// ── 悬停浮层 ──────────────────────────────────────────────────────────────
const hoverIndex = ref(-1)
const labelShown = ref(false)
// 浮层已经可见时在行间移动才做位移过渡；首次出现直接落位再淡入，不从上一次的
// 位置飞过来。
const labelGlide = ref(false)
const labelTop = ref(0)
const labelLeft = ref(0)
const labelItem = computed(() => (hoverIndex.value >= 0 ? items.value[hoverIndex.value] : null))
let hideTimer: ReturnType<typeof setTimeout> | null = null

const labelStyle = computed(() => ({
  transform: `translate3d(${labelLeft.value}px, ${labelTop.value}px, 0)`
}))

const rowClass = (index: number) => {
  const hovered = hoverIndex.value
  return {
    deep: (items.value[index]?.depth ?? 0) > 0,
    active: index === activeIndex.value,
    hover: index === hovered,
    near: hovered >= 0 && Math.abs(index - hovered) === 1
  }
}

const rowCenterInRoot = (index: number): number => {
  const list = listRef.value
  if (!list) return 0
  return (
    list.offsetTop + LIST_PAD_TOP + index * rowHeight.value + rowHeight.value / 2 - list.scrollTop
  )
}

const rowTextTruncated = (index: number): boolean => {
  const text = listRef.value?.querySelector<HTMLElement>(`#hr-row-${index} .hr-text`)
  return !!text && text.scrollWidth > text.clientWidth + 1
}

const placeLabel = async (index: number): Promise<void> => {
  await nextTick()
  const label = labelRef.value
  const root = rootRef.value
  if (!label || !root || hoverIndex.value !== index) return
  const item = items.value[index]
  const rect = root.getBoundingClientRect()
  // 横线模式：浮层贴在横线右侧；常驻模式：就地展开，文字与行内文字对齐。
  labelLeft.value = rect.left + (pinned.value ? 3 + (item?.depth ?? 0) * 12 : DASH_RAIL_WIDTH - 4)
  labelTop.value =
    rect.top + clampLabelTop(rowCenterInRoot(index), label.offsetHeight, root.clientHeight)
  if (!labelShown.value) {
    labelGlide.value = false
    labelShown.value = true
    requestAnimationFrame(() => {
      labelGlide.value = labelShown.value
    })
  }
}

const showLabelFor = (index: number): void => {
  if (hideTimer) {
    clearTimeout(hideTimer)
    hideTimer = null
  }
  if (index === hoverIndex.value && labelShown.value) return
  hoverIndex.value = index
  if (pinned.value && !rowTextTruncated(index)) {
    labelShown.value = false
    labelGlide.value = false
    return
  }
  placeLabel(index).catch(() => {})
}

const hideLabel = (immediate = false): void => {
  if (hideTimer) clearTimeout(hideTimer)
  const run = (): void => {
    hideTimer = null
    hoverIndex.value = -1
    labelShown.value = false
    labelGlide.value = false
  }
  if (immediate) run()
  else hideTimer = setTimeout(run, 140)
}

const indexAtPointer = (event: MouseEvent): number => {
  const list = listRef.value
  if (!list) return -1
  const y = event.clientY - list.getBoundingClientRect().top + list.scrollTop - LIST_PAD_TOP
  return rowAt(y, rowHeight.value, items.value.length)
}

const onPointerMove = (event: PointerEvent): void => {
  if (!visible.value) return
  const index = indexAtPointer(event)
  if (index >= 0) showLabelFor(index)
}
const onPointerDown = (event: PointerEvent): void => {
  // 触屏没有悬停：按下即显示这一条，松手（click）再跳转。
  if (event.pointerType !== 'mouse') onPointerMove(event)
}
const onPointerLeave = (): void => {
  if (document.activeElement !== listRef.value) hideLabel()
}

const jump = (index: number): void => {
  const item = items.value[index]
  const source = activeHeadingSource.value
  if (!item || !source) return
  const now = performance.now()
  jumpLock = {
    index,
    until: now + 600,
    deadline: now + JUMP_LOCK_MAX_MS,
    lastTop: source.scroller.scrollTop
  }
  scheduleMeasure()
  activeIndex.value = index
  if (source.reveal?.(item)) return
  if (item.slug) bus.emit('scroll-to-header', item.slug)
}

const onClick = (event: MouseEvent): void => {
  const index = indexAtPointer(event)
  if (index >= 0) jump(index)
}

// 轨道本身不需要滚动时，滚轮交给正文：鼠标停在左缘也能照常翻页。
const onWheel = (event: WheelEvent): void => {
  const list = listRef.value
  const scroller = activeHeadingSource.value?.scroller
  if (!list || !scroller || list.scrollHeight > list.clientHeight + 1) return
  const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? scroller.clientHeight : 1
  scroller.scrollTop += event.deltaY * unit
}

const onListScroll = (): void => {
  if (hoverIndex.value >= 0 && labelShown.value) placeLabel(hoverIndex.value).catch(() => {})
}

// ── 键盘 ──────────────────────────────────────────────────────────────────
const onFocus = (): void => {
  if (!items.value.length) return
  showLabelFor(activeIndex.value >= 0 ? activeIndex.value : 0)
}
const onBlur = (): void => hideLabel(true)

const onKeydown = (event: KeyboardEvent): void => {
  const count = items.value.length
  if (!count) return
  const current = hoverIndex.value >= 0 ? hoverIndex.value : Math.max(0, activeIndex.value)
  const page = Math.max(1, Math.floor((listRef.value?.clientHeight ?? 200) / rowHeight.value) - 1)
  let next = current
  switch (event.key) {
    case 'ArrowDown':
      next = current + 1
      break
    case 'ArrowUp':
      next = current - 1
      break
    case 'PageDown':
      next = current + page
      break
    case 'PageUp':
      next = current - page
      break
    case 'Home':
      next = 0
      break
    case 'End':
      next = count - 1
      break
    case 'Enter':
    case ' ':
      event.preventDefault()
      jump(current)
      return
    case 'Escape':
      event.preventDefault()
      listRef.value?.blur()
      bus.emit('editor-focus')
      return
    default:
      return
  }
  event.preventDefault()
  next = Math.min(count - 1, Math.max(0, next))
  showLabelFor(next)
  const list = listRef.value
  if (list) {
    const inner = list.clientHeight - LIST_PAD_TOP - LIST_PAD_BOTTOM
    const target = followScrollTop(next, rowHeight.value, list.scrollTop, inner, rowsHeight.value)
    if (target !== null) list.scrollTop = target
  }
}

// ── 监听 ──────────────────────────────────────────────────────────────────
let detachScroller: (() => void) | null = null
watch(
  activeHeadingSource,
  (source) => {
    detachScroller?.()
    detachScroller = null
    if (!source) return
    const scroller = source.scroller
    scroller.addEventListener('scroll', scheduleMeasure, { passive: true })
    // 正文内容高度变了（打字、图片加载、块展开）标题会挪位，不滚动也要重算。
    const content = scroller.firstElementChild
    const observer = new ResizeObserver(scheduleMeasure)
    observer.observe(scroller)
    if (content) observer.observe(content)
    detachScroller = () => {
      scroller.removeEventListener('scroll', scheduleMeasure)
      observer.disconnect()
    }
    scheduleMeasure()
  },
  { immediate: true }
)

watch(items, () => {
  activeHeadingSource.value?.invalidate?.()
  if (hoverIndex.value >= items.value.length) hideLabel(true)
  nextTick(scheduleMeasure)
})
watch(
  () => currentFile.value?.id,
  () => {
    jumpLock = null
    hideLabel(true)
    nextTick(scheduleMeasure)
  }
)
watch(visible, (shown) => {
  if (shown) nextTick(scheduleMeasure)
  else hideLabel(true)
})

let listObserver: ResizeObserver | null = null
let resizeRaf: number | null = null
const onWindowResize = (): void => {
  if (resizeRaf !== null) return
  resizeRaf = requestAnimationFrame(() => {
    resizeRaf = null
    viewportWidth.value = window.innerWidth
  })
}

onMounted(() => {
  window.addEventListener('resize', onWindowResize, { passive: true })
  const list = listRef.value
  if (list) {
    listHeight.value = list.clientHeight
    listObserver = new ResizeObserver(() => {
      listHeight.value = list.clientHeight
    })
    listObserver.observe(list)
  }
})

onBeforeUnmount(() => {
  window.removeEventListener('resize', onWindowResize)
  listObserver?.disconnect()
  detachScroller?.()
  if (measureRaf !== null) cancelAnimationFrame(measureRaf)
  if (resizeRaf !== null) cancelAnimationFrame(resizeRaf)
  if (hideTimer) clearTimeout(hideTimer)
  if (morphTimer) clearTimeout(morphTimer)
  if (lockTimer) clearTimeout(lockTimer)
  layoutStore.SET_RAIL_WIDTH(0)
})
</script>

<style scoped>
/* 时长：常规跟随 .26s，切换常驻（morphing）时行、栏宽、指示线统一 .42s，
   缓动都用 --ease-panel（零过冲），与左右面板开合同一手感。 */
.heading-rail {
  --hr-dur: 0.26s;
  --hr-dash: color-mix(in oklab, var(--ink) 20%, transparent);
  --hr-dash-deep: color-mix(in oklab, var(--ink) 14%, transparent);
  --hr-dash-hover: color-mix(in oklab, var(--ink) 62%, transparent);
  position: relative;
  z-index: 6;
  flex: none;
  height: 100%;
  min-width: 0;
  display: flex;
  flex-direction: column;
  opacity: 0;
  user-select: none;
  transition:
    width 0.42s var(--ease-panel),
    opacity 0.24s ease;
}
.heading-rail.shown {
  opacity: 1;
}
.heading-rail.morphing {
  --hr-dur: 0.42s;
}

/* 常驻模式的小标题：大纲 + 阅读进度。横线模式高度收成 0。 */
.hr-head {
  flex: none;
  height: 0;
  overflow: hidden;
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  padding: 0 14px 0 14px;
  font-size: var(--f11, 11px);
  line-height: 1.45;
  color: var(--faint);
  font-weight: 600;
  opacity: 0;
  white-space: nowrap;
  transition:
    height 0.42s var(--ease-panel),
    opacity 0.2s ease;
}
.heading-rail.pinned .hr-head {
  height: 30px;
  opacity: 1;
  transition:
    height 0.42s var(--ease-panel),
    opacity 0.3s ease 0.12s;
}
.hr-head-progress {
  font-variant-numeric: tabular-nums;
  font-weight: 500;
}

.hr-list {
  flex: 1 1 auto;
  min-height: 0;
  overflow-x: hidden;
  overflow-y: auto;
  scrollbar-width: none;
  padding: 18px 0 24px;
  box-sizing: border-box;
  cursor: pointer;
  outline: none;
  /* 溢出时上下边缘淡出，提示轨道还能滚。 */
  mask-image: linear-gradient(
    to bottom,
    transparent 0,
    #000 14px,
    #000 calc(100% - 18px),
    transparent 100%
  );
}
.hr-list::-webkit-scrollbar {
  display: none;
}
.hr-list:focus-visible {
  box-shadow: inset 2px 0 0 var(--accent);
}

.hr-rows {
  position: relative;
  transition: height var(--hr-dur) var(--ease-panel);
}

.hr-row {
  position: relative;
  height: var(--hr-row);
  display: flex;
  align-items: center;
  padding-left: 14px;
  box-sizing: border-box;
  transition: height var(--hr-dur) var(--ease-panel);
}

.hr-dash {
  flex: none;
  width: var(--w);
  height: 2px;
  border-radius: 1px;
  background: var(--hr-dash);
  transform-origin: left center;
  transition:
    transform 0.22s var(--ease-panel),
    background-color 0.18s ease,
    opacity 0.24s ease,
    width var(--hr-dur) var(--ease-panel);
}
.hr-row.deep .hr-dash {
  background: var(--hr-dash-deep);
}
/* 悬停的那条拉长、加深，邻近两条微微跟随——指针在密集横线间移动时有放大镜感。 */
.hr-row.near .hr-dash {
  transform: scaleX(1.15);
}
.hr-row.hover .hr-dash {
  transform: scaleX(1.45);
  background: var(--hr-dash-hover);
}

.hr-text {
  position: absolute;
  left: calc(14px + var(--d) * 12px);
  right: 12px;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  font-size: 12.5px;
  line-height: 1.4;
  color: var(--muted);
  opacity: 0;
  transform: translateX(-8px);
  pointer-events: none;
  transition:
    opacity 0.14s ease,
    transform 0.2s var(--ease-panel),
    color 0.18s ease;
}
.hr-row:not(.deep) .hr-text {
  color: var(--ink);
  font-weight: 500;
}

/* ── 常驻完整标题 ── */
.heading-rail.pinned .hr-dash {
  opacity: 0;
  transform: scaleX(0.3);
}
.heading-rail.pinned .hr-text {
  opacity: 1;
  transform: none;
  transition:
    opacity 0.3s ease calc(min(var(--i), 24) * 9ms + 60ms),
    transform 0.42s var(--ease-panel) calc(min(var(--i), 24) * 9ms + 40ms),
    color 0.18s ease;
}
.heading-rail.pinned:not(.morphing) .hr-text {
  transition:
    opacity 0.14s ease,
    transform 0.2s var(--ease-panel),
    color 0.18s ease;
}
.heading-rail.pinned .hr-row::before {
  content: '';
  position: absolute;
  inset: 2px 6px;
  border-radius: 6px;
  background: transparent;
  transition: background-color 0.15s ease;
}
.heading-rail.pinned .hr-row.hover::before {
  background: var(--hover);
}
.heading-rail.pinned .hr-row.active .hr-text {
  color: var(--accent);
  font-weight: 600;
}

/* ── 当前位置指示线（墨蓝，跟随深浅色主题的 --accent） ── */
.hr-indicator {
  position: absolute;
  top: 0;
  left: 0;
  border-radius: 1.5px;
  background: var(--accent);
  transform-origin: 0 50%;
  pointer-events: none;
  transition:
    transform var(--hr-dur) var(--ease-panel),
    width var(--hr-dur) var(--ease-panel),
    height var(--hr-dur) var(--ease-panel),
    scale 0.22s var(--ease-panel),
    opacity 0.2s ease;
}
.hr-indicator.off {
  opacity: 0;
}
.hr-indicator.hover {
  scale: 1.45 1;
}

/* ── 悬停浮层 ── */
.hr-label {
  position: fixed;
  top: 0;
  left: 0;
  z-index: 1001;
  /* 绝对定位在 48px 宽的轨道里：不写 max-content 会被包含块挤成一列字。 */
  width: max-content;
  display: flex;
  align-items: baseline;
  gap: 8px;
  max-width: min(380px, calc(100vw - 80px));
  padding: 6px 11px 7px;
  box-sizing: border-box;
  border-radius: 8px;
  background: var(--surface-2);
  box-shadow:
    var(--shadow-pop),
    0 6px 18px rgba(0, 0, 0, 0.07);
  color: var(--ink);
  font-size: 13px;
  line-height: 1.45;
  pointer-events: none;
  opacity: 0;
  visibility: hidden;
  translate: -4px 0;
  transition:
    opacity 0.14s ease,
    translate 0.18s var(--ease-panel),
    visibility 0s linear 0.14s;
}
.hr-label.show {
  opacity: 1;
  visibility: visible;
  translate: 0 0;
  transition:
    opacity 0.14s ease,
    translate 0.18s var(--ease-panel),
    visibility 0s;
}
.hr-label.show.glide {
  transition:
    opacity 0.14s ease,
    translate 0.18s var(--ease-panel),
    transform 0.16s var(--ease-panel),
    visibility 0s;
}
[data-theme='dark'] .hr-label {
  background: var(--surface-1);
  box-shadow:
    0 0 0 0.5px rgba(255, 255, 255, 0.1),
    0 6px 18px rgba(0, 0, 0, 0.4);
}
.hr-label-lv {
  flex: none;
  font-size: 10.5px;
  font-weight: 600;
  color: var(--faint);
  font-variant-numeric: tabular-nums;
}
.hr-label-text {
  min-width: 0;
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 4;
  overflow: hidden;
  overflow-wrap: anywhere;
}

@media (prefers-reduced-motion: reduce) {
  .heading-rail,
  .heading-rail *,
  .hr-label {
    transition-duration: 0s !important;
    transition-delay: 0s !important;
  }
}
</style>
