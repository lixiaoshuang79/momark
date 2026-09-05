<template>
  <div class="editor-container">
    <div class="editor-middle">
      <title-bar
        :project="projectTree"
        :pathname="pathname"
        :filename="filename"
        :active="windowActive"
        :platform="platform"
        :is-saved="isSaved"
        :tab-count="titleTabCount"
      />

      <!-- 标签栏 + 面包屑：win-body 之上的全宽行（PHASE2-SPEC §1：
           标题栏 40px / 标签栏 40px（single 整行移除）/ 面包屑 28px）。
           唯一标签被拖出到分屏时 currentFile 为空，仍渲染面包屑行以保留
           bp-docname（拖回）与右栏开关。 -->
      <div v-if="(hasCurrentFile || splitActive) && init" class="editor-chrome">
        <editor-tabs v-if="tabbarVisible" />
        <crumbs />
      </div>

      <!-- 主体三栏：侧栏 / 编辑区列 / 分隔线 / 右侧浏览器面板
           （PHASE2-SPEC §1/§3：win-body 行从面包屑行之下开始） -->
      <div class="win-body" :class="winBodyClasses">
        <side-bar v-if="init" />

        <div class="editor-main-col">
          <div v-if="!init" class="editor-placeholder" />
          <recent v-if="!hasCurrentFile && init" />
          <editor-with-tabs
            v-if="hasCurrentFile && init"
            :markdown="markdown"
            :cursor="cursor"
            :muya-index-cursor="muyaIndexCursor"
            :source-code="sourceCode"
            :text-direction="textDirection"
            :platform="platform"
          />
          <status-bar v-if="hasCurrentFile && init" :word-count="wordCount" :is-saved="isSaved" />
        </div>

        <splitter v-if="showSplitter" />
        <split-drop-zone />
        <browser-panel />
      </div>

      <command-palette />
      <export-setting-dialog />
      <rename />
      <import-modal />
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, watch, nextTick, onMounted, ref } from 'vue'
import { useMainStore } from '@/store'
import { storeToRefs } from 'pinia'
import { addStyles, addThemeStyle, addCustomStyle, type AddStylesOptions } from '@/util/theme'
import Recent from '@/components/recent/index.vue'
import EditorWithTabs from '@/components/editorWithTabs/index.vue'
import EditorTabs from '@/components/editorWithTabs/tabs.vue'
import Crumbs from '@/components/crumbs/index.vue'
import TitleBar from '@/components/titleBar/index.vue'
import SideBar from '@/components/sideBar/index.vue'
import StatusBar from '@/components/statusBar/index.vue'
import CommandPalette from '@/components/commandPalette/index.vue'
import ExportSettingDialog from '@/components/exportSettings/index.vue'
import Rename from '@/components/rename/index.vue'
import ImportModal from '@/components/import/index.vue'
import BrowserPanel from '@/components/browserPanel/index.vue'
import Splitter from '@/components/splitter.vue'
import SplitDropZone from '@/components/splitDropZone.vue'
import bus from '@/bus'
import { DEFAULT_STYLE } from '@/config'
import { useLayoutStore } from '@/store/layout'
import { useListenForMainStore } from '@/store/listenForMain'
import { usePreferencesStore } from '@/store/preferences'
import { useEditorStore } from '@/store/editor'
import { useCommandCenterStore } from '@/store/commandCenter'
import { useProjectStore } from '@/store/project'
import { useNotificationStore } from '@/store/notification'
import { useBrowserPanelStore } from '@/store/browserPanel'
import { useSplitStore } from '@/store/split'
import { useWorkspaceStore } from '@/store/workspace'

const mainStore = useMainStore()
const editorStore = useEditorStore()
const preferencesStore = usePreferencesStore()
const layoutStore = useLayoutStore()
const projectStore = useProjectStore()
const listenForMainStore = useListenForMainStore()
const commandCenterStore = useCommandCenterStore()
const notificationStore = useNotificationStore()
const bpStore = useBrowserPanelStore()
const splitStore = useSplitStore()
const workspaceStore = useWorkspaceStore()

const timer = ref<ReturnType<typeof setTimeout> | null>(null)

const { windowActive, platform, init } = storeToRefs(mainStore)
const { sourceCode, theme, customCss, textDirection, zoom } = storeToRefs(preferencesStore)
const { projectTree } = storeToRefs(projectStore)
const { currentFile, tabs } = storeToRefs(editorStore)
const { open: bpanelOpen } = storeToRefs(bpStore)
const { active: splitActive, draggingSplit } = storeToRefs(splitStore)
const { scene, tabbarVisible } = storeToRefs(workspaceStore)

const pathname = computed(() => currentFile.value?.pathname)
const filename = computed(() => currentFile.value?.filename)
const isSaved = computed(() => currentFile.value?.isSaved)
// 标题区（PHASE2-SPEC §1/§10）：仅 single 场景显示状态点+完整路径；
// multi / split-* 场景标题区留空 —— 用 tabCount>1 的既有判定表达。
const titleTabCount = computed(() => (scene.value === 'single' ? tabs.value.length : 2))
// `markdown` is read by `<editor-with-tabs>` whose prop is `required: true`.
// In template space we render that subtree only when `hasCurrentFile` is set,
// but vue-tsc can't see through the v-if guard — coalesce to '' so the prop
// type is `string`. The `<editor-with-tabs>` mount is still gated.
const markdown = computed<string>(() => currentFile.value?.markdown ?? '')
const cursor = computed(() => currentFile.value?.cursor)
const wordCount = computed(() => currentFile.value?.wordCount)
// `muyaIndexCursor` is loosely typed as `unknown` on the editor store; the
// downstream prop expects `Object | undefined`. Cast at the boundary.
const muyaIndexCursor = computed<Record<string, unknown> | undefined>(
  () => currentFile.value?.muyaIndexCursor as Record<string, unknown> | undefined
)

const hasCurrentFile = computed<boolean>(() => {
  return currentFile.value?.markdown !== undefined
})

// win-body 状态类（PHASE2-SPEC §3/§5 / STATE-MACHINE）：
// .panel-open = 面板展开；.split = 分屏激活（左列 padding 收窄对齐）；
// .dragging-split = 分隔线拖动中（禁用面板宽度过渡 + 全局 col-resize）。
const winBodyClasses = computed(() => ({
  'panel-open': bpanelOpen.value,
  split: splitActive.value,
  'dragging-split': draggingSplit.value
}))

const showSplitter = computed(() => splitActive.value && bpanelOpen.value)

// Watchers
watch(theme, (value, oldValue) => {
  if (value !== oldValue) {
    addThemeStyle(value)
  }
})

watch(customCss, (value, oldValue) => {
  if (value !== oldValue) {
    addCustomStyle({
      customCss: value
    })
  }
})

watch(zoom, (zoomValue) => {
  bus.emit('mt::window-zoom', zoomValue)
})

const setupDragDropHandler = (): void => {
  window.addEventListener(
    'dragover',
    (e: DragEvent) => {
      if (!e.dataTransfer || !e.dataTransfer.types.length) return

      if (e.dataTransfer.types.indexOf('Files') >= 0) {
        if (
          e.dataTransfer.items.length === 1 &&
          e.dataTransfer.items[0]!.type.indexOf('image') > -1
        ) {
          // Do nothing
        } else {
          e.preventDefault()
          if (timer.value) {
            clearTimeout(timer.value)
          }
          timer.value = setTimeout(() => {
            bus.emit('importDialog', false)
          }, 300)
          bus.emit('importDialog', true)
        }
        e.dataTransfer.dropEffect = 'copy'
      } else if (e.dataTransfer.types.indexOf('text/uri-list') >= 0) {
        // A web-link / web-image drag (e.g. an <img> dragged from a browser).
        // The muya editor's own dragover/drop handlers accept these and insert
        // an image block, so leave the drop enabled — forcing dropEffect='none'
        // here would clobber the editor's 'copy' and suppress the drop event.
      } else if (window.__momarkReturnDrag) {
        // 分屏右侧文档标题拖回标签栏的内部拖放（PHASE2-SPEC §3.4）：
        // 放行，由 tabs.vue 的 dragover/drop 处理。
      } else {
        e.stopPropagation()
        e.dataTransfer.dropEffect = 'none'
      }
    },
    false
  )
}
onMounted(async () => {
  if (window.marktext?.initialState) {
    preferencesStore.SET_USER_PREFERENCE(window.marktext.initialState)
  }

  mainStore.LISTEN_WIN_STATUS()
  await commandCenterStore.LISTEN_COMMAND_CENTER_BUS()
  layoutStore.LISTEN_FOR_LAYOUT()
  listenForMainStore.LISTEN_FOR_EDIT()
  preferencesStore.LISTEN_FOR_VIEW()
  listenForMainStore.LISTEN_FOR_SHOW_DIALOG()
  listenForMainStore.LISTEN_FOR_PARAGRAPH_INLINE_STYLE()
  projectStore.LISTEN_FOR_UPDATE_PROJECT()
  projectStore.LISTEN_FOR_LOAD_PROJECT()
  projectStore.LISTEN_FOR_SIDEBAR_CONTEXT_MENU()
  preferencesStore.ASK_FOR_USER_PREFERENCE()
  preferencesStore.LISTEN_TOGGLE_VIEW()
  editorStore.LISTEN_SCREEN_SHOT()
  editorStore.LISTEN_FOR_CLOSE()
  editorStore.LISTEN_FOR_SAVE_AS()
  editorStore.LISTEN_FOR_MOVE_TO()
  editorStore.LISTEN_FOR_SAVE()
  editorStore.LISTEN_FOR_SET_PATHNAME()
  editorStore.LISTEN_FOR_BOOTSTRAP_WINDOW()
  editorStore.LISTEN_FOR_SAVE_CLOSE()
  editorStore.LISTEN_FOR_RENAME()
  editorStore.LISTEN_FOR_SET_LINE_ENDING()
  editorStore.LISTEN_FOR_SET_ENCODING()
  editorStore.LISTEN_FOR_SET_FINAL_NEWLINE()
  editorStore.LISTEN_FOR_NEW_TAB()
  editorStore.LISTEN_FOR_CLOSE_TAB()
  editorStore.LISTEN_FOR_TAB_CYCLE()
  editorStore.LISTEN_FOR_SWITCH_TABS()
  editorStore.LISTEN_FOR_PRINT_SERVICE_CLEARUP()
  editorStore.LISTEN_FOR_EXPORT_SUCCESS()
  editorStore.LISTEN_FOR_FILE_CHANGE()
  editorStore.LISTEN_WINDOW_ZOOM()
  editorStore.LISTEN_FOR_RELOAD_IMAGES()
  editorStore.LISTEN_FOR_CONTEXT_MENU()
  editorStore.LISTEN_FOR_STATE_REPLACE()

  // module: notification
  notificationStore.listenForNotification()

  setupDragDropHandler()

  nextTick(() => {
    // `initialState` from bootstrap carries nullable URL params (string|null);
    // `addStyles` requires non-null `theme` / `codeFontFamily` strings.
    // Coalesce against DEFAULT_STYLE for every nullable field.
    const init = window.marktext?.initialState
    const style: AddStylesOptions = {
      theme: init?.theme ?? DEFAULT_STYLE.theme,
      codeFontFamily: init?.codeFontFamily ?? DEFAULT_STYLE.codeFontFamily,
      codeFontSize: init?.codeFontSize ?? DEFAULT_STYLE.codeFontSize,
      hideScrollbar: init?.hideScrollbar ?? DEFAULT_STYLE.hideScrollbar
    }
    addStyles(style)
  })
})
</script>

<style scoped>
.editor-placeholder,
.editor-container {
  display: flex;
  flex-direction: row;
  position: absolute;
  width: 100vw;
  height: 100vh;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
}
.editor-container .hide {
  z-index: -1;
  opacity: 0;
  position: absolute;
  left: -10000px;
}
.editor-placeholder {
  background: var(--editorBgColor);
}
.editor-middle {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 100vh;
  position: relative;
  min-width: 0;
  & > .editor {
    flex: 1;
  }
}
/* 标签栏 + 面包屑全宽行（win-body 之上） */
.editor-chrome {
  flex: none;
  display: flex;
  flex-direction: column;
}
/* 主体三栏行：编辑区列 / 分隔线 / 右栏 */
.editor-main-col {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}
</style>
