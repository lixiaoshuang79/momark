<template>
  <teleport to="body">
    <!-- 本窗口模态（原型 §2.2）：不打开偏好设置窗口、卡片保持打开。
         click / pointerdown / mousedown 一律就地止住：引擎卡片靠 document 上的
         click 监听做「点外部收起」（BaseFloat），模态里的点击不该被读成「点了
         卡片外面」，否则点「添加」就把卡片连没写完的备注一起收走。 -->
    <div
      v-if="open"
      class="qp-sheet"
      @click.self="close"
      @click.stop
      @pointerdown.stop
      @mousedown.stop
    >
      <div
        ref="cardEl"
        class="qp-card"
        role="dialog"
        aria-modal="true"
        :aria-label="t('annotation.quickPhrase.settingsTitle')"
        @keydown="onCardKeydown"
      >
        <header class="qp-sec">
          <h3>{{ t('annotation.quickPhrase.settingsTitle') }}</h3>
          <button class="qp-reset" :disabled="!changed" @click="resetDefaults">
            {{ t('annotation.quickPhrase.reset') }}
          </button>
        </header>

        <div
          ref="listEl"
          class="qp-list"
          :class="{ dragging: dragFrom !== null }"
          @keydown="onListKeydown"
        >
          <!-- 空态：还没有常用语 -->
          <div v-if="!phrases.length && !adding" class="qp-empty">
            {{ t('annotation.quickPhrase.empty') }}
            <div class="qp-empty-btns">
              <button class="mini" @click="resetDefaults">
                {{
                  t('annotation.quickPhrase.restoreDefaults', { n: DEFAULT_QUICK_PHRASES.length })
                }}
              </button>
              <button class="mini" @click="openAddRow">
                {{ t('annotation.quickPhrase.emptyAdd') }}
              </button>
            </div>
          </div>

          <template v-else>
            <div
              v-for="(phrase, index) in phrases"
              :key="phrase"
              class="qp-row"
              :class="{
                lifting: dragFrom === index,
                shifting: (dragFrom !== null && dragFrom !== index) || settling === index,
                editing: editingIndex === index
              }"
              :data-i="index"
              tabindex="0"
            >
              <span class="qp-pos" aria-hidden="true">{{ index + 1 }}</span>
              <span
                class="qp-grip"
                :title="t('annotation.quickPhrase.dragTitle')"
                @pointerdown="onGripPointerDown($event, index)"
              >
                <svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor">
                  <circle cx="5.6" cy="3.6" r="1.15" />
                  <circle cx="10.4" cy="3.6" r="1.15" />
                  <circle cx="5.6" cy="8" r="1.15" />
                  <circle cx="10.4" cy="8" r="1.15" />
                  <circle cx="5.6" cy="12.4" r="1.15" />
                  <circle cx="10.4" cy="12.4" r="1.15" />
                </svg>
              </span>
              <template v-if="editingIndex === index">
                <!-- 刻意不挂 maxlength：它按 UTF-16 码元计数，含 emoji 的短语会被
                     提前截断；长度只在提交时按码点校验（validate）。 -->
                <input
                  class="qp-input"
                  :value="editDraft"
                  @input="onEditInput"
                  @keydown.enter.prevent="commitEdit"
                  @keydown.esc.stop.prevent="cancelEdit"
                  @blur="onEditBlur"
                />
                <span class="qp-len">{{ editLenHint }}</span>
              </template>
              <template v-else>
                <button
                  class="qp-txt"
                  :title="t('annotation.quickPhrase.editTitle')"
                  @click="startEdit(index)"
                >
                  {{ phrase }}
                </button>
                <button
                  class="qp-del"
                  :title="t('annotation.quickPhrase.delete')"
                  @click="removeAt(index)"
                >
                  <svg
                    width="12"
                    height="12"
                    viewBox="0 0 16 16"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="1.5"
                    stroke-linecap="round"
                  >
                    <path d="M4 4l8 8M12 4l-8 8" />
                  </svg>
                </button>
              </template>
              <span v-if="error && error.key === index" class="qp-err">{{ error.text }}</span>
            </div>

            <!-- 新增行：↵ 提交后自动再开一行（连续录入） -->
            <div v-if="adding" class="qp-row editing" data-new="1">
              <span class="qp-grip">
                <svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor">
                  <circle cx="5.6" cy="3.6" r="1.15" />
                  <circle cx="10.4" cy="3.6" r="1.15" />
                  <circle cx="5.6" cy="8" r="1.15" />
                  <circle cx="10.4" cy="8" r="1.15" />
                  <circle cx="5.6" cy="12.4" r="1.15" />
                  <circle cx="10.4" cy="12.4" r="1.15" />
                </svg>
              </span>
              <input
                class="qp-input"
                :value="addDraft"
                :placeholder="t('annotation.quickPhrase.addPlaceholder')"
                @input="onAddInput"
                @keydown.enter.prevent="commitAdd"
                @keydown.esc.stop.prevent="cancelAdd"
                @blur="onAddBlur"
              />
              <span class="qp-len">{{ addLenHint }}</span>
              <span v-if="error && error.key === 'new'" class="qp-err">{{ error.text }}</span>
            </div>

            <button v-if="!adding && !atLimit" class="qp-add" data-act="add" @click="openAddRow">
              <svg
                width="13"
                height="13"
                viewBox="0 0 16 16"
                fill="none"
                stroke="currentColor"
                stroke-width="1.5"
                stroke-linecap="round"
              >
                <path d="M8 3.4v9.2M3.4 8h9.2" />
              </svg>
              {{ t('annotation.quickPhrase.add') }}
            </button>
          </template>

          <!-- 删除 / 恢复默认后的 5s 撤销条（设置窗口没有正文撤销栈，显式按钮）。
               放在分支外：删掉最后一条后空态接手，撤销条仍要在（否则最后一条
               删了就再也回不来）。 -->
          <div v-if="undo" class="qp-undo">
            {{ undo.text }}
            <button @click="applyUndo">
              {{ t('annotation.quickPhrase.undo') }}
            </button>
          </div>
        </div>

        <footer class="qp-foot">
          <span class="qp-limit">
            {{
              t('annotation.quickPhrase.count', { n: phrases.length, max: QUICK_PHRASE_MAX_COUNT })
            }}
          </span>
          <button class="btn-sm" @click="close">
            {{ t('annotation.quickPhrase.done') }}
          </button>
        </footer>
      </div>
    </div>
  </teleport>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { t } from '../i18n'
import { useAnnotationStore } from '@/store/annotation'
import {
  normalizePhrase,
  QUICK_PHRASE_MAX_COUNT,
  QUICK_PHRASE_MAX_LEN
} from '@muyajs/core/annotation/quickPhrase'
import { DEFAULT_QUICK_PHRASES, usePreferencesStore } from '@/store/preferences'

/**
 * 常用语设置弹窗（原型 v8 §2.2 / 实现规格 §三 B 线）。
 *
 * 形态是**本窗口模态**：卡片头 ⚙ 触发（引擎事件 → annotation store 的
 * `quickPhraseSettingsOpen`），卡片保持打开、不切到偏好设置窗口。改完即写偏好
 * （`SET_SINGLE_PREFERENCE`），没有保存按钮；偏好变化经 annotation store 的
 * watch 整表推给引擎，卡片 chips 实时刷新。
 *
 * 打开时**不自动聚焦**：焦点仍留在卡片的输入框里，用户不动键盘时不会打断写作
 * （弹窗内任何交互按用户意图自行取焦）。
 */

const preferencesStore = usePreferencesStore()
const annotationStore = useAnnotationStore()

const open = computed(() => annotationStore.quickPhraseSettingsOpen)

/** 列表以偏好为唯一数据源（写回即生效，弹窗不留本地副本）。 */
const phrases = computed<string[]>(() => {
  const raw = preferencesStore.annotationQuickPhrases
  return Array.isArray(raw) ? raw : []
})

/** 与默认值完全一致（同序）时「恢复默认」不可点。 */
const changed = computed(
  () =>
    phrases.value.length !== DEFAULT_QUICK_PHRASES.length ||
    phrases.value.some((phrase, index) => phrase !== DEFAULT_QUICK_PHRASES[index])
)

const atLimit = computed(() => phrases.value.length >= QUICK_PHRASE_MAX_COUNT)

const cardEl = ref<HTMLElement | null>(null)
const listEl = ref<HTMLElement | null>(null)

// ── 偏好写回 ──────────────────────────────────────────────────────────

/** 改完即写偏好：SET_SINGLE_PREFERENCE 先更新本地态再经 IPC 落盘 + 广播。 */
const writePhrases = (list: string[]): void => {
  preferencesStore.SET_SINGLE_PREFERENCE({ type: 'annotationQuickPhrases', value: [...list] })
}

// ── 校验 ──────────────────────────────────────────────────────────────

type Invalid = 'empty' | 'long' | 'dup'

/**
 * 校验一条待写入的常用语。`except` 是「正在被改的那一行」的下标（改自己不算重复）。
 * 空 = 取消语义（各调用方各自处理），超长 / 重复 = 抖动 + 行下提示、不写入。
 *
 * 规范化走引擎的 `normalizePhrase`（折叠含全角空格的连续空白）：卡片的判定 /
 * 这里的写入 / 回推引擎必须同源，只 trim 会让全角空格的短语存成另一串，
 * 卡片就出现「按钮在、点了没用」。长度按码点计（与引擎 `Array.from` 同口径）。
 */
const validate = (
  value: string,
  except: number | null
): { ok: true; value: string } | { ok: false; reason: Invalid } => {
  const phrase = normalizePhrase(value)
  if (!phrase) return { ok: false, reason: 'empty' }
  if (Array.from(phrase).length > QUICK_PHRASE_MAX_LEN) return { ok: false, reason: 'long' }
  if (phrases.value.some((item, index) => normalizePhrase(item) === phrase && index !== except)) {
    return { ok: false, reason: 'dup' }
  }
  return { ok: true, value: phrase }
}

const errorText = (reason: Invalid): string =>
  reason === 'long'
    ? t('annotation.quickPhrase.tooLong', { n: QUICK_PHRASE_MAX_LEN })
    : t('annotation.quickPhrase.exists')

const error = ref<{ key: number | 'new'; text: string } | null>(null)
let errorTimer: ReturnType<typeof setTimeout> | null = null

/** 清掉错误提示与它的自清定时器（关闭弹窗时也用；幂等）。 */
const clearError = (): void => {
  error.value = null
  if (errorTimer) {
    clearTimeout(errorTimer)
    errorTimer = null
  }
}

/** 抖动 + 行下红字提示（1.4s 后自清，同原型 qpShake）。 */
const flashError = (key: number | 'new', reason: Invalid): void => {
  error.value = { key, text: errorText(reason) }
  if (errorTimer) clearTimeout(errorTimer)
  errorTimer = setTimeout(clearError, 1400)
  // 抖动是纯装饰：类名等本次渲染落地后再挂，否则会被 Vue 的 class patch 抹掉；
  // 先移除再强制 reflow，保证连续两次同样的错误也能重放动画。
  nextTick(() => {
    const row =
      key === 'new'
        ? listEl.value?.querySelector<HTMLElement>('.qp-row[data-new]')
        : listEl.value?.querySelector<HTMLElement>(`.qp-row[data-i="${key}"]`)
    if (!row) return
    row.classList.remove('shake')
    row.getBoundingClientRect() // 读一次几何强制同步重排，让上面的类名移除先生效
    row.classList.add('shake')
    window.setTimeout(() => row.classList.remove('shake'), 320)
  })
}

/** 达到 18 字才显示计数（原型 upd()）。 */
const lenHint = (value: string): string => {
  const n = Array.from(value).length
  return n >= 18 ? `${n}/${QUICK_PHRASE_MAX_LEN}` : ''
}

// ── 就地编辑（点文字 → ↵ 提交 / Esc 还原 / 失焦提交）──────────────────

const editingIndex = ref<number | null>(null)
const editDraft = ref('')
const editLenHint = ref('')

const startEdit = (index: number): void => {
  editingIndex.value = index
  editDraft.value = phrases.value[index] ?? ''
  editLenHint.value = lenHint(editDraft.value)
  nextTick(() => {
    const input = listEl.value?.querySelector<HTMLInputElement>('.qp-row.editing .qp-input')
    input?.focus()
    input?.setSelectionRange(input.value.length, input.value.length)
  })
}

const onEditInput = (event: Event): void => {
  editDraft.value = (event.target as HTMLInputElement).value
  editLenHint.value = lenHint(editDraft.value)
}

const cancelEdit = (): void => {
  editingIndex.value = null
  editDraft.value = ''
  editLenHint.value = ''
}

const commitEdit = (): void => {
  const index = editingIndex.value
  if (index === null) return
  const result = validate(editDraft.value, index)
  if (!result.ok) {
    // 空 → 还原（等价取消）；超长 / 重复 → 留在编辑态，可继续改或 Esc 还原
    if (result.reason === 'empty') cancelEdit()
    else flashError(index, result.reason)
    return
  }
  if (result.value !== phrases.value[index]) {
    const next = phrases.value.slice()
    next[index] = result.value
    writePhrases(next)
  }
  cancelEdit()
}

/** 失焦 = 提交；非法值不写入：空静默还原，超长 / 重复还原并给出原因。 */
const onEditBlur = (): void => {
  const index = editingIndex.value
  if (index === null) return
  const result = validate(editDraft.value, index)
  if (!result.ok) {
    if (result.reason !== 'empty') flashError(index, result.reason)
    cancelEdit()
    return
  }
  commitEdit()
}

// ── 添加行（↵ 提交后自动再开一行，连续录入）──────────────────────────

const adding = ref(false)
const addDraft = ref('')
const addLenHint = ref('')

const openAddRow = (): void => {
  if (atLimit.value) return
  adding.value = true
  addDraft.value = ''
  addLenHint.value = ''
  nextTick(() => {
    listEl.value?.querySelector<HTMLInputElement>('.qp-row[data-new] .qp-input')?.focus()
  })
}

const cancelAdd = (): void => {
  adding.value = false
  addDraft.value = ''
  addLenHint.value = ''
}

const onAddInput = (event: Event): void => {
  addDraft.value = (event.target as HTMLInputElement).value
  addLenHint.value = lenHint(addDraft.value)
}

const commitAdd = (): void => {
  const result = validate(addDraft.value, null)
  if (!result.ok) {
    // 空内容提交视为取消；超长 / 重复抖动提示并留在输入态
    if (result.reason === 'empty') cancelAdd()
    else flashError('new', result.reason)
    return
  }
  writePhrases([...phrases.value, result.value])
  addDraft.value = ''
  addLenHint.value = ''
  if (phrases.value.length >= QUICK_PHRASE_MAX_COUNT) cancelAdd()
}

const onAddBlur = (): void => {
  if (adding.value) cancelAdd()
}

// ── 删除 / 恢复默认 / 撤销 ────────────────────────────────────────────

/**
 * 撤销条：删除与「恢复默认」共用一个槽位，保留 5s。
 *
 * 删除只记「被删的那一条 + 原下标」而不是整表快照：整表回写会把期间在别处
 * （另一个窗口 / 连续操作）新增的条目一并抹掉。恢复默认记整表——「撤销恢复
 * 默认」的语义本来就是把这整份旧表还回来。
 */
type UndoEntry =
  | { kind: 'deleted'; text: string; phrase: string; index: number }
  | { kind: 'reset'; text: string; list: string[] }

const undo = ref<UndoEntry | null>(null)
let undoTimer: ReturnType<typeof setTimeout> | null = null

const armUndo = (entry: UndoEntry): void => {
  undo.value = entry
  if (undoTimer) clearTimeout(undoTimer)
  undoTimer = setTimeout(() => {
    undo.value = null
    undoTimer = null
  }, 5000)
}

/** 收掉撤销条与它的计时器（应用撤销 / 关闭弹窗时用；幂等）。 */
const clearUndo = (): void => {
  undo.value = null
  if (undoTimer) {
    clearTimeout(undoTimer)
    undoTimer = null
  }
}

const removeAt = (index: number): void => {
  const label = phrases.value[index]
  if (typeof label !== 'string') return
  const before = phrases.value.slice()
  const next = before.slice()
  next.splice(index, 1)
  writePhrases(next)
  // 编辑态跟着行号走：删掉的正是编辑行则取消，否则整体前移一位
  if (editingIndex.value === index) cancelEdit()
  else if (editingIndex.value !== null && editingIndex.value > index) editingIndex.value -= 1
  armUndo({
    kind: 'deleted',
    text: t('annotation.quickPhrase.undoDeleted', { label }),
    phrase: label,
    index
  })
}

const resetDefaults = (): void => {
  if (!changed.value) return
  const before = phrases.value.slice()
  writePhrases([...DEFAULT_QUICK_PHRASES])
  cancelEdit()
  cancelAdd()
  armUndo({ kind: 'reset', text: t('annotation.quickPhrase.undoReset'), list: before })
}

const applyUndo = (): void => {
  const entry = undo.value
  if (!entry) return
  clearUndo()
  if (entry.kind === 'reset') {
    writePhrases([...entry.list])
    return
  }
  // 只把被删的那一条按原下标插回（越界则贴到末尾）；期间别人又加了同名条目
  // 就不重复插。
  const next = phrases.value.slice()
  if (!next.includes(entry.phrase)) {
    next.splice(Math.min(entry.index, next.length), 0, entry.phrase)
  }
  writePhrases(next)
}

// ── 拖拽排序（原生 pointer events；拖动期间不重排 DOM）─────────────────

const dragFrom = ref<number | null>(null)
/** 落位动画的那一行（松手后 220ms 内保留 160ms 的 translate 过渡）。 */
const settling = ref<number | null>(null)

const onGripPointerDown = (event: PointerEvent, index: number): void => {
  if (event.button !== 0 || dragFrom.value !== null) return
  const grip = event.currentTarget as HTMLElement
  const row = grip.closest<HTMLElement>('.qp-row')
  const list = listEl.value
  if (!row || !list) return
  event.preventDefault()
  // 排序会让行号整体错位：先把就地编辑收掉，避免「改的是另一行」
  cancelEdit()

  const H = row.offsetHeight || 32
  const startY = event.clientY
  const from = index
  const rows = Array.from(list.querySelectorAll<HTMLElement>('.qp-row'))
  const others = rows.filter((item) => item !== row)
  const pos = row.querySelector<HTMLElement>('.qp-pos')
  // 落位线的纵向基准：首行的 offsetTop（= 列表的 padding-top），别写死 8px
  const padTop = rows.length ? rows[0].offsetTop : 0
  let to = from
  let dy = 0

  dragFrom.value = from

  const gap = document.createElement('div')
  gap.className = 'qp-gapdrop'
  list.appendChild(gap)
  const paint = (offset: number, target: number): void => {
    row.style.translate = `0 ${offset}px`
    for (const other of others) {
      const i = Number(other.dataset.i)
      let shift = 0
      // 往下拖：中间的行上移一格；往上拖：中间的行下移一格
      if (from < target && i > from && i <= target) shift = -H
      else if (from > target && i >= target && i < from) shift = H
      other.style.translate = shift ? `0 ${shift}px` : ''
    }
    if (pos) pos.textContent = String(target + 1)
    gap.style.top = `${padTop + target * H + H}px`
  }
  paint(0, from)
  requestAnimationFrame(() => gap.classList.add('run'))

  const onMove = (ev: PointerEvent): void => {
    dy = ev.clientY - startY
    const raw = Math.round((from * H + dy) / H)
    to = Math.max(0, Math.min(phrases.value.length - 1, raw))
    paint(dy, to)
  }

  const cleanup = (): void => {
    grip.removeEventListener('pointermove', onMove)
    grip.removeEventListener('pointerup', onUp)
    grip.removeEventListener('pointercancel', onUp)
    gap.remove()
  }

  const onUp = (): void => {
    cleanup()
    dragFrom.value = null
    const moved = to !== from
    if (moved) {
      const next = phrases.value.slice()
      const [item] = next.splice(from, 1)
      next.splice(to, 0, item)
      writePhrases(next)
    }
    // 松手位置 → 落位：重排后这一行的布局位置变了，内联位移要按新位置折算，
    // 否则会瞬跳（拖拽期间不重排 DOM 就是为了这个）。
    settling.value = moved ? to : from
    nextTick(() => {
      for (const other of others) other.style.translate = ''
      row.style.translate = `0 ${dy + (from - to) * H}px`
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          row.style.translate = ''
        })
      })
      window.setTimeout(() => {
        settling.value = null
      }, 220)
    })
  }

  grip.setPointerCapture(event.pointerId)
  grip.addEventListener('pointermove', onMove)
  grip.addEventListener('pointerup', onUp)
  grip.addEventListener('pointercancel', onUp)
}

/** ⌥↑ / ⌥↓：键盘移动（与拖拽共用同一份顺序写回）。 */
const onListKeydown = (event: KeyboardEvent): void => {
  if (!event.altKey || (event.key !== 'ArrowUp' && event.key !== 'ArrowDown')) return
  const target = event.target as HTMLElement | null
  // 焦点在输入框里时不抢键：⌥↑/⌥↓ 在文本控件里是「移到段首/段尾」。
  if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return
  const row = target?.closest<HTMLElement>('.qp-row')
  if (!row || row.dataset.i === undefined) return
  event.preventDefault()
  const from = Number(row.dataset.i)
  const to = from + (event.key === 'ArrowUp' ? -1 : 1)
  if (to < 0 || to >= phrases.value.length) return
  cancelEdit() // 行号会整体错位，同拖拽
  const next = phrases.value.slice()
  const [item] = next.splice(from, 1)
  next.splice(to, 0, item)
  writePhrases(next)
  nextTick(() => {
    listEl.value?.querySelector<HTMLElement>(`.qp-row[data-i="${to}"]`)?.focus()
  })
}

// ── 关闭（「完成」/ Esc / 点遮罩）─────────────────────────────────────

/**
 * 引擎卡片还开着时返回它的输入框，否则 null。
 *
 * 卡片浮层关闭时不是从 DOM 摘除，而是被引擎 BaseFloat 挪到 (-9999, -9999)
 * 并把 opacity 置 0——节点一直挂着，直接 querySelector 在卡片已关时也会命中。
 * 必须按可见性过滤，否则会把焦点送进屏幕外的输入框（正是引擎侧刚修掉的缺陷）。
 */
const cardNoteIfOpen = (): HTMLTextAreaElement | null => {
  // 主编辑器与分屏各可能有一张卡片，取第一张「开着」的（隐藏的节点会一直挂着）。
  const notes = document.querySelectorAll<HTMLTextAreaElement>('textarea.mu-annotation-note')
  for (const note of notes) {
    const wrapper = note.closest<HTMLElement>('.mu-float-wrapper')
    if (wrapper && wrapper.style.opacity !== '0' && wrapper.style.top !== '-9999px') return note
  }
  return null
}

const close = (): void => {
  cancelEdit()
  cancelAdd()
  annotationStore.quickPhraseSettingsOpen = false
  // 关闭即作废上一次的状态：5 秒内重开不该再看到旧撤销条 / 旧错误提示。
  clearUndo()
  clearError()
  // 焦点还给卡片输入框：弹窗开着时键盘归弹窗，关闭后卡片的 Esc / ⌥N / ⌘↵
  // 必须重新可用。卡片已关时不动焦点（返回 null），免得抢走正文的焦点。
  cardNoteIfOpen()?.focus()
}

const onCardKeydown = (event: KeyboardEvent): void => {
  if (event.key !== 'Escape') return
  event.preventDefault()
  close()
}

/**
 * Esc 的归属：弹窗是当前最上层，Esc 该先关弹窗而不是把底下的卡片一起关掉。
 * 焦点在弹窗内时由弹窗自己的 keydown 处理（输入框会先拦下 Esc 取消编辑）；
 * 焦点还在卡片/正文里时，这里在**捕获阶段**拦下，避免引擎卡片的 Esc 处理器
 * 也收到同一个按键。
 */
const onWindowKeydown = (event: KeyboardEvent): void => {
  if (event.key !== 'Escape' || !open.value) return
  const target = event.target as Node | null
  if (target && cardEl.value?.contains(target)) return
  event.stopPropagation()
  close()
}

onMounted(() => {
  window.addEventListener('keydown', onWindowKeydown, true)
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onWindowKeydown, true)
  clearError()
  clearUndo()
})
</script>

<style scoped>
/* 遮罩层挂在 body 上（teleport），scoped 属性选择器仍能命中本组件渲染的节点。 */
.qp-sheet {
  position: fixed;
  inset: 0;
  /* 10002：模态要压住引擎的标注卡片——BaseFloat 的 z-index 是 10000，本应用
     的对话框层是 10000 / 图片查看器 10001。 */
  z-index: 10002;
  display: grid;
  place-items: center;
  background: var(--backdrop);
}
.qp-card {
  width: min(520px, 82vw);
  max-height: min(640px, 80vh);
  display: flex;
  flex-direction: column;
  background: var(--surface-2);
  border-radius: 12px;
  box-shadow: var(--shadow-win);
  overflow: hidden;
  animation: qpOpen 200ms var(--ease-standard) both;
}
@keyframes qpOpen {
  from {
    opacity: 0;
    translate: 0 6px;
  }
  to {
    opacity: 1;
    translate: 0 0;
  }
}
.qp-sec {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 15px 17px 9px;
}
.qp-sec h3 {
  margin: 0;
  font-size: 14px;
  font-weight: 500;
  color: var(--ink);
}
.qp-reset {
  margin-left: auto;
  border: none;
  background: transparent;
  padding: 2px 4px;
  border-radius: 5px;
  font: inherit;
  font-size: 12px;
  color: var(--muted);
  cursor: pointer;
  transition:
    color 0.12s ease,
    background 0.12s ease;
}
.qp-reset:hover:not(:disabled) {
  color: var(--accent);
}
.qp-reset:disabled {
  color: var(--line-strong);
  cursor: default;
}
.qp-list {
  position: relative;
  padding: 8px 0 6px;
  min-height: 96px;
  border-top: 1px solid var(--line);
  overflow-y: auto;
  flex: 1 1 auto;
}
.qp-row {
  position: relative;
  display: flex;
  align-items: center;
  gap: 8px;
  height: 32px;
  padding: 0 17px;
  font-size: 13px;
  color: var(--ink);
  box-sizing: border-box;
}
/* 行首就是拖拽手柄（不再是 ⌥N 键帽）：常驻可见，因为「拖」是这一行唯一的排序入口 */
.qp-grip {
  flex: 0 0 auto;
  display: grid;
  place-items: center;
  width: 14px;
  height: 20px;
  margin-left: -3px;
  color: color-mix(in oklab, var(--muted) 40%, var(--surface-2));
  cursor: grab;
  transition: color 0.12s var(--ease-standard);
}
.qp-row:hover .qp-grip,
.qp-row:focus-within .qp-grip {
  color: var(--faint);
}
.qp-grip:hover {
  color: var(--muted);
}
.qp-grip:active {
  cursor: grabbing;
}
/* 拖拽中：其余行 translate 让位（160ms standard），被拖那行抬起来 */
.qp-row.lifting {
  z-index: 2;
  background: var(--surface-2);
  box-shadow: var(--shadow-pop);
  border-radius: 6px;
}
.qp-row.shifting {
  transition: translate 160ms var(--ease-standard);
}
/* 落点反馈：拖起来之后才浮出「插到第几行」。absolute 而不是给行加边框 ——
   拖拽期间不能改动任何行的尺寸，否则让位的位移量会算错 */
.qp-pos {
  position: absolute;
  left: 14px;
  width: 14px;
  top: 50%;
  translate: 0 -50%;
  z-index: 3;
  text-align: center;
  font: 500 11px/1 var(--font-mono);
  color: var(--accent);
  opacity: 0;
  transition: opacity 120ms var(--ease-standard);
}
.qp-list.dragging .qp-row.lifting .qp-pos {
  opacity: 1;
}
/* 数字浮在 ⠿ 原本的位置上（同宽同位），拖起来时把 ⠿ 收掉避免字形叠在一起 */
.qp-row.lifting .qp-grip {
  opacity: 0;
}
.qp-gapdrop {
  position: absolute;
  left: 17px;
  right: 17px;
  height: 2px;
  z-index: 1;
  margin-top: -1px;
  border-radius: 1px;
  pointer-events: none;
  background: var(--accent);
}
.qp-gapdrop::before {
  content: '';
  position: absolute;
  left: -3px;
  top: -2px;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--accent);
}
@keyframes qpGapDrop {
  from {
    opacity: 0;
    scale: 0 1;
  }
  to {
    opacity: 1;
    scale: 1 1;
  }
}
.qp-gapdrop.run {
  animation: qpGapDrop 140ms var(--ease-standard) both;
}
.qp-txt {
  flex: 1 1 auto;
  min-width: 0;
  text-align: left;
  border: none;
  background: transparent;
  font: inherit;
  color: inherit;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  padding: 3px 6px;
  margin-left: -6px;
  border-radius: 5px;
  cursor: text;
  transition: background 0.12s ease;
}
.qp-txt:hover {
  background: var(--hover);
}
.qp-del {
  flex: 0 0 auto;
  color: var(--faint);
  opacity: 0;
  width: 20px;
  height: 20px;
  border: none;
  background: transparent;
  border-radius: 5px;
  display: grid;
  place-items: center;
  cursor: pointer;
  transition:
    opacity 0.12s ease,
    color 0.12s ease,
    background 0.12s ease;
}
.qp-row:hover .qp-del,
.qp-row:focus-within .qp-del {
  opacity: 1;
}
.qp-del:hover {
  color: var(--danger);
  background: color-mix(in oklab, var(--danger) 10%, transparent);
}
.qp-row.shake {
  animation: qpShake 300ms var(--ease-standard) both;
}
@keyframes qpShake {
  0%,
  100% {
    translate: 0 0;
  }
  16% {
    translate: -5px 0;
  }
  33% {
    translate: 5px 0;
  }
  50% {
    translate: -4px 0;
  }
  66% {
    translate: 4px 0;
  }
  83% {
    translate: -2px 0;
  }
}
.qp-input {
  flex: 1 1 auto;
  min-width: 0;
  height: 24px;
  padding: 0 8px;
  border: 1px solid var(--accent);
  border-radius: 6px;
  outline: none;
  font: 13px/1 var(--font-body);
  color: var(--ink);
  background: var(--surface-2);
  box-shadow: 0 0 0 3px color-mix(in oklab, var(--accent) 12%, transparent);
}
.qp-input::placeholder {
  color: var(--faint);
}
.qp-len {
  flex: 0 0 auto;
  font: 10.5px/1 var(--font-mono);
  color: var(--faint);
}
.qp-err {
  position: absolute;
  left: 39px;
  bottom: -2px;
  font-size: 10.5px;
  color: var(--danger);
}
.qp-add {
  display: flex;
  align-items: center;
  gap: 7px;
  width: calc(100% - 34px);
  margin: 2px 17px 0;
  height: 32px;
  padding: 0 8px;
  border: none;
  background: transparent;
  border-radius: 6px;
  font: inherit;
  font-size: 12.5px;
  color: var(--muted);
  cursor: pointer;
  transition:
    background 0.12s ease,
    color 0.12s ease;
}
.qp-add:hover {
  background: var(--hover);
  color: var(--ink);
}
.qp-undo {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 8px 17px 0;
  padding: 7px 10px;
  border-radius: 7px;
  background: var(--hover);
  font-size: 12px;
  color: var(--muted);
}
.qp-undo button {
  margin-left: auto;
  border: none;
  background: transparent;
  padding: 0;
  font: inherit;
  color: var(--accent);
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
}
.qp-undo button:hover {
  text-decoration: underline;
}
.qp-empty {
  padding: 26px 17px 20px;
  text-align: center;
  font-size: 12.5px;
  color: var(--muted);
  line-height: 1.8;
}
.qp-empty-btns {
  display: flex;
  justify-content: center;
  gap: 8px;
  margin-top: 12px;
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
.qp-foot {
  flex: none;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 11px 17px;
  border-top: 1px solid var(--line);
}
.qp-limit {
  margin-right: auto;
  font: 11px/1 var(--font-mono);
  color: var(--faint);
}
.btn-sm {
  height: 27px;
  padding: 0 14px;
  border: none;
  border-radius: 6px;
  font: inherit;
  font-size: 12.5px;
  font-weight: 500;
  background: var(--accent);
  color: var(--accent-on);
  cursor: pointer;
  transition: background 0.14s ease;
}
.btn-sm:hover {
  background: var(--accent-hover);
}

/* 减少动态效果：只压时长，不压 delay */
@media (prefers-reduced-motion: reduce) {
  .qp-card,
  .qp-row.shake,
  .qp-gapdrop.run {
    animation-duration: 0.01ms !important;
    animation-delay: 0s !important;
  }
  .qp-row.shifting {
    transition-duration: 0.01ms !important;
    transition-delay: 0s !important;
  }
}
</style>
