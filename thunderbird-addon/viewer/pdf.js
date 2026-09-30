// PDF renderer (pdf.js). Documents and presentations arrive here as PDFs the
// host converted with LibreOffice; presentations open one slide at a time.
const base = new URL("../vendor/pdfjs/", import.meta.url).href;
let libs = null;

async function loadLibs() {
  if (libs) return libs;
  const pdfjsLib = await import(`${base}pdf.min.mjs`);
  globalThis.pdfjsLib = pdfjsLib; // pdf_viewer.mjs reads it from the global
  pdfjsLib.GlobalWorkerOptions.workerSrc = `${base}pdf.worker.min.mjs`;
  const viewer = await import(`${base}pdf_viewer.mjs`);
  if (!document.querySelector("link[data-pdfjs]")) {
    const sheet = Object.assign(document.createElement("link"), { rel: "stylesheet", href: `${base}pdf_viewer.css` });
    sheet.dataset.pdfjs = "";
    document.head.append(sheet);
  }
  libs = { pdfjsLib, viewer };
  return libs;
}

export async function render(stage, file, { linkFor, setToolbar, h, icon, iconButton, toast }) {
  const convert = file.kind === "document" || file.kind === "slides";
  stage.replaceChildren(h("div.converting", {}, h("div.spinner"), h("span", {}, convert ? "Converting with LibreOffice…" : "Loading PDF…")));
  const [{ pdfjsLib, viewer: pdfViewer }, link] = await Promise.all([loadLibs(), linkFor(file.path, convert ? "pdf" : undefined)]);

  const container = h("div.pdf-container", { tabindex: "0" }, h("div.pdfViewer"));
  const eventBus = new pdfViewer.EventBus();
  const linkService = new pdfViewer.PDFLinkService({ eventBus });
  const findController = new pdfViewer.PDFFindController({ eventBus, linkService });
  const viewer = new pdfViewer.PDFViewer({ container, viewer: container.firstChild, eventBus, linkService, findController, textLayerMode: 1, removePageBorders: true });
  linkService.setViewer(viewer);

  const task = pdfjsLib.getDocument({
    url: link.url,
    cMapUrl: `${base}cmaps/`,
    cMapPacked: true,
    standardFontDataUrl: `${base}standard_fonts/`,
    wasmUrl: `${base}wasm/`,
    iccUrl: `${base}iccs/`,
    isEvalSupported: false,
    enableXfa: true,
  });
  const doc = await task.promise;
  stage.replaceChildren(container);
  viewer.setDocument(doc);
  linkService.setDocument(doc, null);

  const slides = file.kind === "slides";
  let mode = slides ? "pages" : "scroll";
  container.classList.toggle("slides", slides);

  // ---- toolbar
  const pageInput = h("input.input.page-input", { value: "1", "aria-label": "Page", inputmode: "numeric" });
  const pageCount = h("span.label", {}, `/ ${doc.numPages}`);
  const zoomSelect = h("select.input", { "aria-label": "Zoom" },
    ...[["auto", "Auto"], ["page-fit", "Fit page"], ["page-width", "Fit width"], ["0.5", "50%"], ["0.75", "75%"], ["1", "100%"], ["1.25", "125%"], ["1.5", "150%"], ["2", "200%"], ["3", "300%"]].map(([value, label]) => h("option", { value }, label)));
  const findInput = h("input.input.find-input", { placeholder: "Find in document", "aria-label": "Find in document" });
  const findCount = h("span.label", {});
  const modeButtons = h("div.segmented", {},
    h("button", { type: "button", "aria-pressed": String(mode === "scroll"), onclick: () => setMode("scroll") }, "Scroll"),
    h("button", { type: "button", "aria-pressed": String(mode === "pages"), onclick: () => setMode("pages") }, slides ? "Slides" : "Pages"));

  const goto = (n) => { viewer.currentPageNumber = Math.max(1, Math.min(doc.numPages, n)); };
  const find = (again = false, previous = false) => {
    eventBus.dispatch("find", { source: null, type: again ? "again" : "", query: findInput.value, caseSensitive: false, entireWord: false, highlightAll: true, findPrevious: previous, matchDiacritics: false });
  };
  function setMode(next) {
    mode = next;
    viewer.scrollMode = next === "pages" ? pdfViewer.ScrollMode.PAGE : pdfViewer.ScrollMode.VERTICAL;
    viewer.currentScaleValue = next === "pages" ? "page-fit" : "auto";
    zoomSelect.value = viewer.currentScaleValue;
    for (const button of modeButtons.children) button.setAttribute("aria-pressed", String(button.textContent === "Scroll" ? next === "scroll" : next === "pages"));
  }
  pageInput.addEventListener("change", () => goto(Number(pageInput.value)));
  zoomSelect.addEventListener("change", () => { viewer.currentScaleValue = zoomSelect.value; });
  findInput.addEventListener("keydown", (event) => { if (event.key === "Enter") find(true, event.shiftKey); });
  findInput.addEventListener("input", () => find());
  eventBus.on("pagechanging", ({ pageNumber }) => { pageInput.value = String(pageNumber); });
  eventBus.on("scalechanging", ({ presetValue, scale }) => { zoomSelect.value = presetValue ?? String(Math.round(scale * 100) / 100); if (!zoomSelect.value) zoomSelect.value = "auto"; });
  eventBus.on("updatefindmatchescount", ({ matchesCount }) => { findCount.textContent = matchesCount.total ? `${matchesCount.current} of ${matchesCount.total}` : findInput.value ? "No matches" : ""; });
  eventBus.on("pagesinit", () => { if (slides) setMode("pages"); else viewer.currentScaleValue = "auto"; });

  const zoomBy = (factor) => { viewer.currentScale = Math.max(0.1, Math.min(10, viewer.currentScale * factor)); };
  setToolbar(
    h("div.group", {}, iconButton("keyboard_arrow_left", "Previous page", () => goto(viewer.currentPageNumber - 1), { small: true }), pageInput, pageCount, iconButton("keyboard_arrow_right", "Next page", () => goto(viewer.currentPageNumber + 1), { small: true })),
    h("span.divider"),
    h("div.group", {}, iconButton("zoom_out", "Zoom out", () => zoomBy(1 / 1.2), { small: true }), zoomSelect, iconButton("zoom_in", "Zoom in", () => zoomBy(1.2), { small: true })),
    h("span.divider"),
    modeButtons,
    slides ? iconButton("fullscreen", "Present", () => container.requestFullscreen?.(), { small: true }) : null,
    h("span.spacer"),
    h("div.group.search-field", {}, icon("search", { size: 18 }), findInput),
    findCount,
  );
  container.focus();
  if (doc.numPages === 0) toast("This document has no pages");

  return {
    state: () => ({ page: viewer.currentPageNumber, pages: doc.numPages, zoom: viewer.currentScaleValue, mode, converted: convert }),
    command: async (action, args) => {
      if (action === "page") goto(Number(args.page));
      else if (action === "next") goto(viewer.currentPageNumber + 1);
      else if (action === "previous") goto(viewer.currentPageNumber - 1);
      else if (action === "zoom") { viewer.currentScaleValue = String(args.zoom); }
      else if (action === "find") { findInput.value = args.text ?? ""; find(); }
      else if (action === "mode") setMode(args.mode === "pages" ? "pages" : "scroll");
      else if (action === "text") {
        const page = await doc.getPage(Number(args.page ?? viewer.currentPageNumber));
        const content = await page.getTextContent();
        return { page: page.pageNumber, text: content.items.map((item) => item.str + (item.hasEOL ? "\n" : "")).join("") };
      } else throw new Error(`Unknown PDF action ${action}`);
      return { page: viewer.currentPageNumber, pages: doc.numPages };
    },
    onKey: (event) => {
      if (mode !== "pages") return;
      if (["ArrowRight", "PageDown", " "].includes(event.key)) { goto(viewer.currentPageNumber + 1); event.preventDefault(); }
      if (["ArrowLeft", "PageUp"].includes(event.key)) { goto(viewer.currentPageNumber - 1); event.preventDefault(); }
    },
    dispose: () => { viewer.cleanup?.(); void task.destroy?.(); },
  };
}
