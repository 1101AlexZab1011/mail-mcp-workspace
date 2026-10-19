<template>
  <Modal :visible="scriptEditor.visible" :width="980" @closed="close()">
    <div class="script-editor" v-if="element">
      <div class="header">
        <div class="heading">Script <span class="file">{{ element.src }}</span></div>
        <div class="settings">
          <label class="lib" v-for="lib in LIBS" :key="lib"><input type="checkbox" :checked="libs.includes(lib)" @change="toggleLib(lib)" /> {{ lib }}</label>
          <span class="label">Steps:</span>
          <NumberInput class="steps" :min="0" :max="50" v-model:value="steps" />
        </div>
      </div>
      <div class="columns">
        <div class="code-column">
          <TextArea class="code" v-model:value="code" :rows="22" spellcheck="false" />
          <Input class="data" v-model:value="data" placeholder="Data files, comma-separated (e.g. data/ratemap.json)" />
        </div>
        <div class="preview-column">
          <div class="preview" :style="{ aspectRatio: `${element.width} / ${element.height}` }">
            <div class="frame" ref="frameRef"></div>
          </div>
          <div class="preview-actions">
            <Button @click="run()"><i-icon-park-outline:play-one /> Run</Button>
            <Button :disabled="!host || host.steps === 0" @click="host?.stepTo(host.step - 1)"><i-icon-park-outline:left /></Button>
            <span class="step">step {{ shownStep }} / {{ host?.steps ?? steps }}</span>
            <Button :disabled="!host || host.steps === 0" @click="host?.stepTo(host.step + 1)"><i-icon-park-outline:right /></Button>
            <Button :disabled="!host" @click="usePoster()" v-tooltip="'Use the current picture as the still shown in thumbnails and exports'"><i-icon-park-outline:camera /> Poster</Button>
          </div>
          <div class="console">
            <div v-for="(line, i) in consoleLines" :key="i" :class="line.kind">{{ line.text }}</div>
            <div v-if="!consoleLines.length" class="empty">Console output and errors appear here.</div>
          </div>
        </div>
      </div>
      <div class="footer">
        <Button v-if="hooks.ask" @click="askAgent()"><i-icon-park-outline:robot /> Ask the agent…</Button>
        <div class="spacer"></div>
        <Button @click="close()">Close</Button>
        <Button type="primary" @click="save()">Save</Button>
      </div>
    </div>
  </Modal>
</template>

<script lang="ts" setup>
import { computed, onUnmounted, ref, shallowRef, triggerRef, useTemplateRef, watch } from 'vue'
import { storeToRefs } from 'pinia'
import { useSlidesStore } from '@/store'
import type { PPTScriptElement } from '@/types/slides'
import { hooks } from '@/bridge/hooks'
import { ScriptHost } from '@/utils/scripts'
import message from '@/utils/message'
import useHistorySnapshot from '@/hooks/useHistorySnapshot'
import { scriptEditor } from './state'
import Modal from '@/components/Modal.vue'
import Input from '@/components/Input.vue'
import NumberInput from '@/components/NumberInput.vue'
import TextArea from '@/components/TextArea.vue'
import Button from '@/components/Button.vue'

const LIBS = ['d3', 'three']
const slidesStore = useSlidesStore()
const { currentSlide, theme, slideIndex } = storeToRefs(slidesStore)
const { addHistorySnapshot } = useHistorySnapshot()
const frameRef = useTemplateRef<HTMLElement>('frameRef')

const element = computed(() => currentSlide.value.elements.find(el => el.id === scriptEditor.elementId && el.type === 'script') as PPTScriptElement | undefined)
const code = ref('')
const savedCode = ref('')
const libs = ref<string[]>([])
const steps = ref(0)
const data = ref('')
const host = shallowRef<ScriptHost | null>(null)
const tick = ref(0)

const shownStep = computed(() => (tick.value, host.value?.step ?? 0))
const consoleLines = computed(() => {
  void tick.value
  if (!host.value) return []
  return [...host.value.logs.map(text => ({ kind: 'log', text })), ...host.value.errors.map(text => ({ kind: 'error', text }))]
})
// Logs arrive by message; refresh the view a few times a second while open.
const timer = setInterval(() => { if (scriptEditor.visible) tick.value++ }, 400)
onUnmounted(() => clearInterval(timer))

watch(() => [scriptEditor.visible, scriptEditor.elementId], async () => {
  stop()
  if (!scriptEditor.visible || !element.value) return
  libs.value = [...(element.value.libs ?? [])]
  steps.value = element.value.steps ?? 0
  data.value = (element.value.data ?? []).join(', ')
  code.value = savedCode.value = hooks.readScript ? await hooks.readScript(element.value.src).catch(() => '') : ''
  void run()
}, { immediate: true })

const draft = (): PPTScriptElement => ({
  ...element.value!,
  libs: [...libs.value],
  steps: steps.value,
  data: data.value.split(',').map(item => item.trim()).filter(Boolean),
})

const stop = () => {
  host.value?.destroy()
  host.value = null
}

const run = async () => {
  stop()
  if (!element.value || !frameRef.value) return
  const next = new ScriptHost(draft(), currentSlide.value.id, 'preview')
  host.value = next
  next.onError = () => tick.value++
  try {
    await next.start(frameRef.value, { theme: theme.value, code: code.value })
    next.enter()
  }
  catch (e) {
    const text = (e as Error).message
    next.errors.push(text === 'not-trusted' ? 'Scripts are off for this deck (not trusted)' : text)
  }
  triggerRef(host)
  tick.value++
}

const toggleLib = (lib: string) => {
  libs.value = libs.value.includes(lib) ? libs.value.filter(item => item !== lib) : [...libs.value, lib]
}

const usePoster = async () => {
  if (!host.value || !hooks.savePoster || !element.value) return
  try {
    const poster = await hooks.savePoster(await host.value.capture())
    slidesStore.updateElement({ id: element.value.id, props: { poster } })
    addHistorySnapshot()
    message.success('Poster updated')
  }
  catch (e) {
    message.error((e as Error).message)
  }
}

const save = async () => {
  if (!element.value) return
  if (code.value !== savedCode.value) {
    if (!hooks.writeScript) return message.error('Scripts cannot be saved here')
    await hooks.writeScript(element.value.src, code.value)
    savedCode.value = code.value
  }
  const { libs: l, steps: s, data: d } = draft()
  slidesStore.updateElement({ id: element.value.id, props: { libs: l, steps: s, data: d } })
  addHistorySnapshot()
  message.success('Script saved')
}

const askAgent = () => {
  if (!element.value) return
  hooks.ask?.({
    target: 'element',
    slideIndex: slideIndex.value,
    slideId: currentSlide.value.id,
    elements: [{ id: element.value.id, type: 'script', name: element.value.name, text: `${element.value.src}${host.value?.errors.length ? `\nErrors:\n${host.value.errors.join('\n')}` : ''}` }],
  })
}

const close = () => {
  stop()
  scriptEditor.visible = false
}
</script>

<style lang="scss" scoped>
.script-editor {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.heading {
  font-size: 16px;
  font-weight: 600;

  .file {
    font-weight: 400;
    font-size: 13px;
    color: var(--pp-text-3);
    margin-left: 8px;
  }
}
.settings {
  display: flex;
  align-items: center;
  gap: 12px;
  font-size: 13px;

  .steps {
    width: 90px;
  }
}
.columns {
  display: flex;
  gap: 16px;
}
.code-column {
  flex: 1.3;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.code {
  font-family: 'JetBrainsMono', monospace;
  font-size: 12px;
}
.preview-column {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.preview {
  width: 100%;
  max-height: 300px;
  background: #fff;
  border: 1px solid var(--pp-border);
  border-radius: $borderRadius;
  overflow: hidden;
}
.frame {
  width: 100%;
  height: 100%;
}
.preview-actions {
  display: flex;
  align-items: center;
  gap: 6px;

  .step {
    font-size: 12px;
    color: var(--pp-text-3);
  }
}
.console {
  flex: 1;
  min-height: 100px;
  max-height: 180px;
  overflow: auto;
  font: 12px/1.5 'JetBrainsMono', monospace;
  padding: 6px 8px;
  border: 1px solid var(--pp-border);
  border-radius: $borderRadius;
  background: var(--pp-surface-2);

  .error {
    color: #d14424;
  }
  .empty {
    color: var(--pp-text-3);
  }
}
.footer {
  display: flex;
  gap: 8px;

  .spacer {
    flex: 1;
  }
}
</style>
