<template>
  <!-- 文件夹抽屉：左侧边栏「文件」tab 的替代。临时浮层（不占布局、不遮挡时不存在），
       从标签栏左侧的文件夹按钮 / ⇧⌘E / 命令面板 / 菜单「视图 → 同目录文件」打开，
       列出当前文档所在目录的 Markdown 文件，可筛选、键盘上下选择、回车打开。 -->
  <Transition name="fd">
    <div
      v-if="open"
      ref="cardRef"
      class="folder-drawer"
      role="dialog"
      :aria-label="t('folderDrawer.title')"
      :style="{ top: `${anchor.top}px`, left: `${anchor.left}px` }"
      @keydown="onKeydown"
    >
      <div class="fd-head">
        <span class="fd-title">{{ t('folderDrawer.title') }}</span>
        <span v-if="dirLabel" class="fd-dir" :title="dir">{{ dirLabel }}</span>
      </div>
      <input
        v-if="dir"
        ref="filterRef"
        v-model="query"
        class="fd-filter"
        spellcheck="false"
        :placeholder="t('folderDrawer.filterPlaceholder')"
      />
      <div v-if="shown.length" ref="listRef" class="fd-list" role="listbox">
        <div
          v-for="(entry, i) of shown"
          :key="entry.pathname"
          class="fd-row"
          role="option"
          :aria-selected="i === cursor"
          :class="{ cur: i === cursor, sel: isCurrentFile(entry.pathname) }"
          :title="entry.pathname"
          @mousemove="cursor = i"
          @mousedown.prevent
          @click="openEntry(entry)"
        >
          <mo-icon name="i-file" />
          <span class="fd-name">{{ entry.name }}</span>
          <span v-if="isCurrentFile(entry.pathname)" class="fd-badge">{{
            t('folderDrawer.current')
          }}</span>
          <span v-else-if="isOpenTab(entry.pathname)" class="fd-dot" />
        </div>
      </div>
      <div v-else class="fd-empty">
        {{
          !dir
            ? t('folderDrawer.noFolder')
            : query
              ? t('folderDrawer.noMatch')
              : t('folderDrawer.noFiles')
        }}
      </div>
      <div class="fd-foot">
        <button class="fd-act" @mousedown.prevent @click="run('mt::cmd-open-file')">
          <mo-icon name="i-file" />{{ t('folderDrawer.openFile') }}
        </button>
        <button class="fd-act" @mousedown.prevent @click="run('mt::cmd-open-folder')">
          <mo-icon name="i-folder" />{{ t('folderDrawer.openFolder') }}
        </button>
        <button
          v-if="dir"
          class="fd-act icon"
          :title="t('sideBar.tree.revealInFinder')"
          @mousedown.prevent
          @click="reveal"
        >
          <mo-icon name="i-external" />
        </button>
      </div>
    </div>
  </Transition>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { storeToRefs } from 'pinia'
import MoIcon from '@/components/icons/MoIcon.vue'
import bus from '../../bus'
import { t } from '../../i18n'
import { useEditorStore } from '@/store/editor'
import { useLayoutStore } from '@/store/layout'
import { useProjectStore } from '@/store/project'
import {
  compactDirLabel,
  filterFolderEntries,
  resolveDrawerDir,
  toFolderEntries,
  type FolderEntry
} from './folderModel'

const editorStore = useEditorStore()
const layoutStore = useLayoutStore()
const projectStore = useProjectStore()
const { currentFile, tabs } = storeToRefs(editorStore)
const { folderDrawerOpen: open } = storeToRefs(layoutStore)
const { projectTree } = storeToRefs(projectStore)

const cardRef = ref<HTMLElement | null>(null)
const filterRef = ref<HTMLInputElement | null>(null)
const listRef = ref<HTMLElement | null>(null)
const query = ref('')
const cursor = ref(0)
const entries = ref<FolderEntry[]>([])
const anchor = ref({ top: 88, left: 10 })

const dir = computed(() =>
  resolveDrawerDir(
    currentFile.value?.pathname,
    (projectTree.value as { pathname?: string } | null)?.pathname,
    window.path.dirname
  )
)
const home = (): string | undefined =>
  window.electron?.process?.env?.HOME ??
  (window.marktext?.env as { HOME?: string } | undefined)?.HOME
const dirLabel = computed(() => compactDirLabel(dir.value, home(), window.path.sep))
const shown = computed(() => filterFolderEntries(entries.value, query.value))

const load = async (): Promise<void> => {
  const target = dir.value
  if (!target) {
    entries.value = []
    return
  }
  try {
    const names = (await window.fileUtils.readdir(target)) as string[]
    if (target !== dir.value) return
    entries.value = toFolderEntries(
      names,
      target,
      (name) => window.fileUtils.hasMarkdownExtension(name),
      window.path.join
    )
  } catch {
    entries.value = []
  }
}

const isCurrentFile = (pathname: string): boolean => {
  const file = currentFile.value
  return !!file?.pathname && window.fileUtils.isSamePathSync(file.pathname, pathname)
}
const isOpenTab = (pathname: string): boolean =>
  tabs.value.some(
    (tab) => !!tab.pathname && window.fileUtils.isSamePathSync(tab.pathname, pathname)
  )

const close = (): void => layoutStore.SET_FOLDER_DRAWER(false)

const openEntry = (entry: FolderEntry): void => {
  const opened = tabs.value.find(
    (tab) => !!tab.pathname && window.fileUtils.isSamePathSync(tab.pathname, entry.pathname)
  )
  if (opened) {
    if (!isCurrentFile(entry.pathname)) editorStore.UPDATE_CURRENT_FILE(opened)
  } else {
    window.electron.ipcRenderer.send('mt::open-file', entry.pathname, {})
  }
  close()
}

const run = (channel: 'mt::cmd-open-file' | 'mt::cmd-open-folder'): void => {
  close()
  window.electron.ipcRenderer.send(channel)
}

const reveal = (): void => {
  const target = currentFile.value?.pathname || dir.value
  if (target) window.electron.shell.showItemInFolder(target)
}

const placeAnchor = (): void => {
  const button = document.querySelector<HTMLElement>('.editor-tabs .tb-folder')
  if (button) {
    const rect = button.getBoundingClientRect()
    anchor.value = {
      top: Math.round(rect.bottom + 6),
      left: Math.max(8, Math.round(rect.left - 4))
    }
  } else {
    const tabsRow = document.querySelector<HTMLElement>('.editor-chrome')
    const top = tabsRow ? tabsRow.getBoundingClientRect().bottom : 48
    anchor.value = { top: Math.round(top + 6), left: 10 }
  }
}

const scrollCursorIntoView = (): void => {
  nextTick(() => {
    const rows = listRef.value?.querySelectorAll<HTMLElement>('.fd-row')
    rows?.item(cursor.value)?.scrollIntoView({ block: 'nearest' })
  })
}

const onKeydown = (event: KeyboardEvent): void => {
  const count = shown.value.length
  if (event.key === 'Escape') {
    event.preventDefault()
    close()
    bus.emit('editor-focus')
    return
  }
  if (!count) return
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault()
    const step = event.key === 'ArrowDown' ? 1 : -1
    cursor.value = (cursor.value + step + count) % count
    scrollCursorIntoView()
  } else if (event.key === 'Enter' && !event.isComposing) {
    event.preventDefault()
    const entry = shown.value[cursor.value]
    if (entry) openEntry(entry)
  }
}

const onOutsidePointer = (event: PointerEvent): void => {
  const target = event.target as Node | null
  if (!open.value || !target) return
  if (cardRef.value?.contains(target)) return
  // 点抽屉按钮本身由按钮的 toggle 处理，这里不重复关。
  if ((target as Element).closest?.('.tb-folder')) return
  close()
}

watch(open, async (isOpen) => {
  if (!isOpen) return
  query.value = ''
  placeAnchor()
  await load()
  const current = shown.value.findIndex((entry) => isCurrentFile(entry.pathname))
  cursor.value = Math.max(0, current)
  await nextTick()
  filterRef.value?.focus()
  scrollCursorIntoView()
})
watch(dir, () => {
  if (open.value) load().catch(() => {})
})
watch(query, () => {
  cursor.value = 0
})

// 只打开了文件夹、没有已保存的文档在显示时（欢迎页 / 空白标签），左侧边栏移除后
// 打开文件夹就看不到任何东西——这时自动把抽屉打开，列出这个文件夹里的文档。
// 带文档启动（文件所在目录也会作为项目打开）不打扰。
let projectOpenTimer: ReturnType<typeof setTimeout> | null = null
watch(
  () => (projectTree.value as { pathname?: string } | null)?.pathname ?? '',
  (root, prev) => {
    if (!root || root === prev) return
    if (projectOpenTimer) clearTimeout(projectOpenTimer)
    projectOpenTimer = setTimeout(() => {
      projectOpenTimer = null
      if (!currentFile.value?.pathname) layoutStore.SET_FOLDER_DRAWER(true)
    }, 600)
  }
)

const onFindInFolder = (): void => {
  nextTick(() => filterRef.value?.focus())
}

onMounted(() => {
  window.addEventListener('pointerdown', onOutsidePointer, true)
  bus.on('findInFolder', onFindInFolder)
})
onBeforeUnmount(() => {
  window.removeEventListener('pointerdown', onOutsidePointer, true)
  bus.off('findInFolder', onFindInFolder)
  if (projectOpenTimer) clearTimeout(projectOpenTimer)
})
</script>

<style scoped>
.folder-drawer {
  position: fixed;
  z-index: 60;
  width: 300px;
  max-width: calc(100vw - 20px);
  max-height: min(520px, calc(100vh - 120px));
  display: flex;
  flex-direction: column;
  box-sizing: border-box;
  padding: 10px 8px 8px;
  border-radius: 13px;
  background: var(--surface-2);
  border: 0.5px solid rgba(11, 11, 11, 0.13);
  box-shadow:
    0 2px 8px rgba(0, 0, 0, 0.08),
    0 12px 32px rgba(0, 0, 0, 0.08);
  color: var(--ink);
  user-select: none;
  transform-origin: 16px 0;
}
[data-theme='dark'] .folder-drawer {
  background: var(--surface-1);
  border: 0.5px solid rgba(255, 255, 255, 0.08);
  box-shadow: 0 8px 28px rgba(0, 0, 0, 0.45);
}

.fd-head {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 0 8px 8px;
  min-width: 0;
}
.fd-title {
  flex: none;
  font-size: var(--f12, 12px);
  font-weight: 600;
}
.fd-dir {
  min-width: 0;
  font-size: var(--f11, 11px);
  color: var(--faint);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.fd-filter {
  flex: none;
  margin: 0 4px 6px;
  height: 30px;
  padding: 0 10px;
  border-radius: 8px;
  border: none;
  outline: none;
  background: var(--hover);
  color: var(--ink);
  font-size: var(--f12, 12px);
  box-shadow: 0 0 0 1px transparent;
  transition: box-shadow 0.15s ease;
}
.fd-filter:focus {
  box-shadow: var(--focus-ring);
}
.fd-filter::placeholder {
  color: var(--faint);
}

.fd-list {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  padding: 0 0 4px;
}
.fd-row {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 32px;
  padding: 0 8px;
  border-radius: 8px;
  font-size: var(--f12, 12px);
  cursor: pointer;
  transition: background-color 0.12s ease;
}
.fd-row svg {
  width: 15px;
  height: 15px;
  color: var(--muted);
  flex: none;
}
.fd-row.cur {
  background: var(--hover);
}
.fd-row.sel {
  background: var(--selected);
}
.fd-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.fd-badge {
  flex: none;
  font-size: 11px;
  font-weight: 600;
  color: var(--accent);
}
.fd-dot {
  flex: none;
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--faint);
}

.fd-empty {
  padding: 14px 8px;
  font-size: var(--f11, 11px);
  color: var(--faint);
}

.fd-foot {
  flex: none;
  display: flex;
  gap: 4px;
  padding: 6px 2px 0;
  margin-top: 2px;
  border-top: 0.5px solid var(--line);
}
.fd-act {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 28px;
  padding: 0 8px;
  border: none;
  border-radius: 7px;
  background: transparent;
  color: var(--muted);
  font-size: var(--f11, 11px);
  cursor: pointer;
  transition:
    background-color 0.15s ease,
    color 0.15s ease;
}
.fd-act:hover {
  background: var(--hover);
  color: var(--ink);
}
.fd-act.icon {
  margin-left: auto;
  padding: 0 7px;
}
.fd-act svg {
  width: 13px;
  height: 13px;
}

.fd-enter-active {
  transition:
    opacity 0.18s ease,
    transform 0.32s var(--ease-panel);
}
.fd-leave-active {
  transition:
    opacity 0.12s ease,
    transform 0.16s ease;
}
.fd-enter-from,
.fd-leave-to {
  opacity: 0;
  transform: translateY(-6px) scale(0.97);
}
@media (prefers-reduced-motion: reduce) {
  .fd-enter-active,
  .fd-leave-active {
    transition: opacity 0.01s linear;
  }
  .fd-enter-from,
  .fd-leave-to {
    transform: none;
  }
}
</style>
