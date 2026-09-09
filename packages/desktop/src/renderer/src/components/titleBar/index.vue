<template>
  <div>
    <div v-if="showTitleBar" class="title-bar-editor-bg" />
    <div
      v-if="showTitleBar"
      class="title-bar"
      :class="[{ active: active }, { frameless: titleBarStyle === 'custom' }, { isOsx: isOsx }]"
    >
      <div v-if="showCustomTitleBar" class="left-toolbar title-no-drag">
        <div class="frameless-titlebar-menu title-no-drag" @click.stop="handleMenuClick">
          <span class="text-center-vertical">&#9776;</span>
        </div>
      </div>

      <!-- 左右侧栏开关已统一到标签条两端（tabs.vue，单/多文档同位），
           顶栏不再放置任何面板开关。 -->

      <!-- 标题区：「文件A | 文件B」——右侧栏有文档（分屏第二文档 / 预览文档）
           时以竖线分隔显示在窗口顶栏；右文档名可拖回标签栏（分屏=回标签集合、
           预览=建成标签），× 关闭右栏文档。平时仍为「…/目录/文件名」。 -->
      <div class="title" @dblclick.stop="toggleMaxmizeOnMacOS">
        <div v-if="filename || pathname" class="title-path" :style="titleFontStyle">
          <span class="title-dot" :class="{ show: !isSaved }" />
          <span
            class="filename title-no-drag"
            :class="{ isOsx: platform === 'darwin' }"
            :title="titleLabel"
            @click.stop="toggleCollapse"
            @dblclick.stop="rename"
            >{{ titleLabel }}</span
          >
          <template v-if="rightDocName">
            <span class="title-sep" aria-hidden="true">|</span>
            <span
              class="filename right-doc title-no-drag"
              draggable="true"
              :title="rightDocTitle"
              @dragstart="onRightDragStart"
              @dragend="onRightDragEnd"
              @click.stop="toggleCollapse"
              @dblclick.stop
              >{{ rightDocName }}</span
            >
            <button
              class="right-doc-close"
              :title="t('sideBar.rightPanelCloseDoc')"
              @click.stop="closeRightDoc"
            >
              <mo-icon name="i-x" />
            </button>
          </template>
        </div>
        <div v-else class="title-brand">墨记</div>
      </div>

      <div
        v-if="titleBarStyle === 'custom' && !isFullScreen && !isOsx"
        class="right-toolbar"
        :class="[{ 'title-no-drag': titleBarStyle === 'custom' }]"
      >
        <div
          class="frameless-titlebar-button frameless-titlebar-close"
          @click.stop="handleCloseClick"
        >
          <div>
            <svg width="10" height="10">
              <path :d="windowIconClose" />
            </svg>
          </div>
        </div>
        <div
          class="frameless-titlebar-button frameless-titlebar-toggle"
          @click.stop="handleMaximizeClick"
        >
          <div>
            <svg width="10" height="10">
              <path v-show="!isMaximized" :d="windowIconMaximize" />
              <path v-show="isMaximized" :d="windowIconRestore" />
            </svg>
          </div>
        </div>
        <div
          class="frameless-titlebar-button frameless-titlebar-minimize"
          @click.stop="handleMinimizeClick"
        >
          <div>
            <svg width="10" height="10">
              <path :d="windowIconMinimize" />
            </svg>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { usePreferencesStore } from '@/store/preferences.js'
import { useEditorStore } from '@/store/editor'
import { useSplitStore } from '@/store/split'
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue'
import { storeToRefs } from 'pinia'
import { minimizePath, restorePath, maximizePath, closePath } from '../../assets/window-controls.js'
import { isOsx as isOsxPlatform } from '@/util'
import { shouldShowInAppTitleBar } from './visibility'
import { t } from '../../i18n'
import bus from '../../bus'
import MoIcon from '@/components/icons/MoIcon.vue'

interface ProjectInfo {
  name?: string
  [key: string]: unknown
}

const props = defineProps<{
  project?: ProjectInfo | null
  filename?: string
  pathname?: string
  active?: boolean
  platform?: string
  isSaved?: boolean
  // 标签集合大小：顶栏仅用于文案/字号逻辑，不再承载面板开关。
  tabCount?: number
}>()

const preferencesStore = usePreferencesStore()
const editorStore = useEditorStore()
const splitStore = useSplitStore()

const isOsx = isOsxPlatform
const windowIconMinimize = minimizePath
const windowIconRestore = restorePath
const windowIconMaximize = maximizePath
const windowIconClose = closePath

const isFullScreen = ref(false)
const isMaximized = ref(false)

onMounted(async () => {
  try {
    const [fs, max] = await Promise.all([
      window.electron.windowControl.isFullScreen(),
      window.electron.windowControl.isMaximized()
    ])
    isFullScreen.value = !!fs
    isMaximized.value = !!max
  } catch {}
})

const { titleBarStyle } = storeToRefs(preferencesStore)

// 单击折叠：路径最多往上 3 级，分隔符统一 /；切换文档时重置为完整路径。
// round9（用户拍板）：单击顶栏标题区时，「文件A | 文件B」两侧同时切换
// 「带路径 ⇄ 纯文件名」两种状态（共用一个 collapsed）。
const collapsed = ref(false)
watch(
  () => props.filename,
  () => {
    collapsed.value = false
  }
)

const MAX_DIR_LEVELS = 3

// 路径缩略：家目录缩写 ~；目录最多保留 3 级，超出前缀 …/。
const compactPathLabel = (pathname: string): string => {
  const name = window.path.basename(pathname)
  const home =
    window.electron?.process?.env?.HOME ??
    (window.marktext?.env as { HOME?: string } | undefined)?.HOME
  const dir = window.path.dirname(pathname)
  let rel = dir
  if (home && (dir === home || dir.startsWith(home + window.path.sep))) {
    rel = '~' + dir.slice(home.length)
  }
  if (!rel || rel === '.') return name
  const segs = rel.split('/').filter(Boolean)
  const truncated = segs.length > MAX_DIR_LEVELS
  const kept = truncated ? segs.slice(-MAX_DIR_LEVELS) : segs
  return `${truncated ? '…/' : ''}${kept.join('/')}/${name}`
}

// 「文件A | 文件B」的右文档指示：分屏第二文档（round8 起右侧文档为真编辑器，
// 无独立预览文档路径）。round9：与左侧共用 collapsed——完整态显示缩略路径。
const rightDocName = computed(() => {
  if (splitStore.active) {
    const tab = editorStore.tabs.find((item) => item.id === splitStore.tabId)
    if (!tab) return ''
    return collapsed.value ? tab.filename : compactPathLabel(tab.pathname)
  }
  return ''
})

const rightDocTitle = computed(() => {
  if (splitStore.active) {
    const tab = editorStore.tabs.find((item) => item.id === splitStore.tabId)
    return tab?.pathname ?? rightDocName.value
  }
  return ''
})

// 顶栏右文档名拖回标签栏：标记内部拖放（app.vue 的 window dragover 据此放行），
// 高亮标签条/顶部行，drop 时按来源落地（drop 处理在 tabs.vue onReturnDrop）。
const onRightDragStart = (event: DragEvent) => {
  if (!rightDocName.value) return
  event.dataTransfer?.setData('application/x-momark-split-doc', rightDocName.value)
  window.__momarkReturnDrag = true
  bus.emit('split:return-drag-start')
}

const onRightDragEnd = () => {
  window.__momarkReturnDrag = false
  bus.emit('split:return-drag-end')
}

// × 关闭右栏文档：分屏 = 文档回左侧标签集合。
const closeRightDoc = () => {
  if (splitStore.active) {
    splitStore.RETURN_SPLIT_TO_TABS(false)
  }
}

// 标题文案：collapsed 时纯文件名，否则缩略路径（与右文档侧同一口径）。
const titleLabel = computed(() => {
  const name = props.filename ?? ''
  if (!props.pathname) return name
  if (collapsed.value) return name
  return compactPathLabel(props.pathname)
})

const toggleCollapse = () => {
  collapsed.value = !collapsed.value
}

// 标题文字过长时自适应缩小字号（多文档时分屏 tab 数多、可用宽度小，
// 避免顶栏溢出挤压）：按 titleLabel 长度阶梯降级 14 → 13 → 12 → 11px。
const titleFontStyle = computed(() => {
  const rightLen = rightDocName.value ? rightDocName.value.length + 4 : 0
  const len = titleLabel.value.length + rightLen
  if (len > 76) return { fontSize: '11px' }
  if (len > 56) return { fontSize: '12px' }
  if (len > 40) return { fontSize: '13px' }
  return { fontSize: '14px' }
})

const showCustomTitleBar = computed(() => {
  return titleBarStyle.value === 'custom' && !isOsx
})

const showTitleBar = computed(() => {
  return shouldShowInAppTitleBar(titleBarStyle.value, isOsx)
})

watch(
  () => props.filename,
  (value) => {
    // Set filename when hover on dock
    const hasOpenFolder = !!(props.project && props.project.name)
    const projectName = props.project?.name ?? ''
    let title = ''
    if (value) {
      title = hasOpenFolder ? `${value} - ${projectName}` : `${value}`
    } else {
      title = hasOpenFolder ? projectName : ''
    }

    document.title = title
  }
)

const handleCloseClick = () => {
  window.electron.windowControl.close()
}

const handleMaximizeClick = async () => {
  if (isFullScreen.value) {
    window.electron.windowControl.setFullScreen(false)
    return
  }
  if (isMaximized.value) window.electron.windowControl.unmaximize()
  else window.electron.windowControl.maximize()
}

const toggleMaxmizeOnMacOS = () => {
  if (isOsx) {
    handleMaximizeClick()
  }
}

const handleMinimizeClick = () => {
  window.electron.windowControl.minimize()
}

const handleMenuClick = () => {
  window.electron.windowControl.popupApplicationMenu({ x: 23, y: 20 })
}

const rename = () => {
  if (props.platform === 'darwin') {
    editorStore.RESPONSE_FOR_RENAME()
  }
}

const onMaximize = () => {
  isMaximized.value = true
}
const onUnmaximize = () => {
  isMaximized.value = false
}
const onEnterFullScreen = () => {
  isFullScreen.value = true
}
const onLeaveFullScreen = () => {
  isFullScreen.value = false
}

const offMaximize = window.electron.ipcRenderer.on('mt::window-maximize', onMaximize)
const offUnmaximize = window.electron.ipcRenderer.on('mt::window-unmaximize', onUnmaximize)
const offEnterFullScreen = window.electron.ipcRenderer.on(
  'mt::window-enter-full-screen',
  onEnterFullScreen
)
const offLeaveFullScreen = window.electron.ipcRenderer.on(
  'mt::window-leave-full-screen',
  onLeaveFullScreen
)

onBeforeUnmount(() => {
  offMaximize()
  offUnmaximize()
  offEnterFullScreen()
  offLeaveFullScreen()
})
</script>

<style scoped>
.title-bar-editor-bg {
  height: 40px;
  background: var(--bg);
  position: relative;
  left: 0;
  top: 0;
  right: 0;
  flex: none;
}
.title-bar {
  -webkit-app-region: drag;
  user-select: none;
  background: transparent;
  height: 40px;
  box-sizing: border-box;
  color: var(--muted);
  position: fixed;
  left: 0;
  top: 0;
  right: 0;
  z-index: 2;
  transition: color 0.4s ease-in-out;
  cursor: default;
}
.active {
  color: var(--ink);
}

.title {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  /* 居中标题不能压到原生红绿灯（macOS）与左右工具栏 */
  padding: 0 148px;
  overflow: hidden;
}

.title-path {
  display: flex;
  align-items: center;
  gap: 8px;
  max-width: 100%;
  min-width: 0;
  overflow: hidden;
  /* 基础字号 14px（用户反馈 --f13 17.33px 偏大）；超长时由 titleFontStyle
     内联按阶梯缩小（14→13→12→11px）。 */
  font-size: 14px;
  line-height: 1.45;
  font-weight: 600;
  color: var(--muted);
}

.title-path .filename {
  color: var(--muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  min-width: 0;
}

/* 「文件A | 文件B」：竖线分隔淡色、右文档名可拖回标签栏、× 关闭右栏文档 */
.title-sep {
  color: var(--faint);
  font-weight: 400;
  padding: 0 1px;
  flex: none;
}
.title-path .filename.right-doc {
  max-width: 240px;
  flex: none;
  cursor: grab;
}
.title-path .filename.right-doc:active {
  cursor: grabbing;
}
.title-path .filename.right-doc:hover {
  color: var(--ink);
}
.right-doc-close {
  flex: none;
  width: 18px;
  height: 18px;
  border: none;
  border-radius: 5px;
  background: transparent;
  display: grid;
  place-items: center;
  color: var(--faint);
  cursor: pointer;
  opacity: 0;
  transition:
    background 0.15s ease,
    color 0.15s ease,
    opacity 0.15s ease;
}
.title-path:hover .right-doc-close {
  opacity: 1;
}
.right-doc-close:hover {
  background: var(--hover);
  color: var(--ink);
}
.right-doc-close svg {
  width: 11px;
  height: 11px;
}

.title-brand {
  font-size: 14px;
  font-weight: 600;
  color: var(--faint);
}

/* 左右侧栏开关已统一到标签条两端（tabs.vue），顶栏只保留标题与窗口控制。 */

/* 未保存状态点（PHASE2-SPEC §2：7px 墨蓝，保存成功即移除） */
.title-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--accent);
  flex: none;
  opacity: 0;
  transition: opacity 0.16s ease;
}
.title-dot.show {
  opacity: 1;
}

.title-bar .title .filename.isOsx:hover {
  color: var(--accent);
}

.left-toolbar {
  padding: 0 10px;
  height: 100%;
  position: absolute;
  top: 0;
  left: 0;
  width: 118px; /* + 2*10px padding*/
  display: flex;
  flex-direction: row;
}
.right-toolbar {
  height: 100%;
  position: absolute;
  top: 0;
  right: 0;
  width: 138px;
  display: flex;
  align-items: center;
  flex-direction: row-reverse;
}

.title-no-drag {
  -webkit-app-region: no-drag;
}
/* frameless window controls */
.frameless-titlebar-button {
  position: relative;
  display: block;
  width: 46px;
  height: 40px;
}
.frameless-titlebar-button > div {
  position: absolute;
  display: inline-flex;
  top: 50%;
  left: 50%;
  transform: translateX(-50%) translateY(-50%);
}
.frameless-titlebar-menu {
  color: var(--muted);
}
.frameless-titlebar-close:hover {
  background-color: rgb(228, 79, 79);
}
.frameless-titlebar-minimize:hover,
.frameless-titlebar-toggle:hover {
  background-color: rgba(0, 0, 0, 0.1);
}
.frameless-titlebar-button svg {
  fill: #000000;
}
.frameless-titlebar-close:hover svg {
  fill: #ffffff;
}

.text-center-vertical {
  display: inline-block;
  vertical-align: middle;
  line-height: normal;
}
</style>
