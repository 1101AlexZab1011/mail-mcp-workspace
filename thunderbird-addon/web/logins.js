// The Browser's "save this password?": when a login form is sent in a web page, its username and password go
// to the add-on's background (never to the agent's tools), which asks the user in the web tab's toolbar
// (experiments/workspace/webmenu.js). Thunderbird's own password capture does not fire in its content tabs.
// A content script of every http(s) page; the background ignores pages that are not Browser tabs.
document.addEventListener("submit", (event) => {
  const form = event.target;
  if (!(form instanceof HTMLFormElement)) return;
  const fields = [...form.querySelectorAll("input")];
  const password = fields.find((input) => input.type === "password" && input.value);
  if (!password) return;
  // The username is the last filled text field before the password, as the password manager reads it.
  const username = fields.slice(0, fields.indexOf(password)).reverse()
    .find((input) => ["text", "email", "tel", ""].includes(input.type) && input.value);
  let formActionOrigin = location.origin;
  try { formActionOrigin = new URL(form.action || location.href).origin; } catch { /* keep the page's */ }
  void browser.runtime.sendMessage({
    to: "background", type: "login-submitted",
    origin: location.origin, formActionOrigin, username: username?.value ?? "", password: password.value,
  }).catch(() => {});
}, true);
