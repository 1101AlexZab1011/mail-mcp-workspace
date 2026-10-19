// Which script element the script editor dialog is editing.
import { reactive } from 'vue'

export const scriptEditor = reactive({ visible: false, elementId: '' })

export const openScriptEditor = (elementId: string) => Object.assign(scriptEditor, { visible: true, elementId })
