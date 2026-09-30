// Which side each dock lives on. Everything that opens, minimizes or reads a
// dock goes through these, so moving a dock is a change here (and in the
// layout defaults in experiments/workspace/layout.js).
export const CHAT_SIDE = "right";
export const FILES_SIDE = "left";
export const sideIcon = (side, action) => `${side}_panel_${action}`; // left_panel_close, right_panel_open…
