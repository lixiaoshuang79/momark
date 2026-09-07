<script setup lang="ts">
import { MO_SYMBOLS } from './moSymbols'

// 全局隐藏 sprite：与原型 <defs> 完全一致，供 <mo-icon> 用 <use> 引用。
// 只渲染一次（App.vue 挂载），icon 本体零重复。
</script>

<template>
  <svg
    class="mo-sprite"
    aria-hidden="true"
    style="position: absolute; width: 0; height: 0; overflow: hidden"
    v-html="MO_SYMBOLS"
  />
</template>
