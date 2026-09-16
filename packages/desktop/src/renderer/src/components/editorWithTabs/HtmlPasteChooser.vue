<template>
  <div
    v-if="visible"
    class="html-paste-chooser"
    :style="{ left: `${x}px`, top: `${y}px` }"
    @mousedown.stop
    @click.stop
  >
    <div class="hpc-title">
      {{ t('editor.htmlFilePaste.title') }}
    </div>
    <div class="hpc-file" :title="fileName">
      {{ fileName }}
    </div>
    <div class="hpc-actions">
      <button class="hpc-btn hpc-btn--primary" @click="emit('choose', 'embed')">
        {{ t('editor.htmlFilePaste.embed') }}
      </button>
      <button class="hpc-btn" @click="emit('choose', 'upload')">
        {{ t('editor.htmlFilePaste.upload') }}
      </button>
      <button class="hpc-btn hpc-btn--ghost" @click="emit('close')">
        {{ t('common.cancel') }}
      </button>
    </div>
    <div class="hpc-hint">
      {{ t('editor.htmlFilePaste.hint') }}
    </div>
  </div>
</template>

<script setup lang="ts">
import { t } from '@/i18n'

defineProps<{
  visible: boolean
  x: number
  y: number
  fileName: string
}>()

const emit = defineEmits<{
  (e: 'choose', action: 'embed' | 'upload'): void
  (e: 'close'): void
}>()
</script>

<style scoped>
/* 粘贴 html 文件时的二选一气泡：贴光标下方，浮在编辑器之上（不改变文档内容）。 */
.html-paste-chooser {
  position: fixed;
  z-index: 100;
  min-width: 230px;
  max-width: 320px;
  padding: 10px 12px;
  border: 1px solid var(--floatBorderColor, #dcdfe6);
  border-radius: 8px;
  background: var(--floatBgColor, #fff);
  box-shadow: var(--floatShadow, 0 4px 16px rgb(0 0 0 / 16%));
  color: var(--floatFontColor, #333);
  font-size: 13px;
  user-select: none;
}

.hpc-title {
  font-weight: 600;
}

.hpc-file {
  margin-top: 4px;
  overflow: hidden;
  color: var(--editorColor, #666);
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.hpc-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 10px;
}

.hpc-btn {
  padding: 4px 10px;
  border: 1px solid var(--buttonBorder, #dcdfe6);
  border-radius: 5px;
  background: var(--buttonBgColor, #f5f5f5);
  color: var(--buttonFontColor, #333);
  font-size: 12px;
  cursor: pointer;
}

.hpc-btn:hover {
  border-color: var(--buttonBorderHover, #c8c9cc);
  background: var(--buttonBgColorHover, #ececec);
}

.hpc-btn--primary {
  border-color: var(--buttonPrimaryBorder, #409eff);
  background: var(--buttonPrimaryBgColor, #409eff);
  color: var(--buttonPrimaryFontColor, #fff);
}

.hpc-btn--primary:hover {
  background: var(--buttonPrimaryBgColorHover, #66b1ff);
}

.hpc-btn--ghost {
  border-color: transparent;
  background: transparent;
}

.hpc-hint {
  margin-top: 8px;
  color: var(--editorColor, #999);
  font-size: 11px;
  line-height: 1.5;
  opacity: 0.75;
}
</style>
