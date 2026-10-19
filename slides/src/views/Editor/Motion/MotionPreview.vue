<template>
  <div class="motion-preview" :style="{ width: width + 'px', height: width * viewportRatio + 'px' }" @mouseenter="hoverPlay && play()">
    <div class="stage" ref="hostRef"></div>
    <div class="error" v-if="error">{{ error }}</div>
  </div>
</template>

<script lang="ts" setup>
import { getCurrentInstance, onMounted, onUnmounted, ref, watch } from 'vue'
import { storeToRefs } from 'pinia'
import { useSlidesStore } from '@/store'
import type { Slide } from '@/types/slides'
import { createStage, playOnStage, type MotionSpec, type Stage } from '@/utils/motionStage'

const props = withDefaults(defineProps<{
  from: Slide | null
  to: Slide
  spec: MotionSpec | null
  width?: number
  /** Play when the pointer enters (tiles); otherwise call play() or change the spec. */
  hoverPlay?: boolean
  autoplay?: boolean
}>(), { width: 236, hoverPlay: false, autoplay: false })

const { viewportRatio } = storeToRefs(useSlidesStore())
const app = getCurrentInstance()!.appContext.app
const hostRef = ref<HTMLElement | null>(null)
const error = ref('')
let stage: Stage | null = null
let animations: Animation[] = []
let token = 0

/** Build the stage showing the arriving slide at rest; play() then animates it. */
const show = async () => {
  const mine = ++token
  for (const animation of animations) animation.cancel()
  animations = []
  stage?.destroy()
  stage = null
  if (!hostRef.value) return null
  const next = await createStage(app, { from: props.from, to: props.to, width: props.width, host: hostRef.value })
  if (mine !== token) {
    next.destroy()
    return null
  }
  stage = next
  return next
}

const play = async () => {
  const mine = ++token
  for (const animation of animations) animation.cancel()
  animations = []
  stage?.destroy()
  stage = null
  error.value = ''
  if (!hostRef.value || !props.spec) return
  const next = await createStage(app, { from: props.from, to: props.to, width: props.width, host: hostRef.value })
  if (mine !== token) return next.destroy()
  stage = next
  try {
    animations = playOnStage(stage, props.spec, { from: props.from, to: props.to }).animations
  }
  catch (e) {
    error.value = (e as Error).message
  }
}

watch(() => props.spec, () => { void (props.autoplay ? play() : show()) }, { deep: true })
watch(() => [props.to, props.from], () => void show(), { deep: true })
onMounted(() => void (props.autoplay ? play() : show()))
onUnmounted(() => { token++; stage?.destroy() })
defineExpose({ play })
</script>

<style lang="scss" scoped>
.motion-preview {
  position: relative;
  overflow: hidden;
  border-radius: $borderRadius;
  background: #000;
}
.stage {
  position: absolute;
  inset: 0;
}
.error {
  position: absolute;
  inset: auto 0 0 0;
  padding: 4px 8px;
  font-size: 12px;
  color: #fff;
  background: rgba(200, 40, 40, .85);
}
</style>
