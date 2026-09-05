<template>
  <div class="about-page">
    <div class="win-titlebar" />

    <div class="about-body">
      <!-- 冻结 icon-1：92px、圆角 21px -->
      <img class="app-icon" :src="MoMarkLogo" alt="墨记 MoMark" />
      <h2>墨记 MoMark</h2>
      <div class="ver">{{ t('about.version') }} {{ version }}</div>

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
import { computed, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { useMainStore } from '@/store'
import { addThemeStyle } from '@/util/theme'
import MoMarkLogo from '@/assets/images/logo.png'

const { t } = useI18n()

const mainStore = useMainStore()
const version = computed(() => mainStore.appVersion || '0.1.0')

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
