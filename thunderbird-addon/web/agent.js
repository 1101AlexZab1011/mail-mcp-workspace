// The agent's hands in a web page of the Browser: injected by the GUI bridge (tabs.executeScript) into
// the active web tab, then called as __mwWeb.<command>(args). It lists the page's controls with refs,
// fills them, and reads the page's text. Everything it returns comes from the page: untrusted data.
//
// The user's part stays the user's: logins (password fields) and final buttons that send, submit or pay
// are refused here; the agent asks the user to press them.
/* eslint-disable no-var */
var __mwWeb = globalThis.__mwWeb ?? (() => {
  const refs = new Map();
  // Refs name the document too, so a ref from a page the tab has left never finds an element here.
  const page = Math.random().toString(36).slice(2, 6);
  let serial = 0;

  const INTERACTIVE = [
    "a[href]", "button", "input:not([type=hidden])", "select", "textarea", "summary", "[contenteditable=''], [contenteditable=true]",
    "[role=button]", "[role=link]", "[role=checkbox]", "[role=radio]", "[role=switch]", "[role=tab]", "[role=menuitem]",
    "[role=option]", "[role=combobox]", "[role=textbox]", "[role=searchbox]", "[tabindex]:not([tabindex='-1'])",
  ].join(", ");
  // Buttons that finish something for good: the user presses these, not the agent.
  const FINAL = /(?<![\p{L}\p{N}])(absenden|abschicken|senden|versenden|übermitteln|uebermitteln|einreichen|kaufen|bezahlen|zahlen|zahlungspflichtig|bestellen|buchen|unterschreiben|unterzeichnen|signieren|löschen|kündigen|submit|send|buy|purchase|pay|checkout|place order|order now|confirm|book now|sign|delete|transfer)(?![\p{L}\p{N}])/iu;

  const clean = (text, max = 120) => (text ?? "").replace(/\s+/g, " ").trim().slice(0, max);

  // Password fields stay secret even when the page shows them as text ("show password"): every field seen
  // as a password once is remembered, for as long as the page lives.
  const secrets = new WeakSet();
  const noteSecrets = () => { for (const el of document.querySelectorAll("input[type=password]")) secrets.add(el); };
  const isSecret = (el) => el.localName === "input" && (secrets.has(el) || el.type === "password"
    || /(current|new)-password|one-time-code/.test(el.autocomplete ?? "")
    || /pass(wor[dt])?|pwd|kennwort|\bpin\b|\btan\b/i.test(`${el.name} ${el.id} ${labelText(el)}`));

  function labelText(el) {
    const by = el.getAttribute("aria-labelledby");
    if (by) {
      const text = by.split(/\s+/).map((id) => document.getElementById(id)?.textContent ?? "").join(" ");
      if (clean(text)) return clean(text);
    }
    if (clean(el.getAttribute("aria-label"))) return clean(el.getAttribute("aria-label"));
    if (el.labels?.length) { const text = [...el.labels].map(ownText).join(" "); if (clean(text)) return clean(text); }
    if (el.localName === "input" && ["submit", "button", "reset"].includes(el.type)) return clean(el.value) || clean(el.type);
    if (el.localName === "input" && el.type === "image") return clean(el.alt) || "image button";
    if (!["input", "select", "textarea"].includes(el.localName)) {
      const text = clean(el.innerText ?? el.textContent);
      if (text) return text;
      const img = el.querySelector("img[alt]");
      if (clean(img?.alt)) return clean(img.alt);
    }
    return clean(el.getAttribute("placeholder")) || clean(el.title) || clean(el.getAttribute("name")) || clean(el.id);
  }

  /** A label's own words, without the text of the controls it wraps (a select's options). */
  function ownText(label) {
    const copy = label.cloneNode(true);
    for (const control of copy.querySelectorAll("select, textarea, input, button, datalist")) control.remove();
    return copy.textContent;
  }

  function roleOf(el) {
    const role = el.getAttribute("role");
    if (role) return role;
    switch (el.localName) {
      case "a": return "link";
      case "button": case "summary": return "button";
      case "select": return el.multiple ? "listbox" : "combobox";
      case "textarea": return "textbox";
      case "input": {
        const type = el.type;
        if (["submit", "button", "reset", "image"].includes(type)) return "button";
        if (type === "checkbox" || type === "radio") return type;
        if (type === "search") return "searchbox";
        return "textbox";
      }
      default: return el.isContentEditable ? "textbox" : el.localName;
    }
  }

  /** A button that submits its form (an explicit submit, or a button without a type inside a form). */
  function submits(el) {
    if (el.localName === "input") return ["submit", "image"].includes(el.type);
    if (el.localName === "button") return (el.getAttribute("type") ?? "submit").toLowerCase() === "submit" && Boolean(el.form);
    return false;
  }

  function finalVerdict(el, action) {
    const name = labelText(el);
    if (action === "type" && isSecret(el)) {
      return { refused: true, reason: "Password fields are the user's: ask the user to log in themselves." };
    }
    const pressing = action === "click" || (action === "press" && el.form);
    if (!pressing) return null;
    // Enter in a field submits through the form's default button: judge that button.
    const button = action === "press" ? (el.form?.querySelector("button:not([type]), button[type=submit], input[type=submit], input[type=image]") ?? null) : el;
    const label = button ? labelText(button) : "";
    if (button && (submits(button) || roleOf(button) === "button") && FINAL.test(label)) {
      return { refused: true, reason: `“${label}” sends or completes something for good. Ask the user to press it themselves.` };
    }
    if (action === "click" && el.localName === "a" && FINAL.test(name) && /(?<![\p{L}])(pay|checkout|bezahlen|kaufen|buy)(?![\p{L}])/iu.test(name)) {
      return { refused: true, reason: `“${name}” looks like a payment step. Ask the user to press it themselves.` };
    }
    return null;
  }

  function visible(el) {
    const rect = el.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) {
      // Hidden native checkboxes/radios are often drawn by their label; keep them.
      if (!(el.localName === "input" && ["checkbox", "radio"].includes(el.type) && el.labels?.length)) return false;
    }
    return el.checkVisibility?.({ visibilityProperty: true }) ?? true;
  }

  function describe(el, ref) {
    const item = { ref, role: roleOf(el), name: labelText(el) };
    if (el.localName === "input" && !["submit", "button", "reset", "image", "checkbox", "radio"].includes(el.type)) item.type = el.type;
    if ("value" in el && !["button", "submit", "reset", "image", "checkbox", "radio"].includes(el.type) && el.localName !== "button" && el.localName !== "select") {
      if (isSecret(el)) item.value = el.value ? "(filled)" : "";
      else if (el.value) item.value = clean(el.value, 300);
    }
    if (el.isContentEditable && el.localName !== "input") item.value = clean(el.innerText, 300);
    if (el.localName === "select") {
      item.value = clean(el.selectedOptions?.[0]?.textContent);
      item.options = [...el.options].slice(0, 60).map((o) => clean(o.textContent, 80) + (o.value && clean(o.textContent) !== o.value ? ` [${o.value}]` : ""));
    }
    if (el.localName === "input" && ["checkbox", "radio"].includes(el.type)) item.checked = el.checked;
    else if (el.getAttribute("aria-checked")) item.checked = el.getAttribute("aria-checked") === "true";
    if (el.getAttribute("aria-selected") === "true") item.selected = true;
    if (el.getAttribute("aria-expanded")) item.expanded = el.getAttribute("aria-expanded") === "true";
    if (el.disabled || el.getAttribute("aria-disabled") === "true") item.disabled = true;
    if (el.required || el.getAttribute("aria-required") === "true") item.required = true;
    if (el.getAttribute("aria-invalid") === "true" || (el.validity && !el.validity.valid && el.value)) item.invalid = true;
    if (el.localName === "a") item.href = clean(el.href, 160);
    if (submits(el)) item.submits = true;
    const rect = el.getBoundingClientRect();
    if (rect.bottom < 0 || rect.top > innerHeight) item.offscreen = true;
    return item;
  }

  function snapshot({ query, limit = 200 } = {}) {
    refs.clear();
    serial++;
    const items = [];
    let total = 0;
    const needle = query ? String(query).toLowerCase() : "";
    for (const el of document.querySelectorAll(INTERACTIVE)) {
      if (!visible(el)) continue;
      // A label-only wrapper (e.g. tabindex on a container holding a real control) adds nothing.
      if (el.matches("[tabindex]") && !el.matches("a, button, input, select, textarea, [role]") && el.querySelector("a, button, input, select, textarea")) continue;
      const ref = `w${page}${serial}.${refs.size + 1}`;
      const item = describe(el, ref);
      if (needle && !`${item.name} ${item.value ?? ""} ${item.role}`.toLowerCase().includes(needle)) continue;
      total++;
      if (items.length >= limit) continue;
      refs.set(ref, new WeakRef(el));
      items.push(item);
    }
    return { url: location.href, title: document.title, items, truncated: total > items.length ? total : undefined };
  }

  function resolve(ref) {
    const el = refs.get(ref)?.deref();
    if (!el?.isConnected) throw new Error(`Ref ${ref} is stale: take a new web_snapshot`);
    return el;
  }

  /** Set a field's value the way typing does, so the page's framework (React, Angular, …) sees it. */
  function setValue(el, value) {
    const proto = el.localName === "textarea" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    if (setter) setter.call(el, value); else el.value = value;
    el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  /** Where to click: the element's centre in the page's viewport, if the element is what is there. */
  function pointOf(el) {
    el.scrollIntoView({ block: "center", inline: "nearest" });
    const rect = el.getBoundingClientRect();
    const x = rect.x + Math.min(rect.width / 2, Math.max(4, rect.width - 4));
    const y = rect.y + rect.height / 2;
    const hit = document.elementFromPoint(x, y);
    return hit && (hit === el || el.contains(hit) || hit.contains(el) || (el.labels && [...el.labels].some((l) => l.contains(hit)))) ? { x, y } : null;
  }

  function act({ ref, action, value, check = false }) {
    const el = resolve(ref);
    const name = labelText(el);
    const verdict = finalVerdict(el, action);
    if (verdict) return { ref, action, name, ...verdict };
    if (check) {
      // Clicks go out as real mouse input from Thunderbird when the element is in view there.
      if (action === "click" || ((action === "check" || action === "uncheck") && el.checked !== (action === "check"))) {
        const point = pointOf(el);
        if (point) return { ref, action, name, point };
      }
      return { ref, action, name };
    }
    switch (action) {
      case "click": el.click(); break;
      case "focus": el.focus(); break;
      case "type": {
        el.focus();
        if (el.isContentEditable && !("value" in el)) { document.execCommand("selectAll"); document.execCommand("insertText", false, value ?? ""); }
        else setValue(el, String(value ?? ""));
        break;
      }
      case "select": {
        if (el.localName !== "select") throw new Error("Not a dropdown: click it and pick the option from a new snapshot");
        const wanted = String(value ?? "").trim().toLowerCase();
        const option = [...el.options].find((o) => o.value.toLowerCase() === wanted) ?? [...el.options].find((o) => clean(o.textContent).toLowerCase() === wanted)
          ?? [...el.options].find((o) => clean(o.textContent).toLowerCase().includes(wanted));
        if (!option) throw new Error(`No option “${value}”. Options: ${[...el.options].map((o) => clean(o.textContent, 40)).join(" | ")}`);
        el.value = option.value;
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
        break;
      }
      case "check": case "uncheck": {
        const want = action === "check";
        const checked = "checked" in el ? el.checked : el.getAttribute("aria-checked") === "true";
        if (checked !== want) el.click();
        break;
      }
      case "press": {
        const key = String(value ?? "Enter");
        el.focus();
        if (key === "Enter" && el.form && el.localName === "input") { el.form.requestSubmit(); break; }
        for (const type of ["keydown", "keypress", "keyup"]) el.dispatchEvent(new KeyboardEvent(type, { key, bubbles: true, cancelable: true }));
        break;
      }
      default: throw new Error(`Unknown action ${action}`);
    }
    return after(el, { ref, action, name });
  }

  function after(el, result) {
    const done = { ...result, done: true };
    if ("checked" in el && ["checkbox", "radio"].includes(el.type)) done.checked = el.checked;
    else if (el.localName === "select") done.value = clean(el.selectedOptions?.[0]?.textContent);
    else if ("value" in el && !isSecret(el) && el.localName !== "button") done.value = clean(el.value, 300);
    return done;
  }

  /** After a real click from Thunderbird: what the control looks like now. */
  function state({ ref }) {
    const el = resolve(ref);
    return after(el, { ref, name: labelText(el) });
  }

  function read({ maxChars = 20000 } = {}) {
    const text = (document.body?.innerText ?? "").replace(/\n{3,}/g, "\n\n").trim();
    return { url: location.href, title: document.title, text: text.slice(0, maxChars), truncated: text.length > maxChars ? text.length : undefined };
  }

  // Every command first notes the page's password fields, so a field shown as text later is still known.
  const noting = (command) => (args) => { noteSecrets(); return command(args); };
  return { snapshot: noting(snapshot), act: noting(act), state: noting(state), read: noting(read) };
})();
globalThis.__mwWeb = __mwWeb;
