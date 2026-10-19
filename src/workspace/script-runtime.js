// Runs inside a script element's sandboxed frame (served by the workspace host at /s/<id>/). It gives the
// script one global, `slide`, and talks to the Slides page by postMessage (see the fork's utils/scripts.ts).
// The frame has no same-origin access and its CSP allows no network: it can only draw and talk to its parent.

const parent = window.parent;
const send = (message) => parent.postMessage(message, "*");
const handlers = { enter: [], leave: [], step: [] };
let state = { width: 300, height: 200, pixelRatio: 1, theme: {}, data: {}, mode: "screen", step: 0, steps: 0 };
let surface = null;
let paused = false;
let clockStart = performance.now();
let pausedAt = 0;

const format = (value) => {
  if (value instanceof Error) return value.stack || value.message;
  if (typeof value === "object") { try { return JSON.stringify(value); } catch { return String(value); } }
  return String(value);
};
for (const level of ["log", "info", "warn", "error"]) {
  const original = console[level].bind(console);
  console[level] = (...args) => { original(...args); send({ type: level === "error" ? "error" : "log", text: args.map(format).join(" "), message: args.map(format).join(" ") }); };
}
window.addEventListener("error", (event) => send({ type: "error", message: `${event.message}${event.lineno ? ` (line ${event.lineno})` : ""}` }));
window.addEventListener("unhandledrejection", (event) => send({ type: "error", message: format(event.reason) }));

function call(kind, ...args) {
  for (const fn of handlers[kind]) {
    try { fn(...args); } catch (error) { send({ type: "error", message: format(error) }); }
  }
}

const clock = () => (paused ? pausedAt : performance.now() - clockStart);

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const slide = {
  get width() { return state.width; },
  get height() { return state.height; },
  get theme() { return state.theme; },
  get step() { return state.step; },
  get steps() { return state.steps; },
  get mode() { return state.mode; },
  /** A canvas the size of the box, at device resolution (drawing units are box px). */
  canvas() {
    if (surface?.tagName === "CANVAS") return surface;
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(state.width * state.pixelRatio);
    canvas.height = Math.round(state.height * state.pixelRatio);
    canvas.style.cssText = "width: 100%; height: 100%; display: block;";
    // A canvas holds one kind of context: 2D (scaled to box px) or WebGL (kept drawn, so posters can capture it).
    const getContext = canvas.getContext.bind(canvas);
    let ctx2d = null;
    canvas.getContext = (kind, options) => {
      if (kind === "2d") {
        if (!ctx2d) {
          ctx2d = getContext("2d", options);
          ctx2d?.scale(state.pixelRatio, state.pixelRatio);
        }
        return ctx2d;
      }
      if (/^(webgl2?|experimental-webgl)$/.test(kind)) return getContext(kind, { ...options, preserveDrawingBuffer: true });
      return getContext(kind, options);
    };
    document.body.replaceChildren(canvas);
    surface = canvas;
    return canvas;
  },
  /** An SVG the size of the box (viewBox in box px). */
  svg() {
    if (surface?.tagName === "svg") return surface;
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", `0 0 ${state.width} ${state.height}`);
    svg.setAttribute("width", "100%");
    svg.setAttribute("height", "100%");
    svg.style.display = "block";
    document.body.replaceChildren(svg);
    surface = svg;
    return svg;
  },
  /** A data file the element lists: parsed JSON, text (csv, txt), or an ArrayBuffer. */
  data(name) {
    if (!(name in state.data)) throw new Error(`No data file "${name}"; list it in the script's data files`);
    const value = state.data[name];
    if (typeof value === "string" && /\.json$/i.test(name)) return JSON.parse(value);
    return value;
  },
  onEnter(fn) { handlers.enter.push(fn); },
  onLeave(fn) { handlers.leave.push(fn); },
  onStep(fn) { handlers.step.push(fn); },
  /** Like requestAnimationFrame, with time in ms since the slide was entered (it stops while paused). */
  requestFrame(fn) {
    return requestAnimationFrame(() => {
      if (paused) { slide.requestFrame(fn); return; }
      try { fn(clock()); } catch (error) { send({ type: "error", message: format(error) }); }
    });
  },
  random(seed = 1) { return mulberry32(seed); },
  ease: {
    linear: (t) => t,
    inOut: (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2),
    out: (t) => 1 - (1 - t) ** 3,
    in: (t) => t * t * t,
  },
  log: (...args) => console.log(...args),
};
window.slide = slide;

async function poster() {
  if (!surface) return "";
  if (surface.tagName === "CANVAS") return surface.toDataURL("image/png");
  const markup = new XMLSerializer().serializeToString(surface);
  const image = new Image();
  image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(markup)}`;
  await image.decode();
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(state.width * state.pixelRatio);
  canvas.height = Math.round(state.height * state.pixelRatio);
  canvas.getContext("2d").drawImage(image, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/png");
}

async function load(src) {
  await new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = src;
    script.onload = resolve;
    script.onerror = () => reject(new Error(`Could not load ${src}`));
    document.head.append(script);
  });
}

window.addEventListener("message", async (event) => {
  if (event.source !== parent || !event.data || typeof event.data !== "object") return;
  const message = event.data;
  if (message.type === "init") {
    state = { ...state, ...message };
    document.documentElement.style.cssText = "margin: 0; height: 100%; overflow: hidden; background: transparent;";
    document.body.style.cssText = `margin: 0; width: 100%; height: 100%; overflow: hidden; font-family: ${state.theme?.fontName || "system-ui, sans-serif"}; color: ${state.theme?.fontColor || "#222"};`;
    try {
      const libs = new URL(location.href).searchParams.get("libs")?.split(",").filter(Boolean) ?? [];
      for (const lib of libs) {
        if (lib === "three") window.THREE = await import("./lib/three.js");
        else await load(`lib/${lib}.js`);
      }
      await load("script.js");
    } catch (error) {
      send({ type: "error", message: format(error) });
    }
    send({ type: "ready", steps: state.steps });
  }
  if (message.type === "enter") { clockStart = performance.now(); paused = false; call("enter"); }
  if (message.type === "leave") call("leave");
  if (message.type === "step") { state.step = message.n; call("step", message.n); }
  if (message.type === "pause") { pausedAt = clock(); paused = true; }
  if (message.type === "resume") { clockStart = performance.now() - pausedAt; paused = false; }
  if (message.type === "capture") send({ type: "poster", dataUrl: await poster().catch(() => "") });
});
