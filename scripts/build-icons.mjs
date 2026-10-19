#!/usr/bin/env node
// Builds the add-on's icon set from Material Symbols (Rounded, weight 400):
//
//   thunderbird-addon/shared/icons.js   name → path data, for the add-on's pages
//   thunderbird-addon/icons/<name>.svg  standalone files, for chrome CSS masks and
//                                       the spaces toolbar (fill: context-fill)
//
// Only the names listed here are bundled. Custom glyphs (no Material match) live
// in CUSTOM below and follow the same 960-unit grid.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = join(root, "node_modules/@material-symbols/svg-400/rounded");

export const NAMES = [
  // shell and docks
  "chat", "forum", "left_panel_close", "left_panel_open", "right_panel_close", "right_panel_open", "open_in_full", "close_fullscreen",
  "remove", "close", "more_vert", "more_horiz", "settings", "search", "refresh", "add", "arrow_back", "arrow_forward", "arrow_upward",
  "chevron_right", "keyboard_arrow_up", "chevron_left", "keyboard_arrow_down", "check", "check_circle", "error", "warning", "info", "help",
  "send", "attach_file", "content_copy", "download", "upload", "open_in_new", "link", "delete", "edit", "drive_file_rename",
  "visibility", "visibility_off", "filter_list", "sort", "tune", "home", "folder", "folder_open", "create_new_folder", "description",
  "draft", "code", "terminal", "image", "movie", "music_note", "picture_as_pdf", "table", "slideshow", "article", "text_snippet",
  "play_arrow", "pause", "volume_up", "volume_off", "speed", "fullscreen", "fullscreen_exit", "zoom_in", "zoom_out", "fit_screen",
  "first_page", "last_page", "replay_10", "forward_10", "keyboard_arrow_left", "keyboard_arrow_right", "wrap_text", "format_list_numbered", "stop",
  // spaces
  "mail", "calendar_month", "contacts", "task_alt", "preview", "widgets", "brush", "palette",
  // paint
  "menu", "splitscreen_right", "splitscreen_bottom", "select", "lasso_select", "polyline", "select_all", "deselect", "content_cut", "aspect_ratio", "note_add", "keyboard", "arrow_selector_tool", "draw", "ink_highlighter", "ink_eraser", "horizontal_rule", "north_east", "rectangle", "circle",
  "title", "format_color_fill", "colorize", "crop", "undo", "redo", "pan_tool", "layers", "photo_library", "content_paste",
  "flip_to_front", "flip_to_back", "opacity", "line_weight",
  // agent / artifacts
  "smart_toy", "wand_stars", "lock", "lock_open", "verified_user", "gpp_maybe", "bug_report", "code_blocks", "deployed_code",
  "keyboard_double_arrow_left", "keyboard_double_arrow_right", "dock_to_left", "dock_to_right", "cloud_off", "wifi_off", "schedule",
  // writer
  "format_bold", "format_italic", "format_strikethrough", "format_list_bulleted", "format_quote", "format_h1", "format_h2", "format_h3",
  "format_paragraph", "functions", "tag", "toc", "spellcheck", "save", "sync", "data_object", "menu_book", "lightbulb", "superscript",
  "dictionary", "check_small", "rate_review", "priority_high",
  // slides
  "upload", "slideshow",
];

// Glyphs Material Symbols lacks, drawn on the same 960 grid (viewBox 0 -960 960 960).
const CUSTOM = {
  // The Writer: a fountain-pen nib (cap, collar, nib with breather hole and slit),
  // drawn from strokes of the set's weight and flattened to one path.
  writer: "M 385 -860 A 15 15 0 0 0 370.6 -849.3 L 340.6 -749.3 A 15 15 0 0 0 355 -730 L 605 -730 A 15 15 0 0 0 619.4 -749.3 L 589.4 -849.3 A 15 15 0 0 0 575 -860 L 385 -860 z M 300 -708 A 40 40 0 0 0 260 -668 A 40 40 0 0 0 300 -628 L 660 -628 A 40 40 0 0 0 700 -668 A 40 40 0 0 0 660 -708 L 300 -708 z M 345 -624 A 36 36 0 0 0 309 -588 C 309 -516.6 275.8 -476.2 237.4 -413.9 A 36 36 0 0 0 239 -373.6 L 451 -86.6 A 36 36 0 0 0 509 -86.6 L 721 -373.6 A 36 36 0 0 0 722.6 -413.9 C 684.2 -476.2 651 -516.6 651 -588 A 36 36 0 0 0 615 -624 A 36 36 0 0 0 579 -588 C 579 -504.4 615.3 -448.4 648.4 -396.6 L 508 -206.5 L 508 -320 A 28 28 0 0 0 507.4 -325.7 C 540.2 -337.1 564 -368.5 564 -405 C 564 -451.1 526.1 -489 480 -489 C 433.9 -489 396 -451.1 396 -405 C 396 -368.5 419.8 -337.1 452.6 -325.7 A 28 28 0 0 0 452 -320 L 452 -206.5 L 311.6 -396.6 C 344.7 -448.4 381 -504.4 381 -588 A 36 36 0 0 0 345 -624 z M 480 -433 C 495.8 -433 508 -420.8 508 -405 C 508 -389.2 495.8 -377 480 -377 C 464.2 -377 452 -389.2 452 -405 C 452 -420.8 464.2 -433 480 -433 z",
  // Slides: a presentation screen on its stand, showing a rising line; same stroke weight as the set.
  slides: "M 130 -838 A 38 38 0 0 0 92 -800 A 38 38 0 0 0 130 -762 L 168 -762 L 168 -380 C 168 -358 174 -335.7 189.9 -319.9 C 205.7 -304 228 -298 250 -298 L 448 -298 L 448 -243.3 L 337.4 -132.6 A 32 32 0 0 0 337.4 -87.4 A 32 32 0 0 0 382.6 -87.4 L 480 -184.7 L 577.4 -87.4 A 32 32 0 0 0 622.6 -87.4 A 32 32 0 0 0 622.6 -132.6 L 512 -243.3 L 512 -298 L 710 -298 C 732 -298 754.3 -304 770.1 -319.9 C 786 -335.7 792 -358 792 -380 L 792 -762 L 830 -762 A 38 38 0 0 0 868 -800 A 38 38 0 0 0 830 -838 L 130 -838 z M 232 -762 L 728 -762 L 728 -380 C 728 -368.7 725.7 -365.9 724.9 -365.1 C 724.1 -364.3 721.3 -362 710 -362 L 250 -362 C 238.7 -362 235.9 -364.3 235.1 -365.1 C 234.3 -365.9 232 -368.7 232 -380 L 232 -762 z M 649.1 -688 A 28 28 0 0 0 629.6 -679.2 L 497 -537.8 L 427.2 -592.1 A 28 28 0 0 0 390.2 -589.8 L 290.2 -489.8 A 28 28 0 0 0 290.2 -450.2 A 28 28 0 0 0 329.8 -450.2 L 412.3 -532.7 L 482.8 -477.9 A 28 28 0 0 0 520.4 -480.8 L 670.4 -640.8 A 28 28 0 0 0 669.2 -680.4 A 28 28 0 0 0 656.4 -687.3 A 28 28 0 0 0 649.1 -688 z",
  // An artifact: a window with a code bracket and a spark, "something built".
  artifact: "M200-120q-33 0-56.5-23.5T120-200v-560q0-33 23.5-56.5T200-840h360v80H200v560h560v-360h80v360q0 33-23.5 56.5T760-120H200Zm160-160-120-120 120-120 42 42-78 78 78 78-42 42Zm240 0-42-42 78-78-78-78 42-42 120 120-120 120Zm120-340-25-55-55-25 55-25 25-55 25 55 55 25-55 25-25 55Z",
};

async function pathOf(name) {
  const svg = await readFile(join(source, `${name}.svg`), "utf8");
  const paths = [...svg.matchAll(/ d="([^"]+)"/g)].map((match) => match[1]);
  if (!paths.length) throw new Error(`No path in ${name}`);
  return paths.join(" ");
}

const icons = {};
for (const name of NAMES) {
  icons[name] = await pathOf(name);
  try { icons[`${name}.fill`] = await pathOf(`${name}-fill`); } catch { /* no filled variant */ }
}
Object.assign(icons, CUSTOM);

const addon = join(root, "thunderbird-addon");
await writeFile(join(addon, "shared/icons.js"), `// Generated by scripts/build-icons.mjs from Material Symbols Rounded (Apache-2.0). Do not edit.
export const ICONS = ${JSON.stringify(icons)};

/** An inline SVG icon; \`fill\` picks the filled variant when there is one. */
export function icon(name, { fill = false, size = 20, label } = {}) {
  const d = (fill && ICONS[\`\${name}.fill\`]) || ICONS[name];
  if (!d) throw new Error(\`Unknown icon \${name}\`);
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 -960 960 960");
  svg.setAttribute("width", size);
  svg.setAttribute("height", size);
  svg.setAttribute("class", "icon");
  if (label) svg.setAttribute("aria-label", label); else svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", d);
  svg.append(path);
  return svg;
}
`);
await mkdir(join(addon, "icons"), { recursive: true });
for (const [name, d] of Object.entries(icons)) {
  await writeFile(join(addon, "icons", `${name}.svg`), `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 -960 960 960" fill="context-fill" fill-opacity="context-fill-opacity"><path d="${d}"/></svg>\n`);
}
console.log(`${Object.keys(icons).length} icons`);
