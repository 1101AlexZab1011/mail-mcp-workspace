async function openChat() {
  const url = browser.runtime.getURL("chat.html");
  const tabs = await browser.tabs.query({});
  const existing = tabs.find((tab) => tab.url === url);
  if (existing) return browser.tabs.update(existing.id, { active: true });
  return browser.tabs.create({ url });
}
browser.browserAction.onClicked.addListener(openChat);
browser.runtime.onMessage.addListener((message) => message?.command === "open-chat" ? openChat() : undefined);

// Pair with the listener-mcp broker at startup, so an open pairing grant is used even if
// the chat tab is never opened while it lasts. The panel pairs the same way on its own.
async function pairInBackground() {
  const stored = await browser.storage.local.get({ listenerEndpoint: "http://127.0.0.1:47800", listenerToken: "" }).catch(() => null);
  if (!stored || stored.listenerToken) return;
  // POST: Thunderbird omits Origin on extension GETs, and pairing is bound to the origin.
  const response = await fetch(`${stored.listenerEndpoint}/v1/pair`, { method: "POST" }).catch(() => null);
  if (!response?.ok) return;
  const { token } = await response.json();
  await browser.storage.local.set({ listenerEndpoint: stored.listenerEndpoint, listenerToken: token });
}
void pairInBackground();
