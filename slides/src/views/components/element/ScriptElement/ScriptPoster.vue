<template>
  <img v-if="elementInfo.poster" class="poster" :src="elementInfo.poster" alt="" draggable="false" />
  <div v-else class="placeholder">
    <i-icon-park-outline:code class="icon" />
    <span class="name">{{ elementInfo.src.split('/').pop() }}</span>
  </div>
</template>

<script lang="ts" setup>
import type { PPTScriptElement } from '@/types/slides'

defineProps<{
  elementInfo: PPTScriptElement
}>()
</script>

<style lang="scss" scoped>
.poster {
  width: 100%;
  height: 100%;
  object-fit: contain;
  display: block;
}
.placeholder {
  width: 100%;
  height: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 6px;
  border: 1px dashed #9aa3b2;
  background: rgba(127, 140, 160, .08);
  color: #6b7486;
  font-size: 14px;

  .icon {
    font-size: 28px;
  }
}
</style>
