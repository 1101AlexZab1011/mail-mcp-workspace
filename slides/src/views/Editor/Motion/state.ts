// Which custom definition the motion editor dialog is editing (one dialog, opened from several panels).
import { reactive } from 'vue'

export const motionEditor = reactive({
  visible: false,
  kind: 'transition' as 'transition' | 'effect',
  /** The name being edited; '' for a new one. */
  name: '',
  /** For effects: the element to preview on. */
  elementId: '',
})

export const openMotionEditor = (kind: 'transition' | 'effect', name = '', elementId = '') => {
  Object.assign(motionEditor, { visible: true, kind, name, elementId })
}
