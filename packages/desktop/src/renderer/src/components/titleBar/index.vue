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

      <!-- 单文档态：7px 墨蓝状态点 + 完整路径（多文档/分栏态标题区留空） -->
      <div class="title" @dblclick.stop="toggleMaxmizeOnMacOS">
        <div v-if="isSingleDoc && (filename || pathname)" class="title-path">
          <span class="title-dot" :class="{ show: !isSaved }" />
          <span class="title-text">
            <span v-if="dirDisplay" class="title-dirs">{{ dirDisplay }}</span>
            <span v-if="dirDisplay" class="title-sep">›</span>
            <span
              class="filename title-no-drag"
              :class="{ isOsx: platform === 'darwin' }"
              @click="rename"
              >{{ filename }}</span
            >
          </span>
        </div>
        <div v-else-if="isSingleDoc" class="title-brand">墨记 MoMark</div>
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
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue'
import { storeToRefs } from 'pinia'
import { minimizePath, restorePath, maximizePath, closePath } from '../../assets/window-controls.js'
import { isOsx as isOsxPlatform } from '@/util'
import { shouldShowInAppTitleBar } from './visibility'
import { useEditorStore } from '@/store/editor'

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

// 完整路径（dirname 部分）：家目录折叠为 `~`，段间用系统分隔符连接，
// 与文件名之间用 ` › ` 分隔（PHASE2-SPEC §1 标题区格式）。
const dirDisplay = computed(() => {
  if (!props.pathname) return ''
  const sep = window.path.sep
  const dir = window.path.dirname(props.pathname)
  if (!dir || dir === '.') return ''
  const home = window.marktext?.env?.HOME as string | undefined
  let base = dir
  if (home && (base === home || base.startsWith(home + sep))) {
    base = '~' + base.slice(home.length)
  }
  return base
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
  font-size: var(--f13);
  font-weight: 600;
  color: var(--muted);
}

.title-text {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  white-space: nowrap;
}

.title-dirs {
  white-space: nowrap;
}

.title-sep {
  color: var(--faint);
  font-weight: 400;
}

.title-path .filename {
  color: var(--ink);
  white-space: nowrap;
}

.title-brand {
  font-size: var(--f13);
  font-weight: 600;
  color: var(--faint);
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
