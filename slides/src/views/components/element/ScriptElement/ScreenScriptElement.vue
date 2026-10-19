<template>
  <div
    class="screen-element-script base-element-script"
    :style="{ top: elementInfo.top + 'px', left: elementInfo.left + 'px', width: elementInfo.width + 'px', height: elementInfo.height + 'px' }"
  >
    <div class="rotate-wrapper" :style="{ transform: `rotate(${elementInfo.rotate}deg)` }">
      <ScriptPoster v-if="!live" :elementInfo="elementInfo" />
      <div class="frame" ref="frameRef" v-show="live"></div>
    </div>
  </div>
</template>

<script lang="ts" setup>
import { computed, inject, onMounted, onUnmounted, ref, watch } from 'vue'
import { storeToRefs } from 'pinia'
import { useSlidesStore } from '@/store'
import type { PPTScriptElement } from '@/types/slides'
import { injectKeySlideId, injectKeySlideScale } from '@/types/injectKey'
import { ScriptHost } from '@/utils/scripts'
import ScriptPoster from './ScriptPoster.vue'

const props = defineProps<{
  elementInfo: PPTScriptElement
}>()

const { currentSlide, theme } = storeToRefs(useSlidesStore())
const slideId = inject(injectKeySlideId, ref(''))
const scale = inject(injectKeySlideScale, ref(1))
const frameRef = ref<HTMLElement | null>(null)
const live = ref(false)
let host: ScriptHost | null = null

const isCurrent = computed(() => currentSlide.value?.id === slideId.value)

// The script starts when its slide is first shown and keeps its state while the slide is near.
const start = async () => {
  if (host || !frameRef.value) return
  host = new ScriptHost(props.elementInfo, slideId.value, 'screen')
  try {
    await host.start(frameRef.value, { theme: theme.value, pixelRatio: window.devicePixelRatio * scale.value })
    live.value = true
    if (isCurrent.value) host.enter()
  }
  catch {
    host.destroy()
    host = null
  }
}

watch(isCurrent, (now, before) => {
  if (now) {
    if (host) host.enter()
    else void start()
  }
  else if (before) host?.leave()
})

onMounted(() => { if (isCurrent.value) void start() })
onUnmounted(() => host?.destroy())
</script>

<style lang="scss" scoped>
.screen-element-script {
  position: absolute;
}
.rotate-wrapper, .frame {
  width: 100%;
  height: 100%;
}
</style>
