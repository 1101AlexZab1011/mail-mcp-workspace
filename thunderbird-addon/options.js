import { PAIR_COMMAND, forgetToken, ensurePaired, host, json } from "./shared/broker.js";
import { APPEARANCES, setAppearance } from "./shared/theme.js";
import { dropdown, h } from "./shared/page.js";
import { DEFAULT_CODE_THEME } from "./viewer/code-theme.js";

const endpoint = document.querySelector("#endpoint");
const token = document.querySelector("#token");
const status = document.querySelector("#status");
document.querySelector("#pair-command").textContent = PAIR_COMMAND(location.origin);
browser.storage.local.get({ listenerEndpoint: "http://127.0.0.1:47800", listenerToken: "" }).then((settings) => { endpoint.value = settings.listenerEndpoint; token.value = settings.listenerToken; });

function brokerOrigin() {
  const url = new URL(endpoint.value);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1") throw new Error("Use http://127.0.0.1:<port>.");
  return url.origin;
}
document.querySelector("#save").addEventListener("click", async () => {
  try {
    if (!token.value) throw new Error("Enter a token, or use Pair now.");
    await browser.storage.local.set({ listenerEndpoint: brokerOrigin(), listenerToken: token.value, listenerScopesOk: false });
    status.textContent = "Saved.";
  } catch (error) { status.textContent = error.message; }
});
document.querySelector("#pair").addEventListener("click", async () => {
  try {
    await browser.storage.local.set({ listenerEndpoint: brokerOrigin() });
    await forgetToken();
    const paired = await ensurePaired();
    token.value = paired.token;
    status.textContent = "Paired.";
  } catch (error) { status.textContent = error instanceof TypeError ? "The broker is not reachable." : error.message; }
});

// ---- appearance
async function renderAppearance() {
  const { appearance } = await browser.storage.local.get({ appearance: "system" });
  document.querySelector("#appearance").replaceChildren(...APPEARANCES.map(([mode, label]) => h("button", {
    type: "button", role: "radio", "aria-checked": String(appearance === mode),
    onclick: async () => { await setAppearance(mode); await renderAppearance(); },
  }, label)));
}
void renderAppearance();

// ---- code theme, with a live preview
const SAMPLE = `// Fetch unread mail and group it by sender.
import { client } from "./mail";

export async function unreadBySender(folder: string): Promise<Map<string, number>> {
  const messages = await client.list(folder, { unread: true });
  const counts = new Map<string, number>();
  for (const { from } of messages) counts.set(from, (counts.get(from) ?? 0) + 1);
  return counts; // 3 senders, 12 messages
}`;

async function preview(theme) {
  const target = document.querySelector("#code-preview");
  try {
    const result = await host("/v1/highlight", json({ code: SAMPLE, lang: "typescript", theme }));
    target.innerHTML = result.html;
    target.style.background = result.bg;
  } catch (error) { target.textContent = `Preview unavailable: ${error.message}`; }
}

async function renderCodeTheme() {
  const { themes } = await fetch("http://127.0.0.1:47810/v1/code-themes").then((r) => r.json()).catch(() => ({ themes: [{ id: DEFAULT_CODE_THEME, name: "One Dark Pro" }] }));
  const { codeTheme } = await browser.storage.local.get({ codeTheme: DEFAULT_CODE_THEME });
  const picker = dropdown(themes.map((t) => [t.id, t.name]), codeTheme, async (id) => { await browser.storage.local.set({ codeTheme: id }); await preview(id); }, { label: "Code theme", width: 220 });
  document.querySelector("#code-theme").replaceChildren(picker);
  await preview(codeTheme);
}
void renderCodeTheme();
