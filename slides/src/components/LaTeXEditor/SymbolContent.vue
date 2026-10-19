<template>
  <div class="symbol-content" v-html="svg"></div>
</template>

<script lang="ts" setup>
import { computed } from 'vue'
import { latexToSVG } from '@/utils/latex'

const props = defineProps<{
  latex: string
}>()

const svg = computed(() => {
  try {
    return latexToSVG(props.latex, false)
  }
  catch {
    return props.latex
  }
})
</script>

<style lang="scss" scoped>
.symbol-content {
  font-size: 18px;
  display: flex;
  align-items: center;
  justify-content: center;
}
</style>
