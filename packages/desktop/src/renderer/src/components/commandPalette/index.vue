<template>
  <transition name="palette-fade">
    <div v-if="showCommandPalette" class="command-palette-overlay" @mousedown.self="closePalette">
      <div class="palette-panel" role="dialog" aria-modal="true">
        <div class="input-row">
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <circle cx="11" cy="11" r="8" />
            <path d="m21 21-4.35-4.35" />
          </svg>
          <input
            ref="searchInput"
            v-model="query"
            type="text"
            class="search"
            :placeholder="placeholderText"
            @input="updateCommands"
            @keydown="handleKeydown"
          />
          <span class="kbdhint">Esc</span>
        </div>
        <div ref="listEl" class="list">
          <!-- 下钻子命令（更换主题 / 缩放 / 文字方向） -->
          <template v-if="drill">
            <div class="group-head">
              {{ drill.description }}
            </div>
            <div
              v-for="(item, index) of drillItems"
              :key="item.id"
              :ref="
                (el) => {
                  if (el) commandItems[index] = el as HTMLElement
                }
              "
              class="item"
              :class="{ sel: index === selectedCommandIndex }"
              @mouseenter="selectedCommandIndex = index"
              @click="executeDrillItem(item)"
            >
              <span class="name">{{ item.description }}</span>
            </div>
          </template>

          <!-- 5 分组命令列表 -->
          <template v-else-if="visibleGroups.length > 0">
            <template v-for="group of visibleGroups" :key="group.key">
              <div class="group-head">
                {{ group.name }}
              </div>
              <div
                v-for="item of group.items"
                :key="item.id"
                :ref="
                  (el) => {
                    if (el) commandItems[item.flatIndex] = el as HTMLElement
                  }
                "
                class="item"
                :class="{ sel: item.flatIndex === selectedCommandIndex }"
                @mouseenter="selectedCommandIndex = item.flatIndex"
                @click="executeItem(item)"
              >
                <span class="name">
                  <template v-for="(seg, segIndex) of item.segments" :key="segIndex">
                    <mark v-if="seg.hit">{{ seg.text }}</mark>
                    <template v-else>{{ seg.text }}</template>
                  </template>
                </span>
                <span v-if="item.shortcut && item.shortcut.length" class="kbd">
                  <kbd v-for="(accelerator, idx) of item.shortcut" :key="idx">{{
                    accelerator
                  }}</kbd>
                </span>
              </div>
            </template>
          </template>

          <!-- 无结果：原因 + 修改关键词提示 -->
          <div v-else class="noresult">
            <p>
              {{ noResultReason }}<br />
              <span class="hint">{{ noResultHint }}</span>
            </p>
          </div>
        </div>
      </div>
    </div>
  </transition>
</template>

<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount, nextTick, onBeforeUpdate, computed } from 'vue'
import { useCommandCenterStore } from '@/store/commandCenter'
import { useI18n } from 'vue-i18n'
import log from 'electron-log'
import bus from '../../bus'
import notice from '../../services/notification'
import { PALETTE_GROUP_DEFS, FLATTENED_LEAVES, groupLabel } from './grouping'

// Loose typing for command descriptors — they originate from heterogeneous
// sources (static, runtime, quickOpen search results) and have legacy duck-
// typed shapes we don't want to rewrite as part of the @ts-nocheck removal.
interface CommandItem {
  id: string
  description?: string
  title?: string
  shortcut?: string[]
  value?: unknown
  execute?: () => void
  executeSubcommand?: (commandId: string, value?: unknown) => void | Promise<void>
  subcommands?: CommandItem[]
  subcommandSelectedIndex?: number
  [key: string]: unknown
}

interface Segment {
  text: string
  hit: boolean
}

interface PaletteEntry {
  id: string
  description: string
  shortcut: string[]
  /** 组内展开后的全局序号，用于 ↑↓ 导航。 */
  flatIndex: number
  segments: Segment[]
  execute: () => void
  drill?: CommandItem
}

interface VisibleGroup {
  key: string
  name: string
  items: PaletteEntry[]
}

const { t } = useI18n()
const commandCenterStore = useCommandCenterStore()

const showCommandPalette = ref(false)
const query = ref('')
const selectedCommandIndex = ref(0)
const drill = ref<CommandItem | null>(null)
const drillItems = ref<CommandItem[]>([])
const searchInput = ref<HTMLInputElement | null>(null)
const listEl = ref<HTMLElement | null>(null)
let commandItems: HTMLElement[] = []

const placeholderText = computed(() => {
  try {
    return t('commandPalette.placeholder')
  } catch {
    return 'Search commands...'
  }
})

const noResultReason = computed(() => {
  try {
    return t('commandPalette.noResultReason', { query: query.value.trim() })
  } catch {
    return 'No commands found.'
  }
})
const noResultHint = computed(() => {
  try {
    return t('commandPalette.noResultHint')
  } catch {
    return 'Try a different keyword.'
  }
})

onBeforeUpdate(() => {
  commandItems = []
})

// ---------------------------------------------------------------- feed build

/**
 * 从命令中心 root 子命令中按 5 分组清单构造面板数据。清单外（未实现）命令不展示；
 * 导出 HTML/PDF/docx 三条叶子命令扁平化成独立条目。
 */
const buildFeed = (): Map<string, PaletteEntry> => {
  const root = commandCenterStore.rootCommand as unknown as { subcommands?: CommandItem[] }
  const rootCommands = root.subcommands ?? []
  const feed = new Map<string, PaletteEntry>()
  let flatIndex = 0

  const pushEntry = (id: string, entry: Omit<PaletteEntry, 'flatIndex' | 'segments'>): void => {
    const description = entry.description || id
    feed.set(id, {
      ...entry,
      flatIndex: flatIndex++,
      segments: segmentize(description, query.value.trim())
    })
  }

  for (const groupDef of PALETTE_GROUP_DEFS) {
    for (const commandId of groupDef.commands) {
      if (FLATTENED_LEAVES.has(commandId)) {
        // Leaf of `file.export-file` — flatten into an independent entry.
        const parent = rootCommands.find((c) => c.id === 'file.export-file')
        const leaf = parent?.subcommands?.find((s) => s.id === commandId)
        if (!parent || !leaf) continue
        pushEntry(commandId, {
          id: commandId,
          description: leaf.description ?? commandId,
          shortcut: [],
          execute: () => {
            const result = parent.executeSubcommand?.(commandId, leaf.value)
            if (result instanceof Promise) {
              result.catch((error: unknown) => log.error('Command execution failed:', error))
            }
          }
        })
        continue
      }

      const cmd = rootCommands.find((c) => c.id === commandId)
      if (!cmd) continue

      if (cmd.subcommands && cmd.subcommands.length > 0) {
        // Drill-down parent (更换主题 / 缩放 / 文字方向)。
        pushEntry(commandId, {
          id: commandId,
          description: cmd.description ?? commandId,
          shortcut: cmd.shortcut ?? [],
          execute: () => {
            // Real execution happens through the drill view; the root entry
            // itself is a navigation affordance.
          },
          drill: cmd
        })
      } else if (cmd.execute) {
        pushEntry(commandId, {
          id: commandId,
          description: cmd.description ?? commandId,
          shortcut: cmd.shortcut ?? [],
          execute: () => cmd.execute?.()
        })
      }
    }
  }
  return feed
}

const segmentize = (text: string, queryString: string): Segment[] => {
  const q = queryString.trim().toLowerCase()
  if (!q) {
    return [{ text, hit: false }]
  }
  const lower = text.toLowerCase()
  const segments: Segment[] = []
  let cursor = 0
  let index = lower.indexOf(q, cursor)
  while (index !== -1) {
    if (index > cursor) {
      segments.push({ text: text.slice(cursor, index), hit: false })
    }
    segments.push({ text: text.slice(index, index + q.length), hit: true })
    cursor = index + q.length
    index = lower.indexOf(q, cursor)
  }
  if (cursor < text.length) {
    segments.push({ text: text.slice(cursor), hit: false })
  }
  return segments.length > 0 ? segments : [{ text, hit: false }]
}

const visibleGroups = computed<VisibleGroup[]>(() => {
  const feed = buildFeed()
  const groups: VisibleGroup[] = []
  for (const def of PALETTE_GROUP_DEFS) {
    const items = def.commands
      .map((id) => feed.get(id))
      .filter((entry): entry is PaletteEntry => entry !== undefined)
    if (items.length > 0) {
      groups.push({ key: def.key, name: groupLabel(def.key), items })
    }
  }
  return groups
})

const flatCount = computed<number>(() => {
  const groups = visibleGroups.value
  const last = groups[groups.length - 1]
  if (!last) return 0
  const lastItem = last.items[last.items.length - 1]
  return lastItem ? lastItem.flatIndex + 1 : 0
})

const findEntryByFlatIndex = (flatIndex: number): PaletteEntry | null => {
  for (const group of visibleGroups.value) {
    for (const item of group.items) {
      if (item.flatIndex === flatIndex) return item
    }
  }
  return null
}

// ---------------------------------------------------------------- lifecycle

const handleShow = (command?: unknown) => {
  const next = command as CommandItem | undefined
  query.value = ''
  if (next && Array.isArray(next.subcommands) && next.subcommands.length > 0) {
    // 运行时入口（快速打开 / 拼写语言 / 编码 / 行尾 / 末尾空行）直接下钻。
    drill.value = next
    drillItems.value = next.subcommands
    selectedCommandIndex.value = 0
  } else {
    drill.value = null
    drillItems.value = []
    selectedCommandIndex.value = 0
  }
  showCommandPalette.value = true
  bus.emit('editor-blur')
  nextTick(() => {
    searchInput.value?.focus()
    scrollSelectedIntoView()
  })
}

const closePalette = (): void => {
  showCommandPalette.value = false
  query.value = ''
  drill.value = null
  drillItems.value = []
  commandItems = []
}

const scrollSelectedIntoView = (): void => {
  const el = commandItems[selectedCommandIndex.value]
  if (el) {
    el.scrollIntoView({ block: 'nearest' })
  }
}

const updateCommands = (): void => {
  const queryString = query.value.trim()
  if (!drill.value) {
    // 分组列表由 visibleGroups 响应式重建
    selectedCommandIndex.value = flatCount.value > 0 ? 0 : -1
  } else {
    const cmd = drill.value
    const subs = cmd.subcommands ?? []
    drillItems.value = queryString
      ? subs.filter((s) => (s.description ?? '').toLowerCase().includes(queryString.toLowerCase()))
      : subs
    selectedCommandIndex.value = drillItems.value.length > 0 ? 0 : -1
  }
}

const handleKeydown = (event: KeyboardEvent): void => {
  if (event.isComposing) return
  switch (event.key) {
    case 'ArrowUp': {
      event.preventDefault()
      event.stopPropagation()
      const count = drill.value ? drillItems.value.length : flatCount.value
      if (count <= 0) break
      selectedCommandIndex.value =
        selectedCommandIndex.value <= 0 ? count - 1 : selectedCommandIndex.value - 1
      scrollSelectedIntoView()
      break
    }
    case 'ArrowDown': {
      event.preventDefault()
      event.stopPropagation()
      const count = drill.value ? drillItems.value.length : flatCount.value
      if (count <= 0) break
      selectedCommandIndex.value =
        selectedCommandIndex.value + 1 >= count ? 0 : selectedCommandIndex.value + 1
      scrollSelectedIntoView()
      break
    }
    case 'Enter': {
      event.preventDefault()
      event.stopPropagation()
      if (drill.value) {
        const item = drillItems.value[selectedCommandIndex.value]
        if (item) executeDrillItem(item)
      } else {
        const entry = findEntryByFlatIndex(selectedCommandIndex.value)
        if (entry) executeItem(entry)
      }
      break
    }
    case 'Escape': {
      event.preventDefault()
      event.stopPropagation()
      if (drill.value) {
        // 回到分组列表
        drill.value = null
        drillItems.value = []
        selectedCommandIndex.value = 0
      } else {
        closePalette()
      }
      break
    }
    default: {
      break
    }
  }
}

const notifyExecuted = (description: string): void => {
  notice.notify({
    title: description,
    message: '',
    type: 'info',
    time: 2000
  })
}

const executeItem = (item: PaletteEntry): void => {
  if (item.drill) {
    drill.value = item.drill
    query.value = ''
    updateCommands()
    return
  }
  const description = item.description
  closePalette()
  try {
    item.execute()
  } catch (error) {
    log.error('Command execution failed:', error)
  }
  notifyExecuted(description)
}

const executeDrillItem = (item: CommandItem): void => {
  const cmd = drill.value
  if (!cmd) return
  const description = item.description ?? item.id
  closePalette()
  try {
    const result = cmd.executeSubcommand?.(item.id, item.value)
    if (result instanceof Promise) {
      result.catch((error: unknown) => log.error('Command execution failed:', error))
    }
  } catch (error) {
    log.error('Command execution failed:', error)
  }
  notifyExecuted(description)
}

const handleLanguageChanged = (): void => {
  if (showCommandPalette.value) {
    selectedCommandIndex.value = 0
  }
}

onMounted(() => {
  bus.on('show-command-palette', handleShow)
  bus.on('language-changed', handleLanguageChanged)
})

onBeforeUnmount(() => {
  bus.off('show-command-palette', handleShow)
  bus.off('language-changed', handleLanguageChanged)
})
</script>

<style scoped>
.command-palette-overlay {
  position: fixed;
  inset: 0;
  z-index: 10000;
  display: flex;
  align-items: flex-start;
  justify-content: center;
  background: var(--backdrop);
}

.palette-panel {
  /* 540×480pt（macOS 1pt = 1 CSS px），对应原型 560×486px 悬浮卡片 */
  width: 540px;
  max-height: 480px;
  margin-top: 10vh;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: var(--surface-2);
  border: 1px solid var(--line);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-pop);
  color: var(--ink);
}

.input-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 13px 14px;
  border-bottom: 1px solid var(--line);
  flex: none;
}

.input-row svg {
  width: 16px;
  height: 16px;
  color: var(--faint);
  flex: none;
}

.input-row input {
  flex: 1;
  min-width: 0;
  border: none;
  outline: none;
  background: transparent;
  color: var(--ink);
  font-size: 14px;
}

.input-row input::placeholder {
  color: var(--faint);
}

.kbdhint {
  flex: none;
  padding: 3px 7px;
  font-size: 11px;
  color: var(--muted);
  background: var(--surface-0);
  border: 1px solid var(--line-strong);
  border-radius: 6px;
}

.list {
  flex: 1;
  overflow-y: auto;
  padding: 6px;
}

.group-head {
  padding: 12px 10px 4px;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.05em;
  color: var(--faint);
  user-select: none;
}

.item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  height: 36px;
  padding: 0 10px;
  border-radius: 8px;
  cursor: pointer;
  transition: background 0.15s ease;
  user-select: none;
}

.item:hover {
  background: var(--hover);
}

.item.sel {
  background: var(--accent);
  color: var(--accent-on);
}

.item .name {
  flex: 1;
  min-width: 0;
  font-size: 14px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.item .name mark {
  background: none;
  color: var(--accent);
  font-weight: 700;
}

.item.sel .name mark {
  color: var(--accent-on);
}

.item .kbd {
  display: inline-flex;
  gap: 4px;
  flex: none;
}

.item .kbd kbd {
  display: inline-block;
  min-width: 10px;
  padding: 2.5px 7px;
  text-align: center;
  font-family: inherit;
  font-size: 11px;
  line-height: 1.3;
  color: var(--muted);
  background: var(--surface-0);
  border: 1px solid var(--line);
  border-radius: 6px;
}

.item.sel .kbd kbd {
  color: var(--accent-on);
  background: transparent;
  border-color: color-mix(in oklab, var(--accent-on), transparent 80%);
}

.noresult {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 44px 20px;
  text-align: center;
}

.noresult p {
  margin: 0;
  font-size: 14px;
  line-height: 1.7;
  color: var(--muted);
}

.noresult .hint {
  font-size: 13px;
  color: var(--faint);
}
</style>

<style>
.palette-fade-enter-active,
.palette-fade-leave-active {
  transition: opacity 0.15s ease;
}

.palette-fade-enter,
.palette-fade-leave-to {
  opacity: 0;
}
</style>
