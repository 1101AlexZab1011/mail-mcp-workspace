// Code and plain text: highlighted by the host (Shiki, VS Code grammars) with
// line numbers, wrap toggle, copy, and go-to-line.
import { codeTheme, paintCode } from "./code-theme.js";

export async function render(stage, file, { host, setToolbar, h, iconButton, toast }) {
  const theme = await codeTheme();
  const result = await host(`/v1/fs/highlight?path=${encodeURIComponent(file.path)}&theme=${theme}${file.kind === "text" && !file.language ? "&lang=text" : ""}`);
  let wrap = file.kind === "text";
  const view = h(`div.code${wrap ? ".wrap" : ""}`, { tabindex: "0" });
  paintCode(view, result);
  if (result.truncated) view.append(h("div.truncated", {}, `Showing the first 1 MB of ${file.name}.`));
  stage.replaceChildren(view);

  const lineInput = h("input.input.page-input", { placeholder: "Line", "aria-label": "Go to line", inputmode: "numeric" });
  const gotoLine = (n) => {
    const line = view.querySelectorAll(".line")[Math.max(0, Number(n) - 1)];
    if (!line) return false;
    line.scrollIntoView({ block: "center" });
    line.animate([{ background: "var(--mw-selection)" }, { background: "transparent" }], { duration: 1400 });
    return true;
  };
  lineInput.addEventListener("keydown", (event) => { if (event.key === "Enter") gotoLine(lineInput.value); });
  const wrapButton = iconButton("wrap_text", "Wrap lines", () => {
    wrap = !wrap;
    view.classList.toggle("wrap", wrap);
    wrapButton.setAttribute("aria-pressed", String(wrap));
  }, { small: true, pressed: wrap });
  setToolbar(
    h("span.chip.primary", {}, result.language ?? "text"),
    h("span.label", {}, `${result.lines} lines`),
    h("span.spacer"),
    lineInput,
    wrapButton,
    iconButton("content_copy", "Copy all", async () => { await navigator.clipboard.writeText(view.querySelector("pre")?.textContent ?? ""); toast("Copied"); }, { small: true }),
  );
  view.focus();
  return {
    state: () => ({ language: result.language, lines: result.lines, wrap, truncated: result.truncated }),
    command: (action, args) => {
      if (action === "line") return { ok: gotoLine(args.line) };
      if (action === "wrap") { wrap = Boolean(args.wrap); view.classList.toggle("wrap", wrap); return { wrap }; }
      throw new Error(`Unknown code action ${action}`);
    },
  };
}
