<template>
  <!-- 网页 pane（feat/right-panel-redesign，DESIGN-NOTES §3.4 网页）：
       第二行工具条（后退 / 前进 / 刷新 / 地址栏 / ⋯）；第三行网页条（有网页就显示，
       每页可见 × 关闭，末尾 + 新建）；下面是 webview。 -->
  <div class="bp-url" @keydown.esc="onEsc">
    <div class="rp-sub">
      <button
        class="rp-ib"
        :title="t('rightPanel.web.back')"
        :disabled="!canGoBack"
        @click="goBack"
      >
        <mo-icon name="i-chev-left" />
      </button>
      <button
        class="rp-ib"
        :title="t('rightPanel.web.forward')"
        :disabled="!canGoForward"
        @click="goForward"
      >
        <mo-icon name="i-chev-right" />
      </button>
      <button
        class="rp-ib"
        :title="t('rightPanel.web.reload')"
        :disabled="!activePage"
        @click="reload"
      >
        <mo-icon name="i-refresh" />
      </button>

      <div
        v-if="!editing"
        ref="addrEl"
        class="rp-addr"
        role="button"
        tabindex="0"
        :aria-label="t('rightPanel.web.address')"
        :title="activePage?.url"
        @click="startEdit()"
        @keydown.enter.prevent="startEdit()"
      >
        <template v-if="activePage && !newPage">
          <svg v-if="isHttps" class="rp-lock" viewBox="0 0 16 16" aria-hidden="true">
            <rect x="3.5" y="7" width="9" height="6.5" rx="1.5" />
            <path d="M5.5 7V5.2a2.5 2.5 0 0 1 5 0V7" />
          </svg>
          <span class="host">{{ hostLabel }}</span>
          <span class="path">{{ pathLabel }}</span>
        </template>
        <template v-else>
          <svg class="rp-lock" viewBox="0 0 16 16" aria-hidden="true">
            <path d="M11.2 7a4.2 4.2 0 1 1-8.4 0 4.2 4.2 0 0 1 8.4 0zM10.2 10.2l3.3 3.3" />
          </svg>
          <span class="path">{{ t('rightPanel.web.addressPlaceholder') }}</span>
        </template>
      </div>
      <div v-else class="rp-addr edit">
        <svg class="rp-lock" viewBox="0 0 16 16" aria-hidden="true">
          <path d="M11.2 7a4.2 4.2 0 1 1-8.4 0 4.2 4.2 0 0 1 8.4 0zM10.2 10.2l3.3 3.3" />
        </svg>
        <input
          ref="inputEl"
          v-model="draft"
          spellcheck="false"
          :aria-label="t('rightPanel.web.address')"
          :placeholder="t('rightPanel.web.addressPlaceholder')"
          @keydown.enter.prevent="commitEdit"
          @keydown.esc.prevent.stop="cancelEdit(true)"
          @blur="cancelEdit(false)"
        />
      </div>

      <div ref="moreWrap" class="rp-more">
        <button
          class="rp-ib"
          :class="{ on: menuOpen }"
          :title="t('rightPanel.web.more')"
          aria-haspopup="menu"
          :aria-expanded="menuOpen"
          @click.stop="toggleMenu"
        >
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <circle cx="3.5" cy="8" r="1" />
            <circle cx="8" cy="8" r="1" />
            <circle cx="12.5" cy="8" r="1" />
          </svg>
        </button>
        <transition name="rp-pop">
          <div v-if="menuOpen" ref="menuEl" class="rp-pop" role="menu" @keydown="onMenuKey">
            <div class="rp-zoom">
              <span>{{ t('rightPanel.web.zoom') }}</span>
              <button class="rp-ib" :disabled="!activePage" @click="zoom('out')">−</button>
              <b>{{ zoomLabel }}</b>
              <button class="rp-ib" :disabled="!activePage" @click="zoom('in')">＋</button>
            </div>
            <button
              role="menuitemcheckbox"
              :aria-checked="!!activePage?.fitWidth"
              :disabled="!activePage"
              @click="toggleFit"
            >
              <span class="tick">{{ activePage?.fitWidth ? '✓' : '' }}</span>
              {{ t('rightPanel.web.fitWidth') }}
            </button>
            <button
              role="menuitemcheckbox"
              :aria-checked="deviceMode === 'mobile'"
              :disabled="!activePage"
              @click="toggleDevice"
            >
              <span class="tick">{{ deviceMode === 'mobile' ? '✓' : '' }}</span>
              {{ t('rightPanel.web.mobile') }}
            </button>
            <hr />
            <button role="menuitem" :disabled="!activePage" @click="openExternal">
              <span class="tick" />{{ t('rightPanel.web.openExternal') }}
            </button>
            <button role="menuitem" :disabled="!activePage" @click="copyLink">
              <span class="tick" />{{ t('rightPanel.web.copyLink') }}
            </button>
            <template v-if="activePage">
              <hr />
              <button role="menuitem" @click="closeActive">
                <span class="tick" />{{ t('rightPanel.web.closePage') }}
              </button>
            </template>
          </div>
        </transition>
      </div>
    </div>

    <!-- 网页条：有网页就显示（单页也显示——关闭和新建需要一个固定、可见的位置） -->
    <div
      v-if="urlPages.length"
      ref="stripEl"
      class="rp-pages"
      role="tablist"
      :aria-label="t('rightPanel.web.pages')"
      @keydown="onStripKey"
    >
      <div
        v-for="page of urlPages"
        :key="page.id"
        class="rp-page"
        :class="{ on: page.id === activePageId && !newPage, closing: closingId === page.id }"
        :data-id="page.id"
        @auxclick="onAuxClick($event, page.id)"
        @contextmenu.prevent="openPageMenu($event, page.id)"
      >
        <button
          class="rp-page-main"
          role="tab"
          :aria-selected="page.id === activePageId"
          :tabindex="page.id === activePageId ? 0 : -1"
          :title="page.title || page.url"
          @click="activate(page.id)"
        >
          <span class="fav">
            <img
              v-if="page.favicon"
              :src="page.favicon"
              alt=""
              @error="bpStore.UPDATE_PAGE_STATE(page.id, { favicon: null })"
            />
            <span v-else>{{ letterOf(page) }}</span>
            <i v-if="page.loading" class="ring" />
          </span>
          <span class="t">{{ page.title || hostOf(page.url) }}</span>
        </button>
        <button
          class="rp-page-x"
          tabindex="-1"
          :aria-label="t('rightPanel.web.closeNamed', { name: page.title || hostOf(page.url) })"
          :title="t('rightPanel.web.closePage') + ' ⌫'"
          @click.stop="closePage(page.id)"
        >
          <mo-icon name="i-x" />
        </button>
      </div>
      <button class="rp-ib rp-new" :title="t('rightPanel.web.newPage')" @click="startNewPage">
        <mo-icon name="i-plus" />
      </button>
    </div>

    <div class="rp-wview">
      <!-- 每页一个 webview 实例，display 切换保活（登录态/滚动/历史） -->
      <webview-page
        v-for="page of urlPages"
        :key="page.id"
        :page="page"
        :active="page.id === activePageId && !newPage"
      />

      <div v-if="!urlPages.length || newPage" class="rp-wempty">
        <mo-icon name="i-globe" />
        <p>
          {{
            !urlPages.length && lastClosedPage
              ? t('rightPanel.web.allClosed')
              : t('rightPanel.web.emptyHint')
          }}
        </p>
        <p v-if="!urlPages.length && lastClosedPage" class="reopen">
          {{ t('rightPanel.web.justClosed') }}
          <button @click="reopen">
            {{ lastClosedPage.title }} · {{ t('rightPanel.web.reopen') }}
          </button>
        </p>
      </div>

      <!-- 加载失败：原因 + 重试 / 在浏览器中打开 -->
      <div v-else-if="activePage && activePage.error" class="rp-werr">
        <mo-icon name="i-globe" />
        <b>{{ t('rightPanel.web.failed') }}</b>
        <p class="why">
          {{ activePage.error }}
        </p>
        <div class="row">
          <button class="rp-btn" @click="retry">
            <mo-icon name="i-refresh" />{{ t('rightPanel.web.retry') }}
          </button>
          <button class="rp-btn" @click="openExternal">
            <mo-icon name="i-external" />{{ t('rightPanel.web.openExternal') }}
          </button>
        </div>
      </div>

      <!-- 首载加载态（进度线由 index.vue 的 bp-track 统一驱动） -->
      <div
        v-else-if="activePage && activePage.loading && !loadedOnce.has(activePage.id)"
        class="bp-loading"
      >
        <div class="spin" />
        <p>{{ t('rightPanel.web.loading') }}</p>
      </div>

      <!-- round17：缩放浮标（快捷键 Cmd +/-/0 与「适应宽度」的即时反馈，自动隐藏） -->
      <transition name="bp-hint">
        <div v-if="zoomHint" :key="zoomHint.seq" class="bp-zoom-hint">
          {{ zoomHint.text }}
        </div>
      </transition>

      <!-- 关闭后的撤销条（面板内，4.2s 自动消失） -->
      <transition name="rp-undo">
        <div v-if="undoVisible && lastClosedPage" class="rp-undo" role="status">
          <span>{{ t('rightPanel.web.closedNamed', { name: lastClosedPage.title }) }}</span>
          <button @click="reopen">
            {{ t('rightPanel.web.undo') }}
          </button>
        </div>
      </transition>
    </div>

    <!-- 网页条右键菜单 -->
    <div
      v-if="pageMenu"
      class="rp-pop rp-ctx"
      role="menu"
      :style="{ left: `${pageMenu.x}px`, top: `${pageMenu.y}px` }"
      @keydown="onMenuKey"
    >
      <button role="menuitem" @click="ctx('close')">
        <span class="tick" />{{ t('rightPanel.web.closePage') }}<kbd>⌫</kbd>
      </button>
      <button v-if="urlPages.length > 1" role="menuitem" @click="ctx('others')">
        <span class="tick" />{{ t('rightPanel.web.closeOthers') }}
      </button>
      <button v-if="hasPagesToRight" role="menuitem" @click="ctx('right')">
        <span class="tick" />{{ t('rightPanel.web.closeRight') }}
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { storeToRefs } from 'pinia'
import MoIcon from '@/components/icons/MoIcon.vue'
import { t } from '../../i18n'
import { motionReduced } from '@/util/motion'
import { useBrowserPanelStore, type WebPage } from '@/store/browserPanel'
import WebviewPage from './webviewPage.vue'

const bpStore = useBrowserPanelStore()
const { urlPages, activePageId, zoomHint, deviceMode, lastClosedPage } = storeToRefs(bpStore)

const activePage = computed(() => urlPages.value.find((p) => p.id === activePageId.value) ?? null)

const hostOf = (url: string): string => {
  try {
    return new URL(url).host.replace(/^www\./, '')
  } catch {
    return url
  }
}
const isHttps = computed(() => !!activePage.value?.url.startsWith('https:'))
const hostLabel = computed(() => (activePage.value ? hostOf(activePage.value.url) : ''))
const pathLabel = computed(() => {
  if (!activePage.value) return ''
  try {
    const u = new URL(activePage.value.url)
    const rest = u.pathname + u.search
    return rest === '/' ? '' : rest
  } catch {
    return ''
  }
})
const letterOf = (page: WebPage): string =>
  (hostOf(page.url) || page.title || '?').charAt(0).toUpperCase()

// ── 前进 / 后退可用性（bp:getState → navigationHistory）──────────────────
const canGoBack = ref(false)
const canGoForward = ref(false)
const refreshNavState = async (): Promise<void> => {
  const id = activePageId.value
  if (!id) {
    canGoBack.value = false
    canGoForward.value = false
    return
  }
  try {
    const state = await window.bp.getState(id)
    canGoBack.value = state.canGoBack
    canGoForward.value = state.canGoForward
  } catch {
    canGoBack.value = false
    canGoForward.value = false
  }
}
watch(
  () => [activePageId.value, activePage.value?.loading, activePage.value?.url] as const,
  () => {
    refreshNavState()
  },
  { immediate: true }
)
const goBack = (): void => {
  if (activePageId.value) window.bp.back(activePageId.value)
}
const goForward = (): void => {
  if (activePageId.value) window.bp.forward(activePageId.value)
}
const reload = (): void => {
  const id = activePageId.value
  if (!id) return
  bpStore.UPDATE_PAGE_STATE(id, { loading: true, error: null })
  window.bp.reload(id)
}
const retry = reload

// ── 地址栏：平时「🔒 域名 + 弱化路径」，点击 / ↩ 进入编辑（全选），↩ 加载，Esc 取消 ──
const addrEl = ref<HTMLElement | null>(null)
const inputEl = ref<HTMLInputElement | null>(null)
const editing = ref(false)
const draft = ref('')
// 「+ 新建网页」：地址栏进入空白编辑态，↩ 新建一页（不覆盖当前页）
const newPage = ref(false)

const startEdit = (opts: { blank?: boolean } = {}): void => {
  draft.value = opts.blank || newPage.value ? '' : (activePage.value?.url ?? '')
  editing.value = true
  nextTick(() => {
    inputEl.value?.focus()
    inputEl.value?.select()
  })
}
const commitEdit = async (): Promise<void> => {
  const value = draft.value
  const asNew = newPage.value
  editing.value = false
  newPage.value = false
  if (!value.trim()) return
  await bpStore.NAVIGATE_ACTIVE(value, { newPage: asNew })
}
const cancelEdit = (refocus: boolean): void => {
  if (!editing.value) return
  editing.value = false
  newPage.value = false
  if (refocus) nextTick(() => addrEl.value?.focus())
}
const startNewPage = (): void => {
  newPage.value = true
  startEdit({ blank: true })
}
const onEsc = (): void => {
  if (pageMenu.value) pageMenu.value = null
  else if (menuOpen.value) menuOpen.value = false
}

// ── 网页条：激活 / 关闭 / 键盘 / 中键 / 右键 ─────────────────────────────
const stripEl = ref<HTMLElement | null>(null)
const closingId = ref<string | null>(null)

const activate = (id: string): void => {
  newPage.value = false
  bpStore.ACTIVATE_PAGE(id)
}

const focusActiveChip = (): void => {
  nextTick(() => {
    const btn = stripEl.value?.querySelector<HTMLElement>('.rp-page.on .rp-page-main')
    if (btn) btn.focus()
    else addrEl.value?.focus()
  })
}

const undoVisible = ref(false)
let undoTimer: ReturnType<typeof setTimeout> | null = null
const showUndo = (): void => {
  undoVisible.value = true
  if (undoTimer) clearTimeout(undoTimer)
  undoTimer = setTimeout(() => {
    undoVisible.value = false
    undoTimer = null
  }, 4200)
}

// 关闭：条目宽度收到 0 并淡出（180ms 退出曲线），邻居自然补位；减少动态效果只淡出。
const closePage = (id: string): void => {
  if (closingId.value) return
  const hadFocus = !!stripEl.value?.contains(document.activeElement)
  const chip = stripEl.value?.querySelector<HTMLElement>(`.rp-page[data-id="${CSS.escape(id)}"]`)
  const commit = (): void => {
    closingId.value = null
    bpStore.CLOSE_PAGE(id)
    showUndo()
    if (hadFocus || !urlPages.value.length) focusActiveChip()
  }
  if (!chip) return commit()
  closingId.value = id
  const reduced = motionReduced()
  const anim = chip.animate(
    reduced
      ? [{ opacity: 1 }, { opacity: 0 }]
      : [
          { width: `${chip.offsetWidth}px`, opacity: 1 },
          { width: '0px', opacity: 0, marginRight: '-4px' }
        ],
    { duration: reduced ? 120 : 180, easing: 'cubic-bezier(0.4, 0, 1, 1)', fill: 'forwards' }
  )
  anim.onfinish = commit
  anim.oncancel = commit
}
const closeActive = (): void => {
  menuOpen.value = false
  if (activePageId.value) closePage(activePageId.value)
}
const reopen = (): void => {
  undoVisible.value = false
  bpStore.REOPEN_CLOSED_PAGE().catch(() => {})
}

const onAuxClick = (event: MouseEvent, id: string): void => {
  if (event.button === 1) closePage(id)
}

const onStripKey = (event: KeyboardEvent): void => {
  const main = (event.target as HTMLElement).closest('.rp-page-main')
  if (!main) return
  const ids = urlPages.value.map((p) => p.id)
  const cur = (main.closest('.rp-page') as HTMLElement | null)?.dataset.id ?? ''
  const i = ids.indexOf(cur)
  let to: string | undefined
  if (event.key === 'ArrowRight') to = ids[(i + 1) % ids.length]
  else if (event.key === 'ArrowLeft') to = ids[(i - 1 + ids.length) % ids.length]
  else if (event.key === 'Home') to = ids[0]
  else if (event.key === 'End') to = ids[ids.length - 1]
  if (to) {
    event.preventDefault()
    activate(to)
    focusActiveChip()
    return
  }
  if (event.key === 'Backspace' || event.key === 'Delete') {
    event.preventDefault()
    closePage(cur)
  }
}

const pageMenu = ref<{ id: string; x: number; y: number } | null>(null)
const hasPagesToRight = computed(() => {
  const id = pageMenu.value?.id
  if (!id) return false
  const i = urlPages.value.findIndex((p) => p.id === id)
  return i !== -1 && i < urlPages.value.length - 1
})
const openPageMenu = (event: MouseEvent, id: string): void => {
  const root = (event.currentTarget as HTMLElement).closest('.bp-url') as HTMLElement | null
  const rect = root?.getBoundingClientRect()
  pageMenu.value = {
    id,
    x: Math.max(6, event.clientX - (rect?.left ?? 0)),
    y: event.clientY - (rect?.top ?? 0) + 4
  }
  menuOpen.value = false
}
const ctx = (action: 'close' | 'others' | 'right'): void => {
  const id = pageMenu.value?.id
  pageMenu.value = null
  if (!id) return
  if (action === 'close') closePage(id)
  else if (action === 'others') bpStore.CLOSE_OTHER_PAGES(id)
  else bpStore.CLOSE_PAGES_TO_RIGHT(id)
}

// ── ⋯ 菜单：缩放 / 适应宽度 / 移动端样式 / 外部打开 / 复制链接 / 关闭 ─────────
const moreWrap = ref<HTMLElement | null>(null)
const menuEl = ref<HTMLElement | null>(null)
const menuOpen = ref(false)
const toggleMenu = (): void => {
  menuOpen.value = !menuOpen.value
  pageMenu.value = null
  if (menuOpen.value) {
    nextTick(() => menuEl.value?.querySelector<HTMLElement>('button:not(:disabled)')?.focus())
  }
}
const zoomLabel = computed(() => {
  const page = activePage.value
  if (!page) return '100%'
  return page.fitWidth
    ? `${t('rightPanel.web.fitShort')} · ${Math.round(page.zoom * 100)}%`
    : `${Math.round(page.zoom * 100)}%`
})
const zoom = (action: 'in' | 'out'): void => {
  if (activePageId.value) bpStore.APPLY_ZOOM_ACTION(activePageId.value, action)
}
const toggleFit = (): void => {
  bpStore.TOGGLE_FIT_WIDTH()
}
const toggleDevice = (): void => {
  menuOpen.value = false
  bpStore.TOGGLE_DEVICE_MODE()
}
const openExternal = (): void => {
  menuOpen.value = false
  const url = activePage.value?.url
  if (url) bpStore.OPEN_EXTERNAL(url).catch(() => {})
}
const copyLink = (): void => {
  menuOpen.value = false
  const url = activePage.value?.url
  if (url) window.electron.clipboard.writeText(url)
}
const onMenuKey = (event: KeyboardEvent): void => {
  const menu = event.currentTarget as HTMLElement
  const items = Array.from(menu.querySelectorAll<HTMLElement>('button:not(:disabled)'))
  const i = items.indexOf(document.activeElement as HTMLElement)
  if (event.key === 'ArrowDown') {
    event.preventDefault()
    ;(items[i + 1] ?? items[0])?.focus()
  } else if (event.key === 'ArrowUp') {
    event.preventDefault()
    ;(items[i - 1] ?? items[items.length - 1])?.focus()
  }
}

const onDocPointer = (event: PointerEvent): void => {
  const target = event.target as Node
  if (menuOpen.value && !moreWrap.value?.contains(target)) menuOpen.value = false
  if (pageMenu.value && !(target as Element).closest?.('.rp-ctx')) pageMenu.value = null
}
onMounted(() => document.addEventListener('pointerdown', onDocPointer, true))

// 缩放浮标自动隐藏：seq 变化（同文案连按）也会重置计时。
let hintTimer: number | null = null
watch(
  () => zoomHint.value?.seq,
  (seq) => {
    if (hintTimer !== null) window.clearTimeout(hintTimer)
    if (!seq) {
      hintTimer = null
      return
    }
    hintTimer = window.setTimeout(() => {
      bpStore.zoomHint = null
      hintTimer = null
    }, 1400)
  }
)

// 完成过一次加载的页面不再显示整层 loading 覆盖（后续导航只显示进度线）。
const loadedOnce = ref<Set<string>>(new Set())
watch(
  () => urlPages.value.map((p) => `${p.id}:${p.loading}:${!!p.error}`).join('|'),
  () => {
    for (const page of urlPages.value) {
      if (!page.loading && !page.error && !loadedOnce.value.has(page.id)) {
        const next = new Set(loadedOnce.value)
        next.add(page.id)
        loadedOnce.value = next
      }
    }
  },
  { immediate: true }
)

// 新建页落地后退出「新建」态
watch(activePageId, () => {
  if (!editing.value) newPage.value = false
})

onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', onDocPointer, true)
  if (hintTimer !== null) window.clearTimeout(hintTimer)
  if (undoTimer) clearTimeout(undoTimer)
})

defineExpose({ focusAddress: () => startEdit() })
</script>
