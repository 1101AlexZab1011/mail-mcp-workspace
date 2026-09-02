const messages = document.querySelector("#messages");
const connection = document.querySelector("#connection");
const text = document.querySelector("#text");
const suggestions = document.querySelector("#skill-suggestions");
let settings; let cursor = 0;
let selectedSuggestion = 0;
const skills = [
  { command: "/email-start-chat", description: "Start or continue Agent Chat" },
  { command: "/email-review-pending", description: "Review and triage Pending email" },
  { command: "/email-summary", description: "Summarize recent email" },
];
const show = (item) => { const article = document.createElement("article"); article.className = item.type; article.textContent = item.text; messages.append(article); messages.scrollTop = messages.scrollHeight; };
async function loadSettings() {
  settings = await browser.storage.local.get({ endpoint: "http://127.0.0.1:46931", token: "" });
  if (settings.token) return;
  const response = await fetch(`${settings.endpoint}/v1/extension-settings`);
  if (!response.ok) return;
  const paired = await response.json();
  settings = { endpoint: paired.endpoint, token: paired.token };
  await browser.storage.local.set(settings);
}
async function api(path, init = {}) {
  if (!settings.token) throw new Error("Open Settings and add the local listener token.");
  const response = await fetch(`${settings.endpoint}${path}`, { ...init, headers: { authorization: `Bearer ${settings.token}`, "content-type": "application/json", ...(init.headers ?? {}) } });
  const result = await response.json(); if (!response.ok) throw new Error(result.error ?? "Listener unavailable"); return result;
}
async function refresh() {
  try { const result = await api(`/v1/conversations/default?after=${cursor}`); for (const item of result.items) { show(item); cursor = Math.max(cursor, item.sequence); } connection.textContent = result.agent_active ? "Agent active" : "Listener ready · no agent active"; }
  catch (error) { connection.textContent = error.message; }
}
document.querySelector("#compose").addEventListener("submit", async (event) => { event.preventDefault(); const value = text.value.trim(); if (!value) return; try { const item = await api("/v1/messages", { method: "POST", body: JSON.stringify({ conversation_id: "default", text: value }) }); show({ ...item, type: "user" }); cursor = Math.max(cursor, item.sequence); text.value = ""; connection.textContent = "Waiting for agent"; } catch (error) { connection.textContent = error.message; } });
function matchingSkills() { const query = text.value.trim().toLowerCase(); return query.startsWith("/") ? skills.filter((skill) => skill.command.startsWith(query)) : []; }
function hideSuggestions() { suggestions.hidden = true; suggestions.replaceChildren(); selectedSuggestion = 0; }
function chooseSuggestion(skill) { text.value = `${skill.command} `; hideSuggestions(); text.focus(); }
function renderSuggestions() {
  const matches = matchingSkills();
  if (!matches.length) return hideSuggestions();
  selectedSuggestion = Math.min(selectedSuggestion, matches.length - 1);
  suggestions.replaceChildren(...matches.map((skill, index) => {
    const item = document.createElement("div"); item.className = "skill-suggestion"; item.setAttribute("role", "option"); item.setAttribute("aria-selected", String(index === selectedSuggestion));
    item.innerHTML = `<span>${skill.command}</span><small>${skill.description}</small>`;
    item.addEventListener("mousedown", (event) => { event.preventDefault(); chooseSuggestion(skill); });
    return item;
  }));
  suggestions.hidden = false;
}
text.addEventListener("input", renderSuggestions);
text.addEventListener("keydown", (event) => {
  const matches = matchingSkills();
  if (matches.length && event.key === "ArrowDown") { event.preventDefault(); selectedSuggestion = (selectedSuggestion + 1) % matches.length; return renderSuggestions(); }
  if (matches.length && event.key === "ArrowUp") { event.preventDefault(); selectedSuggestion = (selectedSuggestion - 1 + matches.length) % matches.length; return renderSuggestions(); }
  if (matches.length && event.key === "Tab") { event.preventDefault(); return chooseSuggestion(matches[selectedSuggestion]); }
  if (event.key === "Escape") return hideSuggestions();
  if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); document.querySelector("#compose").requestSubmit(); }
});
document.querySelector("#settings").addEventListener("click", () => browser.runtime.openOptionsPage());
(async () => { await loadSettings(); await refresh(); setInterval(refresh, 1500); })();
