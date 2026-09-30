const endpoint = document.querySelector("#endpoint");
const token = document.querySelector("#token");
const status = document.querySelector("#status");
const defaults = { listenerEndpoint: "http://127.0.0.1:47800", listenerToken: "" };
document.querySelector("#pair-command").textContent = `listener-mcp pair --name thunderbird --origin ${location.origin} --scopes 'publish:mail/chat/**,read:mail/chat/**,blobs'`;
browser.storage.local.get(defaults).then((settings) => { endpoint.value = settings.listenerEndpoint; token.value = settings.listenerToken; });
function brokerOrigin() {
  const url = new URL(endpoint.value);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1") throw new Error("Use http://127.0.0.1:<port>.");
  return url.origin;
}
document.querySelector("#save").addEventListener("click", async () => {
  try {
    if (!token.value) throw new Error("Enter a token, or use Pair now.");
    await browser.storage.local.set({ listenerEndpoint: brokerOrigin(), listenerToken: token.value });
    status.textContent = "Saved.";
  } catch (error) { status.textContent = error.message; }
});
document.querySelector("#pair").addEventListener("click", async () => {
  try {
    const origin = brokerOrigin();
    const response = await fetch(`${origin}/v1/pair`, { method: "POST" });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error?.message ?? `Pairing failed (${response.status})`);
    await browser.storage.local.set({ listenerEndpoint: origin, listenerToken: result.token });
    token.value = result.token;
    status.textContent = "Paired.";
  } catch (error) { status.textContent = error instanceof TypeError ? "The broker is not reachable." : error.message; }
});
