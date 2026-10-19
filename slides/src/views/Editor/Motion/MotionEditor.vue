<template>
  <Modal :visible="motionEditor.visible" :width="760" @closed="close()">
    <div class="motion-editor">
      <div class="header">
        <div class="heading">{{ isNew ? 'New custom' : 'Edit' }} {{ motionEditor.kind === 'transition' ? 'transition' : 'effect' }}</div>
        <Select
          v-if="isNew"
          class="starter"
          :value="starter"
          :options="starterOptions"
          @update:value="value => useStarter(value as string)"
        />
      </div>
      <div class="columns">
        <div class="fields">
          <div class="row"><div class="label">Name:</div><Input class="field" v-model:value="name" placeholder="e.g. iris" /></div>
          <div class="row"><div class="label">Label:</div><Input class="field" v-model:value="label" placeholder="shown in the menu" /></div>
          <div class="row">
            <div class="label">Duration:</div>
            <NumberInput class="field" :min="100" :max="10000" :step="100" v-model:value="duration"><template #suffix>ms</template></NumberInput>
          </div>
          <div class="row">
            <div class="label">Easing:</div>
            <Select class="field" :value="easingChoice" :options="easingOptions" @update:value="value => easingChoice = value as string" />
          </div>
          <div class="row" v-if="easingChoice === 'custom'"><div class="label"></div><Input class="field" v-model:value="customEasing" placeholder="cubic-bezier(.2, 0, 0, 1)" /></div>
          <div class="hint">
            {{ motionEditor.kind === 'transition'
              ? 'Keyframes for the slide leaving (out) and the slide arriving (in); order: in-over | out-over; perspective (px) for 3D.'
              : 'type: in | out | attention; keyframes; path (SVG path in slide px, from the element); origin (transform-origin).' }}
            Properties in camelCase, e.g. clipPath, transform, filter, opacity.
          </div>
          <TextArea class="code" v-model:value="body" :rows="13" spellcheck="false" />
          <div class="problems" v-if="problems.length">{{ problems.join(' · ') }}</div>
        </div>
        <div class="preview">
          <MotionPreview ref="previewRef" :from="previewFrom" :to="previewTo" :spec="previewSpec" :width="300" autoplay />
          <Button class="play" @click="previewRef?.play()"><i-icon-park-outline:play-one /> Play again</Button>
          <div class="preview-note">{{ previewNote }}</div>
        </div>
      </div>
      <div class="footer">
        <Button v-if="!isNew" class="danger" @click="remove()"><i-icon-park-outline:delete /> Delete</Button>
        <Button v-if="hooks.ask" @click="askAgent()"><i-icon-park-outline:robot /> Ask the agent…</Button>
        <div class="spacer"></div>
        <Button @click="close()">Cancel</Button>
        <Button type="primary" :disabled="!!problems.length || !name.trim()" @click="save()">Save</Button>
      </div>
    </div>
  </Modal>
</template>

<script lang="ts" setup>
import { computed, ref, useTemplateRef, watch } from 'vue'
import { storeToRefs } from 'pinia'
import { useSlidesStore } from '@/store'
import type { MotionEffect, MotionTransition } from '@/types/slides'
import { DEFAULT_EASING, EASINGS, EFFECT_STARTERS, TRANSITION_STARTERS, validateEffect, validateTransition } from '@/utils/motion'
import type { MotionSpec } from '@/utils/motionStage'
import { hooks } from '@/bridge/hooks'
import message from '@/utils/message'
import useHistorySnapshot from '@/hooks/useHistorySnapshot'
import { motionEditor } from './state'
import MotionPreview from './MotionPreview.vue'
import Modal from '@/components/Modal.vue'
import Input from '@/components/Input.vue'
import NumberInput from '@/components/NumberInput.vue'
import Select from '@/components/Select.vue'
import TextArea from '@/components/TextArea.vue'
import Button from '@/components/Button.vue'

const slidesStore = useSlidesStore()
const { motion, slides, slideIndex, currentSlide } = storeToRefs(slidesStore)
const { addHistorySnapshot } = useHistorySnapshot()
const previewRef = useTemplateRef<InstanceType<typeof MotionPreview>>('previewRef')

const name = ref('')
const label = ref('')
const duration = ref(800)
const easingChoice = ref(DEFAULT_EASING)
const customEasing = ref('')
const body = ref('{}')
const starter = ref('')

const isNew = computed(() => !motionEditor.name)
const starters = computed<Record<string, MotionTransition | MotionEffect>>(() => (motionEditor.kind === 'transition' ? TRANSITION_STARTERS : EFFECT_STARTERS))
const starterOptions = computed(() => Object.keys(starters.value).map(key => ({ label: `Start from: ${key}`, value: key })))
const easingOptions = [...EASINGS, { label: 'Custom…', value: 'custom' }]

const load = (def: MotionTransition | MotionEffect, defName: string) => {
  const { label: l, duration: d, easing, ...rest } = def
  name.value = defName
  label.value = l ?? ''
  duration.value = d ?? 800
  if (!easing || EASINGS.some(item => item.value === easing)) easingChoice.value = easing ?? DEFAULT_EASING
  else {
    easingChoice.value = 'custom'
    customEasing.value = easing
  }
  body.value = JSON.stringify(rest, null, 2)
}

const useStarter = (key: string) => {
  starter.value = key
  load(starters.value[key], name.value || key.toLowerCase().replace(/[^a-z0-9]+/g, '-'))
}

watch(() => [motionEditor.visible, motionEditor.name, motionEditor.kind], () => {
  if (!motionEditor.visible) return
  const library = motionEditor.kind === 'transition' ? motion.value.transitions : motion.value.effects
  if (motionEditor.name && library[motionEditor.name]) load(library[motionEditor.name], motionEditor.name)
  else useStarter(Object.keys(starters.value)[0])
}, { immediate: true })

const parsed = computed<{ def: MotionTransition | MotionEffect | null, error: string }>(() => {
  try {
    const rest = JSON.parse(body.value || '{}')
    if (!rest || typeof rest !== 'object' || Array.isArray(rest)) return { def: null, error: 'The keyframes block must be a JSON object' }
    const easing = easingChoice.value === 'custom' ? customEasing.value.trim() : easingChoice.value
    const def = { ...rest, duration: duration.value, ...(easing ? { easing } : {}), ...(label.value.trim() ? { label: label.value.trim() } : {}) }
    return { def, error: '' }
  }
  catch (error) {
    return { def: null, error: `JSON: ${(error as Error).message}` }
  }
})

const problems = computed(() => {
  if (parsed.value.error) return [parsed.value.error]
  const def = parsed.value.def!
  const list = motionEditor.kind === 'transition' ? validateTransition(def as MotionTransition) : validateEffect(def as MotionEffect)
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name.value.trim())) list.push('name: lowercase letters, digits and dashes')
  return list
})

// Preview: a transition from the previous slide into the current one; an effect on the selected element.
const previewTo = computed(() => currentSlide.value)
const previewFrom = computed(() => (slideIndex.value > 0 ? slides.value[slideIndex.value - 1] : null))
const previewElement = computed(() => motionEditor.elementId || currentSlide.value.elements[0]?.id || '')
const previewSpec = computed<MotionSpec | null>(() => {
  if (problems.value.length || !parsed.value.def) return null
  if (motionEditor.kind === 'transition') return { kind: 'transition', def: parsed.value.def as MotionTransition }
  if (!previewElement.value) return null
  return { kind: 'effect', def: parsed.value.def as MotionEffect, elementId: previewElement.value }
})
const previewNote = computed(() => (motionEditor.kind === 'transition'
  ? `From slide ${slideIndex.value || '–'} to slide ${slideIndex.value + 1}`
  : previewElement.value ? 'On the selected element of this slide' : 'Add an element to preview the effect'))

const save = () => {
  const def = parsed.value.def
  if (!def || problems.value.length) return
  const key = name.value.trim()
  const next = { transitions: { ...motion.value.transitions }, effects: { ...motion.value.effects } }
  const library = motionEditor.kind === 'transition' ? next.transitions : next.effects
  if (motionEditor.name && motionEditor.name !== key) delete library[motionEditor.name]
  library[key] = def as never
  slidesStore.setMotion(next)
  if (motionEditor.kind === 'transition') slidesStore.updateSlide({ turningMode: `custom:${key}` })
  addHistorySnapshot()
  message.success(`Saved ${motionEditor.kind} “${key}”`)
  close()
}

const remove = () => {
  const next = { transitions: { ...motion.value.transitions }, effects: { ...motion.value.effects } }
  if (motionEditor.kind === 'transition') delete next.transitions[motionEditor.name]
  else delete next.effects[motionEditor.name]
  slidesStore.setMotion(next)
  addHistorySnapshot()
  close()
}

const askAgent = () => {
  hooks.ask?.({
    target: 'slide',
    slideIndex: slideIndex.value,
    slideId: currentSlide.value.id,
    elements: [],
    motion: { kind: motionEditor.kind, name: name.value.trim(), definition: body.value },
  })
}

const close = () => {
  motionEditor.visible = false
}
</script>

<style lang="scss" scoped>
.motion-editor {
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.heading {
  font-size: 16px;
  font-weight: 600;
}
.starter {
  width: 260px;
}
.columns {
  display: flex;
  gap: 20px;
}
.fields {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.row {
  display: flex;
  align-items: center;

  .label {
    width: 80px;
    flex-shrink: 0;
  }
  .field {
    flex: 1;
  }
}
.hint {
  font-size: 12px;
  color: var(--pp-text-3);
  line-height: 1.5;
}
.code {
  font-family: 'JetBrainsMono', monospace;
  font-size: 12px;
}
.problems {
  font-size: 12px;
  color: #d14424;
}
.preview {
  width: 300px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.preview-note {
  font-size: 12px;
  color: var(--pp-text-3);
}
.footer {
  display: flex;
  gap: 8px;

  .spacer {
    flex: 1;
  }
}
</style>
