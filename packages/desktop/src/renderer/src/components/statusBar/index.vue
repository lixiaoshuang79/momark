<template>
  <div class="statusbar">
    <button class="wc" :title="wcTooltip" @click="cycle">{{ wcLabel }} {{ formatted }}</button>
    <span class="fs">
      <span class="dot" :class="{ show: !isSaved }" />
      <span>{{ isSaved ? t('statusBar.saved') : t('statusBar.unsaved') }}</span>
    </span>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { t } from '../../i18n'
import type { FileWordCount } from '@shared/types/files'

const props = defineProps<{
  wordCount?: FileWordCount | null
  isSaved?: boolean
}>()

// 状态栏（PHASE2-SPEC §7）：高 32px、顶部 hairline；
// 左=字数按钮（字数[千分位] → 段落 → 字符 循环）；右=保存状态 + 7px 墨蓝点。
// 不显示光标行列、模式胶囊、重复路径。
const WC_STATES = [
  { key: 'word', labelKey: 'statusBar.words' },
  { key: 'paragraph', labelKey: 'statusBar.paragraphs' },
  { key: 'character', labelKey: 'statusBar.characters' }
] as const

const index = ref(0)

const state = computed(() => WC_STATES[index.value]!)
const wcLabel = computed(() => t(state.value.labelKey))
const formatted = computed(() => {
  const value = props.wordCount?.[state.value.key] ?? 0
  return Number(value).toLocaleString('en-US')
})

const cycle = () => {
  index.value = (index.value + 1) % WC_STATES.length
}

const wcTooltip = computed(() => {
  const { word, paragraph, character } = props.wordCount ?? {
    word: 0,
    paragraph: 0,
    character: 0
  }
  return `${t('statusBar.words')} ${Number(word).toLocaleString('en-US')} · ${t('statusBar.paragraphs')} ${Number(paragraph).toLocaleString('en-US')} · ${t('statusBar.characters')} ${Number(character).toLocaleString('en-US')}`
})
</script>

<style scoped>
.statusbar {
  height: 32px;
  flex: none;
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 0 14px;
  border-top: 1px solid var(--line);
  background: var(--bg);
  font-size: var(--f11);
  color: var(--muted);
  box-sizing: border-box;
}
.wc {
  background: none;
  border: none;
  color: var(--muted);
  font-size: var(--f11);
  cursor: pointer;
  padding: 2px 7px;
  border-radius: 6px;
  font-family: inherit;
  transition: all 0.15s ease;
  margin-right: auto;
  flex: none;
}
.wc:hover {
  background: var(--hover);
  color: var(--ink);
}
.fs {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-left: auto;
  flex: none;
  text-align: right;
}
.fs .dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--accent);
  display: none;
}
.fs .dot.show {
  display: block;
}
</style>
