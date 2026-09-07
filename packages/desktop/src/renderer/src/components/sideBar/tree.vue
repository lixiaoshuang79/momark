<template>
  <div class="side-bar-files">
    <div v-if="dirFiles.length" class="file-list">
      <div
        v-for="file of dirFiles"
        :key="file.pathname"
        class="sb-row"
        :title="file.pathname"
        @click="handleFileClick(file.pathname)"
        @mousedown.prevent
      >
        <file-icon :name="file.name" />
        <span class="fname">{{ file.name }}</span>
        <span v-if="isCurrentFile(file.pathname)" class="cur">{{
          t('sideBar.tree.currentFile')
        }}</span>
      </div>
    </div>
    <div v-else class="sb-empty">
      <span>{{ t('sideBar.tree.noFilesInDirectory') }}</span>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue'
import { storeToRefs } from 'pinia'
import { useEditorStore } from '@/store/editor'
import { t } from '../../i18n'
import FileIcon from './icon.vue'

const editorStore = useEditorStore()
const { currentFile, tabs } = storeToRefs(editorStore)

interface DirFile {
  name: string
  pathname: string
}

// 文件 tab：当前文档所在目录的 .md 文件列表（文件名排序，含当前文件本身）。
const dirFiles = ref<DirFile[]>([])

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

.sb-row {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 32px;
  padding: 0 8px;
  border-radius: 8px;
  color: var(--ink);
  font-size: var(--f12);
  cursor: pointer;
  margin-bottom: 1px;
  transition: background 0.15s ease;
}

.sb-row:hover {
  background: var(--hover);
}

.sb-row .fname {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;
}

/* 当前文件行尾「当前」墨蓝标记 */
.sb-row .cur {
  margin-left: auto;
  font-size: 11px;
  color: var(--accent);
  font-weight: 600;
  flex: none;
}

.sb-empty {
  padding: 16px 8px;
  font-size: var(--f11);
  color: var(--faint);
}
</style>
