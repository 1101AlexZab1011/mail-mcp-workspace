<template>
  <div
    class="base-element-script"
    :style="{ top: elementInfo.top + 'px', left: elementInfo.left + 'px', width: elementInfo.width + 'px', height: elementInfo.height + 'px' }"
  >
    <div class="rotate-wrapper" :style="{ transform: `rotate(${elementInfo.rotate}deg)` }">
      <ScriptPoster :elementInfo="elementInfo" />
    </div>
  </div>
</template>

<script lang="ts" setup>
import type { PPTScriptElement } from '@/types/slides'
import ScriptPoster from './ScriptPoster.vue'

defineProps<{
  elementInfo: PPTScriptElement
}>()
</script>

<style lang="scss" scoped>
.base-element-script {
  position: absolute;
}
.rotate-wrapper {
  width: 100%;
  height: 100%;
}
</style>
