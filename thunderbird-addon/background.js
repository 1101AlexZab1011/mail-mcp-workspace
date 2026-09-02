async function openChat() {
  const url = browser.runtime.getURL("chat.html");
  const tabs = await browser.tabs.query({});
  const existing = tabs.find((tab) => tab.url === url);
  if (existing) return browser.tabs.update(existing.id, { active: true });
  return browser.tabs.create({ url });
}
browser.browserAction.onClicked.addListener(openChat);
browser.runtime.onMessage.addListener((message) => message?.command === "open-chat" ? openChat() : undefined);
