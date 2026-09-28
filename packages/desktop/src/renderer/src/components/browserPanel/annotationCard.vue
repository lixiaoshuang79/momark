<template>
  <article
    class="ann-card"
    :class="{ 'is-active': active, 'just-entered': entering }"
    :data-status="status"
    tabindex="0"
    @click="locate"
    @dblclick.stop="startEdit"
  >
    <span class="ac-idx" :class="statusClass">{{ order }}</span>
    <div class="ac-body">
      <div
        class="ac-quote"
        :class="{ 'is-global': isGlobal }"
        :title="isGlobal ? t('annotation.globalNoteTag') : quote"
      >
        {{ isGlobal ? t('annotation.globalNoteTag') : quote }}
      </div>

      <template v-if="editing">
        <textarea
          ref="editBox"
          v-model="draft"
          class="ac-editbox"
          rows="2"
          @click.stop
          @keydown.esc.prevent.stop="cancelEdit"
          @keydown.enter.meta.prevent.stop="commitEdit"
          @keydown.enter.ctrl.prevent.stop="commitEdit"
          @input="autoGrow"
        />
        <div class="ac-editfoot">
          <button class="mini" @click.stop="cancelEdit">
            {{ t('annotation.action.cancel') }}
          </button>
          <button class="mini primary" :disabled="!draft.trim()" @click.stop="commitEdit">
            {{ t('annotation.action.save') }}
          </button>
        </div>
      </template>
      <div v-else class="ac-note">
        {{ annotation.note }}
      </div>

      <div class="ac-meta">
        <span class="ac-status">{{ statusText }}</span>
        <span class="ac-tools">
          <button
            v-if="status !== 'orphan'"
            class="icon-btn"
            :title="t('annotation.action.edit')"
            @click.stop="startEdit"
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              stroke-width="1.4"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <path d="M11.1 2.6l2.3 2.3-8 8L2.6 13.4l.5-2.8z" />
              <path d="M9.6 4.1l2.3 2.3" />
            </svg>
          </button>
          <button class="icon-btn" :title="t('annotation.action.locate')" @click.stop="locate">
            <svg
              width="14"
              height="14"
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              stroke-width="1.4"
              stroke-linecap="round"
            >
              <circle cx="8" cy="8" r="4.4" />
              <path d="M8 1.4v2M8 12.6v2M1.4 8h2M12.6 8h2" />
            </svg>
          </button>
          <button
            v-if="status === 'copied'"
            class="icon-btn"
            :title="t('annotation.action.unmark')"
            @click.stop="store.reCopy(annotation.id)"
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              stroke-width="1.4"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <path d="M3.2 8a4.8 4.8 0 1 1 1.5 3.5" />
              <path d="M3.1 13.1v-2.6h2.6" />
            </svg>
          </button>
          <button
            class="icon-btn"
            :title="t('annotation.action.archive')"
            @click.stop="store.archive([annotation.id])"
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              stroke-width="1.4"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <path d="M2.2 5.6h11.6v7.2H2.2z" />
              <path d="M1.6 3.2h12.8v2.4H1.6z" />
              <path d="M6.4 8.6h3.2" />
            </svg>
          </button>
          <button
            class="icon-btn danger"
            :title="t('annotation.action.delete')"
            @click.stop="store.remove(annotation.id)"
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              stroke-width="1.4"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <path d="M3.2 4.4h9.6M5.2 4.4V2.9h5.6v1.5M4.4 4.4l.6 9.1h6l.6-9.1" />
            </svg>
          </button>
        </span>
      </div>

      <div v-if="hint" class="ac-hint">
        <i class="dot" :class="hint.dot" />
        {{ hint.text }}
      </div>
    </div>
  </article>
</template>

<script setup lang="ts">
import { computed, nextTick, ref } from 'vue'
import { t } from '../../i18n'
import { useAnnotationStore } from '@/store/annotation'
import type { IAnnotation } from '@shared/types/ipc'

/**
 * 面板里的一条标注卡片（方案 §3.4 / 原型 .ann-card）。
 *
 * 左序号圆点 + 引文单行省略 + 备注（2 行省略，hover 展开）+ 状态行
 * （hover 才浮出的行内动作）。单击卡片空白 = 定位，双击 = 就地编辑。
 */

const props = defineProps<{
  annotation: IAnnotation
  order: number
  /**
   * 刚保存的新条目（面板可见时由 annotationMode 标记 ~1.3s）：opacity+translate
   * 入场（#24）。只走 CSS 动画，不改任何布局属性。
   */
  entering?: boolean
}>()

const store = useAnnotationStore()
const { annotation } = props

const quote = computed(() => annotation.anchor.quote.replace(/\s+/g, ' ').trim())
/** 全局备注：引文区显示语义标签而非引文（引擎侧 `anchor.ranges` 为空）。 */
const isGlobal = computed(() => !!annotation.global)
const active = computed(() => store.activeId === annotation.id)

const status = computed<'pending' | 'copied' | 'orphan'>(() => {
  if (annotation.anchorState === 'orphaned') return 'orphan'
  return annotation.copied ? 'copied' : 'pending'
})

const statusClass = computed(() =>
  status.value === 'pending' ? '' : status.value === 'copied' ? 'hollow' : 'dead'
)

const statusText = computed(() => {
  if (status.value === 'orphan') return t('annotation.status.orphan')
  if (status.value === 'copied') {
    return t('annotation.status.copied', { round: annotation.round ?? 1 })
  }
  return t('annotation.status.uncopied')
})

const hint = computed<{ dot: string; text: string } | null>(() => {
  if (status.value === 'orphan') return { dot: '', text: t('annotation.hint.orphan') }
  if (status.value !== 'copied') return null
  if (annotation.contentChanged === true) {
    return { dot: 'green', text: t('annotation.hint.changed') }
  }
  if (annotation.contentChanged === false) {
    return { dot: 'amber', text: t('annotation.hint.unchanged') }
  }
  return null
})

// ── 就地编辑（⌘↵ 保存 / Esc 取消 / 空备注禁用保存）────────────────────
const editing = ref(false)
const draft = ref('')
const editBox = ref<HTMLTextAreaElement | null>(null)

const startEdit = (): void => {
  if (status.value === 'orphan') return
  draft.value = annotation.note
  editing.value = true
  nextTick(() => {
    const box = editBox.value
    if (!box) return
    box.focus()
    box.setSelectionRange(box.value.length, box.value.length)
    autoGrow()
  })
}

const cancelEdit = (): void => {
  editing.value = false
  draft.value = ''
}

const commitEdit = (): void => {
  const note = draft.value.trim()
  if (!note) return
  store.updateNote(annotation.id, draft.value)
  editing.value = false
  draft.value = ''
}

/** 备注框随内容长高：2 行起，超过 8 行内部滚动（原型 bindAutoGrow(ta,2,8)）。 */
const autoGrow = (): void => {
  const box = editBox.value
  if (!box) return
  const lineHeight = 20
  box.style.height = 'auto'
  const max = lineHeight * 8
  box.style.height = `${Math.min(box.scrollHeight, max)}px`
  box.style.overflowY = box.scrollHeight > max ? 'auto' : 'hidden'
}

const locate = (): void => store.locate(annotation.id)
</script>

<style scoped>
.ann-card {
  position: relative;
  display: grid;
  grid-template-columns: 16px 1fr;
  gap: 8px;
  padding: 10px 12px 9px;
  border-bottom: 1px solid var(--line);
  cursor: pointer;
  transition: background 0.14s ease;
}
.ann-card:hover,
.ann-card.is-active {
  background: var(--hover);
}
/* 新条目入场（原型动效 #24）：opacity+translate 280ms + 底色 accent 8%→0 1200ms。
   底色那条**不写 fill**：动画结束后把背景还给这一级的 hover 规则——fill: forwards
   会把 hover 底色永久压掉。 */
.ann-card.just-entered {
  animation:
    annCardIn 280ms var(--ease-grow, cubic-bezier(0.18, 1.28, 0.36, 1)) both,
    annCardGlow 1200ms var(--ease-standard, cubic-bezier(0.2, 0, 0, 1));
}
@keyframes annCardIn {
  from {
    opacity: 0;
    translate: 0 -4px;
  }
  to {
    opacity: 1;
    translate: 0 0;
  }
}
@keyframes annCardGlow {
  from {
    background-color: color-mix(in oklab, var(--accent) 8%, transparent);
  }
  to {
    background-color: transparent;
  }
}
.ac-idx {
  width: 16px;
  height: 16px;
  border-radius: 50%;
  margin-top: 1px;
  display: grid;
  place-items: center;
  font: 500 10px/1 var(--font-mono);
  background: var(--accent);
  color: var(--accent-on);
}
/* 已复制：淡墨蓝底 + 墨蓝字（取代 1.5px 线框空心——线框版笨重，用户反馈「丑」）。 */
.ac-idx.hollow {
  background: color-mix(in oklab, var(--accent) 14%, transparent);
  color: var(--accent);
}
/* 失效：淡灰底 + 灰字，同样不打线框。 */
.ac-idx.dead {
  background: color-mix(in oklab, var(--fg) 7%, transparent);
  color: var(--faint);
}
.ac-body {
  min-width: 0;
}
.ac-quote {
  font: 12px/1.5 var(--font-mono);
  color: var(--faint);
  padding-left: 8px;
  border-left: 3px solid var(--accent);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  margin-bottom: 5px;
}
.ac-quote.is-global {
  font-family: inherit;
  color: var(--muted);
}
.ann-card:hover .ac-quote {
  color: var(--muted);
}
.ann-card[data-status='copied'] .ac-quote,
.ann-card[data-status='orphan'] .ac-quote {
  border-left-color: var(--line-strong);
}
.ac-note {
  font-size: 13px;
  line-height: 1.6;
  color: var(--ink);
  margin-bottom: 6px;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.ann-card:hover .ac-note {
  -webkit-line-clamp: 6;
}
.ac-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 18px;
}
.ac-status {
  flex: 1 1 auto;
  min-width: 0;
  font-size: 11.5px;
  color: var(--muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.ac-tools {
  flex: 0 0 auto;
  display: flex;
  gap: 1px;
  opacity: 0;
  pointer-events: none;
  transition: opacity 0.12s ease;
}
.ann-card:hover .ac-tools,
.ann-card:focus-within .ac-tools {
  opacity: 1;
  pointer-events: auto;
}
.icon-btn {
  width: 21px;
  height: 21px;
  border-radius: 5px;
  border: none;
  background: transparent;
  display: grid;
  place-items: center;
  color: var(--muted);
  cursor: pointer;
  padding: 0;
  transition:
    background 0.12s ease,
    color 0.12s ease;
}
.icon-btn:hover {
  background: var(--hover);
  color: var(--ink);
}
.icon-btn.danger:hover {
  color: var(--danger);
}
.ac-hint {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 11px;
  color: var(--muted);
  margin-top: 3px;
}
.dot {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  flex: 0 0 auto;
  background: var(--faint);
}
.dot.green {
  background: var(--success);
}
.dot.amber {
  background: var(--warn);
}
.ac-editbox {
  display: block;
  width: 100%;
  box-sizing: border-box;
  min-height: 40px;
  max-height: 160px;
  border: 1px solid var(--line-strong);
  border-radius: 8px;
  padding: 8px 10px;
  background: var(--surface-2);
  font: 13px/1.6 var(--font-body);
  color: var(--ink);
  resize: none;
  overflow-y: hidden;
  outline: none;
  margin-bottom: 6px;
  transition:
    border-color 0.14s ease,
    background 0.14s ease,
    box-shadow 0.14s ease;
}
.ac-editbox:focus {
  border-color: var(--accent);
  box-shadow: 0 0 0 3px color-mix(in oklab, var(--accent) 12%, transparent);
}
.ac-editfoot {
  display: flex;
  justify-content: flex-end;
  gap: 6px;
  margin-bottom: 4px;
}
.mini {
  height: 21px;
  padding: 0 8px;
  border: none;
  border-radius: 5px;
  font-size: 11.5px;
  font-family: inherit;
  color: var(--muted);
  background: transparent;
  box-shadow: inset 0 0 0 1px var(--line-strong);
  cursor: pointer;
  transition:
    background 0.12s ease,
    color 0.12s ease;
}
.mini:hover {
  background: var(--hover);
  color: var(--ink);
}
.mini.primary {
  background: var(--accent);
  color: var(--accent-on);
  box-shadow: none;
  font-weight: 500;
}
.mini.primary:disabled {
  background: var(--surface-2);
  color: var(--faint);
  box-shadow: inset 0 0 0 1px var(--line);
  cursor: default;
}
</style>
