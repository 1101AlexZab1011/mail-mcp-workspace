import { PAIR_COMMAND, forgetToken, ensurePaired } from "./shared/broker.js";

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
