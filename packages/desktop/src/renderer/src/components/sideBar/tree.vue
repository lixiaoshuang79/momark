<template>
  <div class="side-bar-files">
    <div v-if="dirLabel" class="sb-head">文件夹 · {{ dirLabel }}</div>
    <div v-if="dirFiles.length" class="file-list">
      <div
        v-for="file of dirFiles"
        :key="file.pathname"
        class="sb-row"
        :class="{ sel: isCurrentFile(file.pathname) }"
        :title="file.pathname"
        @click="handleFileClick(file.pathname)"
        @mousedown.prevent
      >
        <mo-icon name="i-file" />
        <span class="fname">{{ file.name }}</span>
        <span v-if="isCurrentFile(file.pathname)" class="cur-group">
          <!-- round11 新功能：当前文档行的「在访达中打开」按钮，「当前」标记之前 -->
          <button
            class="reveal-btn"
            :title="t('sideBar.tree.revealInFinder')"
            @click.stop="revealInFinder(file.pathname)"
          >
            <mo-icon name="i-folder" />
            <span class="reveal-label">{{ t('sideBar.tree.revealInFinder') }}</span>
          </button>
          <span class="cur">{{ t('sideBar.tree.currentFile') }}</span>
        </span>
      </div>
    </div>
    <div v-else class="sb-empty">
      <span>{{ t('sideBar.tree.noFilesInDirectory') }}</span>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, watch, computed } from 'vue'
import { storeToRefs } from 'pinia'
import { useEditorStore } from '@/store/editor'
import MoIcon from '@/components/icons/MoIcon.vue'
import { t } from '../../i18n'

const editorStore = useEditorStore()
const { currentFile, tabs } = storeToRefs(editorStore)

interface DirFile {
  name: string
  pathname: string
}

// 文件 tab：当前文档所在目录的 .md 文件列表（文件名排序，含当前文件本身）。
const dirFiles = ref<DirFile[]>([])

// 目录标签（原型 sb-head：「文件夹 · ~/path/」）
const dirLabel = computed(() => {
  const pathname = currentFile.value?.pathname ?? ''
  return pathname ? window.path.dirname(pathname) : ''
})

const loadDirFiles = async (): Promise<void> => {
  const file = currentFile.value
  if (!file?.pathname) {
    dirFiles.value = []
    return
  }
  const dir = window.path.dirname(file.pathname)
  try {
    const names = (await window.fileUtils.readdir(dir)) as string[]
    dirFiles.value = names
      .filter((name) => window.fileUtils.hasMarkdownExtension(name))
      .map((name) => ({ name, pathname: window.path.join(dir, name) }))
      .sort((a, b) => a.name.localeCompare(b.name))
  } catch {
    dirFiles.value = []
  }
}

// 切换标签/打开新文档（目录变化）时刷新列表。
watch(
  () => currentFile.value?.pathname,
  () => {
    loadDirFiles().catch(() => {})
  },
  { immediate: true }
)

const isCurrentFile = (pathname: string): boolean => {
  const file = currentFile.value
  if (!file?.pathname) return false
  return window.fileUtils.isSamePathSync(file.pathname, pathname)
}

// 点击打开/切换对应标签：沿用 treeOpenedTab 逻辑——已打开则切换活动标签，未打开则走 open-file IPC。
const handleFileClick = (pathname: string): void => {
  const openedTab = tabs.value.find((f) => window.fileUtils.isSamePathSync(f.pathname, pathname))
  if (openedTab) {
    if (!isCurrentFile(openedTab.pathname)) {
      editorStore.UPDATE_CURRENT_FILE(openedTab)
    }
  } else {
    window.electron.ipcRenderer.send('mt::open-file', pathname, {})
  }
}

// round11 新功能（用户拍板）：在访达中打开该文件所在位置并高亮该文件。
const revealInFinder = (pathname: string): void => {
  window.electron.shell.showItemInFolder(pathname)
}
</script>

<style scoped>
.side-bar-files {
  height: 100%;
  overflow-x: hidden;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
}

.file-list {
  display: flex;
  flex-direction: column;
}

/* 原型 sb-head：「文件夹 · 路径」小标题 */
.sb-head {
  font-size: var(--f11);
  line-height: 1.45;
  color: var(--faint);
  padding: 6px 8px 7px;
  font-weight: 600;
  flex: none;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.sb-row {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 32px;
  padding: 0 8px;
  border-radius: 8px;
  color: var(--ink);
  font-size: var(--f12);
  line-height: 1.45;
  cursor: pointer;
  margin-bottom: 1px;
  transition: background 0.15s ease;
}

/* 原型：行首统一 i-file 图标 15px 墨灰 */
.sb-row svg {
  width: 15px;
  height: 15px;
  color: var(--muted);
  flex: none;
}

.sb-row:hover {
  background: var(--hover);
}
.sb-row.sel {
  background: var(--selected);
}

.sb-row .fname {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;
}

/* 当前文件行尾「当前」墨蓝标记 + 「在访达中打开」按钮（round11 新功能） */
.sb-row .cur-group {
  margin-left: auto;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  flex: none;
}

.sb-row .cur {
  font-size: 11px;
  color: var(--accent);
  font-weight: 600;
  flex: none;
}

.sb-row .reveal-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 22px;
  padding: 0 7px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--muted);
  font-size: 11px;
  font-weight: 600;
  line-height: 1;
  cursor: pointer;
  flex: none;
  transition:
    background 0.15s ease,
    color 0.15s ease;
}

.sb-row .reveal-btn:hover {
  background: var(--hover);
  color: var(--accent);
}

.sb-row .reveal-btn:active {
  transform: scale(0.97);
}

.sb-row .reveal-btn svg {
  width: 12px;
  height: 12px;
  flex: none;
}

.sb-empty {
  padding: 16px 8px;
  font-size: var(--f11);
  color: var(--faint);
}
</style>
