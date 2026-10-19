// Custom motion: slide transitions, element effects and Magic Move, played with the Web Animations API.
// Definitions are data (keyframes) stored in the deck; see MotionTransition / MotionEffect in types/slides.ts.
import type { MotionEffect, MotionTransition, PPTElement, Slide } from '@/types/slides'
import { getElementRange } from '@/utils/element'

export const CUSTOM_PREFIX = 'custom:'
export const MAGIC_MOVE = 'magic'
export const DEFAULT_TRANSITION_DURATION = 800
export const DEFAULT_EASING = 'cubic-bezier(.2, 0, 0, 1)'
const MAX_DURATION = 10_000

export const isCustomMode = (mode?: string) => !!mode && (mode === MAGIC_MOVE || mode.startsWith(CUSTOM_PREFIX))
export const customName = (value?: string) => (value?.startsWith(CUSTOM_PREFIX) ? value.slice(CUSTOM_PREFIX.length) : '')

// ------------------------------------------------------------- validation --

const probe = () => document.createElement('div')

function checkKeyframes(keyframes: unknown, what: string): string[] {
  if (keyframes === undefined) return []
  if (!Array.isArray(keyframes) || !keyframes.length || !keyframes.every(k => k && typeof k === 'object' && !Array.isArray(k))) {
    return [`${what} must be a list of keyframe objects`]
  }
  const style = probe().style as unknown as Record<string, unknown>
  const unknown = new Set<string>()
  for (const frame of keyframes as Record<string, unknown>[]) {
    for (const key of Object.keys(frame)) if (!['offset', 'easing', 'composite'].includes(key) && !(key in style)) unknown.add(key)
  }
  if (unknown.size) return [`${what}: not CSS properties: ${[...unknown].join(', ')} (use camelCase, e.g. clipPath)`]
  try {
    probe().animate(keyframes as Keyframe[], 1).cancel()
  }
  catch (error) {
    return [`${what}: ${(error as Error).message}`]
  }
  return []
}

function checkTiming(def: { duration?: number, easing?: string }): string[] {
  const problems: string[] = []
  if (def.duration !== undefined && !(def.duration > 0 && def.duration <= MAX_DURATION)) problems.push(`duration must be between 1 and ${MAX_DURATION} ms`)
  if (def.easing !== undefined) {
    try {
      probe().animate([{}, {}], { duration: 1, easing: def.easing }).cancel()
    }
    catch {
      problems.push(`easing "${def.easing}" is not a CSS easing`)
    }
  }
  return problems
}

/** Problems with a transition definition; empty when it can play. */
export const validateTransition = (def: MotionTransition): string[] => {
  if (!def || typeof def !== 'object') return ['a transition is an object']
  const problems = [...checkTiming(def), ...checkKeyframes(def.out, 'out'), ...checkKeyframes(def.in, 'in')]
  if (!def.out && !def.in) problems.push('give keyframes for out, in or both')
  if (def.order && def.order !== 'in-over' && def.order !== 'out-over') problems.push('order is in-over or out-over')
  return problems
}

/** Problems with an effect definition; empty when it can play. */
export const validateEffect = (def: MotionEffect): string[] => {
  if (!def || typeof def !== 'object') return ['an effect is an object']
  const problems = [...checkTiming(def), ...checkKeyframes(def.keyframes, 'keyframes')]
  if (!['in', 'out', 'attention'].includes(def.type)) problems.push('type is in, out or attention')
  if (!def.keyframes && !def.path) problems.push('give keyframes, a path, or both')
  if (def.path) {
    try {
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
      path.setAttribute('d', def.path)
      if (!(path.getTotalLength() >= 0)) problems.push('path is not SVG path data')
    }
    catch {
      problems.push('path is not SVG path data')
    }
  }
  return problems
}

// ------------------------------------------------------------- transitions --

/** Slides are hidden by class while not current; keyframes default to visible so the motion shows. */
const visible = (keyframes: Keyframe[] | undefined, fallback: Keyframe[]) => (keyframes?.length ? keyframes : fallback).map(frame => ({ opacity: 1, ...frame }))

interface TransitionTargets {
  outEl: HTMLElement | null
  inEl: HTMLElement
  /** The items holding the slides (stacking is set on them). */
  outItem?: HTMLElement | null
  inItem?: HTMLElement
}

/**
 * Play a custom transition. Forward: the definition as written. Backward (reverse): the slide being
 * left plays the 'in' keyframes backwards and the slide coming back plays 'out' backwards.
 */
export function playTransition(def: MotionTransition, targets: TransitionTargets, { reverse = false } = {}): Animation[] {
  const timing: KeyframeAnimationOptions = { duration: def.duration ?? DEFAULT_TRANSITION_DURATION, easing: def.easing ?? DEFAULT_EASING, fill: 'both' }
  const leaving = reverse ? targets.inEl : targets.outEl
  const arriving = reverse ? targets.outEl : targets.inEl
  const outFrames = visible(def.out, [{}, {}])
  const inFrames = visible(def.in, [{}, {}])
  const animations: Animation[] = []
  const perspective = def.perspective ? `${def.perspective}px` : ''
  for (const el of [leaving, arriving]) if (el?.parentElement && perspective) el.parentElement.style.perspective = perspective
  // Stacking: which slide is on top during the move.
  const top = (def.order ?? 'in-over') === 'in-over' ? (reverse ? targets.outItem : targets.inItem) : (reverse ? targets.inItem : targets.outItem)
  const bottom = top === targets.inItem ? targets.outItem : targets.inItem
  if (top) top.style.zIndex = '4'
  if (bottom) bottom.style.zIndex = '3'
  if (reverse) {
    if (leaving) animations.push(leaving.animate(inFrames, { ...timing, direction: 'reverse' }))
    if (arriving) animations.push(arriving.animate(outFrames, { ...timing, direction: 'reverse' }))
  }
  else {
    if (leaving) animations.push(leaving.animate(outFrames, timing))
    if (arriving) animations.push(arriving.animate(inFrames, timing))
  }
  return finishTogether(animations, () => {
    for (const el of [targets.outItem, targets.inItem]) if (el) el.style.zIndex = ''
    for (const el of [leaving, arriving]) if (el?.parentElement && perspective) el.parentElement.style.perspective = ''
  })
}

/** Cancel the animations (dropping their fill) once they have all finished, then clean up. */
function finishTogether(animations: Animation[], cleanup: () => void) {
  Promise.all(animations.map(a => a.finished.catch(() => undefined))).then(() => {
    for (const a of animations) a.cancel()
    cleanup()
  })
  return animations
}

// -------------------------------------------------------------- Magic Move --

const plainText = (html = '') => html.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim()
const contentKey = (el: PPTElement) => {
  if (el.type === 'image' || el.type === 'video' || el.type === 'audio') return `${el.type}:${el.src}`
  if (el.type === 'text') return `text:${plainText(el.content)}`
  if (el.type === 'shape' && el.text?.content) return `shape:${plainText(el.text.content)}`
  if (el.type === 'latex') return `latex:${el.latex}`
  return ''
}

/** Pairs of matching elements between two slides: by name first, then by the same file or text. Map: arriving id → leaving id. */
export function matchElements(from: Slide, to: Slide): Map<string, string> {
  const pairs = new Map<string, string>()
  const taken = new Set<string>()
  const pair = (key: (el: PPTElement) => string) => {
    for (const el of to.elements) {
      if (pairs.has(el.id)) continue
      const k = key(el)
      if (!k) continue
      const match = from.elements.find(other => !taken.has(other.id) && other.type === el.type && key(other) === k)
      if (match) {
        pairs.set(el.id, match.id)
        taken.add(match.id)
      }
    }
  }
  pair(el => (el.name ? `name:${el.name}` : ''))
  pair(el => (el.id ? `id:${el.id}` : ''))
  pair(contentKey)
  return pairs
}

const box = (el: PPTElement) => {
  const { minX, maxX, minY, maxY } = getElementRange(el)
  return { left: el.left, top: el.top, width: Math.max(maxX - minX, 1), height: Math.max(maxY - minY, 1), rotate: 'rotate' in el ? el.rotate || 0 : 0 }
}

/**
 * Magic Move from one slide to the next: matching elements glide from their old box to the new one, the
 * rest fade. find(root, id) returns an element's positioned node inside a rendered slide.
 */
export function playMagicMove(
  from: Slide, to: Slide,
  roots: { outEl: HTMLElement | null, inEl: HTMLElement, outItem?: HTMLElement | null, inItem?: HTMLElement },
  find: (root: HTMLElement, id: string) => HTMLElement | null,
  { duration = DEFAULT_TRANSITION_DURATION, easing = DEFAULT_EASING } = {},
): Animation[] {
  const timing: KeyframeAnimationOptions = { duration, easing, fill: 'both' }
  const pairs = matchElements(from, to)
  const animations: Animation[] = []
  const matchedOld = new Set(pairs.values())
  if (roots.outItem) roots.outItem.style.zIndex = '3'
  if (roots.inItem) roots.inItem.style.zIndex = '4'

  // The old slide stays underneath, fully visible except what moves; the new one builds on top of it.
  if (roots.outEl) {
    animations.push(roots.outEl.animate([{ opacity: 1 }, { opacity: 1 }], timing))
    for (const id of matchedOld) {
      const node = find(roots.outEl, id)
      if (node) animations.push(node.animate([{ opacity: 0 }, { opacity: 0 }], timing))
    }
    // Unmatched old elements fade out.
    for (const el of from.elements) {
      if (matchedOld.has(el.id)) continue
      const node = find(roots.outEl, el.id)
      if (node) animations.push(node.animate([{ opacity: 1 }, { opacity: 0 }], timing))
    }
  }
  animations.push(roots.inEl.animate([{ opacity: 1 }, { opacity: 1 }], timing))
  if (roots.outEl) {
    // The new slide's background (and its frames' own fills) fades in, so the old slide shows through at first.
    // The slideshow nests the background in .screen-slide, thumbnails in .elements.
    const background = roots.inEl.querySelector<HTMLElement>(':scope > .screen-slide > .background, :scope > .elements > .background')
    if (background) animations.push(background.animate([{ opacity: 0 }, { opacity: 1 }], timing))
    for (const frame of [roots.inEl, ...roots.inEl.querySelectorAll<HTMLElement>(':scope > .screen-slide, :scope > .elements')]) {
      const fill = getComputedStyle(frame).backgroundColor
      if (fill && fill !== 'rgba(0, 0, 0, 0)' && fill !== 'transparent') animations.push(frame.animate([{ backgroundColor: 'transparent' }, { backgroundColor: fill }], timing))
    }
  }
  for (const el of to.elements) {
    const node = find(roots.inEl, el.id)
    if (!node) continue
    const oldId = pairs.get(el.id)
    const old = oldId ? from.elements.find(item => item.id === oldId) : undefined
    if (!old) {
      animations.push(node.animate([{ opacity: 0 }, { opacity: 1 }], timing))
      continue
    }
    const a = box(old)
    const b = box(el)
    const fromTransform = `translate(${a.left - b.left}px, ${a.top - b.top}px) scale(${a.width / b.width}, ${a.height / b.height})`
    const changed = contentKey(old) !== contentKey(el)
    node.style.transformOrigin = '0 0'
    animations.push(node.animate([{ transform: fromTransform, opacity: changed ? 0 : 1 }, { transform: 'none', opacity: 1 }], timing))
    if (changed && roots.outEl) {
      // Changed content: the old version moves along and fades out.
      const oldNode = find(roots.outEl, old.id)
      if (oldNode) {
        oldNode.style.transformOrigin = '0 0'
        const toTransform = `translate(${b.left - a.left}px, ${b.top - a.top}px) scale(${b.width / a.width}, ${b.height / a.height})`
        animations.push(oldNode.animate([{ transform: 'none', opacity: 1 }, { transform: toTransform, opacity: 0 }], timing))
      }
    }
  }
  return finishTogether(animations, () => {
    for (const el of [roots.outItem, roots.inItem]) if (el) el.style.zIndex = ''
  })
}

// ----------------------------------------------------------------- effects --

/** Keyframes that move an element along an SVG path (in slide px, starting where the element is). */
export function pathKeyframes(path: string, samples = 40): Keyframe[] {
  const node = document.createElementNS('http://www.w3.org/2000/svg', 'path')
  node.setAttribute('d', path)
  const length = node.getTotalLength()
  const start = node.getPointAtLength(0)
  return Array.from({ length: samples + 1 }, (_, i) => {
    const p = node.getPointAtLength((length * i) / samples)
    return { translate: `${p.x - start.x}px ${p.y - start.y}px`, offset: i / samples }
  })
}

/** Play a custom effect on an element's node. 'out' effects keep their end state (the element stays gone). */
export function playEffect(el: HTMLElement, def: MotionEffect, duration?: number): Animation[] {
  const timing: KeyframeAnimationOptions = { duration: duration ?? def.duration ?? 1000, easing: def.easing ?? DEFAULT_EASING, fill: def.type === 'out' ? 'forwards' : 'none' }
  if (def.origin) el.style.transformOrigin = def.origin
  const animations: Animation[] = []
  if (def.keyframes?.length) animations.push(el.animate(def.keyframes, timing))
  if (def.path) animations.push(el.animate(pathKeyframes(def.path), { ...timing, easing: def.easing ?? 'ease-in-out' }))
  if (!animations.length) animations.push(el.animate([{}, {}], timing))
  return animations
}

// ----------------------------------------------------------------- starters --
// Ready definitions to start a new custom transition or effect from (the editor's "New" menu).

export const TRANSITION_STARTERS: Record<string, MotionTransition> = {
  'Iris': { duration: 900, out: [{ opacity: 1 }, { opacity: 0.6 }], in: [{ clipPath: 'circle(0% at 50% 50%)' }, { clipPath: 'circle(75% at 50% 50%)' }] },
  'Wipe left': { duration: 700, in: [{ clipPath: 'inset(0 0 0 100%)' }, { clipPath: 'inset(0 0 0 0)' }] },
  'Zoom through': { duration: 800, out: [{ transform: 'scale(1)', opacity: 1 }, { transform: 'scale(1.6)', opacity: 0 }], in: [{ transform: 'scale(0.8)', opacity: 0 }, { transform: 'scale(1)', opacity: 1 }], order: 'out-over' },
  'Flip': { duration: 900, perspective: 1600, out: [{ transform: 'rotateY(0deg)' }, { transform: 'rotateY(-90deg)', offset: 0.5 }, { transform: 'rotateY(-90deg)', opacity: 0 }], in: [{ transform: 'rotateY(90deg)', opacity: 0 }, { transform: 'rotateY(90deg)', opacity: 1, offset: 0.5 }, { transform: 'rotateY(0deg)' }] },
  'Blur dissolve': { duration: 900, out: [{ filter: 'blur(0px)', opacity: 1 }, { filter: 'blur(12px)', opacity: 0 }], in: [{ filter: 'blur(12px)', opacity: 0 }, { filter: 'blur(0px)', opacity: 1 }] },
}

export const EFFECT_STARTERS: Record<string, MotionEffect> = {
  'Rise and focus': { type: 'in', duration: 700, keyframes: [{ opacity: 0, transform: 'translateY(40px)', filter: 'blur(8px)' }, { opacity: 1, transform: 'none', filter: 'none' }] },
  'Pop': { type: 'in', duration: 500, easing: 'cubic-bezier(.34, 1.56, .64, 1)', origin: 'center', keyframes: [{ opacity: 0, transform: 'scale(0.6)' }, { opacity: 1, transform: 'scale(1)' }] },
  'Reveal left to right': { type: 'in', duration: 900, keyframes: [{ clipPath: 'inset(0 100% 0 0)' }, { clipPath: 'inset(0 0 0 0)' }] },
  'Along an arc': { type: 'attention', duration: 1500, path: 'M0 0 C 120 -120 360 -120 480 0' },
  'Pulse highlight': { type: 'attention', duration: 900, origin: 'center', keyframes: [{ transform: 'scale(1)', filter: 'drop-shadow(0 0 0 #f2b134)' }, { transform: 'scale(1.08)', filter: 'drop-shadow(0 0 14px #f2b134)' }, { transform: 'scale(1)', filter: 'drop-shadow(0 0 0 #f2b134)' }] },
  'Fade away': { type: 'out', duration: 600, keyframes: [{ opacity: 1, filter: 'blur(0)' }, { opacity: 0, filter: 'blur(6px)' }] },
}

export const EASINGS = [
  { label: 'Smooth (emphasized)', value: DEFAULT_EASING },
  { label: 'Ease in-out', value: 'ease-in-out' },
  { label: 'Ease out', value: 'ease-out' },
  { label: 'Ease in', value: 'ease-in' },
  { label: 'Overshoot', value: 'cubic-bezier(.34, 1.56, .64, 1)' },
  { label: 'Linear', value: 'linear' },
]
