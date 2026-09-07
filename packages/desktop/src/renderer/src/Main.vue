<script setup lang="ts">
import IconSprite from './components/icons/IconSprite.vue'
</script>

<template>
  <div id="app">
    <!-- 全局 icon sprite（原型 <defs> 逐字节移植）：editor/preference/welcome/about 各窗口共用 -->
    <icon-sprite />
    <!-- This router-view will render either App component (/editor) or Preference component (/preference) -->
    <router-view />
  </div>
</template>
