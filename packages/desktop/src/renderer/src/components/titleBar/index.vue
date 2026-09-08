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

      <!-- 左栏开关：红绿灯右侧常驻（单/多文档态均显示），点击开合侧边栏。 -->
      <button
        class="title-sidebar-btn title-no-drag"
        :class="{ on: showSideBar }"
        :title="t('sideBar.toggleTitle')"
        @click.stop="toggleSideBar"
      >
        <mo-icon name="i-sidebar" />
      </button>

      <!-- 单文档态：7px 墨蓝状态点 + 居中「…/目录/文件名」。
           路径最多往上 3 级、分隔符统一 /；单击折叠为仅文件名，双击原地重命名 -->
      <div class="title" @dblclick.stop="toggleMaxmizeOnMacOS">
        <div v-if="isSingleDoc && (filename || pathname)" class="title-path">
          <span class="title-dot" :class="{ show: !isSaved }" />
          <span
            class="filename title-no-drag"
            :class="{ isOsx: platform === 'darwin' }"
            :title="titleLabel"
            @click.stop="toggleCollapse"
            @dblclick.stop="rename"
            >{{ titleLabel }}</span
          >
        </div>
        <div v-else-if="isSingleDoc" class="title-brand">墨记</div>
      </div>

      <!-- 单文档态右栏控件（面包屑行已整行移除）：开关 + 网页/文档选择器 -->
      <div v-if="isSingleDoc && (filename || pathname)" class="title-controls title-no-drag">
        <button
          class="title-pbtn"
          :class="{ rolled: bpanelOpen }"
          :title="t('sideBar.rightPanelTitle')"
          @click.stop="toggleBpPanel"
        >
          <mo-icon :name="bpanelOpen ? 'i-x' : 'i-partition'" />
        </button>
        <bp-modes :shown="bpanelOpen" />
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
import { useBrowserPanelStore } from '@/store/browserPanel'
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue'
import { storeToRefs } from 'pinia'
import { minimizePath, restorePath, maximizePath, closePath } from '../../assets/window-controls.js'
import { isOsx as isOsxPlatform } from '@/util'
import { shouldShowInAppTitleBar } from './visibility'
import { useEditorStore } from '@/store/editor'
import { useLayoutStore } from '@/store/layout'
import MoIcon from '@/components/icons/MoIcon.vue'
import BpModes from '@/components/browserPanel/bpModes.vue'
import { t } from '../../i18n'

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
  // 标签集合大小：≤1 视为单文档态（标签栏不渲染、标题区显示路径）
  tabCount?: number
}>()

const preferencesStore = usePreferencesStore()
const editorStore = useEditorStore()
const bpStore = useBrowserPanelStore()
const layoutStore = useLayoutStore()

const { open: bpanelOpen } = storeToRefs(bpStore)
const { showSideBar } = storeToRefs(layoutStore)

const toggleSideBar = () => {
  layoutStore.TOGGLE_LAYOUT_ENTRY('showSideBar')
}

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

const isSingleDoc = computed(() => (props.tabCount ?? 0) <= 1)

// 单击折叠：路径最多往上 3 级，分隔符统一 /；切换文档时重置为完整路径。
const collapsed = ref(false)
watch(
  () => props.filename,
  () => {
    collapsed.value = false
  }
)

const MAX_DIR_LEVELS = 3

// 标题文案：家目录缩写成 ~；目录最多保留 3 级，超出前缀 …/。
const titleLabel = computed(() => {
  const name = props.filename ?? ''
  if (!props.pathname) return name
  if (collapsed.value) return name
  const home =
    window.electron?.process?.env?.HOME ??
    (window.marktext?.env as { HOME?: string } | undefined)?.HOME
  const dir = window.path.dirname(props.pathname)
  let rel = dir
  if (home && (dir === home || dir.startsWith(home + window.path.sep))) {
    rel = '~' + dir.slice(home.length)
  }
  if (!rel || rel === '.') return name
  const segs = rel.split('/').filter(Boolean)
  const truncated = segs.length > MAX_DIR_LEVELS
  const kept = truncated ? segs.slice(-MAX_DIR_LEVELS) : segs
  return `${truncated ? '…/' : ''}${kept.join('/')}/${name}`
})

const toggleCollapse = () => {
  collapsed.value = !collapsed.value
}

const toggleBpPanel = () => {
  bpStore.TOGGLE_PANEL()
}

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
  /* 用户反馈：--f13(17.33px) 偏大，缩到 14px（缩约 3.3px ≈ 两个字号级别） */
  font-size: 14px;
  line-height: 1.45;
  font-weight: 600;
  color: var(--muted);
}

.title-path .filename {
  color: var(--muted);
  white-space: nowrap;
}

.title-brand {
  font-size: 14px;
  font-weight: 600;
  color: var(--faint);
}

/* 左栏开关按钮：红绿灯右侧 28×28，hover 浮出、开合状态着色 */
.title-sidebar-btn {
  position: absolute;
  left: 78px;
  top: 50%;
  transform: translateY(-50%);
  width: 28px;
  height: 28px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: none;
  border-radius: 8px;
  background: transparent;
  color: var(--muted);
  cursor: pointer;
  transition:
    background 0.15s ease,
    color 0.15s ease;
}
.title-sidebar-btn:hover {
  background: var(--hover);
  color: var(--ink);
}
.title-sidebar-btn.on {
  color: var(--accent);
}
.title-sidebar-btn svg {
  width: 16px;
  height: 16px;
}

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

/* 单文档态右栏控件：开关 28×28 + 网页/文档选择器（rolled 圆态走全局 browserPanel.css） */
.title-controls {
  position: absolute;
  top: 0;
  right: 10px;
  bottom: 0;
  display: flex;
  align-items: center;
  gap: 6px;
}
.title-pbtn {
  width: 28px;
  height: 28px;
  flex: none;
  display: flex;
  align-items: center;
  justify-content: center;
  border: none;
  border-radius: 8px;
  background: transparent;
  color: var(--muted);
  cursor: pointer;
  transition:
    background 0.15s ease,
    color 0.15s ease;
}
.title-pbtn:hover {
  background: var(--hover);
  color: var(--ink);
}
.title-pbtn svg {
  width: 17px;
  height: 17px;
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
