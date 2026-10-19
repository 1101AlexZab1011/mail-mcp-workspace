// Motion in decks: custom transitions and effects (deck.motion), slide transitions and element
// animations. The Slides page plays them (fork: src/utils/motion.ts); this module checks and edits them.

/** The editor's own transitions and effects (PPTist, animate.css), by kind. */
export const BUILTIN_TRANSITIONS = ["no", "random", "slideX", "slideY", "slideX3D", "slideY3D", "fade", "rotate", "scaleY", "scaleX", "scale", "scaleReverse"];
export const BUILTIN_EFFECTS = {
  in: ["bounceIn", "bounceInLeft", "bounceInRight", "bounceInUp", "bounceInDown", "fadeIn", "fadeInDown", "fadeInDownBig", "fadeInLeft", "fadeInLeftBig", "fadeInRight", "fadeInRightBig", "fadeInUp", "fadeInUpBig", "fadeInTopLeft", "fadeInTopRight", "fadeInBottomLeft", "fadeInBottomRight", "rotateIn", "rotateInDownLeft", "rotateInDownRight", "rotateInUpLeft", "rotateInUpRight", "zoomIn", "zoomInDown", "zoomInLeft", "zoomInRight", "zoomInUp", "slideInDown", "slideInLeft", "slideInRight", "slideInUp", "flipInX", "flipInY", "backInDown", "backInLeft", "backInRight", "backInUp", "lightSpeedInRight", "lightSpeedInLeft"],
  out: ["bounceOut", "bounceOutLeft", "bounceOutRight", "bounceOutUp", "bounceOutDown", "fadeOut", "fadeOutDown", "fadeOutDownBig", "fadeOutLeft", "fadeOutLeftBig", "fadeOutRight", "fadeOutRightBig", "fadeOutUp", "fadeOutUpBig", "fadeOutTopLeft", "fadeOutTopRight", "fadeOutBottomLeft", "fadeOutBottomRight", "rotateOut", "rotateOutDownLeft", "rotateOutDownRight", "rotateOutUpLeft", "rotateOutUpRight", "zoomOut", "zoomOutDown", "zoomOutLeft", "zoomOutRight", "zoomOutUp", "slideOutDown", "slideOutLeft", "slideOutRight", "slideOutUp", "flipOutX", "flipOutY", "backOutDown", "backOutLeft", "backOutRight", "backOutUp", "lightSpeedOutRight", "lightSpeedOutLeft"],
  attention: ["shakeX", "shakeY", "headShake", "swing", "wobble", "tada", "jello", "bounce", "flash", "pulse", "rubberBand", "heartBeat"],
};
export const MAGIC_MOVE = "magic";
const NAME = /^[a-z0-9][a-z0-9-]*$/;
const TRIGGERS = { click: "click", with: "meantime", meantime: "meantime", after: "auto", auto: "auto" };
const MAX_DURATION = 10_000;

export const emptyMotion = () => ({ transitions: {}, effects: {} });

function checkKeyframes(frames, what) {
  if (frames === undefined) return;
  if (!Array.isArray(frames) || !frames.length || !frames.every((f) => f && typeof f === "object" && !Array.isArray(f))) throw new Error(`${what} must be a list of keyframe objects`);
  for (const frame of frames) {
    for (const key of Object.keys(frame)) {
      if (key.includes("-")) throw new Error(`${what}: write CSS properties in camelCase (${key} → ${key.replace(/-([a-z])/g, (_, c) => c.toUpperCase())})`);
    }
  }
}
function checkTiming(def) {
  if (def.duration !== undefined && !(Number(def.duration) > 0 && Number(def.duration) <= MAX_DURATION)) throw new Error(`duration must be between 1 and ${MAX_DURATION} ms`);
  if (def.easing !== undefined && typeof def.easing !== "string") throw new Error("easing is a CSS easing string");
}
const pick = (op, keys) => Object.fromEntries(keys.filter((k) => op[k] !== undefined).map((k) => [k, op[k]]));

/** A transition definition from an op (structure checked here; the page checks the CSS when it plays). */
export function transitionFrom(op) {
  const def = pick(op, ["label", "duration", "easing", "out", "in", "order", "perspective"]);
  checkTiming(def);
  checkKeyframes(def.out, "out");
  checkKeyframes(def.in, "in");
  if (!def.out && !def.in) throw new Error("give keyframes for out, in or both");
  if (def.order && !["in-over", "out-over"].includes(def.order)) throw new Error("order is in-over or out-over");
  return def;
}

export function effectFrom(op) {
  const def = pick(op, ["label", "type", "duration", "easing", "keyframes", "path", "origin"]);
  if (!["in", "out", "attention"].includes(def.type)) throw new Error("type is in, out or attention");
  checkTiming(def);
  checkKeyframes(def.keyframes, "keyframes");
  if (!def.keyframes && !def.path) throw new Error("give keyframes, a path, or both");
  if (def.path !== undefined && (typeof def.path !== "string" || !/^\s*[Mm]/.test(def.path))) throw new Error("path is SVG path data starting with M");
  return def;
}

const checkName = (name) => {
  if (!NAME.test(String(name ?? ""))) throw new Error("name: lowercase letters, digits and dashes (e.g. iris-wipe)");
  return String(name);
};

/** A slide's turningMode from what the agent wrote: a built-in name, "magic", or a custom name (with or without "custom:"). */
export function turningMode(deck, value) {
  if (BUILTIN_TRANSITIONS.includes(value) || value === MAGIC_MOVE) return value;
  const name = String(value ?? "").replace(/^custom:/, "");
  if (deck.motion?.transitions?.[name]) return `custom:${name}`;
  throw new Error(`No transition "${value}": use magic, a built-in one (${BUILTIN_TRANSITIONS.join(", ")}) or one defined with define_transition`);
}

/** An animation's effect and type from what the agent wrote. */
export function effectOf(deck, value) {
  const name = String(value ?? "").replace(/^custom:/, "");
  const custom = deck.motion?.effects?.[name];
  if (custom) return { effect: `custom:${name}`, type: custom.type, duration: custom.duration };
  for (const [type, names] of Object.entries(BUILTIN_EFFECTS)) if (names.includes(value)) return { effect: value, type };
  throw new Error(`No effect "${value}": use one defined with define_effect, or a built-in one (entrance like fadeIn, fadeInUp, zoomIn; exit like fadeOut; emphasis like pulse, headShake)`);
}

/** The motion ops; ops.mjs dispatches here. Returns undefined for ops that are not about motion. */
export function applyMotionOp(deck, op, env, findSlide) {
  switch (op.op) {
    case "define_transition": {
      const name = checkName(op.name);
      deck.motion = { ...emptyMotion(), ...deck.motion };
      deck.motion.transitions = { ...deck.motion.transitions, [name]: transitionFrom(op) };
      return { transition: name, use: `custom:${name}` };
    }
    case "define_effect": {
      const name = checkName(op.name);
      deck.motion = { ...emptyMotion(), ...deck.motion };
      deck.motion.effects = { ...deck.motion.effects, [name]: effectFrom(op) };
      return { effect: name, use: `custom:${name}` };
    }
    case "delete_motion": {
      const name = String(op.name ?? "").replace(/^custom:/, "");
      const kind = op.kind ?? (deck.motion?.transitions?.[name] ? "transition" : "effect");
      const library = kind === "transition" ? deck.motion?.transitions : deck.motion?.effects;
      if (!library?.[name]) throw new Error(`No ${kind} "${name}"`);
      delete library[name];
      // Slides and animations that used it fall back to the defaults.
      for (const slide of deck.slides) {
        if (kind === "transition" && slide.turningMode === `custom:${name}`) delete slide.turningMode;
        if (kind === "effect" && slide.animations) slide.animations = slide.animations.filter((a) => a.effect !== `custom:${name}`);
      }
      return { deleted: name };
    }
    case "set_transition": {
      const slides = op.slide === "all" ? deck.slides : [deck.slides[findSlide(deck, op.slide)]];
      const mode = turningMode(deck, op.transition ?? op.name);
      for (const slide of slides) slide.turningMode = mode;
      return { transition: mode, slides: slides.map((s) => s.id) };
    }
    case "add_animation": {
      const located = deck.slides.find((s) => s.elements.some((e) => e.id === op.id));
      if (!located) throw new Error(`No element ${op.id}`);
      const { effect, type, duration } = effectOf(deck, op.effect);
      const trigger = TRIGGERS[op.trigger ?? "click"];
      if (!trigger) throw new Error("trigger is click, with or after");
      const animation = { id: env.newId(), elId: op.id, type, effect, duration: Number(op.duration ?? duration ?? 1000), trigger };
      located.animations = [...(located.animations ?? [])];
      const at = op.position === undefined ? located.animations.length : Math.max(0, Math.min(Number(op.position), located.animations.length));
      located.animations.splice(at, 0, animation);
      return { animation: animation.id, slide: located.id };
    }
    case "update_animation":
    case "remove_animation": {
      const slide = deck.slides.find((s) => s.animations?.some((a) => a.id === op.id));
      if (!slide) throw new Error(`No animation ${op.id} (animation ids are listed by slides_read)`);
      const index = slide.animations.findIndex((a) => a.id === op.id);
      if (op.op === "remove_animation") {
        slide.animations.splice(index, 1);
        return { removed: op.id };
      }
      const animation = { ...slide.animations[index] };
      if (op.effect !== undefined) Object.assign(animation, (({ effect, type }) => ({ effect, type }))(effectOf(deck, op.effect)));
      if (op.trigger !== undefined) {
        if (!TRIGGERS[op.trigger]) throw new Error("trigger is click, with or after");
        animation.trigger = TRIGGERS[op.trigger];
      }
      if (op.duration !== undefined) animation.duration = Number(op.duration);
      slide.animations[index] = animation;
      if (op.position !== undefined) {
        slide.animations.splice(index, 1);
        slide.animations.splice(Math.max(0, Math.min(Number(op.position), slide.animations.length)), 0, animation);
      }
      return { animation: op.id };
    }
    default:
      return undefined;
  }
}

export const MOTION_OPS = ["define_transition", "define_effect", "delete_motion", "set_transition", "add_animation", "update_animation", "remove_animation"];
