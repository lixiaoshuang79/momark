<template>
  <div class="crumb" :class="{ 'single-doc': isSingleDoc }">
    <div class="crumb-main">
      <span class="path" :title="fullPathDisplay">{{ fullPathDisplay }}</span>
    </div>
    <span v-if="isSingleDoc" class="docname">{{ filename }}</span>
    <button class="crumb-pbtn" :title="t('sideBar.rightPanelTitle')">
      <el-icon :size="13">
        <Monitor />
      </el-icon>
    </button>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { storeToRefs } from 'pinia'
import { useEditorStore } from '@/store/editor'
import { Monitor } from '@element-plus/icons-vue'
import { t } from '../../i18n'

// 面包屑行（PHASE2-SPEC §1：28px）：
// - 多文档态：路径+文件名（左侧）+ 右栏开关；
// - 单文档态：只显示文件名（路径已在标题栏，不重复）+ 右栏开关。
// 分屏双面包屑留给后续任务。
const editorStore = useEditorStore()
const { currentFile, tabs } = storeToRefs(editorStore)

const isSingleDoc = computed(() => tabs.value.length <= 1)

const filename = computed(() => currentFile.value?.filename ?? '')

const dirDisplay = computed(() => {
  const pathname = currentFile.value?.pathname ?? ''
  if (!pathname) return ''
  const dir = window.path.dirname(pathname)
  if (!dir || dir === '.') return ''
  const sep = window.path.sep
  const home = window.marktext?.env?.HOME as string | undefined
  if (home && (dir === home || dir.startsWith(home + sep))) {
    return '~' + dir.slice(home.length)
  }
  return dir
})

const fullPathDisplay = computed(() => {
  const dir = dirDisplay.value
  if (!dir) return filename.value
  return `${dir} › ${filename.value}`
})
</script>

<style scoped>
.crumb {
  flex: none;
  height: 28px;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 8px 0 16px;
  background: var(--bg);
  border-bottom: 1px solid var(--line);
  font-size: var(--f11);
  color: var(--muted);
  position: relative;
  box-sizing: border-box;
}
.crumb-main {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.crumb.single-doc .crumb-main {
  display: none;
}
.docname {
  display: none;
  white-space: nowrap;
  color: var(--muted);
}
.crumb.single-doc .docname {
  display: inline;
}
.path {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.crumb-pbtn {
  display: flex;
  width: 26px;
  height: 22px;
  align-items: center;
  justify-content: center;
  margin-left: auto;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--muted);
  cursor: pointer;
  transition:
    background 0.15s ease,
    color 0.15s ease;
}
.crumb-pbtn:hover {
  background: var(--hover);
  color: var(--ink);
}
</style>
