// Slide decks on disk: `name.slides.json`, PPTist's own model plus a format marker, with media in
// a `media/` folder next to it (never inlined). Pure functions, shared by the Slides page (bundled into
// vendor/slides-core) and the workspace host.

export const FORMAT = "mail-workspace-slides";
export const EXTENSION = ".slides.json";
export const isDeckPath = (path) => String(path).toLowerCase().endsWith(EXTENSION);

export const DEFAULT_THEME = {
  themeColors: ["#4557d6", "#e8743b", "#19a979", "#f2b134", "#945ecf", "#13a4b4"],
  fontColor: "#1f2329",
  fontName: "",
  backgroundColor: "#ffffff",
  shadow: { h: 3, v: 3, blur: 2, color: "#808080" },
  outline: { width: 2, color: "#525252", style: "solid" },
};

const ID_ALPHABET = "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789_-";
/** A 10-character id, like PPTist's nanoid(10). */
export function newId() {
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  return Array.from(bytes, (b) => ID_ALPHABET[b % ID_ALPHABET.length]).join("");
}

export function blankSlide(theme = DEFAULT_THEME) {
  return { id: newId(), elements: [], background: { type: "solid", color: theme.backgroundColor ?? "#ffffff" } };
}

export function newDeck({ title = "Untitled presentation", width = 1280, ratio = 0.5625 } = {}) {
  return { format: FORMAT, version: 1, title, viewportSize: width, viewportRatio: ratio, theme: structuredClone(DEFAULT_THEME), motion: { transitions: {}, effects: {} }, slides: [blankSlide()] };
}

/** Parse a deck file. Also accepts PPTist's own JSON export ({ title, width, height, theme, slides }). */
export function parseDeck(text) {
  let data;
  try { data = JSON.parse(text); } catch (error) { throw new Error(`Not a slide deck: ${error.message}`); }
  if (Array.isArray(data)) data = { slides: data };
  if (!data || typeof data !== "object" || !Array.isArray(data.slides)) throw new Error("Not a slide deck: no slides");
  const width = Number(data.viewportSize ?? data.width ?? 1280);
  const ratio = Number(data.viewportRatio ?? (data.height && data.width ? data.height / data.width : 0.5625));
  for (const [index, slide] of data.slides.entries()) {
    if (!slide || typeof slide !== "object" || !Array.isArray(slide.elements)) throw new Error(`Slide ${index + 1} has no elements list`);
    slide.id ??= newId();
    for (const element of slide.elements) element.id ??= newId();
  }
  return {
    format: FORMAT,
    version: 1,
    title: String(data.title ?? "Untitled presentation"),
    viewportSize: width,
    viewportRatio: ratio,
    theme: { ...DEFAULT_THEME, ...(data.theme ?? {}) },
    motion: { transitions: { ...(data.motion?.transitions ?? {}) }, effects: { ...(data.motion?.effects ?? {}) } },
    slides: data.slides.length ? data.slides : [blankSlide()],
  };
}

/** The file text: stable top-level order, two-space indentation, trailing newline. */
export function serializeDeck(deck) {
  const { title, viewportSize, viewportRatio, theme, slides } = deck;
  const motion = deck.motion && (Object.keys(deck.motion.transitions ?? {}).length || Object.keys(deck.motion.effects ?? {}).length) ? deck.motion : undefined;
  return `${JSON.stringify({ format: FORMAT, version: 1, title, viewportSize, viewportRatio, theme, ...(motion ? { motion } : {}), slides }, null, 2)}\n`;
}

// ---------------------------------------------------------------- media --

/** Every place a deck refers to a media file: [holder, key] pairs (holder[key] is the reference). */
export function* mediaSlots(deck) {
  for (const slide of deck.slides) {
    if (slide.background?.image?.src) yield [slide.background.image, "src"];
    for (const element of slide.elements) yield* elementMediaSlots(element);
  }
}

function* elementMediaSlots(element) {
  if ((element.type === "image" || element.type === "video" || element.type === "audio") && element.src) yield [element, "src"];
  if (element.type === "video" && element.poster) yield [element, "poster"];
  if (element.type === "shape" && element.pattern) yield [element, "pattern"];
  if (element.type === "script" && element.poster) yield [element, "poster"];
}

/** A copy of the deck with every media reference passed through fn(ref) (fn may return the same ref). */
export function mapMedia(deck, fn) {
  const copy = structuredClone(deck);
  for (const [holder, key] of mediaSlots(copy)) holder[key] = fn(holder[key]);
  return copy;
}

const MIME_EXTENSION = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/svg+xml": "svg", "image/webp": "webp", "video/mp4": "mp4", "video/webm": "webm", "audio/mpeg": "mp3", "audio/wav": "wav", "audio/ogg": "ogg" };
export const extensionForMime = (mime) => MIME_EXTENSION[String(mime).split(";")[0].trim().toLowerCase()] ?? "bin";

/** Is this reference a file next to the deck (as opposed to a URL or inline data)? */
export const isRelativeMedia = (ref) => typeof ref === "string" && ref !== "" && !/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(ref) && !ref.startsWith("/");

// ------------------------------------------------------------- reading --

/** Visible text of PPTist rich-text HTML. */
export function htmlText(html) {
  return String(html ?? "")
    .replace(/<\/(p|li|h\d|div)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&#39;/g, "'").replace(/&amp;/g, "&")
    .replace(/\n{2,}/g, "\n").trim();
}

// PPTist's chart types by the names its menu shows ("bar" is drawn as vertical columns).
const CHART_NAMES = { bar: "column", column: "bar", ring: "doughnut" };

export function elementText(element) {
  if (element.type === "text") return htmlText(element.content);
  if (element.type === "shape") return htmlText(element.text?.content);
  if (element.type === "latex") return element.latex;
  if (element.type === "table") return element.data.map((row) => row.map((cell) => cell.text).join(" | ")).join("\n");
  if (element.type === "chart") return `${CHART_NAMES[element.chartType] ?? element.chartType}: ${element.data.labels.join(", ")}`;
  return "";
}

const round = (n) => Math.round(Number(n ?? 0) * 10) / 10;

/** One element as the agent sees it: id, type, box and content, without rendering details. */
export function describeElement(element, { html = false } = {}) {
  const out = { id: element.id, type: element.type };
  if (element.name) out.name = element.name;
  if (element.type === "line") {
    out.from = [round(element.left + element.start[0]), round(element.top + element.start[1])];
    out.to = [round(element.left + element.end[0]), round(element.top + element.end[1])];
    out.color = element.color;
    out.width = element.width;
    if (element.points?.some(Boolean)) out.ends = element.points;
  } else {
    out.box = [round(element.left), round(element.top), round(element.width), round(element.height)];
    if (element.rotate) out.rotate = element.rotate;
  }
  const text = elementText(element);
  if (text) out.text = text.length > 600 ? `${text.slice(0, 600)}…` : text;
  if (html && element.type === "text") out.html = element.content;
  if (html && element.type === "shape" && element.text) out.html = element.text.content;
  if (element.type === "image" || element.type === "video" || element.type === "audio") out.src = shortRef(element.src);
  if (element.type === "script") Object.assign(out, { src: element.src, steps: element.steps ?? 0, ...(element.libs?.length ? { libs: element.libs } : {}), ...(element.data?.length ? { data: element.data } : {}), poster: element.poster ? shortRef(element.poster) : null });
  if (element.type === "shape") { out.fill = element.pattern ? "image" : element.gradient ? "gradient" : element.fill; if (element.pathFormula) out.shape = element.pathFormula; }
  if (element.type === "text" || element.type === "shape") {
    const size = /font-size:\s*([\d.]+)px/.exec(element.type === "text" ? element.content : element.text?.content ?? "");
    if (size) out.size = Number(size[1]);
  }
  if (element.groupId) out.group = element.groupId;
  if (element.lock) out.locked = true;
  return out;
}

const shortRef = (ref) => (typeof ref === "string" && ref.startsWith("data:") ? `${ref.slice(0, 30)}… (inline)` : ref);

/** The deck as the agent reads it: slides with their elements and speaker notes. */
export function summarize(deck, { from = 0, to = deck.slides.length - 1, html = false } = {}) {
  const last = Math.min(to, deck.slides.length - 1);
  const slides = [];
  for (let index = Math.max(0, from); index <= last; index++) {
    const slide = deck.slides[index];
    const entry = { index, id: slide.id, elements: slide.elements.map((element) => describeElement(element, { html })) };
    if (slide.turningMode) entry.transition = slide.turningMode;
    if (slide.animations?.length) entry.animations = slide.animations.map((a) => ({ id: a.id, element: a.elId, effect: a.effect, type: a.type, trigger: { click: "click", meantime: "with", auto: "after" }[a.trigger] ?? a.trigger, duration: a.duration }));
    if (slide.remark) entry.notes = htmlText(slide.remark);
    if (slide.background?.type === "image") entry.background = { image: shortRef(slide.background.image?.src) };
    else if (slide.background?.type === "gradient") entry.background = "gradient";
    else if (slide.background?.color && slide.background.color !== deck.theme?.backgroundColor) entry.background = slide.background.color;
    if (slide.notes?.length) entry.comments = slide.notes.map((note) => ({ id: note.id, user: note.user, text: note.content, element: note.elId, replies: note.replies?.length ?? 0 }));
    slides.push(entry);
  }
  return {
    title: deck.title,
    canvas: { width: deck.viewportSize, height: Math.round(deck.viewportSize * deck.viewportRatio) },
    slideCount: deck.slides.length,
    fonts: { default: deck.theme?.fontName || "(app default)" },
    motion: { transitions: Object.keys(deck.motion?.transitions ?? {}), effects: Object.fromEntries(Object.entries(deck.motion?.effects ?? {}).map(([name, def]) => [name, def.type])) },
    slides,
  };
}
