<template>
  <div class="welcome-page">
    <!-- 原生红绿灯区（macOS hiddenInset）+ 拖拽区：标题居中 -->
    <div class="win-titlebar">
      <span class="win-title">{{ t('welcome.windowTitle') }}</span>
    </div>

    <div class="welcome-body">
      <div class="welcome-left">
        <div class="hi">
          {{ t('welcome.hi') }}
        </div>
        <div class="hi-sub">
          {{ t('welcome.hiSub') }}
        </div>

        <button class="bigbtn" @click="onNewDocument">
          <!-- 笔：极简内联 SVG（不引入新资产） -->
          <svg
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            stroke-width="1.3"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <path
              d="M2.5 13.5l1.1-3.6 8.2-8.2a1.06 1.06 0 011.5 0l1 1a1.06 1.06 0 010 1.5l-8.2 8.2-3.6 1.1z"
            />
            <path d="M10.3 3.2l2.5 2.5" />
          </svg>
          <span>{{ t('welcome.newDocument') }}</span>
        </button>

        <button class="bigbtn" @click="onOpenFolder">
          <!-- 文件夹 -->
          <svg
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            stroke-width="1.3"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <path
              d="M1.8 4.2c0-.8.6-1.4 1.4-1.4h3l1.6 1.6h5c.8 0 1.4.6 1.4 1.4v6.4c0 .8-.6 1.4-1.4 1.4H3.2c-.8 0-1.4-.6-1.4-1.4V4.2z"
            />
          </svg>
          <span>{{ t('welcome.openFolder') }}</span>
        </button>

        <button class="bigbtn" @click="onOpenFile">
          <!-- 文件 -->
          <svg
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            stroke-width="1.3"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <path
              d="M9.3 1.8H4.6c-.8 0-1.4.6-1.4 1.4v9.6c0 .8.6 1.4 1.4 1.4h6.8c.8 0 1.4-.6 1.4-1.4V5.3l-3.5-3.5z"
            />
            <path d="M9.3 1.8v3.5h3.5" />
          </svg>
          <span>{{ t('welcome.openFile') }}</span>
        </button>
      </div>

      <div class="welcome-right">
        <template v-if="recents.length > 0">
          <h4>{{ t('welcome.recentTitle') }}</h4>
          <div class="recent-list">
            <button
              v-for="item in recents"
              :key="item.path"
              class="recent-item"
              :title="item.path"
              @click="onOpenRecent(item.path)"
            >
              <svg
                viewBox="0 0 16 16"
                fill="none"
                stroke="currentColor"
                stroke-width="1.3"
                stroke-linecap="round"
                stroke-linejoin="round"
              >
                <path
                  d="M9.3 1.8H4.6c-.8 0-1.4.6-1.4 1.4v9.6c0 .8.6 1.4 1.4 1.4h6.8c.8 0 1.4-.6 1.4-1.4V5.3l-3.5-3.5z"
                />
                <path d="M9.3 1.8v3.5h3.5" />
              </svg>
              <div class="rn">
                <div class="n">
                  {{ item.name }}
                </div>
                <div class="p">
                  {{ item.dirname }}
                </div>
              </div>
              <span class="t">{{ formatTime(item.mtime) }}</span>
            </button>
          </div>
        </template>

        <div v-else class="no-recent">
          <!-- 时钟：极简内联 SVG -->
          <svg
            viewBox="0 0 36 36"
            fill="none"
            stroke="currentColor"
            stroke-width="1.6"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <circle cx="18" cy="18" r="13.5" />
            <path d="M18 11.5v6.5l4 2.6" />
          </svg>
          <p>{{ t('welcome.noRecentText') }}</p>
          <button class="nr-new" @click="onNewDocument">
            {{ t('welcome.newDocument') }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { addThemeStyle } from '@/util/theme'
import dayjs from '@/util/day'

interface WelcomeRecent {
  path: string
  name: string
  dirname: string
  mtime: number
}

const { t } = useI18n()

const recents = ref<WelcomeRecent[]>([])

const applyInitialTheme = (): void => {
  // 欢迎窗口不在 App 壳内，主题样式需要自行应用一次（initialState.theme 来自主进程 URL 参数）。
  const theme = window.marktext?.initialState?.theme
  addThemeStyle(theme ?? 'claude-light')
}

const loadRecents = async (): Promise<void> => {
  try {
    recents.value = await window.electron.ipcRenderer.invoke('mt::welcome::recents')
  } catch {
    recents.value = []
  }
}

const onNewDocument = (): void => {
  window.electron.ipcRenderer.send('mt::welcome::new-doc')
}

const onOpenFolder = (): void => {
  window.electron.ipcRenderer.send('mt::welcome::open-folder')
}

const onOpenFile = (): void => {
  window.electron.ipcRenderer.send('mt::welcome::open-file')
}

const onOpenRecent = (filePath: string): void => {
  window.electron.ipcRenderer.send('mt::welcome::open-recent', filePath)
}

const formatTime = (mtime: number): string => {
  const m = dayjs(mtime)
  const now = dayjs()
  if (m.isSame(now, 'day')) return t('welcome.timeToday')
  if (m.isSame(now.subtract(1, 'day'), 'day')) return t('welcome.timeYesterday')
  return m.format('YYYY-MM-DD')
}

onMounted(() => {
  applyInitialTheme()
  loadRecents()
})
</script>

<style scoped>
.welcome-page {
  height: 100vh;
  display: flex;
  flex-direction: column;
  background: var(--bg);
  color: var(--ink);
  font-family: var(--font-body);
  overflow: hidden;
}

.win-titlebar {
  flex: none;
  height: 38px;
  display: flex;
  align-items: center;
  justify-content: center;
  -webkit-app-region: drag;
}

.win-title {
  font-size: var(--f11);
  color: var(--faint);
  user-select: none;
}

.welcome-body {
  flex: 1;
  display: flex;
  padding: 20px 28px 28px;
  min-height: 0;
}

/* ── 左列：问候 + 三大按钮（44px 高、图标+文字单行、无快捷键提示） ── */
.welcome-left {
  width: 212px;
  flex: none;
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding-right: 24px;
  border-right: 1px solid var(--line);
}

.hi {
  font-family: var(--font-display);
  font-weight: 500;
  font-size: 19px;
  margin-bottom: 2px;
}

.hi-sub {
  font-size: var(--f11);
  color: var(--muted);
  margin: 0 0 10px;
  line-height: 1.6;
}

.bigbtn {
  height: 44px;
  flex: none;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 0 14px;
  border: none;
  border-radius: var(--radius);
  background: var(--surface-2);
  color: var(--ink);
  font-size: var(--f12);
  font-family: var(--font-body);
  cursor: pointer;
  box-shadow: var(--elev-ring);
  transition: background var(--motion-fast) var(--ease-standard);
}

.bigbtn:hover {
  background: var(--hover);
}

.bigbtn:active {
  background: var(--selected);
}

.bigbtn:focus-visible {
  outline: none;
  box-shadow: var(--focus-ring);
}

.bigbtn svg {
  width: 16px;
  height: 16px;
  flex: none;
  color: var(--muted);
}

/* ── 右列：最近打开列表 / 首启空态 ── */
.welcome-right {
  flex: 1;
  padding-left: 24px;
  min-width: 0;
  display: flex;
  flex-direction: column;
}

.welcome-right h4 {
  font-size: var(--f12);
  font-weight: 600;
  color: var(--muted);
  margin: 0 0 10px;
}

.recent-list {
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.recent-item {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 8px 10px;
  border: none;
  border-radius: var(--radius);
  background: transparent;
  color: var(--ink);
  font-family: var(--font-body);
  text-align: left;
  cursor: pointer;
  transition: background var(--motion-fast) var(--ease-standard);
}

.recent-item:hover {
  background: var(--hover);
}

.recent-item svg {
  width: 15px;
  height: 15px;
  flex: none;
  color: var(--faint);
}

.recent-item .rn {
  flex: 1;
  min-width: 0;
}

.recent-item .n {
  font-size: var(--f12);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.recent-item .p {
  font-size: var(--f11);
  color: var(--faint);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.recent-item .t {
  flex: none;
  font-size: var(--f11);
  color: var(--faint);
}

/* 首次启动空态：时钟插画 + 文案 + 新建文档按钮 */
.no-recent {
  flex: 1;
  display: grid;
  place-items: center;
  align-content: center;
  gap: 12px;
  text-align: center;
  min-height: 0;
}

.no-recent svg {
  width: 36px;
  height: 36px;
  color: var(--faint);
  opacity: 0.7;
}

.no-recent p {
  font-size: var(--f11);
  color: var(--muted);
  line-height: 1.7;
  margin: 0;
  white-space: pre-line;
}

.nr-new {
  height: 30px;
  padding: 0 14px;
  border: none;
  border-radius: var(--radius);
  background: var(--accent);
  color: var(--accent-on);
  font-size: var(--f11);
  font-weight: 600;
  font-family: var(--font-body);
  cursor: pointer;
  transition: background var(--motion-fast) var(--ease-standard);
}

.nr-new:hover {
  background: var(--accent-hover);
}
</style>
