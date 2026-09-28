<template>
  <div class="about-page">
    <div class="win-titlebar" />

    <div class="about-body">
      <!-- 冻结 icon-1：92px、圆角 21px -->
      <img class="app-icon" :src="MoMarkLogo" alt="墨记" />
      <h2>墨记</h2>
      <div class="ver">{{ t('about.version') }} {{ version }}</div>

      <!-- 检查更新（feat/updater）：查到新版后一键下载 + 提权替换 + 重启 -->
      <div class="update-row">
        <template v-if="state === 'idle'">
          <a href="#" @click.prevent="checkForUpdate">{{ t('about.checkUpdate') }}</a>
        </template>
        <template v-else-if="state === 'checking'">
          {{ t('about.checking') }}
        </template>
        <template v-else-if="state === 'latest'">
          {{ t('about.upToDate') }}
          <a href="#" @click.prevent="checkForUpdate">{{ t('about.recheck') }}</a>
        </template>
        <template v-else-if="state === 'available'">
          {{ t('about.updateAvailable', { version: info?.version ?? '' }) }}
          <button class="up-btn" type="button" @click="startInstall">
            {{ t('about.downloadAndInstall') }}
          </button>
        </template>
        <template v-else-if="state === 'downloading'">
          {{ t('about.downloading', { percent: percent }) }}
        </template>
        <template v-else-if="state === 'extracting'">
          {{ t('about.preparing') }}
        </template>
        <template v-else-if="state === 'installing'">
          {{ t('about.installing') }}
        </template>
        <template v-else-if="state === 'error'">
          {{ t('about.updateFailed') }}
          <a href="#" @click.prevent="openRelease">{{ t('about.manualDownload') }}</a>
        </template>
      </div>

      <div class="line" />

      <div class="links">
        <a href="#" @click.prevent="openExternal('https://momark.app')">官网 momark.app</a>
        ·
        <a href="#" @click.prevent="openExternal('https://github.com/momark')">GitHub 仓库</a>
        ·
        <a href="#" @click.prevent="openExternal('https://github.com/momark/issues')">问题反馈</a>
      </div>

      <div class="thanks">
        {{ t('about.thanks') }}
      </div>
      <div class="license">
        {{ t('about.license', { year: new Date().getFullYear() }) }}
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { t } from '../i18n'
import { useMainStore } from '@/store'
import { addThemeStyle } from '@/util/theme'
import type { IUpdateInfo } from '@shared/types/ipc'
import MoMarkLogo from '@/assets/images/logo.png'

const mainStore = useMainStore()
const version = computed(() => mainStore.appVersion || '0.1.0')

/** 更新流程的状态机：查 → 有/无新版 → 下载 → 解压 → 提权安装（此时应用会退出重启）。 */
type TUpdateState =
  | 'idle'
  | 'checking'
  | 'latest'
  | 'available'
  | 'downloading'
  | 'extracting'
  | 'installing'
  | 'error'

const state = ref<TUpdateState>('idle')
const info = ref<IUpdateInfo | null>(null)
const progress = ref({ received: 0, total: 0 })
let stopProgress: (() => void) | null = null

const percent = computed(() =>
  progress.value.total
    ? Math.min(100, Math.round((progress.value.received / progress.value.total) * 100))
    : 0
)

const checkForUpdate = async (): Promise<void> => {
  state.value = 'checking'

  try {
    const result = await window.electron.updater.check()

    if (result.error || !result.info) {
      state.value = 'error'
      return
    }

    if (result.hasUpdate && result.info.assetUrl) {
      info.value = result.info
      state.value = 'available'
    } else {
      state.value = 'latest'
    }
  } catch {
    state.value = 'error'
  }
}

const startInstall = async (): Promise<void> => {
  if (!info.value) return

  state.value = 'downloading'
  progress.value = { received: 0, total: 0 }
  stopProgress?.()
  stopProgress = window.electron.updater.onProgress((p) => {
    if (p.phase === 'extract') state.value = 'extracting'
    else progress.value = { received: p.received, total: p.total }
  })

  try {
    const { appPath } = await window.electron.updater.download(info.value)
    state.value = 'installing'
    // 成功后主进程会退出重启（安装脚本接管），这里等不到返回也正常
    await window.electron.updater.install(appPath)
  } catch {
    stopProgress?.()
    stopProgress = null
    state.value = 'error'
  }
}

const openRelease = (): void => {
  window.electron.updater.openRelease()
}

const applyInitialTheme = (): void => {
  // 关于窗口不在 App 壳内，主题样式需要自行应用一次。
  const theme = window.marktext?.initialState?.theme
  addThemeStyle(theme ?? 'claude-light')
}

const openExternal = (url: string): void => {
  window.electron.shell.openExternal(url)
}

onMounted(() => {
  applyInitialTheme()
})

onBeforeUnmount(() => {
  stopProgress?.()
})
</script>

<style scoped>
.about-page {
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
  -webkit-app-region: drag;
}

.about-body {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 26px 30px 24px;
  text-align: center;
  overflow-y: auto;
}

.app-icon {
  width: 92px;
  height: 92px;
  border-radius: 21px;
  flex: none;
  user-select: none;
  -webkit-user-drag: none;
}

h2 {
  font-family: var(--font-display);
  font-weight: 500;
  font-size: 20px;
  letter-spacing: 0.02em;
  margin: 14px 0 0;
}

.ver {
  font-size: var(--f11);
  color: var(--muted);
  margin-top: 5px;
}

/* 检查更新一行（feat/updater）：状态文案 + 内联动作，宽度变化时窗口不跳。 */
.update-row {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  min-height: 24px;
  margin-top: 8px;
  font-size: var(--f11);
  color: var(--muted);
}

.update-row a {
  color: var(--accent);
  text-decoration: none;
}

.update-row a:hover {
  text-decoration: underline;
}

.up-btn {
  padding: 3px 10px;
  border: none;
  border-radius: 4px;
  background: var(--accent);
  color: var(--accent-on);
  font-family: inherit;
  font-size: var(--f11);
  cursor: pointer;
}

.up-btn:hover {
  opacity: 0.9;
}

.line {
  width: 100%;
  border-top: 1px solid var(--line);
  margin: 18px 0;
}

.links {
  font-size: var(--f12);
  color: var(--muted);
  line-height: 2.2;
  text-align: left;
  width: 100%;
}

.links a {
  color: var(--accent);
  text-decoration: none;
}

.links a:hover {
  text-decoration: underline;
}

.thanks {
  font-size: var(--f11);
  color: var(--faint);
  line-height: 2;
  text-align: left;
  width: 100%;
  margin-top: 12px;
}

.license {
  font-size: var(--f11);
  color: var(--faint);
  margin-top: 12px;
}
</style>
