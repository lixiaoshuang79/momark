<template>
  <div
    class="editor-with-tabs"
    :style="{ 'max-width': `calc(100vw - ${effectiveSideBarWidth}px)` }"
  >
    <!-- 标签栏：单文档态（tabs ≤ 1）物理移除整行，多文档态渲染（PHASE2-SPEC §1/§10） -->
    <Tabs v-if="showTabBar" />
    <!-- 面包屑行 28px -->
    <Crumbs />
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
import { computed } from 'vue'
import { useLayoutStore } from '@/store/layout'
import { useEditorStore } from '@/store/editor'
import { storeToRefs } from 'pinia'
import Tabs from './tabs.vue'
import Crumbs from '../crumbs/index.vue'
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
const editorStore = useEditorStore()
const { effectiveSideBarWidth } = storeToRefs(layoutStore)
const { tabs } = storeToRefs(editorStore)

// 场景派生（STATE-MACHINE §1）：标签栏是否渲染完全由标签数量决定。
const showTabBar = computed(() => tabs.value.length >= 2)
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
