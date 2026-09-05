<template>
  <div
    class="editor-with-tabs"
    :style="{ 'max-width': `calc(100vw - ${effectiveSideBarWidth}px)` }"
  >
    <!-- 标签栏 + 面包屑已上移到 app.vue 的 .win-body 之上（PHASE2-SPEC §1：
         全宽行；主体三栏从面包屑行之下开始）。本组件只负责编辑内容区。 -->
    <div class="container">
      <editor
        :markdown="markdown"
        :cursor="cursor"
        :text-direction="textDirection"
        :platform="platform"
      />
      <source-code
        v-if="sourceCode"
        :markdown="markdown"
        :muya-index-cursor="muyaIndexCursor"
        :text-direction="textDirection"
      />
    </div>
    <tab-notifications />
  </div>
</template>

<script setup lang="ts">
import { storeToRefs } from 'pinia'
import { useLayoutStore } from '@/store/layout'
import Editor from './editor.vue'
import SourceCode from './sourceCode.vue'
import TabNotifications from './notifications.vue'

defineProps<{
  markdown: string
  // `cursor` originates as `IFileState.cursor` which is `unknown`
  // (see src/shared/types/files.ts); align here instead of forcing every
  // caller to widen.
  cursor: unknown
  muyaIndexCursor?: unknown
  sourceCode: boolean
  textDirection: string
  platform: string
}>()

const layoutStore = useLayoutStore()
const { effectiveSideBarWidth } = storeToRefs(layoutStore)
</script>

<style scoped>
.editor-with-tabs {
  position: relative;
  height: 100%;
  flex: 1;
  display: flex;
  flex-direction: column;

  overflow: hidden;
  background: var(--bg);
  & > .container {
    flex: 1;
    overflow: hidden;
  }
}
</style>
