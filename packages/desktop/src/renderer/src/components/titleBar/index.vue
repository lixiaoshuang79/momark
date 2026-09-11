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
          <!-- round13（用户拍板）：双击标题就地重命名——标题位置直接变输入框，
               不再弹重命名对话框（untitled 仍走旧行为：双击=保存即命名）。 -->
          <input
            v-if="renaming"
            ref="renameInputRef"
            v-model="renameDraft"
            class="rename-input title-no-drag"
            :style="titleFontStyle"
            spellcheck="false"
            @keydown.enter.prevent="commitRename"
            @keydown.esc.prevent="cancelRename"
            @blur="commitRename"
            @click.stop
          />
          <span
            v-else
            class="filename title-no-drag"
            :class="{ isOsx: platform === 'darwin' }"
            :title="titleLabel"
            @click.stop="toggleCollapse"
            @dblclick.stop="startRename"
            >{{ titleLabel }}</span
          >
          <!-- round13（用户拍板）：鼠标移到文件名上时右侧出现小箭头按钮，
               点击在访达中打开该文件（原左栏行尾按钮移来此处，行尾不再拥挤）。 -->
          <button
            v-if="!renaming && pathname"
            class="reveal-title-btn title-no-drag"
            :title="t('sideBar.tree.revealInFinder')"
            @click.stop="revealInFinder"
          >
            <mo-icon name="i-external" />
          </button>
          <template v-if="rightDocName">
            <span class="title-sep" aria-hidden="true">|</span>
            <span
              class="filename right-doc title-no-drag"
              :draggable="splitStore.active"
              :title="rightDocTitle"
              @dragstart="onRightDragStart"
              @dragend="onRightDragEnd"
              @click.stop="toggleCollapse"
              @dblclick.stop="renameRightDoc"
              >{{ rightDocName }}</span
            >
            <!-- round13（用户拍板）：右文档名 hover 也出小箭头——分屏双文档时
                 左右两个文件名各有一个「在访达中打开」箭头。 -->
            <button
              v-if="!renaming && rightDocPathname"
              class="reveal-title-btn title-no-drag"
              :title="t('sideBar.tree.revealInFinder')"
              @click.stop="revealRightDocInFinder"
            >
              <mo-icon name="i-external" />
            </button>
            <button
              class="right-doc-close title-no-drag"
              :title="t('sideBar.rightPanelCloseDoc')"
              @click.stop="closeRightDoc"
            >
              <mo-icon name="i-x" />
            </button>
          </template>
        </div>
        <div v-else class="title-brand">墨记</div>
      </div>

      <!-- round10：底部状态栏移除后，字数+保存状态放右上角（与顶栏同排）。
           数据跟随光标所在侧文档（app.vue 传 titleWordCount/titleSaved）。 -->
      <div v-if="titleWordCount" class="title-stats title-no-drag" :title="wcTooltip">
        <span class="save-state">
          <span class="dot" :class="{ show: !titleSaved }" />
          <span>{{ titleSaved ? t('statusBar.saved') : t('statusBar.unsaved') }}</span>
        </span>
        <button class="wc" @click.stop="cycle">{{ wcLabel }} {{ formatted }}</button>
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
import { useBrowserPanelStore } from '@/store/browserPanel'
import { ref, computed, watch, nextTick, onMounted, onBeforeUnmount } from 'vue'
import { storeToRefs } from 'pinia'
import { minimizePath, restorePath, maximizePath, closePath } from '../../assets/window-controls.js'
import { isOsx as isOsxPlatform } from '@/util'
import { shouldShowInAppTitleBar } from './visibility'
import { t } from '../../i18n'
import bus from '../../bus'
import MoIcon from '@/components/icons/MoIcon.vue'
import type { FileWordCount } from '@shared/types/files'

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
  // round10：底部状态栏已移除——字数/保存状态上移到顶栏右上角，
  // 数据源跟随光标所在侧（左侧文档 / 分屏右文档）由 app.vue 决定。
  titleWordCount?: FileWordCount | null
  titleSaved?: boolean
}>()

const preferencesStore = usePreferencesStore()
const editorStore = useEditorStore()
const splitStore = useSplitStore()
const bpStore = useBrowserPanelStore()

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
  // HTML 渲染页（编辑器内嵌 html「在侧栏打开」）：右文档名槽位显示页面标题。
  if (bpStore.htmlDoc) return bpStore.htmlDoc.title
  return ''
})

const rightDocTitle = computed(() => {
  if (splitStore.active) {
    const tab = editorStore.tabs.find((item) => item.id === splitStore.tabId)
    return tab?.pathname ?? rightDocName.value
  }
  if (bpStore.htmlDoc) return bpStore.htmlDoc.src
  return ''
})

// 右文档磁盘路径：小箭头按钮的显隐与「在访达中打开」参数。
const rightDocPathname = computed(() => {
  if (splitStore.active) {
    const tab = editorStore.tabs.find((item) => item.id === splitStore.tabId)
    return tab?.pathname ?? ''
  }
  return ''
})

// 顶栏右文档名拖回标签栏：标记内部拖放（app.vue 的 window dragover 据此放行），
// 高亮标签条/顶部行，drop 时按来源落地（drop 处理在 tabs.vue onReturnDrop）。
const onRightDragStart = (event: DragEvent) => {
  if (!rightDocName.value || !splitStore.active) return
  event.dataTransfer?.setData('application/x-momark-split-doc', rightDocName.value)
  window.__momarkReturnDrag = true
  bus.emit('split:return-drag-start')
}

const onRightDragEnd = () => {
  window.__momarkReturnDrag = false
  bus.emit('split:return-drag-end')
}

// × 关闭右栏：分屏 = 文档回左侧标签集合；HTML 渲染页 = 直接关掉整个
// 右侧栏（round26 用户拍板：不落「空白文档」态）。
const closeRightDoc = () => {
  if (bpStore.htmlDoc) {
    bpStore.CLOSE_HTML_DOC()
    bpStore.SET_OPEN(false)
    return
  }
  if (splitStore.active) {
    splitStore.RETURN_SPLIT_TO_TABS()
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

// —— round10 顶栏右上角字数/保存（原底部状态栏逻辑迁移）——
const WC_STATES = [
  { key: 'word', labelKey: 'statusBar.words' },
  { key: 'paragraph', labelKey: 'statusBar.paragraphs' },
  { key: 'character', labelKey: 'statusBar.characters' }
] as const

const wcIndex = ref(0)
const wcState = computed(() => WC_STATES[wcIndex.value]!)
const wcLabel = computed(() => t(wcState.value.labelKey))
const formatted = computed(() => {
  const value = props.titleWordCount?.[wcState.value.key] ?? 0
  return Number(value).toLocaleString('en-US')
})
const cycle = () => {
  wcIndex.value = (wcIndex.value + 1) % WC_STATES.length
}
const wcTooltip = computed(() => {
  const { word, paragraph, character } = props.titleWordCount ?? {
    word: 0,
    paragraph: 0,
    character: 0
  }
  return `${t('statusBar.words')} ${Number(word).toLocaleString('en-US')} · ${t('statusBar.paragraphs')} ${Number(paragraph).toLocaleString('en-US')} · ${t('statusBar.characters')} ${Number(character).toLocaleString('en-US')}`
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

// round13（用户拍板）：双击标题就地重命名。
// 已保存文档（有 pathname）→ 标题位置直接变输入框，回车/失焦提交
// editorStore.RENAME（主进程 fs.rename + mt::set-pathname 回填）；
// untitled 保持旧行为（RESPONSE_FOR_RENAME = 保存即命名）。
const renaming = ref(false)
const renameDraft = ref('')
const renameInputRef = ref<HTMLInputElement | null>(null)

const baseNameWithoutExt = (name: string): string => {
  const i = name.lastIndexOf('.')
  return i > 0 ? name.slice(0, i) : name
}

const startRename = () => {
  if (props.platform !== 'darwin') return
  if (!props.pathname) {
    rename()
    return
  }
  renameDraft.value = baseNameWithoutExt(props.filename ?? '')
  renaming.value = true
  nextTick(() => {
    const el = renameInputRef.value
    el?.focus()
    el?.select()
  })
}

const commitRename = () => {
  if (!renaming.value) return
  renaming.value = false
  const name = renameDraft.value.trim()
  if (!name || !props.filename) return
  const oldBase = baseNameWithoutExt(props.filename)
  if (name === oldBase) return
  const ext = props.filename.slice(oldBase.length)
  // 输入含扩展名（如 a.md）→ 视为完整文件名（允许改扩展名）；
  // 只输入主名 → 拼回原扩展名。
  const full = name.includes('.') ? name : name + ext
  editorStore.RENAME(full)
}

const cancelRename = () => {
  renaming.value = false
}

// round13（用户拍板）：顶栏文件名 hover 的小箭头——在访达中打开并高亮。
const revealInFinder = () => {
  if (props.pathname) {
    window.electron.shell.showItemInFolder(props.pathname)
  }
}

// 右文档名的同名箭头（分屏双文档时两侧各自可用）。
const revealRightDocInFinder = () => {
  if (rightDocPathname.value) {
    window.electron.shell.showItemInFolder(rightDocPathname.value)
  }
}

// round11（用户反馈）：双击右侧文档名同样发出重命名（竖线两侧都有效）。
// 复用 RENAME_FILE（= 标签栏右键重命名口径：激活该文档后弹重命名框）。
const renameRightDoc = () => {
  if (props.platform !== 'darwin' || !splitStore.active) return
  const tab = editorStore.tabs.find((item) => item.id === splitStore.tabId)
  if (tab) {
    editorStore.RENAME_FILE(tab)
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
  /* round11：去掉左 148/右 296 的不对称 padding——那是「居中标题不压两侧」
     的旧做法，但两侧避让不等导致「文件A | 文件B」整体偏左（用户反馈
     「根本没居中，是歪的」）。改为全宽 flex 居中 + .title-path 对称收缩。 */
  padding: 0;
  overflow: hidden;
}

.title-path {
  display: flex;
  align-items: center;
  gap: 8px;
  /* 左右各避让 210px：左=macOS 红绿灯+余量，右=title-stats 保存态+字数。
     两侧对称 → 标题盒子的几何中心 = 窗口中心，短标题完美居中、长标题
     从中心向两侧收缩（省略号），不再偏左。 */
  max-width: calc(100% - 420px);
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

/* round13（用户拍板）：文件名 hover 出现的小箭头按钮——在访达中打开 */
.reveal-title-btn {
  flex: none;
  width: 18px;
  height: 18px;
  margin-left: 6px;
  border: none;
  border-radius: 5px;
  background: transparent;
  color: var(--muted);
  display: grid;
  place-items: center;
  cursor: pointer;
  opacity: 0;
  transition:
    opacity 0.15s ease,
    background 0.15s ease,
    color 0.15s ease;
}
.title-path:hover .reveal-title-btn {
  opacity: 1;
}
.reveal-title-btn:hover {
  background: var(--hover);
  color: var(--accent);
}
.reveal-title-btn svg {
  width: 13px;
  height: 13px;
}

/* round13：就地重命名输入框——与标题同位、细描边、墨蓝 focus 环 */
.rename-input {
  width: 240px;
  height: 24px;
  padding: 0 8px;
  border: 1px solid var(--accent);
  border-radius: 6px;
  background: var(--surface-2);
  color: var(--ink);
  font-family: inherit;
  font-weight: 400;
  line-height: 22px;
  outline: none;
  box-shadow: 0 0 0 3px var(--accent-soft);
  margin-left: 2px;
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

/* round10 顶栏右上角：保存状态 + 字数按钮（原底部状态栏上移）。
   macOS 下 right-toolbar 不渲染，统计独占右上角；与居中标题同排不重叠
   （.title 的 padding-right 已避让）。 */
.title-stats {
  position: absolute;
  top: 0;
  right: 12px;
  height: 100%;
  display: flex;
  align-items: center;
  gap: 12px;
  font-size: var(--f11);
  line-height: 1.45;
  color: var(--muted);
  z-index: 3;
}
.title-stats .save-state {
  display: flex;
  align-items: center;
  gap: 6px;
}
.title-stats .save-state .dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--accent);
  opacity: 0;
  transition: opacity 0.2s ease;
}
.title-stats .save-state .dot.show {
  opacity: 1;
}
.title-stats .wc {
  background: none;
  border: none;
  color: var(--muted);
  font-size: var(--f11);
  cursor: pointer;
  padding: 2px 7px;
  border-radius: 6px;
  font-family: inherit;
  transition: all 0.15s ease;
}
.title-stats .wc:hover {
  background: var(--hover);
  color: var(--ink);
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
