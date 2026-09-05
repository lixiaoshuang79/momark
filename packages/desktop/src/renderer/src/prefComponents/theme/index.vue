<template>
  <div class="pref-theme">
    <h4>{{ t('preferences.theme.title') }}</h4>
    <section class="appearance-card">
      <div class="row">
        <div class="lbl">
          {{ t('preferences.theme.appearance') }}
          <div class="sub">
            {{ t('preferences.theme.appearanceSub') }}
          </div>
        </div>
        <div class="radio-group">
          <label>
            <input
              type="radio"
              name="momark-appearance"
              :checked="appearance === 'auto'"
              @change="selectAppearance('auto')"
            />
            <span>{{ t('preferences.theme.followSystem') }}</span>
          </label>
          <label>
            <input
              type="radio"
              name="momark-appearance"
              :checked="appearance === 'light'"
              @change="selectAppearance('light')"
            />
            <span>{{ t('preferences.theme.light') }}</span>
          </label>
          <label>
            <input
              type="radio"
              name="momark-appearance"
              :checked="appearance === 'dark'"
              @change="selectAppearance('dark')"
            />
            <span>{{ t('preferences.theme.dark') }}</span>
          </label>
        </div>
      </div>
    </section>

    <div class="custom-css">
      <div class="description">
        {{ t('preferences.theme.customCss') }}
      </div>
      <textarea
        class="custom-css-input"
        rows="10"
        :value="customCss"
        @change="
          (event: Event) => onSelectChange('customCss', (event.target as HTMLTextAreaElement).value)
        "
      />
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { usePreferencesStore } from '@/store/preferences'
import type { PreferencesState } from '@/store/preferences'
import { storeToRefs } from 'pinia'
import { useI18n } from 'vue-i18n'

const { t } = useI18n()
const preferenceStore = usePreferencesStore()

const { followSystemTheme, theme } = storeToRefs(preferenceStore)

type Appearance = 'auto' | 'light' | 'dark'

// 三选派生值：跟随系统 / 浅色（claude-light）/ 深色（claude-dark）。
const appearance = computed<Appearance>(() => {
  if (followSystemTheme.value) {
    return 'auto'
  }
  return theme.value === 'claude-dark' ? 'dark' : 'light'
})

const selectAppearance = (value: Appearance): void => {
  if (value === 'auto') {
    preferenceStore.SET_SINGLE_PREFERENCE({ type: 'followSystemTheme', value: true })
    preferenceStore.SET_SINGLE_PREFERENCE({ type: 'lightModeTheme', value: 'claude-light' })
    preferenceStore.SET_SINGLE_PREFERENCE({ type: 'darkModeTheme', value: 'claude-dark' })
  } else if (value === 'light') {
    preferenceStore.SET_SINGLE_PREFERENCE({ type: 'followSystemTheme', value: false })
    preferenceStore.SET_SINGLE_PREFERENCE({ type: 'theme', value: 'claude-light' })
  } else {
    preferenceStore.SET_SINGLE_PREFERENCE({ type: 'followSystemTheme', value: false })
    preferenceStore.SET_SINGLE_PREFERENCE({ type: 'theme', value: 'claude-dark' })
  }
}

const { customCss } = storeToRefs(preferenceStore)

const onSelectChange = (type: keyof PreferencesState, value: unknown): void => {
  preferenceStore.SET_SINGLE_PREFERENCE({ type, value })
}
</script>

<style>
.pref-theme {
  & .appearance-card {
    margin-top: 14px;
    background: var(--surface-2);
    border: 1px solid var(--line);
    border-radius: 10px;
    padding: 4px 16px;
  }

  & .row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    padding: 11px 0;
    color: var(--ink);

    & .lbl {
      font-size: 14px;

      & .sub {
        font-size: 12px;
        color: var(--muted);
        margin-top: 3px;
      }
    }
  }

  & .radio-group {
    display: flex;
    gap: 14px;

    & label {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      font-size: 14px;
      color: var(--ink);
      cursor: pointer;
      user-select: none;
    }

    & input[type='radio'] {
      accent-color: var(--accent);
    }
  }
}

.custom-css {
  margin: 20px 0;
  font-size: 14px;
  color: var(--ink);
  & .description {
    margin-bottom: 10px;
  }
  & .custom-css-input {
    width: 100%;
    background: transparent;
    color: var(--ink);
    border: 1px solid var(--line-strong);
    border-radius: 4px;
    padding: 8px 10px;
    font-family: 'DejaVu Sans Mono', 'Source Code Pro', 'Droid Sans Mono', Consolas, monospace;
    font-size: 12px;
    line-height: 1.5;
    box-sizing: border-box;
    resize: vertical;
  }
  & .custom-css-input:focus {
    outline: none;
    border-color: var(--accent);
  }
}
</style>
