<template>
  <div class="pref-container">
    <title-bar v-if="showCustomTitleBar" />
    <div v-if="!showCustomTitleBar" class="title-bar" />
    <pref-tabs class="pref-tabs-row" />
    <div class="pref-content">
      <router-view class="pref-setting" />
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, watch, onMounted, nextTick } from 'vue'
import { usePreferencesStore } from '@/store/preferences'
import { storeToRefs } from 'pinia'
import TitleBar from '@/prefComponents/common/titlebar.vue'
import PrefTabs from '@/prefComponents/sideBar/index.vue'
import { addThemeStyle } from '@/util/theme'
import { DEFAULT_STYLE } from '@/config'
import { isOsx } from '@/util'

// Store
const preferencesStore = usePreferencesStore()

// Computed properties
const { theme, titleBarStyle } = storeToRefs(preferencesStore)

const showCustomTitleBar = computed<boolean>(() => {
  // Always show the custom title bar on macOS to provide a close button
  if (isOsx) {
    return true
  }
  return titleBarStyle.value === 'custom'
})

// Watchers
watch(theme, (newValue, oldValue) => {
  if (newValue !== oldValue) {
    addThemeStyle(newValue)
  }
})

// Lifecycle
onMounted(() => {
  nextTick(() => {
    const state = window.marktext?.initialState ?? DEFAULT_STYLE
    addThemeStyle(state.theme ?? DEFAULT_STYLE.theme)

    preferencesStore.ASK_FOR_USER_PREFERENCE()
  })
})
</script>

<style>
.pref-container {
  width: 100vw;
  height: 100vh;
  max-width: 100vw;
  max-height: 100vh;
  position: fixed;
  top: 0;
  left: 0;
  display: flex;
  flex-direction: column;
  background: var(--surface-0);

  & h1,
  & h2,
  & h3,
  & h4,
  & h5,
  & h6 {
    color: var(--ink);
    font-weight: 500;
    line-height: 1.4;
  }

  & h4 {
    margin: 0;
    font-size: 18px;
  }

  & h5 {
    font-size: 15px;
  }

  & h6 {
    font-size: 15px;
  }

  & .notes {
    display: block;
    margin: 8px 0 0;
    font-style: italic;
    font-size: 12px;
    color: var(--muted);
  }

  & .title-bar {
    width: 100%;
    height: var(--titleBarHeight);
    flex: none;
    -webkit-app-region: drag;
  }

  & .pref-tabs-row {
    width: 100%;
  }

  & .pref-content {
    position: relative;
    flex: 1;
    display: flex;
    flex-direction: column;
    min-height: 0;
    overflow: hidden;

    & .pref-setting {
      padding: 20px 24px;
      flex: 1;
      min-height: 0;
      overflow: auto;
    }

    & span,
    & div,
    & h1,
    & h2,
    & h3,
    & h4,
    & h5,
    & h6 {
      user-select: none;
    }
  }
}
</style>
