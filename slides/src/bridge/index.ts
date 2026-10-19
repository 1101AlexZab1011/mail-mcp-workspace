// window.pptist: how a hosting page drives the editor. It loads and reads decks, watches changes,
// selects, renders slide pictures and runs editor commands. Nothing here knows about the host itself;
// the host plugs in through hooks (./hooks.ts).
import { createVNode, nextTick, render, watch, type App } from 'vue'
import { toCanvas } from 'html-to-image'
import { useMainStore, useScreenStore, useSlidesStore, useSnapshotStore } from '@/store'
import type { Slide, SlideTheme, PPTElement, DeckMotion, MotionEffect, MotionTransition } from '@/types/slides'
import type { ContextmenuItem } from '@/components/Contextmenu/types'
import { db } from '@/utils/database'
import { getElementRange } from '@/utils/element'
import { htmlToText } from '@/utils/common'
import { addFonts, FONTS } from '@/configs/font'
import { renderLatex } from '@/utils/latex'
import useImport from '@/hooks/useImport'
import ThumbnailSlide from '@/views/components/ThumbnailSlide/index.vue'
import { captureFrames, type MotionSpec } from '@/utils/motionStage'
import { customName, isCustomMode, MAGIC_MOVE, validateEffect, validateTransition } from '@/utils/motion'
import { hooks, type AgentContext } from './hooks'
import { listActions, runAction } from './actions'
import { ScriptHost } from '@/utils/scripts'
import type { PPTScriptElement } from '@/types/slides'

export interface Deck {
  title: string
  theme: SlideTheme
  slides: Slide[]
  viewportSize: number
  viewportRatio: number
  motion?: DeckMotion
}

let app: App | null = null
let markReady: () => void = () => {}
const ready = new Promise<void>(resolve => markReady = resolve)

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value))

const slideAt = (slide?: number | string) => {
  const store = useSlidesStore()
  if (slide === undefined) return store.currentSlide
  const found = typeof slide === 'number' ? store.slides[slide] : store.slides.find(item => item.id === slide)
  if (!found) throw new Error(`No slide ${slide}`)
  return found
}

/** The visible text of an element, for summaries and agent context. */
/** Text of rich-text HTML, one line per paragraph; with bullets, list items start with "- ". */
export const richText = (html: string, { bullets = false } = {}) => htmlToText(
  html.replace(/<li[^>]*>/gi, bullets ? '$&\u0001' : '$&').replace(/<\/(p|li|h\d|div)>|<br\s*\/?>/gi, '$&\n'),
).replace(/\u0001/g, '- ').replace(/\n{2,}/g, '\n').trim()

export const elementText = (element: PPTElement): string => {
  if (element.type === 'text') return richText(element.content)
  if (element.type === 'shape') return element.text?.content ? richText(element.text.content) : ''
  if (element.type === 'latex') return element.latex
  if (element.type === 'table') return element.data.map(row => row.map(cell => cell.text).join(' | ')).join('\n')
  if (element.type === 'chart') return element.data.labels.join(', ')
  return ''
}

const getDeck = (): Deck => {
  const store = useSlidesStore()
  return clone({ title: store.title, theme: store.theme, slides: store.slides, viewportSize: store.viewportSize, viewportRatio: store.viewportRatio, motion: store.motion })
}

/** Formulas written without a path (by the agent, or edited in the file) get drawn here. */
const fillFormulas = (slides: Slide[]) => {
  for (const slide of slides) {
    for (const element of slide.elements) {
      if (element.type !== 'latex' || element.path) continue
      let rendered
      try {
        rendered = renderLatex(element.latex)
      }
      catch (error) {
        console.warn(`Formula ${element.id} has a TeX error: ${(error as Error).message}`)
        continue
      }
      const { path, w, h } = rendered
      element.path = path
      element.viewBox = [w, h]
      element.renderer = 'mathjax'
      if (!element.width && !element.height) Object.assign(element, { width: w, height: h })
      else if (!element.height) element.height = element.width * h / w
      else if (!element.width) element.width = element.height * w / h
    }
  }
  return slides
}

/**
 * Replace the deck (or parts of it). Keeps the current slide and selection where they still exist.
 * history: 'reset' starts a new undo history (opening a file); true adds one undo step; false leaves history alone.
 */
const setDeck = async (deck: Partial<Deck>, { history = true }: { history?: boolean | 'reset' } = {}) => {
  const store = useSlidesStore()
  const main = useMainStore()
  const currentId = store.slides.length ? store.currentSlide?.id : undefined
  const selected = [...main.activeElementIdList]
  if (deck.title !== undefined) store.setTitle(deck.title)
  if (deck.theme) store.setTheme(deck.theme)
  if (deck.viewportSize) store.setViewportSize(deck.viewportSize)
  if (deck.viewportRatio) store.setViewportRatio(deck.viewportRatio)
  if (deck.motion) store.setMotion(clone(deck.motion))
  if (deck.slides) {
    if (!deck.slides.length) throw new Error('A deck needs at least one slide')
    store.setSlides(fillFormulas(clone(deck.slides)))
    const index = store.slides.findIndex(slide => slide.id === currentId)
    store.updateSlideIndex(index < 0 ? Math.min(store.slideIndex, store.slides.length - 1) : index)
    const ids = new Set(store.currentSlide.elements.map(element => element.id))
    main.setActiveElementIdList(selected.filter(id => ids.has(id)))
  }
  if (history === 'reset') {
    await db.snapshots.clear()
    await useSnapshotStore().initSnapshotDatabase()
  }
  else if (history) await useSnapshotStore().addSnapshot()
}

/** Call back (with no arguments) whenever the deck changes, by the user or by setDeck. Returns an unsubscribe function. */
const onChange = (callback: () => void) => {
  const store = useSlidesStore()
  return watch(() => [store.slides, store.title, store.theme, store.viewportSize, store.viewportRatio, store.motion], () => callback(), { deep: true })
}

const state = () => {
  const store = useSlidesStore()
  const main = useMainStore()
  return {
    title: store.title,
    slideIndex: store.slideIndex,
    slideId: store.currentSlide?.id,
    slideCount: store.slides.length,
    selected: [...main.activeElementIdList],
    selectedSlides: main.selectedSlidesIndex.map(index => store.slides[index]?.id).filter(Boolean),
    canvas: { width: store.viewportSize, height: Math.round(store.viewportSize * store.viewportRatio) },
    screening: useScreenStore().screening,
  }
}

const select = ({ ids = [], slide }: { ids?: string[], slide?: number | string } = {}) => {
  const store = useSlidesStore()
  const main = useMainStore()
  if (slide !== undefined) store.updateSlideIndex(store.slides.indexOf(slideAt(slide)))
  const known = new Set(store.currentSlide.elements.map(element => element.id))
  const missing = ids.filter(id => !known.has(id))
  if (missing.length) throw new Error(`Not on this slide: ${missing.join(', ')}`)
  main.setActiveElementIdList(ids)
  main.setHandleElementId(ids[0] ?? '')
  return state()
}

interface ShotOptions {
  slide?: number | string
  /** Crop to one element (plus a margin). */
  element?: string
  /** Crop to a region in slide coordinates. */
  region?: { left: number, top: number, width: number, height: number }
  /** Pixels per slide unit (1 = the canvas size, e.g. 1280 wide). */
  scale?: number
  /** Label every element with its id. */
  overlay?: boolean
}

/** Render a slide (or part of it) to a PNG data URL, independent of what is on screen. */
const shot = async ({ slide, element, region, scale = 1, overlay = false }: ShotOptions = {}) => {
  if (!app) throw new Error('The editor is not running')
  const store = useSlidesStore()
  const target = slideAt(slide)
  const width = store.viewportSize
  const height = Math.round(store.viewportSize * store.viewportRatio)
  const host = document.createElement('div')
  host.style.cssText = 'position: fixed; left: -20000px; top: 0; pointer-events: none;'
  document.body.append(host)
  try {
    const vnode = createVNode(ThumbnailSlide, { slide: target, size: width })
    vnode.appContext = app._context
    render(vnode, host)
    await nextTick()
    const root = host.firstElementChild as HTMLElement
    if (overlay) {
      const layer = root.querySelector('.elements') as HTMLElement
      for (const item of target.elements) {
        const { minX, minY } = getElementRange(item)
        const label = document.createElement('div')
        label.textContent = item.id
        label.style.cssText = `position: absolute; left: ${minX}px; top: ${Math.max(0, minY - 16)}px; z-index: 9999; font: 600 12px/16px sans-serif; color: #fff; background: rgba(220, 38, 38, .85); padding: 0 4px; border-radius: 3px;`
        layer.append(label)
      }
    }
    await Promise.all([...root.querySelectorAll('img')].map(img => img.decode().catch(() => undefined)))
    await document.fonts.ready
    // Charts grow in (about a second); capture them drawn.
    if (target.elements.some(item => item.type === 'chart')) await new Promise(resolve => setTimeout(resolve, 1200))
    const canvas = await toCanvas(root, { width, height, pixelRatio: scale, cacheBust: false })
    let crop = region
    if (element) {
      const item = target.elements.find(el => el.id === element)
      if (!item) throw new Error(`No element ${element} on that slide`)
      const { minX, maxX, minY, maxY } = getElementRange(item)
      const margin = 12
      crop = { left: minX - margin, top: minY - margin, width: maxX - minX + 2 * margin, height: maxY - minY + 2 * margin }
    }
    if (!crop) return canvas.toDataURL('image/png')
    const left = Math.max(0, crop.left)
    const top = Math.max(0, crop.top)
    const right = Math.min(width, crop.left + crop.width)
    const bottom = Math.min(height, crop.top + crop.height)
    const out = document.createElement('canvas')
    out.width = Math.max(1, Math.round((right - left) * scale))
    out.height = Math.max(1, Math.round((bottom - top) * scale))
    out.getContext('2d')!.drawImage(canvas, left * scale, top * scale, out.width, out.height, 0, 0, out.width, out.height)
    return out.toDataURL('image/png')
  }
  finally {
    render(null, host)
    host.remove()
  }
}

const contextFor = (target: AgentContext['target']): AgentContext => {
  const store = useSlidesStore()
  const main = useMainStore()
  const elements = target === 'slide' ? [] : main.activeElementList
  return {
    target,
    slideIndex: store.slideIndex,
    slideId: store.currentSlide.id,
    elements: elements.map(element => ({ id: element.id, type: element.type, name: element.name, text: elementText(element) })),
  }
}

/** Menu entries that hand the user's selection to the agent; empty when no host is listening. */
export const agentMenu = (target: AgentContext['target']): ContextmenuItem[] => {
  const items: ContextmenuItem[] = []
  if (hooks.discuss) items.push({ text: 'Discuss in chat', handler: () => hooks.discuss!(contextFor(target)) })
  if (hooks.ask) items.push({ text: 'Ask the agent…', handler: () => hooks.ask!(contextFor(target)) })
  return items.length ? [{ divider: true }, ...items] : []
}

interface FramesOptions {
  /** The slide whose transition (from the slide before) or whose element's effect to show. */
  slide?: number | string
  /** A transition: a definition, or a name ('magic', 'custom:<name>'); default: the slide's own. */
  transition?: MotionTransition | string
  /** An element's effect: its id, and a definition or name (default: its first custom animation). */
  element?: string
  effect?: MotionEffect | string
  at?: number[]
  width?: number
}

/** Pictures of a custom transition or effect at moments `at`, side by side (a PNG data URL). */
const motionFrames = async ({ slide, transition, element, effect, at, width }: FramesOptions = {}) => {
  if (!app) throw new Error('The editor is not running')
  const store = useSlidesStore()
  const to = slideAt(slide)
  const index = store.slides.indexOf(to)
  const from = index > 0 ? store.slides[index - 1] : null
  let spec: MotionSpec
  if (element) {
    const animation = to.animations?.find(item => item.elId === element && item.effect.startsWith('custom:'))
    const def = typeof effect === 'object' ? effect : store.motion.effects[customName(effect ?? animation?.effect)]
    if (!def) throw new Error(`No custom effect ${typeof effect === 'string' ? effect : ''} for element ${element}`)
    const problems = validateEffect(def)
    if (problems.length) throw new Error(problems.join('; '))
    spec = { kind: 'effect', def, elementId: element, duration: animation?.duration }
  }
  else {
    const mode = typeof transition === 'object' ? transition : (transition ?? to.turningMode)
    if (mode === MAGIC_MOVE) spec = { kind: 'magic' }
    else {
      const def = typeof mode === 'object' ? mode : store.motion.transitions[customName(mode)]
      if (!def) throw new Error(isCustomMode(typeof mode === 'string' ? mode : '') ? `No transition ${mode} in the deck` : 'That slide has no custom transition; pass transition')
      const problems = validateTransition(def)
      if (problems.length) throw new Error(problems.join('; '))
      spec = { kind: 'transition', def }
    }
  }
  return captureFrames(app, { from, to }, spec, { at, width })
}

/**
 * Run a script element off screen, as the agent's check: step through `steps` clicks, let it run `wait` ms,
 * and return its console output, errors and a picture of where it ended (PNG data URL, or '' if nothing drew).
 */
const runScript = async (id: string, { steps = 0, wait = 1500, code }: { steps?: number, wait?: number, code?: string } = {}) => {
  const store = useSlidesStore()
  const slide = store.slides.find(item => item.elements.some(el => el.id === id))
  const element = slide?.elements.find(el => el.id === id)
  if (!slide || element?.type !== 'script') throw new Error(`No script element ${id}`)
  const box = document.createElement('div')
  // In the viewport but invisible: Firefox stops animation frames in frames placed off screen.
  box.style.cssText = `position: fixed; left: 0; top: 0; width: ${element.width}px; height: ${element.height}px; opacity: 0; pointer-events: none; z-index: -1;`
  document.body.append(box)
  const host = new ScriptHost(element as PPTScriptElement, slide.id, 'preview')
  try {
    await host.start(box, { theme: store.theme, code, prompt: false })
    host.enter()
    const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
    for (let n = 1; n <= steps; n++) {
      await pause(Math.min(wait, 1500))
      host.stepTo(n)
    }
    await pause(wait)
    const picture = await host.capture().catch(() => '')
    return { logs: host.logs, errors: host.errors, steps: host.steps, picture }
  }
  finally {
    host.destroy()
    box.remove()
  }
}

const importPPTX = (data: Blob, name = 'presentation.pptx') => useImport().importPPTXFile([new File([data], name)], { cover: true })

export const installBridge = (instance: App) => {
  app = instance
  ;(window as any).pptist = {
    version: 1,
    ready,
    hooks,
    getDeck,
    setDeck,
    onChange,
    state,
    select,
    shot,
    elementText,
    renderLatex,
    motionFrames,
    runScript,
    validateTransition,
    validateEffect,
    importPPTX,
    actions: listActions,
    runAction,
    fonts: () => FONTS.map(font => font.value).filter(Boolean),
    addFonts,
    stores: { slides: useSlidesStore, main: useMainStore, snapshot: useSnapshotStore, screen: useScreenStore },
  }
}

/** App.vue calls this once the first deck is in the store. */
export const bridgeReady = () => markReady()
