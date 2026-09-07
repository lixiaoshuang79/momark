<script setup lang="ts">
defineProps<{
  // 原型 symbol id，如 'i-globe' / 'i-x' / 'i-plus'
  name: string
}>()
</script>

<template>
  <!-- 与原型一致：svg 只带尺寸类，符号自带 stroke/fill 设定；尺寸由使用处 CSS 控制 -->
  <svg class="mo-ic" aria-hidden="true"><use :href="`#${name}`" /></svg>
</template>
