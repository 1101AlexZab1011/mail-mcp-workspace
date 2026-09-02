const endpoint = document.querySelector("#endpoint");
const token = document.querySelector("#token");
const status = document.querySelector("#status");
browser.storage.local.get({ endpoint: "http://127.0.0.1:46931", token: "" }).then((settings) => { endpoint.value = settings.endpoint; token.value = settings.token; });
document.querySelector("#save").addEventListener("click", async () => {
  const url = new URL(endpoint.value);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !token.value) { status.textContent = "Use http://127.0.0.1 and a token."; return; }
  await browser.storage.local.set({ endpoint: url.origin, token: token.value });
  status.textContent = "Saved.";
});
