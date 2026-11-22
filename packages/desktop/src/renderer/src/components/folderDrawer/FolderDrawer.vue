<template>
  <!-- 文件夹抽屉：左侧边栏「文件」tab 的替代。临时浮层（不占布局、不遮挡时不存在），
       从标签栏左侧的文件夹按钮 / ⇧⌘E / 命令面板 / 菜单「视图 → 同目录文件」打开。
       feat/right-panel-redesign（DESIGN-NOTES §2）：同时列 Markdown 与 HTML、类型
       chip 筛选、按名称/修改时间排序、当前/已打开状态、行内「在右侧打开 / 在
       Finder 中显示」；底部主按钮「在 Finder 中打开」（选中当前文件）、次按钮
       「打开其他… ⌘O」（系统打开面板从当前目录开始）。 -->
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

      <div v-if="dir" class="fd-filter">
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <path v-for="d of ICONS.search" :key="d" :d="d" />
        </svg>
        <input
          ref="filterRef"
          v-model="query"
          spellcheck="false"
          role="combobox"
          aria-autocomplete="list"
          :aria-expanded="true"
          :aria-controls="listId"
          :aria-activedescendant="shown.length ? `${listId}-${cursor}` : undefined"
          :placeholder="t('folderDrawer.filterPlaceholder')"
        />
        <button
          v-if="query"
          class="fd-clr"
          :title="t('folderDrawer.clearFilter')"
          @mousedown.prevent
          @click="clearFilter"
        >
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <path v-for="d of ICONS.x" :key="d" :d="d" />
          </svg>
        </button>
      </div>

      <div v-if="dir && entries.length" class="fd-chips" role="radiogroup">
        <button
          v-for="chip of chips"
          :key="chip.id"
          class="fd-chip"
          role="radio"
          :aria-checked="typeFilter === chip.id"
          @mousedown.prevent
          @click="typeFilter = chip.id"
        >
          {{ chip.label }} <b>{{ chip.count }}</b>
        </button>
        <button
          class="fd-sort"
          :class="{ on: sort === 'mtime' }"
          :title="sort === 'name' ? t('folderDrawer.sortByName') : t('folderDrawer.sortByMtime')"
          :aria-pressed="sort === 'mtime'"
          @mousedown.prevent
          @click="toggleSort"
        >
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <path v-for="d of ICONS.sort" :key="d" :d="d" />
          </svg>
        </button>
      </div>

      <div v-if="shown.length" :id="listId" ref="listRef" class="fd-list" role="listbox">
        <div
          v-for="(entry, i) of shown"
          :id="`${listId}-${i}`"
          :key="entry.pathname"
          class="fd-row"
          role="option"
          :aria-selected="i === cursor"
          :class="{
            cur: i === cursor,
            sel: isCurrentFile(entry.pathname),
            html: entry.kind === 'html'
          }"
          :title="entry.pathname"
          @mousemove="cursor = i"
          @mousedown.prevent
          @click="openEntry(entry)"
        >
          <svg class="fd-ic" viewBox="0 0 16 16" aria-hidden="true">
            <path v-for="d of ICONS[entry.kind]" :key="d" :d="d" />
          </svg>
          <span class="fd-name">
            <template v-for="(part, pi) of nameParts(entry).stem" :key="`s${pi}`">
              <em v-if="part.hit">{{ part.text }}</em>
              <template v-else>{{ part.text }}</template>
            </template>
            <span class="fd-ext">
              <template v-for="(part, pi) of nameParts(entry).ext" :key="`e${pi}`">
                <em v-if="part.hit">{{ part.text }}</em>
                <template v-else>{{ part.text }}</template>
              </template>
            </span>
          </span>
          <span class="fd-meta" :class="{ 'hide-on-cur': !isCurrentFile(entry.pathname) }">
            <span v-if="isCurrentFile(entry.pathname)" class="fd-badge">{{
              t('folderDrawer.current')
            }}</span>
            <template v-else-if="isOpenTab(entry.pathname)">
              <i class="fd-dot" />{{ t('folderDrawer.opened') }}
            </template>
            <template v-else-if="sort === 'mtime'">{{ formatMtime(entry.mtime) }}</template>
            <span v-if="entry.kind === 'html' && !isOpenTab(entry.pathname) && sort !== 'mtime'">{{
              t('folderDrawer.readOnly')
            }}</span>
          </span>
          <span class="fd-acts">
            <button
              tabindex="-1"
              :title="t('folderDrawer.openInSplit') + ' ⌘↩'"
              @mousedown.prevent
              @click.stop="openInSplit(entry)"
            >
              <svg viewBox="0 0 16 16" aria-hidden="true">
                <path v-for="d of ICONS.split" :key="d" :d="d" />
              </svg>
            </button>
            <button
              tabindex="-1"
              :title="t('folderDrawer.revealItem') + ' ⌥↩'"
              @mousedown.prevent
              @click.stop="revealEntry(entry)"
            >
              <svg viewBox="0 0 16 16" aria-hidden="true">
                <path v-for="d of ICONS.reveal" :key="d" :d="d" />
              </svg>
            </button>
          </span>
        </div>
      </div>
      <div v-else class="fd-empty">
        <template v-if="!dir">
          {{ t('folderDrawer.noFolder') }}
          <small>{{ t('folderDrawer.noFolderHint') }}</small>
          <button class="fd-btn" @mousedown.prevent @click="saveCurrent">
            {{ t('folderDrawer.save') }} <kbd>{{ shortcut('S') }}</kbd>
          </button>
        </template>
        <template v-else-if="!entries.length">
          {{ t('folderDrawer.noFiles') }}
          <button class="fd-btn" @mousedown.prevent @click="openInFinder">
            {{ t('folderDrawer.openInFinder') }}
          </button>
        </template>
        <template v-else>
          {{ t('folderDrawer.noMatchQuery', { query: query.trim() }) }}
          <button class="fd-btn" @mousedown.prevent @click="clearFilter">
            {{ t('folderDrawer.clearFilter') }}
          </button>
        </template>
      </div>

      <div v-if="shown.length" class="fd-keys" aria-hidden="true">
        <span><kbd>↩</kbd> {{ t('folderDrawer.keyOpen') }}</span>
        <span
          ><kbd>{{ shortcut('↩') }}</kbd> {{ t('folderDrawer.openInSplit') }}</span
        >
        <span
          ><kbd>{{ isOsx ? '⌥↩' : 'Alt+↩' }}</kbd> {{ t('folderDrawer.revealItem') }}</span
        >
      </div>

      <div class="fd-foot">
        <button
          v-if="dir"
          class="fd-act main"
          :title="t('folderDrawer.openInFinderTitle')"
          @mousedown.prevent
          @click="openInFinder"
        >
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <path v-for="d of ICONS.finder" :key="d" :d="d" />
          </svg>
          {{ t('folderDrawer.openInFinder') }}
        </button>
        <button class="fd-act" @mousedown.prevent @click="openOther">
          {{ t('folderDrawer.openOther') }} <kbd>{{ shortcut('O') }}</kbd>
        </button>
      </div>
    </div>
  </Transition>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { storeToRefs } from 'pinia'
import bus from '../../bus'
import { t } from '../../i18n'
import { isOsx } from '@/util'
import { useEditorStore } from '@/store/editor'
import { useLayoutStore } from '@/store/layout'
import { useProjectStore } from '@/store/project'
import { openPathInSplit } from '@/components/browserPanel/openInSplit'
import {
  compactDirLabel,
  countByKind,
  filterByKind,
  filterFolderEntries,
  folderEntryKind,
  formatMtime,
  resolveDrawerDir,
  sortFolderEntries,
  splitName,
  toFolderEntries,
  type FolderEntry,
  type FolderSort,
  type FolderTypeFilter
} from './folderModel'

// 抽屉内的线性图标（16 网格、1.35 描边，与既有图标同规格；图标资产冻结，就地内联）
const ICONS = {
  md: ['M4 2h5l3 3v9H4z', 'M9 2v3h3', 'M6 8.5h4M6 11h3'],
  html: ['M4 2h5l3 3v9H4z', 'M9 2v3h3', 'M6.8 8.6 5.6 10l1.2 1.4M9.2 8.6l1.2 1.4-1.2 1.4'],
  search: ['M11.2 7a4.2 4.2 0 1 1-8.4 0 4.2 4.2 0 0 1 8.4 0z', 'M10.2 10.2 13.5 13.5'],
  x: ['M4.5 4.5l7 7M11.5 4.5l-7 7'],
  sort: ['M5 3v10M3 11l2 2 2-2M11 13V3M9 5l2-2 2 2'],
  split: ['M4 3h8a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z', 'M8.5 3v10'],
  reveal: [
    'M9 2.5h4.5V7M13.5 2.5 8 8',
    'M12 9.5v2.8c0 .7-.5 1.2-1.2 1.2H3.7c-.7 0-1.2-.5-1.2-1.2V5.2c0-.7.5-1.2 1.2-1.2h2.8'
  ],
  finder: [
    'M2 4.5c0-.8.7-1.5 1.5-1.5h2.8l1.4 1.5h4.8c.8 0 1.5.7 1.5 1.5v5.5c0 .8-.7 1.5-1.5 1.5h-9c-.8 0-1.5-.7-1.5-1.5z',
    'M7 10.5l3-3M7.6 7.5H10v2.4'
  ]
} as const

const listId = 'fd-list'

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
const typeFilter = ref<FolderTypeFilter>('all')
// 排序方式在会话内记住（刚导出的 HTML 原型按时间排更好找）
const sort = ref<FolderSort>('name')
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

const counts = computed(() => countByKind(entries.value))
const chips = computed<Array<{ id: FolderTypeFilter; label: string; count: number }>>(() => [
  { id: 'all', label: t('folderDrawer.typeAll'), count: counts.value.all },
  { id: 'md', label: 'Markdown', count: counts.value.md },
  { id: 'html', label: 'HTML', count: counts.value.html }
])
const shown = computed(() =>
  filterFolderEntries(
    sortFolderEntries(filterByKind(entries.value, typeFilter.value), sort.value),
    query.value
  )
)
const nameParts = (entry: FolderEntry) => splitName(entry.name, query.value)

const shortcut = (key: string): string => (isOsx ? `⌘${key}` : `Ctrl+${key}`)

const statMtimes = async (target: string, names: string[]): Promise<Map<string, number>> => {
  const out = new Map<string, number>()
  await Promise.all(
    names.map(async (name) => {
      try {
        const st = (await window.fileUtils.stat(window.path.join(target, name))) as {
          mtimeMs?: number
        }
        if (typeof st?.mtimeMs === 'number') out.set(name, st.mtimeMs)
      } catch {
        // 读不到修改时间：按 0 处理，排序沉底
      }
    })
  )
  return out
}

const load = async (): Promise<void> => {
  const target = dir.value
  if (!target) {
    entries.value = []
    return
  }
  try {
    const names = (await window.fileUtils.readdir(target)) as string[]
    const isMarkdown = (name: string): boolean => window.fileUtils.hasMarkdownExtension(name)
    const listed = names.filter((name) => folderEntryKind(name, isMarkdown))
    const mtimes = await statMtimes(target, listed)
    if (target !== dir.value) return
    entries.value = toFolderEntries(listed, target, isMarkdown, window.path.join, mtimes)
  } catch {
    entries.value = []
  }
}

const isCurrentFile = (pathname: string): boolean => {
  const file = currentFile.value
  return !!file?.pathname && window.fileUtils.isSamePathSync(file.pathname, pathname)
}
const findOpenTab = (pathname: string) =>
  tabs.value.find(
    (tab) => !!tab.pathname && window.fileUtils.isSamePathSync(tab.pathname, pathname)
  )
const isOpenTab = (pathname: string): boolean => !!findOpenTab(pathname)

const folderButton = (): HTMLElement | null =>
  document.querySelector<HTMLElement>('.editor-tabs .tb-folder')

const close = (): void => layoutStore.SET_FOLDER_DRAWER(false)

// 已在其他标签打开：切到那个标签，不重复打开。
const openEntry = (entry: FolderEntry): void => {
  const opened = findOpenTab(entry.pathname)
  if (opened) {
    if (!isCurrentFile(entry.pathname)) editorStore.UPDATE_CURRENT_FILE(opened)
  } else {
    window.electron.ipcRenderer.send('mt::open-file', entry.pathname, {})
  }
  close()
}

const openInSplit = (entry: FolderEntry): void => {
  close()
  openPathInSplit(entry.pathname).catch(() => {})
}

const revealEntry = (entry: FolderEntry): void => {
  window.electron.shell.showItemInFolder(entry.pathname)
}

// 「在 Finder 中打开」：打开这个文件夹并选中当前文件；没有当前文件（只开了
// 文件夹）就直接打开文件夹本身。都走主进程 IPC。
const openInFinder = (): void => {
  const file = currentFile.value?.pathname
  if (file && window.fileUtils.isSamePathSync(window.path.dirname(file), dir.value)) {
    window.electron.shell.showItemInFolder(file)
  } else if (dir.value) {
    window.electron.shell.openPath(dir.value)
  }
  close()
}

// 「打开其他… ⌘O」：系统打开面板从当前目录开始，只能选 Markdown / HTML。
const openOther = (): void => {
  close()
  window.electron.ipcRenderer.send(
    'mt::cmd-open-file',
    dir.value ? { defaultPath: dir.value } : undefined
  )
}

const saveCurrent = (): void => {
  close()
  bus.emit('mt::editor-ask-file-save')
}

const clearFilter = (): void => {
  query.value = ''
  typeFilter.value = 'all'
  nextTick(() => filterRef.value?.focus())
}

const toggleSort = (): void => {
  sort.value = sort.value === 'name' ? 'mtime' : 'name'
}

const placeAnchor = (): void => {
  const button = folderButton()
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
    // 焦点还给文件夹按钮（DESIGN-NOTES §2 键盘）
    const button = folderButton()
    if (button) button.focus()
    else bus.emit('editor-focus')
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
    if (!entry) return
    if (event.metaKey || event.ctrlKey) openInSplit(entry)
    else if (event.altKey) revealEntry(entry)
    else openEntry(entry)
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
  typeFilter.value = 'all'
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
watch([query, typeFilter, sort], () => {
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
  width: 348px;
  max-width: calc(100vw - 20px);
  max-height: min(560px, calc(100vh - 120px));
  display: flex;
  flex-direction: column;
  box-sizing: border-box;
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
svg {
  width: 14px;
  height: 14px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.35;
  stroke-linecap: round;
  stroke-linejoin: round;
  flex: none;
}

.fd-head {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 10px 14px 8px;
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
  position: relative;
  margin: 0 10px;
}
.fd-filter > svg {
  position: absolute;
  left: 9px;
  top: 8px;
  color: var(--faint);
}
.fd-filter input {
  width: 100%;
  box-sizing: border-box;
  height: 30px;
  padding: 0 30px;
  border-radius: 8px;
  border: none;
  outline: none;
  background: var(--hover);
  color: var(--ink);
  font-size: var(--f12, 12px);
  transition:
    box-shadow 0.15s ease,
    background-color 0.15s ease;
}
.fd-filter input:focus {
  background: var(--surface-2);
  box-shadow:
    0 0 0 1px var(--accent),
    var(--focus-ring);
}
.fd-filter input::placeholder {
  color: var(--faint);
}
.fd-clr {
  position: absolute;
  right: 4px;
  top: 3px;
  width: 24px;
  height: 24px;
  display: grid;
  place-items: center;
  border: none;
  border-radius: 6px;
  background: none;
  color: var(--faint);
}
.fd-clr:hover {
  background: var(--selected);
  color: var(--ink);
}

.fd-chips {
  flex: none;
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 8px 10px 4px;
}
.fd-chip {
  height: 22px;
  padding: 0 8px;
  border-radius: 11px;
  border: none;
  background: transparent;
  box-shadow: inset 0 0 0 0.5px var(--line-strong);
  font-size: 11.5px;
  color: var(--muted);
  display: inline-flex;
  align-items: center;
  gap: 5px;
  transition:
    background-color 0.15s ease,
    color 0.15s ease,
    transform 0.1s ease;
}
.fd-chip:hover {
  color: var(--ink);
  background: var(--hover);
}
.fd-chip:active {
  transform: scale(0.96);
}
.fd-chip[aria-checked='true'] {
  background: var(--ink);
  color: var(--bg);
  box-shadow: none;
}
.fd-chip b {
  font: 500 10px var(--font-mono);
  opacity: 0.7;
}
.fd-sort {
  margin-left: auto;
  width: 22px;
  height: 22px;
  display: grid;
  place-items: center;
  border: none;
  border-radius: 6px;
  background: none;
  color: var(--muted);
}
.fd-sort:hover {
  background: var(--hover);
  color: var(--ink);
}
.fd-sort.on {
  color: var(--accent);
  background: color-mix(in oklab, var(--accent) 12%, transparent);
}

.fd-list {
  flex: 1 1 auto;
  min-height: 60px;
  overflow-y: auto;
  padding: 4px 6px 6px;
}
.fd-row {
  position: relative;
  display: flex;
  align-items: center;
  gap: 8px;
  height: 32px;
  padding: 0 6px 0 10px;
  border-radius: 7px;
  font-size: var(--f12, 12px);
  cursor: pointer;
  transition: background-color 0.12s ease;
}
.fd-row.cur {
  background: var(--hover);
}
.fd-row.sel::before {
  content: '';
  position: absolute;
  left: 2px;
  top: 8px;
  bottom: 8px;
  width: 2.5px;
  border-radius: 2px;
  background: var(--accent);
}
.fd-ic {
  color: var(--muted);
}
.fd-row.html .fd-ic {
  color: var(--faint);
}
.fd-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.fd-ext {
  color: var(--faint);
}
.fd-name em {
  font-style: normal;
  border-radius: 2px;
  background: color-mix(in oklab, var(--accent) 16%, transparent);
  box-shadow: inset 0 -1px 0 color-mix(in oklab, var(--accent) 50%, transparent);
}
.fd-meta {
  flex: none;
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 11px;
  color: var(--faint);
  white-space: nowrap;
}
.fd-row.cur .fd-meta.hide-on-cur {
  display: none;
}
.fd-badge {
  font-size: 10.5px;
  padding: 1px 6px;
  border-radius: 9px;
  background: color-mix(in oklab, var(--accent) 12%, transparent);
  color: var(--accent);
}
.fd-dot {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--muted);
}
.fd-acts {
  display: none;
}
.fd-row.cur .fd-acts {
  display: flex;
}
.fd-acts button {
  width: 24px;
  height: 24px;
  display: grid;
  place-items: center;
  border: none;
  border-radius: 6px;
  background: none;
  color: var(--muted);
  transition:
    background-color 0.15s ease,
    color 0.15s ease,
    transform 0.1s ease;
}
.fd-acts button:hover {
  background: var(--selected);
  color: var(--ink);
}
.fd-acts button:active {
  transform: scale(0.92);
}

.fd-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  padding: 22px 16px;
  text-align: center;
  font-size: var(--f12, 12px);
  line-height: 1.6;
  color: var(--faint);
}
.fd-empty small {
  font-size: 11.5px;
}
.fd-btn {
  margin-top: 8px;
  height: 26px;
  padding: 0 10px;
  border-radius: 8px;
  border: none;
  background: var(--surface-2);
  box-shadow:
    0 0 0 0.5px var(--line-strong),
    0 1px 2px rgba(0, 0, 0, 0.05);
  color: var(--ink);
  font-size: 12px;
}
.fd-btn:hover {
  background: var(--hover);
}

kbd {
  font: 500 10px var(--font-mono);
  color: var(--faint);
  margin-left: 2px;
}
.fd-keys {
  flex: none;
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  padding: 6px 14px;
  font-size: 10.5px;
  color: var(--faint);
  border-top: 0.5px solid var(--line);
}
.fd-keys kbd {
  margin: 0 2px 0 0;
}

.fd-foot {
  flex: none;
  display: flex;
  gap: 6px;
  padding: 8px 10px 10px;
}
.fd-act {
  flex: 1;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  height: 30px;
  padding: 0 10px;
  border: none;
  border-radius: 8px;
  background: var(--surface-2);
  box-shadow:
    0 0 0 0.5px var(--line-strong),
    0 1px 2px rgba(0, 0, 0, 0.05);
  color: var(--ink);
  font-size: var(--f12, 12px);
  white-space: nowrap;
  cursor: pointer;
  transition:
    background-color 0.15s ease,
    transform 0.1s ease;
}
.fd-act.main {
  flex: 1.25;
}
.fd-act:hover {
  background: var(--hover);
}
.fd-act:active {
  transform: scale(0.98);
}
[data-theme='dark'] .fd-act,
[data-theme='dark'] .fd-btn {
  background: var(--surface-2);
}
button:focus-visible {
  outline: none;
  box-shadow: var(--focus-ring);
}

.fd-enter-active {
  transition:
    opacity 0.18s ease,
    transform 0.18s cubic-bezier(0.2, 0, 0, 1);
}
.fd-leave-active {
  transition:
    opacity 0.12s ease,
    transform 0.16s ease;
}
.fd-enter-from,
.fd-leave-to {
  opacity: 0;
  transform: translateY(-4px) scale(0.96);
}
@media (prefers-reduced-motion: reduce) {
  .fd-enter-active,
  .fd-leave-active {
    transition: opacity 0.1s linear;
  }
  .fd-enter-from,
  .fd-leave-to {
    transform: none;
  }
}
</style>
