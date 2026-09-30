// Markdown: rendered (marked + DOMPurify + KaTeX), or its highlighted source.
/* global marked, DOMPurify, katex */
export async function render(stage, file, { host, linkFor, setToolbar, h }) {
  const { text, truncated } = await host(`/v1/fs/read?path=${encodeURIComponent(file.path)}&limit=${4 * 1024 * 1024}`);
  const folder = file.path.replace(/\/[^/]+$/, "");
  let mode = "rendered";
  const page = h("div.markdown-page", { tabindex: "0" });

  function rendered() {
    const body = h("article.markdown-body");
    body.innerHTML = DOMPurify.sanitize(marked.parse(text, { gfm: true }), { FORBID_TAGS: ["style"], ADD_ATTR: ["target"] });
    // Math: $$…$$ blocks and ```math fences.
    for (const code of body.querySelectorAll("pre code.language-math, pre code.language-latex")) {
      const div = h("div");
      try { katex.render(code.textContent, div, { displayMode: true, throwOnError: false }); } catch { div.textContent = code.textContent; }
      code.closest("pre").replaceWith(div);
    }
    // Links: files open in the viewer, web links outside.
    for (const link of body.querySelectorAll("a[href]")) {
      const href = link.getAttribute("href");
      if (/^https?:/i.test(href)) { link.target = "_blank"; link.rel = "noopener noreferrer"; continue; }
      if (href.startsWith("#")) continue;
      link.addEventListener("click", (event) => {
        event.preventDefault();
        const target = href.startsWith("/") ? href : `${folder}/${href}`;
        browser.runtime.sendMessage({ to: "background", type: "open-file", path: decodeURI(target.split("#")[0]) });
      });
    }
    // Images beside the document load through short-lived host links.
    for (const img of body.querySelectorAll("img")) {
      const src = img.getAttribute("src") ?? "";
      if (/^(https?:|data:)/.test(src)) continue;
      img.removeAttribute("src");
      const target = decodeURI(src.startsWith("/") ? src : `${folder}/${src}`);
      linkFor(target).then((link) => { img.src = link.url; }, () => img.replaceWith(h("em", {}, `[missing image: ${img.alt || src}]`)));
    }
    return body;
  }

  async function source() {
    const result = await host(`/v1/fs/highlight?path=${encodeURIComponent(file.path)}&lang=markdown`);
    const view = h("div.code.wrap");
    view.innerHTML = result.html;
    return view;
  }

  async function show() {
    if (mode === "rendered") { page.replaceChildren(rendered()); stage.replaceChildren(page); }
    else stage.replaceChildren(await source());
    for (const button of toggle.children) button.setAttribute("aria-pressed", String(button.dataset.mode === mode));
  }
  const toggle = h("div.segmented", {},
    h("button", { type: "button", dataset: { mode: "rendered" }, onclick: () => { mode = "rendered"; void show(); } }, "Preview"),
    h("button", { type: "button", dataset: { mode: "source" }, onclick: () => { mode = "source"; void show(); } }, "Source"));
  setToolbar(toggle, h("span.spacer"), truncated ? h("span.chip.warning", {}, "Truncated at 4 MB") : null);
  await show();
  return {
    state: () => ({ mode, headings: [...page.querySelectorAll("h1, h2, h3")].map((el) => el.textContent).slice(0, 50) }),
    command: async (action, args) => {
      if (action === "mode") { mode = args.mode === "source" ? "source" : "rendered"; await show(); return { mode }; }
      if (action === "heading") { const el = [...page.querySelectorAll("h1,h2,h3,h4")].find((x) => x.textContent.toLowerCase().includes(String(args.text).toLowerCase())); el?.scrollIntoView({ block: "start" }); return { found: Boolean(el) }; }
      throw new Error(`Unknown markdown action ${action}`);
    },
  };
}
