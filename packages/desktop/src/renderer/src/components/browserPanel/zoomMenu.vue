<template>
  <span ref="wrapEl" class="bp-zoomwrap">
    <button
      class="bp-fit"
      :class="{ on: !!activePage?.fitWidth }"
      :title="title"
      :aria-label="title"
      aria-haspopup="menu"
      :aria-expanded="open ? 'true' : 'false'"
      :disabled="!activePage"
      @click.stop="toggleMenu"
    >
      <span class="lbl">{{ label }}</span>
      <mo-icon class="caret" name="i-chev-down" />
    </button>

    <transition name="bp-menu">
      <div v-if="open" class="bp-zoommenu" role="menu" aria-label="网页缩放">
        <button role="menuitem" @click.stop="zoom('in')">
          <span class="tick" />
          <span class="txt">放大</span>
          <kbd>⌘+</kbd>
        </button>
        <button role="menuitem" @click.stop="zoom('out')">
          <span class="tick" />
          <span class="txt">缩小</span>
          <kbd>⌘−</kbd>
        </button>
        <button role="menuitem" @click.stop="zoom('reset')">
          <span class="tick" />
          <span class="txt">重置为 100%</span>
          <kbd>⌘0</kbd>
        </button>
        <div class="sep" />
        <button
          role="menuitemradio"
          :aria-checked="activePage?.fitWidth ? 'true' : 'false'"
          @click.stop="toggleFit"
        >
          <span class="tick">{{ activePage?.fitWidth ? '✓' : '' }}</span>
          <span class="txt">适应面板宽度</span>
        </button>
      </div>
    </transition>
  </span>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { storeToRefs } from 'pinia'
import MoIcon from '@/components/icons/MoIcon.vue'
import { useBrowserPanelStore } from '@/store/browserPanel'

/**
 * round18：底部缩放控件（原先是「适应 / 百分比」二态文字按钮，点一下就翻转、
 * 新用户读不懂 —— 用户反馈）。现在拆成「状态读数 + 显式菜单」：
 *   - 触发器只显示当前状态（适应中 / 88%），带 caret 明确「点开有菜单」；
 *   - 菜单里四个动作各自写明（放大 / 缩小 / 重置为 100% / 适应面板宽度），
 *     当前状态用 ✓ 标记，快捷键写在右侧 —— 不复用「点一下翻转」的隐式语义；
 *   - 放大/缩小/重置后菜单保持打开，方便连点微调，点空白或 Esc 关闭。
 * 缩放状态唯一来源仍是 store 的 page.zoom / page.fitWidth。
 */

const bpStore = useBrowserPanelStore()
const { urlPages, activePageId } = storeToRefs(bpStore)

const activePage = computed(() => urlPages.value.find((p) => p.id === activePageId.value) ?? null)

const zoomPct = computed(() => Math.round((activePage.value?.zoom ?? 1) * 100))
const label = computed(() => (activePage.value?.fitWidth ? '适应' : `${zoomPct.value}%`))
const title = computed(() =>
  activePage.value?.fitWidth
    ? `网页缩放：适应面板宽度（当前 ${zoomPct.value}%）· 点击选择缩放方式`
    : `网页缩放：${zoomPct.value}% · 点击选择缩放方式`
)

const wrapEl = ref<HTMLElement | null>(null)
const open = ref(false)

const closeMenu = (): void => {
  open.value = false
}

const toggleMenu = (): void => {
  if (!activePage.value) return
  open.value = !open.value
}

const zoom = (action: 'in' | 'out' | 'reset'): void => {
  const id = activePageId.value
  if (!id) return
  bpStore.APPLY_ZOOM_ACTION(id, action)
}

const toggleFit = (): void => {
  bpStore.TOGGLE_FIT_WIDTH()
}

const onDocMouseDown = (event: MouseEvent): void => {
  if (!wrapEl.value) return
  if (!wrapEl.value.contains(event.target as Node)) closeMenu()
}

const onDocKeyDown = (event: KeyboardEvent): void => {
  if (event.key === 'Escape') {
    closeMenu()
    ;(wrapEl.value?.querySelector('.bp-fit') as HTMLElement | null)?.focus()
  }
}

watch(open, (isOpen) => {
  if (isOpen) {
    document.addEventListener('mousedown', onDocMouseDown, true)
    document.addEventListener('keydown', onDocKeyDown, true)
  } else {
    document.removeEventListener('mousedown', onDocMouseDown, true)
    document.removeEventListener('keydown', onDocKeyDown, true)
  }
})

// 激活页被关掉/切换时菜单没有对象可作用，直接收起。
watch(activePageId, () => closeMenu())

onBeforeUnmount(() => {
  document.removeEventListener('mousedown', onDocMouseDown, true)
  document.removeEventListener('keydown', onDocKeyDown, true)
})
</script>
