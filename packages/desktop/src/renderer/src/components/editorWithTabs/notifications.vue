<template>
  <div
    v-if="currentNotification"
    class="editor-notifications"
    :class="currentNotification.style"
    :style="{ 'max-width': `calc(100vw - ${effectiveSideBarWidth}px)` }"
  >
    <div class="msg">
      {{ currentNotification.msg }}
    </div>
    <div class="controls">
      <div>
        <span
          v-if="currentNotification.showConfirm"
          class="inline-button"
          @click.stop="handleClick(true)"
        >
          {{ t('common.ok') }}
        </span>
        <span class="inline-button" @click.stop="handleClick(false)">
          <el-icon class="close-icon" :size="12">
            <Close />
          </el-icon>
        </span>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useEditorStore } from '@/store/editor'
import { useLayoutStore } from '@/store/layout'
import { useSplitStore } from '@/store/split'
import { storeToRefs } from 'pinia'
import { Close } from '@element-plus/icons-vue'
import { t } from '../../i18n'

const editorStore = useEditorStore()
const layoutStore = useLayoutStore()
const splitStore = useSplitStore()

const { currentFile } = storeToRefs(editorStore)
const { effectiveSideBarWidth } = storeToRefs(layoutStore)

// round10：横幅数据源 = 左侧当前文档的通知栈；分屏开启时右侧文档的
// 外部变更通知同样在此展示（数据挂在 split tab 的 notifications 栈）。
const notificationStack = computed(() => {
  const cur = currentFile.value?.notifications
  if (cur && cur.length > 0) return cur
  if (splitStore.active && splitStore.tabId) {
    const splitTab = editorStore.tabs.find((t) => t.id === splitStore.tabId)
    if (splitTab?.notifications && splitTab.notifications.length > 0) {
      return splitTab.notifications
    }
  }
  return null
})

const currentNotification = computed(() => notificationStack.value?.[0] ?? null)

const handleClick = (status: boolean) => {
  const notifications = notificationStack.value
  if (!notifications || notifications.length === 0) {
    console.error(t('editor.notifications.notificationNotFound'))
    return
  }

  const item = notifications.shift()
  const action = item?.action
  if (action) {
    action(status)
  }
}
</script>

<style scoped>
.editor-notifications {
  position: relative;
  display: flex;
  flex-direction: row;
  max-height: 100px;
  margin-top: 4px;
  background: var(--notificationPrimaryBg);
  color: var(--notificationPrimaryColor);
  padding: 8px 10px;
  user-select: none;
  overflow: hidden;
  &.warn {
    background: var(--notificationWarningBg);
    color: var(--notificationWarningColor);
  }
  &.crit {
    background: var(--notificationErrorBg);
    color: var(--notificationErrorColor);
  }
}
.msg {
  font-size: 13px;
  flex: 1;
}
.controls {
  display: flex;
  flex-direction: column;
  justify-content: center;
  & > div {
    display: flex;
    flex-direction: row;
  }
  & .inline-button:not(:last-child) {
    margin-right: 3px;
  }
  & .inline-button {
    display: flex;
    justify-content: center;
    align-items: center;
    width: 24px;
    height: 24px;
    font-size: 12px;
    cursor: pointer;
    border: 1px solid rgba(255, 255, 255, 0.1);
  }
  & .inline-button:hover {
    background: rgba(255, 255, 255, 0.1);
    border: 1px solid rgba(255, 255, 255, 0.6);
  }
}
</style>
