// Motion off screen: two slides rendered as thumbnails on a small stage, so a transition or an effect can be
// previewed (editor panels) or captured frame by frame (window.pptist.motionFrames, for the agent).
import { createVNode, nextTick, render, type App } from 'vue'
import { toCanvas } from 'html-to-image'
import type { MotionEffect, MotionTransition, Slide } from '@/types/slides'
import { useSlidesStore } from '@/store'
import ThumbnailSlide from '@/views/components/ThumbnailSlide/index.vue'
import { DEFAULT_TRANSITION_DURATION, playEffect, playMagicMove, playTransition } from './motion'

export interface Stage {
  root: HTMLElement
  fromItem: HTMLElement | null
  toItem: HTMLElement
  fromEl: HTMLElement | null
  toEl: HTMLElement
  destroy: () => void
}

export const findThumbnailElement = (root: HTMLElement, id: string) =>
  root.querySelector<HTMLElement>(`[data-el-id="${id}"] [class^=base-element-]`)

/** Render `to` (and `from`, underneath) at the given width into a fixed, off-screen (or given) host. */
export async function createStage(app: App, { from, to, width, host }: { from: Slide | null, to: Slide, width: number, host?: HTMLElement }): Promise<Stage> {
  const root = document.createElement('div')
  root.className = 'motion-stage'
  const own = !host
  const container = host ?? document.body.appendChild(Object.assign(document.createElement('div'), { style: 'position: fixed; left: -20000px; top: 0; pointer-events: none;' }))
  container.append(root)
  const mount = (slide: Slide) => {
    const item = document.createElement('div')
    item.style.cssText = 'position: absolute; inset: 0;'
    root.append(item)
    const vnode = createVNode(ThumbnailSlide, { slide, size: width })
    vnode.appContext = app._context
    render(vnode, item)
    return item
  }
  const fromItem = from ? mount(from) : null
  const toItem = mount(to)
  await nextTick()
  const first = toItem.firstElementChild as HTMLElement
  // Sized from the deck (not measured): the stage may be built while its dialog is still hidden.
  const ratio = useSlidesStore().viewportRatio
  root.style.cssText = `position: relative; overflow: hidden; width: ${width}px; height: ${Math.round(width * ratio)}px; background: #000;`
  await Promise.all([...root.querySelectorAll('img')].map(img => img.decode().catch(() => undefined)))
  return {
    root, fromItem, toItem,
    fromEl: (fromItem?.firstElementChild as HTMLElement) ?? null,
    toEl: first,
    destroy: () => {
      if (fromItem) render(null, fromItem)
      render(null, toItem)
      root.remove()
      if (own) container.remove()
    },
  }
}

export type MotionSpec =
  | { kind: 'transition', def: MotionTransition }
  | { kind: 'magic', duration?: number }
  | { kind: 'effect', def: MotionEffect, elementId: string, duration?: number }

/** Start the motion on a stage. For an entrance effect, the element starts hidden like in the slideshow. */
export function playOnStage(stage: Stage, spec: MotionSpec, slides: { from: Slide | null, to: Slide }): { animations: Animation[], duration: number } {
  if (spec.kind === 'effect') {
    const node = findThumbnailElement(stage.toEl, spec.elementId)
    if (!node) throw new Error(`No element ${spec.elementId} on that slide`)
    const animations = playEffect(node, spec.def, spec.duration)
    return { animations, duration: spec.duration ?? spec.def.duration ?? 1000 }
  }
  const roots = { outEl: stage.fromEl, inEl: stage.toEl, outItem: stage.fromItem, inItem: stage.toItem }
  if (spec.kind === 'magic') {
    if (!slides.from) throw new Error('Magic Move needs a slide before this one')
    const duration = spec.duration ?? DEFAULT_TRANSITION_DURATION
    return { animations: playMagicMove(slides.from, slides.to, roots, findThumbnailElement, { duration }), duration }
  }
  return { animations: playTransition(spec.def, roots), duration: spec.def.duration ?? DEFAULT_TRANSITION_DURATION }
}

/** Pictures of the motion at moments `at` (0 = start, 1 = end), side by side, as one PNG data URL. */
export async function captureFrames(app: App, slides: { from: Slide | null, to: Slide }, spec: MotionSpec, { at = [0, 0.25, 0.5, 0.75, 1], width = 360 } = {}) {
  const stage = await createStage(app, { ...slides, width })
  // Charts grow in when drawn (about a second): let them settle so frames show the motion, not the chart's own.
  if ([slides.from, slides.to].some(slide => slide?.elements.some(el => el.type === 'chart'))) await new Promise(resolve => setTimeout(resolve, 1200))
  try {
    const { animations, duration } = playOnStage(stage, spec, slides)
    const frames: HTMLCanvasElement[] = []
    for (const t of at) {
      for (const animation of animations) {
        animation.pause()
        animation.currentTime = Math.min(Math.max(t, 0), 1) * duration
      }
      frames.push(await toCanvas(stage.root, { pixelRatio: 1 }))
    }
    for (const animation of animations) animation.cancel()
    const gap = 8
    const label = 18
    const out = document.createElement('canvas')
    out.width = frames.reduce((sum, frame) => sum + frame.width, 0) + gap * (frames.length - 1)
    out.height = frames[0].height + label
    const ctx = out.getContext('2d')!
    ctx.fillStyle = '#fff'
    ctx.fillRect(0, 0, out.width, out.height)
    ctx.fillStyle = '#333'
    ctx.font = '12px sans-serif'
    let x = 0
    frames.forEach((frame, i) => {
      ctx.drawImage(frame, x, label)
      ctx.fillText(`t = ${at[i]} (${Math.round(at[i] * duration)} ms)`, x + 4, 13)
      x += frame.width + gap
    })
    return out.toDataURL('image/png')
  }
  finally {
    stage.destroy()
  }
}
