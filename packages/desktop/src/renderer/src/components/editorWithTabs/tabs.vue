<template>
  <div ref="tabsRoot" class="editor-tabs" :class="{ single: scene === 'single' }">
    <button
      class="tb-toggle"
      :class="{ on: showSideBar }"
      :title="t('sideBar.toggleTitle') + ' ⌘\\'"
      @click.stop="toggleSidebar"
    >
      <mo-icon name="i-sidebar" />
    </button>

    <!-- round9（用户拍板）：标签条任何场景都渲染（单文档也显示标签，
         拖回标签栏后文档标签立即可见）。 -->
    <div ref="tabContainer" class="tabstrip">
      <div
        v-for="file of visibleTabs"
        :key="file.id"
        class="tab"
        :class="{ active: currentFile?.id === file.id, dirty: !file.isSaved }"
        :title="file.pathname"
        :data-id="file.id"
        @click.stop="selectFile(file)"
        @click.middle="closeTab(file.id)"
        @contextmenu.prevent="handleContextMenu($event, file)"
      >
        <span class="tname">
          <span class="tn">{{ file.filename }}</span>
          <span class="dot" />
        </span>
        <button
          v-if="visibleTabs.length > 1"
          class="tclose"
          :title="t('tabs.closeTab')"
          @click.stop="removeFileInTab(file)"
        >
          <mo-icon name="i-x" />
        </button>
      </div>
      <!-- 活动标签底部独立滑轨：独立元素，不随标签重建（PHASE2-SPEC §2） -->
      <span ref="indicator" class="tab-indicator" />
      <!-- round12（用户拍板）：标签条最右 hover 显现的新建按钮——
           点击新建 untitled 未保存文件。 -->
      <button class="tab-new" :title="t('tabs.newTab')" @click.stop="newUntitled">
        <mo-icon name="i-plus" />
      </button>
    </div>

    <!-- 右栏文档指示已移到窗口顶栏（titleBar，「文件A | 文件B」竖线分隔、
         可拖回标签栏）。 -->

    <button
      class="tb-toggle panel-toggle"
      :class="{ rolled: bpanelOpen }"
      :title="t('sideBar.rightPanelTitle')"
      @click.stop="toggleBpPanel"
    >
      <mo-icon :name="bpanelOpen ? 'i-x' : 'i-partition'" />
    </button>
    <bp-modes :shown="bpanelOpen" />
  </div>
</template>

<script setup lang="ts">
import { ref, watch, nextTick, onMounted, onBeforeUnmount } from 'vue'
import { useEditorStore } from '@/store/editor'
import { useLayoutStore } from '@/store/layout'
import { storeToRefs } from 'pinia'
import autoScroll from 'dom-autoscroller'
import dragula from 'dragula'
import MoIcon from '@/components/icons/MoIcon.vue'
import { showContextMenu } from '../../contextMenu/tabs'
import bus from '../../bus'
import { t } from '../../i18n'
import type { IFileState } from '@shared/types/files'
import { useBrowserPanelStore } from '@/store/browserPanel'
import { useSplitStore } from '@/store/split'
import { useWorkspaceStore } from '@/store/workspace'
import BpModes from '@/components/browserPanel/bpModes.vue'
// 正文整屏滑出/滑入动效的全局样式（类名挂在兄弟组件的根节点上，
// scoped 样式无法命中，必须全局注入）。
import './transitions.css'

const editorStore = useEditorStore()
const layoutStore = useLayoutStore()
const bpStore = useBrowserPanelStore()
const splitStore = useSplitStore()
const workspaceStore = useWorkspaceStore()

const { currentFile, tabs } = storeToRefs(editorStore)
const { showSideBar } = storeToRefs(layoutStore)
const { open: bpanelOpen } = storeToRefs(bpStore)
const { visibleTabs, scene } = storeToRefs(workspaceStore)

interface AutoScroller {
  readonly down: boolean
  destroy: (forceCleanAnimation?: boolean) => void
}

const tabContainer = ref<HTMLElement | null>(null)
const tabsRoot = ref<HTMLElement | null>(null)
const indicator = ref<HTMLElement | null>(null)
let autoScroller: AutoScroller | null = null
let drake: dragula.Drake | null = null
let resizeObserver: ResizeObserver | null = null
// 投放区 / 面板容器元素（dragula 目标容器，onMounted 时从 DOM 解析）
let splitZoneEl: HTMLElement | null = null
let bpanelEl: HTMLElement | null = null

const toggleSidebar = () => {
  bus.emit('view:toggle-layout-entry', 'showSideBar')
}

const toggleBpPanel = () => {
  bpStore.TOGGLE_PANEL()
}

// 标签拖回标签栏（顶栏右文档名的 return-drag，PHASE2-SPEC §3.4）：
// dragstart 时高亮投放区——多文档态=标签条（accentSoft 底 + accent 环）；
// 单文档态无标签条，整行可投放（editor-tabs 根挂 .return-target）。
const onReturnDragStart = () => {
  tabContainer.value?.classList.add('return-target')
  tabsRoot.value?.classList.add('return-target')
}

const onReturnDragEnd = () => {
  tabContainer.value?.classList.remove('return-target')
  tabsRoot.value?.classList.remove('return-target')
}

const onReturnDragOver = (event: DragEvent) => {
  event.preventDefault()
  event.dataTransfer!.dropEffect = 'move'
}

const onReturnDrop = (event: DragEvent) => {
  event.preventDefault()
  tabContainer.value?.classList.remove('return-target')
  tabsRoot.value?.classList.remove('return-target')
  // 以 dataTransfer 类型鉴别（合成/真实拖放均可靠），全局标记仅用于
  // app.vue 的 window 级放行。
  if (!event.dataTransfer?.types.includes('application/x-momark-split-doc')) return
  if (splitStore.active) {
    // 分屏文档拖回标签栏（回到左侧标签集合）。
    splitStore.RETURN_SPLIT_TO_TABS()
  }
}

// ══ 标签点击切换：正文左右回弹动效（round11 六调用户拍板）══
// 整屏滑出动效（±100vw 跨侧栏穿出）是「底飞过侧边栏、层级不对、
// 没回弹」的根因，已删除。现在：点击瞬间按标签顺序算方向并同步
// 派发事件，editor.vue 侧 useEditorEnterMotion 起跳（内容级横滑
// + 5.5px 反向过冲，wrapper 透明、底不动、裁剪在编辑区内），
// 随后 UPDATE_CURRENT_FILE 落地切换。flushActiveEditor 的耗时
// 不再拖晚起跳（旧 watch 触发路径要等 flush 完 ~280ms 才动）。
// 其他切换路径（键盘循环/侧栏打开/关闭标签）即时切换，不走动效。
const selectFile = (file: IFileState) => {
  if (file.id === currentFile.value?.id) return

  const ids = tabs.value.map((tab) => tab.id)
  const ni = ids.indexOf(file.id)
  const oi = ids.indexOf(currentFile.value?.id ?? '')
  const direction: 'left' | 'right' = oi !== -1 && ni > oi ? 'right' : 'left'

  // 起跳信号：editor.vue 监听此事件，同步起跳后再落地切换。
  document.dispatchEvent(new CustomEvent('momark:tab-enter', { detail: { direction } }))
  editorStore.UPDATE_CURRENT_FILE(file)
}

const removeFileInTab = (file: IFileState) => {
  const { isSaved } = file
  if (isSaved) {
    editorStore.FORCE_CLOSE_TAB(file)
  } else {
    editorStore.CLOSE_UNSAVED_TAB(file)
  }
}

// round12（用户拍板）：新建 untitled 文件（未保存态）。
// 关闭语义：无内容直接关不提示（isSaved=true 走 FORCE_CLOSE_TAB）、
// 写过内容 isSaved 已被置 false 走 CLOSE_UNSAVED_TAB 弹保存对话框。
const newUntitled = (): void => {
  editorStore.NEW_UNTITLED_TAB({})
}

// 滑轨（PHASE2-SPEC §2）：width = max(18px, active.offsetWidth - 20px)，
// transform = translateX(active.offsetLeft + 10px)。
// S 型动效（用户反馈去掉回弹）：width 瞬切 + WAAPI 在 transform 层做
// translateX+scaleX 补偿动画，全程只动画合成层属性，无逐帧 layout。
let indicatorAnim: Animation | null = null
const REDUCED_MOTION =
  typeof window.matchMedia === 'function' &&
  window.matchMedia('(prefers-reduced-motion: reduce)').matches

const moveIndicator = (animate: boolean): void => {
  const strip = tabContainer.value
  const ind = indicator.value
  if (!strip || !ind) return
  const active = strip.querySelector<HTMLElement>('.tab.active')
  if (!active) {
    ind.style.opacity = '0'
    return
  }
  // round10：指示条精确贴住标签文字（.tname = 文件名 + 未保存圆点），
  // 不再以整个 .tab 为基准——tab 右侧为 × 按钮预留 30px padding，
  // 旧算法会把蓝条伸到 × 按钮下方与文字对不齐。
  const tname = active.querySelector<HTMLElement>('.tname')
  const offsetLeft = active.offsetLeft + (tname?.offsetLeft ?? 10)
  const targetW = tname ? tname.offsetWidth : Math.max(18, active.offsetWidth - 20)
  const targetX = tname ? offsetLeft : active.offsetLeft + 10
  if (indicatorAnim) {
    indicatorAnim.cancel()
    indicatorAnim = null
  }
  if (!animate || REDUCED_MOTION) {
    ind.style.width = `${targetW}px`
    ind.style.transform = `translateX(${targetX}px)`
    ind.style.opacity = '1'
    return
  }
  // 起点 = 当前视觉位置（含 scroll）；终点 = 内容坐标（CSS 层自动减 scroll）。
  const stripRect = strip.getBoundingClientRect()
  const curRect = ind.getBoundingClientRect()
  const curX = curRect.left - stripRect.left
  const curW = curRect.width
  const startX = curW > 0 ? curX : targetX
  const startSx = curW > 0 ? targetW / curW : 1
  ind.style.width = `${targetW}px`
  ind.style.opacity = '1'
  indicatorAnim = ind.animate(
    [
      { transform: `translateX(${startX}px) scaleX(${startSx})` },
      { transform: `translateX(${targetX}px) scaleX(1)` }
    ],
    {
      duration: 300,
      easing: 'cubic-bezier(0.4, 0, 0.2, 1)',
      fill: 'forwards'
    }
  )
  indicatorAnim.onfinish = () => {
    ind.style.transform = `translateX(${targetX}px)`
    ind.style.width = `${targetW}px`
    indicatorAnim = null
  }
}

// Keep the active tab visible when the selection changes by something other
// than a direct click on a visible tab (keyboard cycle, switch-by-index, open
// from the sidebar): the strip has `overflow-x: auto` and only scrolls on the
// wheel, so an off-screen tab would otherwise stay hidden (#3958).
const scrollActiveTabIntoView = () => {
  const container = tabContainer.value
  if (!container) return
  const activeTab = container.querySelector<HTMLElement>('.tab.active')
  if (!activeTab) return

  const containerRect = container.getBoundingClientRect()
  const tabRect = activeTab.getBoundingClientRect()
  if (tabRect.left < containerRect.left) {
    container.scrollLeft -= containerRect.left - tabRect.left
  } else if (tabRect.right > containerRect.right) {
    container.scrollLeft += tabRect.right - containerRect.right
  }
}

const handleTabScroll = (event: WheelEvent) => {
  // Use mouse wheel value first but prioritize X value more (e.g. touchpad input).
  let delta = event.deltaY
  if (event.deltaX !== 0) {
    delta = event.deltaX
  }

  const tabsEl = tabContainer.value
  if (!tabsEl) return
  const newLeft = Math.max(0, Math.min(tabsEl.scrollLeft + delta, tabsEl.scrollWidth))
  tabsEl.scrollLeft = newLeft
}

const closeTab = (tabId: unknown) => {
  const tab = tabs.value.find((f) => f.id === tabId)
  if (tab) {
    editorStore.CLOSE_TAB(tab)
  }
}

const closeOthers = (tabId: unknown) => {
  const tab = tabs.value.find((f) => f.id === tabId)
  if (tab) {
    editorStore.CLOSE_OTHER_TABS(tab)
  }
}

const closeSaved = () => {
  editorStore.CLOSE_SAVED_TABS()
}

const closeAll = () => {
  editorStore.CLOSE_ALL_TABS()
}

const rename = (tabId: unknown) => {
  const tab = tabs.value.find((f) => f.id === tabId)
  if (tab && tab.pathname) {
    editorStore.RENAME_FILE(tab)
  }
}

const copyPath = (tabId: unknown) => {
  const tab = tabs.value.find((f) => f.id === tabId)
  if (tab && tab.pathname) {
    window.electron.clipboard.writeText(tab.pathname)
  }
}

const showInFolder = (tabId: unknown) => {
  const tab = tabs.value.find((f) => f.id === tabId)
  if (tab && tab.pathname) {
    window.electron.shell.showItemInFolder(tab.pathname)
  }
}

const handleContextMenu = (event: MouseEvent, tab: IFileState) => {
  if (tab.id) {
    showContextMenu(event, tab)
  }
}

watch(
  () => currentFile.value?.id,
  () => {
    nextTick(() => {
      scrollActiveTabIntoView()
      moveIndicator(true)
    })
  }
)

// 重排/增删标签后滑轨同步位移。
watch(
  () => tabs.value.map((tab) => tab.id).join(','),
  () => {
    nextTick(() => moveIndicator(true))
  }
)

// 标签条运行时（wheel 滚动 / 拖回投放 / dragula 拖拽 / autoScroll / RO / 滑轨首帧）。
// round9：标签条所有场景常驻渲染，onMounted 后一次性挂载运行时，
// 不再随场景出现/消失。
let runtimeTabsEl: HTMLElement | null = null

const setupTabsRuntime = () => {
  const tabsEl = tabContainer.value
  if (!tabsEl || runtimeTabsEl === tabsEl) return
  teardownTabsRuntime()
  runtimeTabsEl = tabsEl

  // Allow to scroll through the tabs by mouse wheel or touchpad.
  tabsEl.addEventListener('wheel', handleTabScroll)

  // 分屏投放目标容器（dragula 多容器）：右缘 38% 投放区 + 整个右栏面板。
  // 两个元素常驻 win-body（app.vue），标签栏挂载时它们必然已在 DOM 中。
  splitZoneEl = document.querySelector<HTMLElement>('.split-drop-zone')
  bpanelEl = document.querySelector<HTMLElement>('.bpanel')
  const dropTargets = [splitZoneEl, bpanelEl].filter((el): el is HTMLElement => el !== null)

  // 标签拖拽：标签栏内 = 重排；投放区/面板 = 分屏展开（PHASE2-SPEC §3）。
  // 目标已在右屏 → accepts 拒绝（blocked，dropEffect none 语义，revertOnSpill 归位）。
  drake = dragula([tabsEl, ...dropTargets], {
    direction: 'horizontal',
    revertOnSpill: true,
    mirrorContainer: tabsEl,
    ignoreInputTextSelection: false,
    moves: (el) => !!el?.classList.contains('tab'),
    accepts: (el, target) => {
      if (target === tabsEl) return true
      const id = el?.getAttribute('data-id') ?? null
      if (!id) return false
      // 该文档已在右屏 → blocked（投放区显示「该文件已在右侧分屏」）。
      return !(splitStore.active && splitStore.tabId === id)
    }
  })
    .on('drag', (el) => {
      el?.classList.add('dragging')
      splitStore.dragTabId = el?.getAttribute('data-id') ?? null
    })
    .on('over', (_el, container) => {
      if (container === splitZoneEl) {
        splitZoneEl?.classList.add('over')
      } else if (container === bpanelEl) {
        bpStore.SET_DRAG_STATE('over')
      }
    })
    .on('out', (_el, container) => {
      if (container === splitZoneEl) {
        splitZoneEl?.classList.remove('over')
      } else if (container === bpanelEl) {
        bpStore.SET_DRAG_STATE('none')
      }
    })
    .on('drop', (el, target, _source, sibling) => {
      el?.classList.remove('dragging')
      const droppedId = el?.getAttribute('data-id')

      // 投放区 / 右栏面板 → 拖拽分屏（文档移出左侧标签集合）。
      if (target === splitZoneEl || target === bpanelEl) {
        if (droppedId) {
          // round11 通知精简（用户拍板）：重复分屏不弹 toast。
          splitStore.DRAG_TO_SPLIT(droppedId)
        }
        splitZoneEl?.classList.remove('over')
        bpStore.SET_DRAG_STATE('none')
        splitStore.dragTabId = null
        return
      }

      // 标签栏内 = 重排（原有逻辑）。
      // Current tab that was dropped and need to be reordered.
      // This should be the next tab (tab | ... | el | sibling | tab | ...) but may be
      // the mirror image or null (tab | ... | el | sibling or null) if last tab.
      // The trailing slide indicator (`tab-indicator`) lives inside the strip:
      // dropping after it is a drop at the very end.
      const siblingIsIndicator = !!sibling && sibling.classList.contains('tab-indicator')
      const nextTabId = sibling && !siblingIsIndicator ? sibling.getAttribute('data-id') : null
      const isLastTab = !sibling || siblingIsIndicator || sibling.classList.contains('gu-mirror')
      if (!droppedId || (sibling && !siblingIsIndicator && !nextTabId)) {
        console.error('Tab reorder error: invalid tab IDs')
        return
      }

      editorStore.EXCHANGE_TABS_BY_ID({
        fromId: droppedId,
        toId: isLastTab ? null : nextTabId
      })
      splitStore.dragTabId = null
      // round11 通知精简（用户拍板）：标签重排结果即时可见，
      // 「顺序已保存」toast 属打扰，已移除。
    })
    .on('cancel', (el) => {
      el?.classList.remove('dragging')
      splitZoneEl?.classList.remove('over')
      bpStore.SET_DRAG_STATE('none')
      splitStore.dragTabId = null
    })

  // Scroll when dragging a tab to the beginning or end of the tab container.
  autoScroller = autoScroll([tabsEl], {
    margin: 20,
    maxSpeed: 6,
    scrollWhenOutside: false,
    autoScroll: () => {
      return autoScroller!.down && drake?.dragging
    }
  })

  // 首帧定位滑轨：无动画（防闪现）。
  nextTick(() => moveIndicator(false))

  // 字体加载/窗口缩放导致标签宽度变化时同步滑轨。
  resizeObserver = new ResizeObserver(() => moveIndicator(true))
  resizeObserver.observe(tabsEl)
}

const teardownTabsRuntime = () => {
  const tabsEl = runtimeTabsEl
  if (tabsEl) {
    tabsEl.removeEventListener('wheel', handleTabScroll)
  }

  if (resizeObserver) {
    resizeObserver.disconnect()
    resizeObserver = null
  }
  if (autoScroller) {
    // Force destroy
    autoScroller.destroy(true)
    autoScroller = null
  }
  if (drake) {
    drake.destroy()
    drake = null
  }
  splitZoneEl?.classList.remove('over')
  bpStore.SET_DRAG_STATE('none')
  splitStore.dragTabId = null
  splitZoneEl = null
  bpanelEl = null
  runtimeTabsEl = null
}

onMounted(() => {
  bus.on('TABS::close-this', closeTab)
  bus.on('TABS::close-others', closeOthers)
  bus.on('TABS::close-saved', closeSaved)
  bus.on('TABS::close-all', closeAll)
  bus.on('TABS::rename', rename)
  bus.on('TABS::copy-path', copyPath)
  bus.on('TABS::show-in-folder', showInFolder)
  bus.on('split:return-drag-start', onReturnDragStart)
  bus.on('split:return-drag-end', onReturnDragEnd)

  // chip 拖回标签栏（原生 HTML5 drop）：绑在 editor-tabs 整行常驻，
  // 任何场景都可整行投放。
  tabsRoot.value?.addEventListener('dragover', onReturnDragOver)
  tabsRoot.value?.addEventListener('drop', onReturnDrop)

  // 标签条常驻渲染（round9），onMounted 后一次性挂载运行时。
  nextTick(() => {
    setupTabsRuntime()
  })
})

onBeforeUnmount(() => {
  teardownTabsRuntime()

  // Remove event listeners
  bus.off('TABS::close-this', closeTab)
  bus.off('TABS::close-others', closeOthers)
  bus.off('TABS::close-saved', closeSaved)
  bus.off('TABS::close-all', closeAll)
  bus.off('TABS::rename', rename)
  bus.off('TABS::copy-path', copyPath)
  bus.off('TABS::show-in-folder', showInFolder)
  bus.off('split:return-drag-start', onReturnDragStart)
  bus.off('split:return-drag-end', onReturnDragEnd)

  tabsRoot.value?.removeEventListener('dragover', onReturnDragOver)
  tabsRoot.value?.removeEventListener('drop', onReturnDrop)
})
</script>

<style scoped>
.editor-tabs {
  flex: none;
  display: flex;
  align-items: center;
  gap: 2px;
  min-height: 40px;
  padding: 2px 14px;
  background: var(--bg);
  box-sizing: border-box;
  user-select: none;
}

.tb-toggle {
  width: 32px;
  height: 32px;
  border: none;
  background: transparent;
  border-radius: 8px;
  cursor: pointer;
  display: grid;
  place-items: center;
  color: var(--muted);
  flex: none;
  /* 原型全量列表：bg/color .22s、radius .38s、transform .48s、shadow .22s，
     opacity 供单文档低透明度态平滑显现 */
  transition:
    background 0.22s ease,
    color 0.22s ease,
    opacity 0.22s ease,
    border-radius 0.38s cubic-bezier(0.22, 1, 0.36, 1),
    transform 0.48s cubic-bezier(0.22, 1, 0.36, 1),
    box-shadow 0.22s ease;
}
.tb-toggle:hover {
  background: var(--hover);
  color: var(--ink);
}
/* 原型：开关内图标 16px */
.tb-toggle svg {
  width: 16px;
  height: 16px;
}
.tb-toggle.on {
  background: color-mix(in oklab, var(--accent) 10%, transparent);
  color: var(--accent);
}

/* 单文档态：两个开关统一留在标签条两端（与多文档一致），
   但低不透明度保简洁，hover / 激活时完全显现。 */
.editor-tabs.single .tb-toggle {
  opacity: 0.42;
}
.editor-tabs.single .tb-toggle:hover,
.editor-tabs.single .tb-toggle.on,
.editor-tabs.single .tb-toggle.rolled {
  opacity: 1;
}
/* 单文档态无标签，右开关靠 margin 顶到右端（与多文档位置一致） */
.editor-tabs.single .tb-toggle.panel-toggle {
  margin-left: auto;
}

.tabstrip {
  display: flex;
  align-items: center;
  gap: 2px;
  flex: 1;
  min-width: 0;
  overflow-x: auto;
  scrollbar-width: none;
  position: relative;
  height: 36px;
}
.tabstrip::-webkit-scrollbar {
  display: none;
}

/* round12（用户拍板）：新建标签按钮——常驻标签条尾部占位、hover 标签条时
   淡显；点击新建 untitled。 */
.tab-new {
  flex: none;
  width: 26px;
  height: 26px;
  margin-left: 3px;
  border: none;
  border-radius: 7px;
  background: transparent;
  color: var(--muted);
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  opacity: 0;
  transition:
    opacity 0.16s ease,
    background 0.15s ease,
    color 0.15s ease;
}
.tab-new svg {
  width: 14px;
  height: 14px;
}
.tabstrip:hover .tab-new {
  opacity: 1;
}
.tab-new:hover {
  background: var(--hover);
  color: var(--ink);
}

/* 标签：只显示文件名；宽度随内容自适应，max 420px，不得省略截断（PHASE2-SPEC §2） */
.tab {
  position: relative;
  flex: 0 0 auto;
  max-width: 420px;
  height: 36px;
  background: transparent;
  border-radius: 8px 8px 0 0;
  cursor: pointer;
  user-select: none;
  padding: 0 30px 0 12px;
  display: flex;
  align-items: center;
  gap: 7px;
  box-sizing: border-box;
  transition:
    background 0.22s ease,
    box-shadow 0.22s ease;
}
.tab:hover {
  background: var(--hover);
}
.tab.active {
  background: var(--surface-2);
}

/* 切换标签的文字行程动效已取消（用户拍板：文字不横穿边缘）——
   切换动效改为正文整屏滑出窗口边缘（transitions.css），
   标签页维持上一版：底部小横条滑动 + 活动标签文字微微变大。 */

.tab .tname {
  /* 基准 --f11（14.67px）；活动态 --f12（16px）= 微微变大（+9%），
     带 0.3s S 型字号过渡 */
  font-size: var(--f11);
  line-height: 1.45;
  font-weight: 600;
  color: var(--muted);
  white-space: nowrap;
  overflow: visible;
  display: flex;
  align-items: center;
  gap: 6px;
  transition: font-size 0.3s var(--ease-tab-enter);
}
.tab.active .tname {
  color: var(--ink);
  font-size: var(--f12);
}

/* 活动标签底部独立滑轨（独立元素，不随标签重建）。
   transform/width 由 moveIndicator 的 WAAPI 动画接管（S 型 300ms 零过冲），
   CSS 不再对两者做 transition，避免瞬写被过渡拖慢。 */
.tab-indicator {
  position: absolute;
  left: 0;
  bottom: 0;
  width: 0;
  height: 2px;
  border-radius: 2px;
  background: var(--accent);
  pointer-events: none;
  z-index: 3;
  opacity: 0;
  transition: opacity 0.16s ease;
}

/* 未保存圆点：7px 墨蓝，文件名之后；保存成功即移除 */
.tab .tname .dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--accent);
  display: none;
  flex: none;
}
.tab.dirty .tname .dot {
  display: block;
}

/* 关闭按钮：18px，hover 标签才出现；仅剩一个标签时不渲染 */
.tab .tclose {
  position: absolute;
  right: 7px;
  top: 50%;
  transform: translateY(-50%);
  width: 18px;
  height: 18px;
  border: none;
  background: transparent;
  border-radius: 50%;
  cursor: pointer;
  display: grid;
  place-items: center;
  color: var(--faint);
  opacity: 0;
  transition: all 0.15s ease;
  padding: 0;
}
.tab:hover .tclose {
  opacity: 1;
}
/* 原型：关闭图标 10px，墨灰 #898781 级 */
.tab .tclose svg {
  width: 10px;
  height: 10px;
}
.tab .tclose:hover {
  background: var(--selected);
  color: var(--ink);
}

/* dragula effects */
.tab.dragging {
  opacity: 0.45;
}
.gu-mirror {
  position: fixed !important;
  margin: 0 !important;
  z-index: 9999 !important;
  opacity: 0.45;
  cursor: grabbing;
}
.gu-hide {
  display: none !important;
}
.gu-unselectable {
  user-select: none !important;
}
.gu-transit {
  opacity: 0.2;
}
</style>
