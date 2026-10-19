import type { PPTScriptElement } from '@/types/slides'

// Callbacks the hosting page installs (window.pptist.hooks). The editor works without them;
// with them, it saves files where the host wants and reaches the agent.

/** What the user pointed at when asking the agent: the slide, and the selected elements if any. */
export interface AgentContext {
  target: 'element' | 'canvas' | 'slide'
  slideIndex: number
  slideId: string
  elements: { id: string, type: string, name?: string, text?: string }[]
  /** When asking about a custom transition or effect being edited. */
  motion?: { kind: 'transition' | 'effect', name: string, definition: string }
}

export interface BridgeHooks {
  /** Rewrite plain text; command is 'polish' | 'expand' | 'condense'. Yields the text so far, or resolves to the whole text. */
  rewrite?: (text: string, command: string) => AsyncIterable<string> | Promise<string>
  /** Save an exported file (PPTX, images, JSON). Without it, the browser downloads it. */
  saveFile?: (blob: Blob, name: string) => Promise<void> | void
  /** "Discuss in chat" on an element, the canvas or a slide thumbnail. */
  discuss?: (context: AgentContext) => void
  /** "Ask the agent…": the host asks the user what to do, then sends it with the context. */
  ask?: (context: AgentContext) => void

  // Script elements. Without these hooks, scripts never run and only their posters show.
  /** A URL serving a sandboxed page that runs the element's script (or `code`, for a preview of unsaved edits). */
  scriptFrame?: (element: PPTScriptElement, code?: string) => Promise<string>
  /** May this deck's scripts run? The host asks the user (once per deck and script version). */
  scriptTrust?: (element: PPTScriptElement, options?: { prompt?: boolean }) => Promise<boolean>
  /** A data file the script listed (relative to the deck): text for .json/.csv/.txt, bytes otherwise. */
  scriptData?: (path: string) => Promise<string | ArrayBuffer>
  readScript?: (src: string) => Promise<string>
  writeScript?: (src: string, code: string) => Promise<void>
  /** Make a new script file with starter code; returns its src. */
  createScript?: () => Promise<string>
  /** Store a poster picture (PNG data URL) as media; returns the reference to put in element.poster. */
  savePoster?: (dataUrl: string) => Promise<string>
}

export const hooks: BridgeHooks = {}
