<template>
  <div class="pref-image">
    <h4>{{ t('preferences.image.title') }}</h4>

    <section class="card">
      <div class="row">
        <div class="lbl">
          {{ t('preferences.image.insertBehavior') }}
          <div class="sub">
            {{ t('preferences.image.insertBehaviorSub') }}
          </div>
        </div>
        <CurSelect
          :value="imageInsertBehavior"
          :options="behaviorOptions"
          :on-change="(value) => onSelectChange('imageInsertBehavior', value)"
        />
      </div>

      <div class="row">
        <div class="lbl">
          {{ t('preferences.image.location') }}
          <div class="sub">
            {{ t('preferences.image.locationSub') }}
          </div>
        </div>
        <CurSelect
          :value="location"
          :options="locationOptions"
          :on-change="(value) => setLocation(value)"
        />
      </div>

      <div v-if="location === 'relative'" class="row">
        <div class="lbl">
          {{ t('preferences.image.relativeFolderName') }}
          <div class="sub">
            {{ t('preferences.image.relativeFolderNameSub') }}
          </div>
        </div>
        <text-box
          class="relative-name"
          :input="imageRelativeDirectoryName"
          :regex-validator="/^(?:$|(?![a-zA-Z]:)[^\/\\].*$)/"
          :default-value="'assets'"
          :on-change="(value) => onSelectChange('imageRelativeDirectoryName', value)"
        />
      </div>

      <div v-if="location === 'global'" class="row">
        <div class="lbl">
          {{ t('preferences.image.folderSetting.globalFolder') }}
        </div>
        <div class="global-folder">
          <text-box
            :input="imageFolderPath"
            :regex-validator="/^(?:$|([a-zA-Z]:)?[\/\\].*$)/"
            :default-value="''"
            :on-change="(value) => setImageFolderPath(value)"
          />
          <el-button size="mini" @click="setImageFolderPath(undefined)">
            {{ t('preferences.image.folderSetting.open') }}
          </el-button>
        </div>
      </div>

      <div class="row">
        <div class="lbl">
          {{ t('preferences.image.uploaderToggle') }}
          <div class="sub">
            {{ t('preferences.image.uploaderToggleSub') }}
          </div>
        </div>
        <Bool
          :bool="imageUploaderEnabled"
          :on-change="(value) => onSelectChange('imageUploaderEnabled', value)"
        />
      </div>

      <div v-if="imageUploaderEnabled" class="row">
        <div class="lbl">
          {{ t('preferences.image.uploaderService') }}
        </div>
        <CurSelect
          :value="imageUploaderService"
          :options="uploaderServiceOptions"
          :on-change="(value) => onSelectChange('imageUploaderService', value)"
        />
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { storeToRefs } from 'pinia'
import { useI18n } from 'vue-i18n'
import { usePreferencesStore } from '@/store/preferences'
import type { PreferencesState } from '@/store/preferences'
import type { PrefSelectOption } from '../common/types'
import CurSelect from '../common/select/index.vue'
import Bool from '../common/bool/index.vue'
import TextBox from '../common/textBox/index.vue'

const { t } = useI18n()

const preferenceStore = usePreferencesStore()

const {
  imageInsertBehavior,
  imageInsertAction,
  imagePreferRelativeDirectory,
  imageRelativeDirectoryName,
  imageFolderPath,
  imageUploaderEnabled,
  imageUploaderService
} = storeToRefs(preferenceStore)

const behaviorOptions: PrefSelectOption<string>[] = [
  { label: t('preferences.image.behavior.render'), value: 'render' },
  { label: t('preferences.image.behavior.viewer'), value: 'viewer' }
]

const locationOptions: PrefSelectOption<string>[] = [
  { label: t('preferences.image.location.relative'), value: 'relative' },
  { label: t('preferences.image.location.global'), value: 'global' },
  { label: t('preferences.image.location.path'), value: 'path' }
]

const uploaderServiceOptions: PrefSelectOption<string>[] = [
  { label: t('preferences.image.uploaderService.picgo'), value: 'picgo' },
  { label: t('preferences.image.uploaderService.tencentCos'), value: 'tencent-cos' }
]

// 落盘位置三选 → schema 键映射：
//   relative = folder + preferRelative（相对目录 assets/，支持 ${filename} 变量语义留配置）
//   global   = folder + 绝对指定目录（imageFolderPath）
//   path     = 保持原位置
const location = computed<string>(() => {
  if (imageInsertAction.value === 'path') {
    return 'path'
  }
  if (imagePreferRelativeDirectory.value) {
    return 'relative'
  }
  return 'global'
})

const setLocation = (value: unknown): void => {
  const next = String(value)
  if (next === 'path') {
    preferenceStore.SET_SINGLE_PREFERENCE({ type: 'imageInsertAction', value: 'path' })
  } else if (next === 'relative') {
    preferenceStore.SET_SINGLE_PREFERENCE({ type: 'imageInsertAction', value: 'folder' })
    preferenceStore.SET_SINGLE_PREFERENCE({ type: 'imagePreferRelativeDirectory', value: true })
    preferenceStore.SET_SINGLE_PREFERENCE({ type: 'imageRelativeDirectoryBase', value: 'file' })
  } else {
    preferenceStore.SET_SINGLE_PREFERENCE({ type: 'imageInsertAction', value: 'folder' })
    preferenceStore.SET_SINGLE_PREFERENCE({ type: 'imagePreferRelativeDirectory', value: false })
  }
}

const setImageFolderPath = (value: string | undefined): void => {
  preferenceStore.SET_IMAGE_FOLDER_PATH(value)
}

const onSelectChange = (type: keyof PreferencesState, value: unknown): void => {
  preferenceStore.SET_SINGLE_PREFERENCE({ type, value })
}
</script>

<style>
.pref-image {
  & .card {
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
    border-bottom: 1px solid var(--line);
    color: var(--ink);

    &:last-child {
      border-bottom: none;
    }

    & .lbl {
      font-size: 14px;
      flex: none;
      max-width: 60%;

      & .sub {
        font-size: 12px;
        color: var(--muted);
        margin-top: 3px;
      }
    }

    & .el-select {
      width: 200px;
      flex: none;
    }

    & .pref-select-item,
    & .pref-bool-item {
      margin: 0;
      flex: none;
    }
  }

  & .global-folder {
    display: flex;
    align-items: center;
    gap: 8px;
    flex: none;

    & .pref-text-box-item {
      margin: 0;
    }
  }
}
</style>
