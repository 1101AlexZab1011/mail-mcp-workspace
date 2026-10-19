// Script elements at run time: each running script lives in a sandboxed frame served by the host page
// (hooks.scriptFrame) and talks to us by postMessage. The protocol:
//   to the frame:   init { width, height, pixelRatio, theme, data, mode, step } · enter · leave · step { n } · capture
//   from the frame: ready { steps? } · error { message } · log { text } · poster { dataUrl }
import type { PPTScriptElement, SlideTheme } from '@/types/slides'
import { hooks } from '@/bridge/hooks'

export type ScriptMode = 'editor' | 'screen' | 'preview'

export class ScriptHost {
  frame: HTMLIFrameElement | null = null
  logs: string[] = []
  errors: string[] = []
  steps = 0
  step = 0
  private listeners: ((event: MessageEvent) => void)[] = []
  private waiting: ((value: unknown) => void)[] = []
  onError: (message: string) => void = () => {}

  constructor(public element: PPTScriptElement, public slideId: string, public mode: ScriptMode) {}

  /** Start the script inside `container` (sized like the element). Throws when scripts are unavailable or not trusted. */
  async start(container: HTMLElement, { theme, pixelRatio = window.devicePixelRatio, code, prompt = true }: { theme: SlideTheme, pixelRatio?: number, code?: string, prompt?: boolean }) {
    if (!hooks.scriptFrame) throw new Error('Scripts cannot run here')
    if (hooks.scriptTrust && !(await hooks.scriptTrust(this.element, { prompt }))) throw new Error('not-trusted')
    const url = await hooks.scriptFrame(this.element, code)
    const data: Record<string, string | ArrayBuffer> = {}
    for (const path of this.element.data ?? []) {
      try {
        data[path] = hooks.scriptData ? await hooks.scriptData(path) : ''
      }
      catch (error) {
        this.errors.push(`data ${path}: ${(error as Error).message}`)
      }
    }
    const frame = document.createElement('iframe')
    frame.setAttribute('sandbox', 'allow-scripts')
    frame.setAttribute('title', `Script ${this.element.src}`)
    frame.style.cssText = 'border: 0; width: 100%; height: 100%; display: block; background: transparent;'
    frame.src = url
    this.frame = frame
    const listener = (event: MessageEvent) => {
      if (event.source !== frame.contentWindow || !event.data || typeof event.data !== 'object') return
      const message = event.data as { type: string, [key: string]: unknown }
      if (message.type === 'ready') this.steps = Number(message.steps ?? this.element.steps ?? 0)
      if (message.type === 'log') this.logs.push(String(message.text))
      if (message.type === 'error') {
        this.errors.push(String(message.message))
        this.onError(String(message.message))
      }
      const waiters = this.waiting
      this.waiting = []
      for (const resolve of waiters) resolve(message)
    }
    window.addEventListener('message', listener)
    this.listeners.push(listener)
    container.replaceChildren(frame)
    await new Promise<void>((resolve, reject) => {
      frame.addEventListener('load', () => resolve(), { once: true })
      setTimeout(() => reject(new Error('The script frame did not load')), 10_000)
    })
    this.post({ type: 'init', width: this.element.width, height: this.element.height, pixelRatio, theme: JSON.parse(JSON.stringify(theme)), data, mode: this.mode, step: this.step, steps: this.element.steps ?? 0 })
    await this.until('ready', 10_000).catch(() => this.errors.push('The script did not start within 10 s'))
    register(this)
  }

  post(message: Record<string, unknown>) {
    this.frame?.contentWindow?.postMessage(message, '*')
  }

  private until(type: string, ms: number) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`No ${type} from the script`)), ms)
      const wait = (message: unknown) => {
        if ((message as { type?: string })?.type === type) {
          clearTimeout(timer)
          resolve(message)
        }
        else this.waiting.push(wait)
      }
      this.waiting.push(wait)
    })
  }

  enter() { this.post({ type: 'enter' }) }
  leave() { this.post({ type: 'leave' }) }
  stepTo(n: number) {
    this.step = Math.max(0, Math.min(n, this.steps))
    this.post({ type: 'step', n: this.step })
  }

  /** The script's current picture (its canvas or SVG) as a PNG data URL. */
  async capture(): Promise<string> {
    this.post({ type: 'capture' })
    const message = await this.until('poster', 5000) as { dataUrl?: string }
    if (!message.dataUrl) throw new Error('The script has nothing drawn to capture')
    return message.dataUrl
  }

  destroy() {
    unregister(this)
    for (const listener of this.listeners) window.removeEventListener('message', listener)
    this.listeners = []
    this.frame?.remove()
    this.frame = null
  }
}

// ------------------------------------------------- slideshow click handling --

const running = new Set<ScriptHost>()
const register = (host: ScriptHost) => running.add(host)
const unregister = (host: ScriptHost) => running.delete(host)

/**
 * A slideshow click on a slide with scripts: the first script (in element order) that still has steps
 * takes it. Returns true when a script took the click. direction -1 steps back.
 */
export function stepScripts(slideId: string, elementOrder: string[], direction: 1 | -1): boolean {
  const hosts = [...running].filter(host => host.mode === 'screen' && host.slideId === slideId)
    .sort((a, b) => elementOrder.indexOf(a.element.id) - elementOrder.indexOf(b.element.id))
  if (direction === 1) {
    const next = hosts.find(host => host.step < host.steps)
    if (!next) return false
    next.stepTo(next.step + 1)
    return true
  }
  const previous = [...hosts].reverse().find(host => host.step > 0)
  if (!previous) return false
  previous.stepTo(previous.step - 1)
  return true
}

export const STARTER_SCRIPT = `// A script element. It draws on a canvas (or an SVG) the size of its box.
// slide.onEnter runs when the slide is shown; slide.onStep(n) on each click (set "steps").
// slide.theme has the deck's fonts and colours; slide.requestFrame animates with a pausable clock.
const canvas = slide.canvas()
const ctx = canvas.getContext('2d')
const { width, height } = slide

slide.onEnter(() => {
  slide.requestFrame(function draw(t) {
    ctx.clearRect(0, 0, width, height)
    const r = (Math.min(width, height) / 3) * (0.8 + 0.2 * Math.sin(t / 400))
    ctx.fillStyle = slide.theme.themeColors[0]
    ctx.beginPath()
    ctx.arc(width / 2, height / 2, r, 0, Math.PI * 2)
    ctx.fill()
    if (t < 4000) slide.requestFrame(draw)
  })
})
`
