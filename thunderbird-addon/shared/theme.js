// Appearance for every add-on page: "system" follows the OS, "light" and
// "dark" force it. Settings stores the choice; pages follow it live.
export const APPEARANCES = [["system", "System"], ["light", "Light"], ["dark", "Dark"]];

function apply(mode) {
  if (mode === "light" || mode === "dark") document.documentElement.dataset.theme = mode;
  else delete document.documentElement.dataset.theme;
}

browser.storage.local.get({ appearance: "system" }).then(({ appearance }) => apply(appearance), () => {});
browser.storage.onChanged.addListener((changes) => { if (changes.appearance) apply(changes.appearance.newValue); });

export async function setAppearance(mode) {
  await browser.storage.local.set({ appearance: mode });
  // Thunderbird's own window follows too (its built-in light/dark themes).
  await browser.workspace.setAppearance(mode).catch(() => {});
}
