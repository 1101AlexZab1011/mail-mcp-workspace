// File viewer space: shows one file at a time, read-only, with a renderer per
// kind (see viewer/). The host tells us what a file is; renderers get a
// context with the host API and a place for their toolbar.
import { host, HOST_ENDPOINT, json } from "./shared/broker.js";
import { $, h, iconButton, background, toast, formatSize, registerPage } from "./shared/page.js";
import { icon } from "./shared/icons.js";

const stage = $("#stage");
const toolbar = $("#toolbar");
const MAX_RECENT = 24;

const renderers = {
  pdf: () => import("./viewer/pdf.js"),
  document: () => import("./viewer/pdf.js"),
  slides: () => import("./viewer/pdf.js"),
  sheet: () => import("./viewer/sheet.js"),
  markdown: () => import("./viewer/markdown.js"),
  code: () => import("./viewer/code.js"),
  text: () => import("./viewer/code.js"),
  svg: () => import("./viewer/image.js"),
  image: () => import("./viewer/image.js"),
  audio: () => import("./viewer/audio.js"),
  video: () => import("./viewer/video.js"),
};
const kindLabel = { pdf: "PDF", document: "Document", slides: "Presentation", sheet: "Spreadsheet", markdown: "Markdown", code: "Code", text: "Text", svg: "SVG", image: "Image", audio: "Audio", video: "Video", binary: "Binary" };

let current = null; // { file, controller }
let theme = null;
let openSeq = 0;

async function iconUrl(file) {
  theme ??= await fetch(`${HOST_ENDPOINT}/icons/theme.json`).then((r) => r.json()).catch(() => ({}));
  const name = file.name.toLowerCase();
  let id = theme.fileNames?.[name];
  const parts = name.split(".");
  for (let i = 1; !id && i < parts.length; i++) id = theme.fileExtensions?.[parts.slice(i).join(".")];
  return `${HOST_ENDPOINT}/icons/${id ?? theme.file ?? "file"}.svg`;
}

/** A capability URL for the file (or its PDF conversion), usable in <img>, <video>, pdf.js. */
async function linkFor(path, convert) {
  const { url, mime, size } = await host("/v1/links", json({ path, ...(convert ? { convert } : {}) }));
  return { url: `${HOST_ENDPOINT}${url}`, mime, size };
}

function setToolbar(...items) {
  toolbar.replaceChildren(...items.filter(Boolean));
  toolbar.hidden = !items.filter(Boolean).length;
}

async function rememberRecent(file) {
  const { "viewer.recent": recent = [] } = await browser.storage.local.get({ "viewer.recent": [] }).catch(() => ({}));
  const next = [{ path: file.path, name: file.name, kind: file.kind, at: Date.now() }, ...recent.filter((r) => r.path !== file.path)].slice(0, MAX_RECENT);
  await browser.storage.local.set({ "viewer.recent": next }).catch(() => {});
}

async function renderHeader(file) {
  const fileIcon = $("#file-icon");
  if (file) { fileIcon.src = await iconUrl(file); fileIcon.hidden = false; } else fileIcon.hidden = true;
  $("#title").textContent = file?.name ?? "Files";
  $("#subtitle").textContent = file ? `${file.path.replace(/\/[^/]+$/, "") || "/"} · ${formatSize(file.size)} · ${new Date(file.mtime).toLocaleString()}` : "Read-only viewer";
  const chip = $("#kind");
  chip.hidden = !file;
  if (file) chip.textContent = kindLabel[file.kind] ?? file.kind;
  $("#actions").replaceChildren(...(file ? [
    iconButton("attach_file", "Attach to chat", () => background("attach-to-chat", { files: [{ path: file.path, name: file.name, type: file.mime, size: file.size }] }).then(() => toast("Attached to the chat"))),
    iconButton("content_copy", "Copy path", async () => { await navigator.clipboard.writeText(file.path); toast("Path copied"); }),
    iconButton("folder_open", "Show in file browser", () => background("files-reveal", { path: file.path })),
    iconButton("open_in_new", "Open in default app", () => host("/v1/open", json({ path: file.path })).then(() => toast("Opened externally"), (e) => toast(e.message))),
    iconButton("refresh", "Reload", () => open(file.path, { force: true })),
    iconButton("close", "Close file", () => showStart()),
  ] : []));
}

async function showStart() {
  try { current?.controller?.dispose?.(); } catch { /* best effort */ }
  current = null;
  setToolbar();
  await renderHeader(null);
  const { "viewer.recent": recent = [] } = await browser.storage.local.get({ "viewer.recent": [] }).catch(() => ({}));
  const list = h("div.recent");
  for (const item of recent) {
    list.append(h("button", { type: "button", onclick: () => open(item.path) },
      h("img", { src: await iconUrl(item), alt: "" }),
      h("span.text", {}, h("span.name", {}, item.name), h("span.path", {}, item.path)),
    ));
  }
  stage.replaceChildren(h("div.scroll", {}, h("div.start", {},
    h("h2", {}, "Files"),
    h("p", {}, "Open a file from the Files panel on the right (Ctrl+6), or ask the agent to open one."),
    recent.length ? list : h("div.empty", {}, icon("draft"), h("p", {}, "Nothing opened yet.")),
  )));
}

async function open(path, { force = false } = {}) {
  const seq = ++openSeq;
  let file;
  try { file = await host(`/v1/fs/stat?path=${encodeURIComponent(path)}`); }
  catch (error) { stage.replaceChildren(h("div.error-box", {}, `Cannot open ${path}: ${error.message}`)); return { error: error.message }; }
  if (file.directory) { await background("files-reveal", { path: file.path }); return { directory: true }; }
  if (!force && current?.file.path === file.path && current.file.mtime === file.mtime) return { path: file.path, kind: file.kind };
  try { current?.controller?.dispose?.(); } catch { /* best effort */ }
  current = { file, controller: null };
  await renderHeader(file);
  setToolbar();
  void rememberRecent(file);
  const load = renderers[file.kind];
  if (!load) { renderFallback(file); return { path: file.path, kind: file.kind }; }
  stage.replaceChildren(h("div.converting", {}, h("div.spinner"), h("span", {}, "Opening…")));
  try {
    const module = await load();
    if (seq !== openSeq) return { superseded: true };
    const controller = await module.render(stage, file, { host, json, linkFor, setToolbar, toast, h, icon, iconButton });
    if (seq !== openSeq) { controller?.dispose?.(); return { superseded: true }; }
    current.controller = controller;
  } catch (error) {
    if (seq !== openSeq) return { superseded: true };
    stage.replaceChildren(h("div.error-box", {}, h("strong", {}, "Could not show this file"), h("p", {}, error.message)));
  }
  return { path: file.path, kind: file.kind };
}

function renderFallback(file) {
  stage.replaceChildren(h("div.scroll", {}, h("div.card", {},
    h("img", { src: $("#file-icon").src, alt: "" }),
    h("strong", {}, file.name),
    h("p", { style: { margin: 0, color: "var(--mw-text-2)" } }, "This file type has no built-in preview."),
    h("dl", {}, h("dt", {}, "Path"), h("dd", {}, file.path), h("dt", {}, "Size"), h("dd", {}, formatSize(file.size)), h("dt", {}, "Type"), h("dd", {}, file.mime), h("dt", {}, "Modified"), h("dd", {}, new Date(file.mtime).toLocaleString())),
    h("button.btn.tonal", { type: "button", onclick: () => host("/v1/open", json({ path: file.path })) }, icon("open_in_new"), "Open in default app"),
  )));
}

registerPage("viewer", {
  state: () => ({
    file: current?.file ?? null,
    view: current?.controller?.state?.() ?? null,
    selectedText: String(getSelection() ?? "").slice(0, 4000) || null,
  }),
  commands: {
    open: ({ query, path }) => open(query ?? path),
    view: (message) => {
      if (!current?.controller?.command) throw new Error("This view has no commands");
      return current.controller.command(message.action, message.args ?? {});
    },
    close: () => showStart(),
  },
});

addEventListener("keydown", (event) => {
  if (event.target.closest?.("input, textarea")) return;
  current?.controller?.onKey?.(event);
});

const initial = new URLSearchParams(location.search).get("path");
if (initial) await open(initial); else await showStart();
