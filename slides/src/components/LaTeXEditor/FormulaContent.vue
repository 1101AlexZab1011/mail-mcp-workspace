<template>
  <div class="formula-content" :style="{ width: width + 'px', height: height + 'px' }">
    <div class="error" v-if="error">{{ error }}</div>
    <div class="svg" v-else v-html="svg"></div>
  </div>
</template>

<script lang="ts" setup>
import { ref, watch } from 'vue'
import { latexToSVG } from '@/utils/latex'

const props = defineProps<{
  latex: string
  width: number
  height: number
}>()

const svg = ref('')
const error = ref('')

watch(() => props.latex, () => {
  try {
    svg.value = props.latex ? latexToSVG(props.latex) : ''
    error.value = ''
  }
  catch (e) {
    error.value = (e as Error).message
  }
}, { immediate: true })
</script>

<style lang="scss" scoped>
.formula-content {
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  font-size: 28px;
}
.svg {
  max-width: 100%;
  max-height: 100%;

  :deep(svg) {
    max-width: 100%;
    max-height: 100%;
  }
}
.error {
  font-size: 13px;
  color: #d14424;
  padding: 0 16px;
}
</style>
