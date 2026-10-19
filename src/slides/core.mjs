// The deck model, agent ops and merge, bundled for the Slides page (vendor/slides-core).
export * from "./deck.mjs";
export { applyOps, textHtml, OP_NAMES, SHAPE_NAMES } from "./ops.mjs";
export { mergeDecks, canonical } from "./merge.mjs";
