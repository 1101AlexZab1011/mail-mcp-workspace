// The code theme chosen in Settings (One Dark Pro by default) and how a
// highlighted block takes on its colours.
export const DEFAULT_CODE_THEME = "one-dark-pro";

export async function codeTheme() {
  const { codeTheme: theme } = await browser.storage.local.get({ codeTheme: DEFAULT_CODE_THEME }).catch(() => ({ codeTheme: DEFAULT_CODE_THEME }));
  return theme;
}

/** Put highlighted HTML into a container that uses the theme's own background. */
export function paintCode(container, result) {
  container.innerHTML = result.html; // Shiki escapes the source; nothing else is rendered.
  container.style.setProperty("--code-bg", result.bg);
  container.style.setProperty("--code-fg", result.fg);
  container.dataset.codeTheme = result.theme;
}
