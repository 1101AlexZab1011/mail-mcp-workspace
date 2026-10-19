// Every editor command the agent may run, by name. The table is the single source: the host lists it
// for the agent (pptist.actions()) and runs entries with pptist.runAction(name, args).
import { useMainStore, useSlidesStore, useSnapshotStore } from '@/store'
import { ElementAlignCommands, ElementOrderCommands } from '@/types/edit'
import { ToolbarStates } from '@/types/toolbar'
import type { DialogForExportTypes } from '@/types/export'
import { KEYS } from '@/configs/hotkey'
import { PRESET_THEMES } from '@/configs/theme'
import useAlignActiveElement from '@/hooks/useAlignActiveElement'
import useAlignElementToCanvas from '@/hooks/useAlignElementToCanvas'
import useCombineElement from '@/hooks/useCombineElement'
import useCopyAndPasteElement from '@/hooks/useCopyAndPasteElement'
import useDeleteElement from '@/hooks/useDeleteElement'
import useHideElement from '@/hooks/useHideElement'
import useLockElement from '@/hooks/useLockElement'
import useMoveElement from '@/hooks/useMoveElement'
import useOrderElement from '@/hooks/useOrderElement'
import useSlideHandler from '@/hooks/useSlideHandler'
import useUniformDisplayElement from '@/hooks/useUniformDisplayElement'
import useScreening from '@/hooks/useScreening'
import useSlideTheme from '@/hooks/useSlideTheme'
import useExport from '@/hooks/useExport'
import { openScriptEditor } from '@/views/Editor/Script/state'
import { openMotionEditor } from '@/views/Editor/Motion/state'

export interface ActionArgs {
  /** Elements to act on (on the current slide); selected first, as if the user had clicked them. */
  ids?: string[]
  /** Slide to act on, by index (0-based) or id; it becomes the current slide. */
  slide?: number | string
  [key: string]: unknown
}

interface Action {
  description: string
  args?: string
  run: (args: ActionArgs) => unknown
}

const ALIGN: Record<string, ElementAlignCommands> = {
  left: ElementAlignCommands.LEFT, right: ElementAlignCommands.RIGHT, top: ElementAlignCommands.TOP, bottom: ElementAlignCommands.BOTTOM,
  'center-x': ElementAlignCommands.HORIZONTAL, 'center-y': ElementAlignCommands.VERTICAL, center: ElementAlignCommands.CENTER,
}
const ORDER: Record<string, ElementOrderCommands> = { front: ElementOrderCommands.TOP, back: ElementOrderCommands.BOTTOM, forward: ElementOrderCommands.UP, backward: ElementOrderCommands.DOWN }
const MOVE: Record<string, string> = { left: KEYS.LEFT, right: KEYS.RIGHT, up: KEYS.UP, down: KEYS.DOWN }
const PANELS = ['selection', 'search', 'comments', 'symbols', 'markup'] as const
const TABS: Record<string, ToolbarStates> = {
  style: ToolbarStates.EL_STYLE, arrange: ToolbarStates.EL_POSITION, animate: ToolbarStates.EL_ANIMATION,
  design: ToolbarStates.SLIDE_DESIGN, transition: ToolbarStates.SLIDE_ANIMATION,
}

const pick = <T>(table: Record<string, T>, key: unknown, what: string): T => {
  const value = table[String(key)]
  if (value === undefined) throw new Error(`Unknown ${what} "${key}"; use one of: ${Object.keys(table).join(', ')}`)
  return value
}
const needSelection = () => {
  const { activeElementList } = useMainStore()
  if (!activeElementList.length) throw new Error('Nothing is selected: pass ids')
  return activeElementList
}

export const ACTIONS: Record<string, Action> = {
  align: {
    description: 'Align the elements: one element (or to: "canvas") against the slide, several against their joint box',
    args: '{ ids?, edge: left|right|top|bottom|center-x|center-y|center, to?: canvas|selection }',
    run: ({ edge, to }) => {
      const command = pick(ALIGN, edge, 'edge')
      if (to === 'canvas' || (to !== 'selection' && needSelection().length === 1)) useAlignElementToCanvas().alignElementToCanvas(command)
      else useAlignActiveElement().alignActiveElement(command)
    },
  },
  distribute: {
    description: 'Space three or more elements evenly',
    args: '{ ids?, axis: x|y }',
    run: ({ axis }) => {
      if (needSelection().length < 3) throw new Error('Distributing needs at least three elements')
      const { uniformHorizontalDisplay, uniformVerticalDisplay } = useUniformDisplayElement()
      if (axis === 'y') uniformVerticalDisplay()
      else uniformHorizontalDisplay()
    },
  },
  order: {
    description: 'Change the stacking order of the selected element',
    args: '{ ids?, to: front|back|forward|backward }',
    run: ({ to }) => {
      const element = needSelection()[0]
      useOrderElement().orderElement(element, pick(ORDER, to, 'order'))
    },
  },
  move: {
    description: 'Nudge the selected elements',
    args: '{ ids?, direction: left|right|up|down, step?: px }',
    run: ({ direction, step }) => { needSelection(); useMoveElement().moveElement(pick(MOVE, direction, 'direction'), Number(step ?? 1)) },
  },
  group: { description: 'Group the selected elements', args: '{ ids? }', run: () => { needSelection(); useCombineElement().combineElements() } },
  ungroup: { description: 'Ungroup the selected group', args: '{ ids? }', run: () => { needSelection(); useCombineElement().uncombineElements() } },
  lock: { description: 'Lock the selected elements', args: '{ ids? }', run: () => { needSelection(); useLockElement().lockElement() } },
  unlock: {
    description: 'Unlock an element',
    args: '{ ids }',
    run: ({ ids }) => {
      const slides = useSlidesStore()
      for (const id of ids ?? []) {
        const element = slides.currentSlide.elements.find(item => item.id === id)
        if (element) useLockElement().unlockElement(element)
      }
    },
  },
  hide: {
    description: 'Hide or show elements while editing (toggle), or all of them',
    args: '{ ids?, all?: show|hide }',
    run: ({ ids, all }) => {
      const { toggleHideElement, showAllElements, hideAllElements } = useHideElement()
      if (all === 'show') showAllElements()
      else if (all === 'hide') hideAllElements()
      else for (const id of ids ?? []) toggleHideElement(id)
    },
  },
  delete: { description: 'Delete the selected elements', args: '{ ids? }', run: () => { needSelection(); useDeleteElement().deleteElement() } },
  duplicate: { description: 'Duplicate the selected elements', args: '{ ids? }', run: () => { needSelection(); useCopyAndPasteElement().quickCopyElement() } },
  'slide.new': { description: 'Add an empty slide after the current one', args: '{ slide? }', run: () => useSlideHandler().createSlide() },
  'slide.duplicate': { description: 'Duplicate the current slide', args: '{ slide? }', run: () => useSlideHandler().copyAndPasteSlide() },
  'slide.delete': {
    description: 'Delete the current slide',
    args: '{ slide? }',
    run: () => useSlideHandler().deleteSlide([useSlidesStore().currentSlide.id]),
  },
  'theme.apply': {
    description: 'Apply the deck theme (fonts, colours, background) to every slide',
    run: () => useSlideTheme().applyThemeToAllSlides(true),
  },
  'theme.preset': {
    description: `Apply one of the ${PRESET_THEMES.length} preset themes`,
    args: '{ index: 0..' + (PRESET_THEMES.length - 1) + ' }',
    run: ({ index }) => {
      const theme = PRESET_THEMES[Number(index)]
      if (!theme) throw new Error('No such preset theme')
      useSlideTheme().applyPresetTheme(theme, true)
    },
  },
  'font.all': { description: 'Use one font for all text in the deck', args: '{ font }', run: ({ font }) => useSlideTheme().applyFontToAllSlides(String(font ?? '')) },
  undo: { description: 'Undo the last change', run: () => useSnapshotStore().unDo() },
  redo: { description: 'Redo', run: () => useSnapshotStore().reDo() },
  present: {
    description: 'Start the slideshow, or end it',
    args: '{ from?: start|current, stop?: true }',
    run: ({ from, stop }) => {
      const { enterScreening, enterScreeningFromStart, exitScreening } = useScreening()
      if (stop) exitScreening()
      else if (from === 'start') enterScreeningFromStart()
      else enterScreening()
    },
  },
  'present.next': {
    description: 'In a running slideshow: the next click (an animation, a script step, or the next slide)',
    run: () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })),
  },
  'present.prev': {
    description: 'In a running slideshow: one click back',
    run: () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true })),
  },
  'script.edit': {
    description: "Open a script element in the script editor for the user (code, live preview, poster)",
    args: '{ ids: [element id], slide? }',
    run: ({ ids }) => {
      const element = useSlidesStore().currentSlide.elements.find(el => el.id === ids?.[0])
      if (element?.type !== 'script') throw new Error('Pass the id of a script element on the slide')
      openScriptEditor(element.id)
    },
  },
  'motion.edit': {
    description: 'Open the custom transition or effect editor for the user',
    args: '{ kind: transition|effect, name? (empty: a new one), ids?: [element for the effect preview] }',
    run: ({ kind, name, ids }) => openMotionEditor(kind === 'effect' ? 'effect' : 'transition', String(name ?? ''), ids?.[0] ?? ''),
  },
  'export.pptx': {
    description: 'Export the deck as PPTX (saved by the host next to the deck)',
    args: '{ media?: boolean }',
    run: ({ media }) => useExport().exportPPTX(useSlidesStore().slides, true, !media),
  },
  'panel.open': {
    description: 'Open a panel for the user',
    args: `{ name: ${PANELS.join('|')} }`,
    run: ({ name }) => {
      const main = useMainStore()
      if (name === 'selection') main.setSelectPanelState(true)
      else if (name === 'search') main.setSearchPanelState(true)
      else if (name === 'comments') main.setNotesPanelState(true)
      else if (name === 'symbols') main.setSymbolPanelState(true)
      else if (name === 'markup') main.setMarkupPanelState(true)
      else throw new Error(`Unknown panel; use one of: ${PANELS.join(', ')}`)
    },
  },
  'panel.tab': {
    description: 'Show a tab of the right-hand toolbar',
    args: `{ name: ${Object.keys(TABS).join('|')} }`,
    run: ({ name }) => useMainStore().setToolbarState(pick(TABS, name, 'tab')),
  },
  'dialog.export': {
    description: 'Open the export dialog on a format',
    args: '{ format: pptx|image|pdf|json }',
    run: ({ format }) => useMainStore().setDialogForExport(String(format ?? 'pptx') as DialogForExportTypes),
  },
  'view.zoom': {
    description: 'Zoom the canvas to a percentage of the window (90 fits)',
    args: '{ percent }',
    run: ({ percent }) => useMainStore().setCanvasPercentage(Number(percent ?? 90)),
  },
  'view.grid': {
    description: 'Show gridlines (0 hides them) or rulers',
    args: '{ size?: px, rulers?: boolean }',
    run: ({ size, rulers }) => {
      const main = useMainStore()
      if (size !== undefined) main.setGridLineSize(Number(size))
      if (rulers !== undefined) main.setRulerState(Boolean(rulers))
    },
  },
}

export const listActions = () => Object.entries(ACTIONS).map(([name, action]) => ({ name, description: action.description, args: action.args ?? '{}' }))

export const runAction = async (name: string, args: ActionArgs = {}) => {
  const action = ACTIONS[name]
  if (!action) throw new Error(`Unknown action "${name}"`)
  const slides = useSlidesStore()
  const main = useMainStore()
  if (args.slide !== undefined) {
    const index = typeof args.slide === 'number' ? args.slide : slides.slides.findIndex(slide => slide.id === args.slide)
    if (index < 0 || index >= slides.slides.length) throw new Error(`No slide ${args.slide}`)
    slides.updateSlideIndex(index)
  }
  if (args.ids) {
    const known = new Set(slides.currentSlide.elements.map(element => element.id))
    const missing = args.ids.filter(id => !known.has(id))
    if (missing.length) throw new Error(`Not on this slide: ${missing.join(', ')}`)
    main.setActiveElementIdList(args.ids)
    main.setHandleElementId(args.ids[0] ?? '')
  }
  await action.run(args)
}
