<template>
  <div
    class="editable-element-script"
    :class="{ 'lock': elementInfo.lock }"
    :style="{ top: elementInfo.top + 'px', left: elementInfo.left + 'px', width: elementInfo.width + 'px', height: elementInfo.height + 'px' }"
  >
    <div class="rotate-wrapper" :style="{ transform: `rotate(${elementInfo.rotate}deg)` }">
      <div
        class="element-content"
        v-contextmenu="contextmenus"
        @mousedown="$event => handleSelectElement($event)"
        @touchstart="$event => handleSelectElement($event)"
        @dblclick="openScriptEditor()"
      >
        <ScriptPoster v-if="!running" :elementInfo="elementInfo" />
        <div class="frame" ref="frameRef" v-show="running"></div>
        <!-- The running frame would swallow clicks; this layer keeps the element selectable and movable. -->
        <div class="cover"></div>
        <div class="run" :class="{ running }" @mousedown.stop @click.stop="toggle()" v-tooltip="running ? 'Stop' : 'Run here'">
          <i-icon-park-outline:pause v-if="running" />
          <i-icon-park-outline:play-one v-else />
        </div>
        <div class="error" v-if="error" :title="error">{{ error }}</div>
      </div>
    </div>
  </div>
</template>

<script lang="ts" setup>
import { onUnmounted, ref, watch } from 'vue'
import { storeToRefs } from 'pinia'
import { useMainStore, useSlidesStore } from '@/store'
import type { PPTScriptElement } from '@/types/slides'
import type { ContextmenuItem } from '@/components/Contextmenu/types'
import { ScriptHost } from '@/utils/scripts'
import { openScriptEditor as openEditor } from '@/views/Editor/Script/state'
import ScriptPoster from './ScriptPoster.vue'

const props = defineProps<{
  elementInfo: PPTScriptElement
  selectElement: (e: MouseEvent | TouchEvent, element: PPTScriptElement, canMove?: boolean) => void
  contextmenus: () => ContextmenuItem[] | null
}>()

const { theme, currentSlide } = storeToRefs(useSlidesStore())
const { canvasScale } = storeToRefs(useMainStore())
const frameRef = ref<HTMLElement | null>(null)
const running = ref(false)
const error = ref('')
let host: ScriptHost | null = null

const handleSelectElement = (e: MouseEvent | TouchEvent) => {
  if (props.elementInfo.lock) return
  e.stopPropagation()
  props.selectElement(e, props.elementInfo)
}

const stop = () => {
  host?.destroy()
  host = null
  running.value = false
}

const toggle = async () => {
  if (running.value) return stop()
  error.value = ''
  host = new ScriptHost(props.elementInfo, currentSlide.value.id, 'editor')
  host.onError = message => error.value = message
  try {
    running.value = true
    await host.start(frameRef.value!, { theme: theme.value, pixelRatio: window.devicePixelRatio * canvasScale.value })
    host.enter()
  }
  catch (e) {
    const message = (e as Error).message
    error.value = message === 'not-trusted' ? 'Scripts are off for this deck' : message
    stop()
  }
}

// A changed script or size restarts it cleanly.
watch(() => [props.elementInfo.src, props.elementInfo.width, props.elementInfo.height, props.elementInfo.libs], () => { if (running.value) stop() })

const openScriptEditor = () => openEditor(props.elementInfo.id)

onUnmounted(stop)
</script>

<style lang="scss" scoped>
.editable-element-script {
  position: absolute;

  &.lock .element-content {
    cursor: default;
  }
}
.rotate-wrapper, .frame {
  width: 100%;
  height: 100%;
}
.element-content {
  width: 100%;
  height: 100%;
  position: relative;
  cursor: move;
}
.cover {
  position: absolute;
  inset: 0;
}
.run {
  position: absolute;
  right: 6px;
  bottom: 6px;
  width: 28px;
  height: 28px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(30, 34, 44, .7);
  color: #fff;
  cursor: pointer;
  font-size: 14px;
  opacity: .85;

  &:hover {
    opacity: 1;
  }
}
.error {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  padding: 3px 8px;
  font-size: 12px;
  color: #fff;
  background: rgba(200, 40, 40, .85);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
</style>
