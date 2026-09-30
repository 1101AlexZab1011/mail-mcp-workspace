// Images and SVG: fit, 100%, wheel zoom around the pointer, drag to pan.
// SVG is shown as an image (its scripts never run), with a source view.
export async function render(stage, file, { linkFor, host, setToolbar, h, iconButton }) {
  const link = await linkFor(file.path);
  const img = h("img", { src: link.url, alt: file.name, draggable: "false" });
  const view = h("div.image-stage", { tabindex: "0" }, img);
  stage.replaceChildren(view);
  await img.decode().catch(() => {});

  let scale = 1;
  let x = 0;
  let y = 0;
  const natural = () => ({ w: img.naturalWidth || 800, h: img.naturalHeight || 600 });
  const zoomLabel = h("span.label", {});
  const apply = () => {
    img.style.transform = `translate(${x}px, ${y}px) scale(${scale})`;
    img.classList.toggle("pixelated", scale >= 4);
    zoomLabel.textContent = `${Math.round(scale * 100)}%`;
  };
  const center = () => {
    const rect = view.getBoundingClientRect();
    const { w, h: ih } = natural();
    x = (rect.width - w * scale) / 2;
    y = (rect.height - ih * scale) / 2;
  };
  const fit = () => {
    const rect = view.getBoundingClientRect();
    const { w, h: ih } = natural();
    scale = Math.min(1, (rect.width - 48) / w, (rect.height - 48) / ih);
    center();
    apply();
  };
  const actual = () => { scale = 1; center(); apply(); };
  const zoomAt = (factor, px, py) => {
    const next = Math.max(0.05, Math.min(32, scale * factor));
    x = px - ((px - x) * next) / scale;
    y = py - ((py - y) * next) / scale;
    scale = next;
    apply();
  };
  view.addEventListener("wheel", (event) => {
    event.preventDefault();
    const rect = view.getBoundingClientRect();
    zoomAt(event.deltaY < 0 ? 1.15 : 1 / 1.15, event.clientX - rect.left, event.clientY - rect.top);
  }, { passive: false });
  view.addEventListener("pointerdown", (event) => {
    const start = { px: event.clientX, py: event.clientY, x, y };
    view.setPointerCapture(event.pointerId);
    view.classList.add("dragging");
    const move = (e) => { x = start.x + e.clientX - start.px; y = start.y + e.clientY - start.py; apply(); };
    view.addEventListener("pointermove", move);
    view.addEventListener("pointerup", () => { view.removeEventListener("pointermove", move); view.classList.remove("dragging"); }, { once: true });
  });
  view.addEventListener("dblclick", () => (scale === 1 ? fit() : actual()));
  new ResizeObserver(() => { if (scale <= 1) fit(); }).observe(view);
  fit();

  let showingSource = false;
  const sourceToggle = file.kind === "svg" ? iconButton("code", "Show source", async () => {
    showingSource = !showingSource;
    sourceToggle.setAttribute("aria-pressed", String(showingSource));
    if (showingSource) {
      const result = await host(`/v1/fs/highlight?path=${encodeURIComponent(file.path)}&lang=xml`);
      const code = h("div.code.wrap");
      code.innerHTML = result.html;
      stage.replaceChildren(code);
    } else stage.replaceChildren(view);
  }, { small: true, pressed: false }) : null;

  setToolbar(
    h("span.label", {}, `${natural().w} × ${natural().h}`),
    h("span.spacer"),
    iconButton("zoom_out", "Zoom out", () => { const r = view.getBoundingClientRect(); zoomAt(1 / 1.25, r.width / 2, r.height / 2); }, { small: true }),
    zoomLabel,
    iconButton("zoom_in", "Zoom in", () => { const r = view.getBoundingClientRect(); zoomAt(1.25, r.width / 2, r.height / 2); }, { small: true }),
    iconButton("fit_screen", "Fit", fit, { small: true }),
    h("button.btn.ghost", { type: "button", onclick: actual, style: { height: "30px", padding: "0 10px" } }, "100%"),
    sourceToggle,
  );
  view.focus();
  return {
    state: () => ({ width: natural().w, height: natural().h, zoom: Math.round(scale * 100) }),
    command: (action, args) => {
      if (action === "zoom") { if (args.zoom === "fit") fit(); else { scale = Number(args.zoom) / 100 || 1; center(); apply(); } return { zoom: Math.round(scale * 100) }; }
      throw new Error(`Unknown image action ${action}`);
    },
  };
}
