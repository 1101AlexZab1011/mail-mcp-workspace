/* Mail, redesigned in the workspace style (with theme/panes.css): above the message list, a search
   field (Ctrl+K) and filter chips (All, Unread, Starred, Attachments) that are always there; the
   message header as a card with the sender's initials and Reply / Reply all / Forward / Archive /
   Delete with their labels. Thunderbird's own quick filter and header do the work.
   Called for each about:3pane and about:message document as it loads (themeDocument). */
/* global Services, ChromeUtils, fit, ctxNotify */

const MAIL_HEADER_DONE = "extensions.mailworkspace.mail.header-layout";

function mailPaneBehaviour(doc) {
  const win = doc.defaultView;
  if (!win || doc.mwMail) return;
  doc.mwMail = true;
  const ready = (fn) => (doc.readyState === "complete" ? fn() : win.addEventListener("load", fn, { once: true }));
  if (/^about:3pane/.test(doc.documentURI)) ready(() => { try { mailListBar(doc); } catch (error) { console.error("Thoth: mail list", error); } });
  if (/^about:3pane/.test(doc.documentURI)) ready(() => { try { mailConnectHome(doc); } catch (error) { console.error("Thoth: mail home", error); } });
  if (/^about:3pane/.test(doc.documentURI)) mailPaneState(win);
  if (/^about:message/.test(doc.documentURI)) ready(() => { try { mailHeaderLayout(doc); } catch (error) { console.error("Thoth: message header", error); } });
  if (/multimessageview\.xhtml/.test(doc.documentURI)) ready(() => { try { mailSummary(doc); } catch (error) { console.error("Thoth: summary", error); } });
}

/**
 * Which mail panes show is the space manager's call (shell.js, fit), not the saved session's: the
 * session keeps whatever the manager last hid for a narrower window, and Thunderbird applies it on
 * start (for the first tab even after the view has loaded), so the folder list stayed hidden for good,
 * with Thoth showing no View menu to bring it back. Each restore now shows the folder and message
 * panes, and the manager then hides what does not fit, to give it back when there is room.
 */
function mailPaneState(win) {
  const original = win.restoreState;
  if (original?.mwThoth) return;
  if (typeof original !== "function") {
    // Called as the document starts, before about3Pane.js has run. Its start-up is a DOMContentLoaded
    // listener added by that script, so this one, added first, runs before it calls restoreState.
    if (win.document.readyState === "loading") win.addEventListener("DOMContentLoaded", () => mailPaneState(win), { once: true });
    return;
  }
  const restore = function (state = {}) {
    // A search result (synthetic view) has no folder list: keep Thunderbird's choice there.
    const shown = state?.syntheticView ? {} : { folderPaneVisible: true, messagePaneVisible: true };
    const result = original.call(this, { ...state, ...shown });
    const top = win.browsingContext?.topChromeWindow;
    if (top?.mwCtx) win.setTimeout(() => { try { fit(top, null, ctxNotify(top)); } catch (error) { console.error("Thoth: mail fit", error); } }, 0);
    return result;
  };
  restore.mwThoth = true;
  // about3Pane.js is a classic script: its init calls the global restoreState, which this replaces.
  win.restoreState = restore;
}

/** The conversation summary: senders by name (the address on hover), as in the list. */
function mailSummary(doc) {
  const win = doc.defaultView;
  const list = doc.getElementById("messageList");
  if (!list) return;
  const names = () => {
    for (const node of list.querySelectorAll(".author")) {
      const text = node.textContent.trim();
      const match = /^"?(.+?)"?\s*<([^>]+)>$/.exec(text);
      if (!match) continue;
      node.textContent = match[1];
      if (node.getAttribute("title") !== match[2]) node.setAttribute("title", match[2]);
    }
  };
  names();
  // Rewriting a name is itself a change to the list; the regex no longer matches it, so this settles.
  new win.MutationObserver(names).observe(list, { childList: true, subtree: true, characterData: true });
}

/** The quick filter bar, always shown, as a search field and chips; "All" clears the filters. */
function mailListBar(doc) {
  const win = doc.defaultView;
  const bar = doc.getElementById("quick-filter-bar");
  const qfb = win.quickFilterBar;
  if (!bar || !qfb) return;
  doc.documentElement.setAttribute("mw-mail", "true");
  const show = () => { if (bar.hidden) { try { qfb._showFilterBar(true); } catch { bar.hidden = false; } } };
  show();
  // Thunderbird hides the bar again when its button is toggled or Escape clears it; keep it.
  new win.MutationObserver(show).observe(bar, { attributes: true, attributeFilter: ["hidden"] });
  const buttons = bar.querySelector(".quickFilterButtons");
  if (buttons && !doc.getElementById("mw-qfb-all")) {
    const all = doc.createElement("button");
    all.id = "mw-qfb-all";
    all.className = "button check-button";
    all.type = "button";
    all.textContent = "All";
    all.addEventListener("click", () => {
      for (const id of ["qfb-unread", "qfb-starred", "qfb-attachment", "qfb-inaddrbook", "qfb-tags"]) {
        const button = doc.getElementById(id);
        if (button?.getAttribute("aria-pressed") === "true") button.click();
      }
      syncAll();
    });
    buttons.prepend(all);
    const syncAll = () => {
      const any = ["qfb-unread", "qfb-starred", "qfb-attachment", "qfb-inaddrbook", "qfb-tags"].some((id) => doc.getElementById(id)?.getAttribute("aria-pressed") === "true");
      // Only on a change: setting the attribute is itself a mutation this observer sees.
      if (all.getAttribute("aria-pressed") !== String(!any)) all.setAttribute("aria-pressed", String(!any));
    };
    for (const id of ["qfb-unread", "qfb-starred", "qfb-attachment", "qfb-inaddrbook", "qfb-tags"]) {
      const button = doc.getElementById(id);
      if (button) new win.MutationObserver(syncAll).observe(button, { attributes: true, attributeFilter: ["aria-pressed"] });
    }
    syncAll();
  }
  // "Search in <folder>…" with Ctrl+K, as the other spaces search.
  const search = doc.getElementById("qfb-qs-textbox");
  const folderName = () => doc.getElementById("threadPaneFolderName")?.textContent?.trim();
  const placeholder = () => { const name = folderName(); const text = `Search in ${name}…`; if (search && name && search.getAttribute("placeholder") !== text) search.setAttribute("placeholder", text); };
  placeholder();
  const title = doc.getElementById("threadPaneFolderName");
  if (title) new win.MutationObserver(placeholder).observe(title, { childList: true, characterData: true, subtree: true });
  doc.addEventListener("keydown", (event) => {
    if ((event.ctrlKey || event.metaKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === "k") {
      event.preventDefault();
      search?.focus?.();
    }
  }, true);
}

/** Whether a mail account is set up (Local Folders alone is not one). */
function hasMailAccount(MailServices) {
  return MailServices.accounts.accounts.some((account) => account.incomingServer && account.incomingServer.type !== "none");
}

/**
 * Mail with no account: instead of Thunderbird's empty folder pane, list and reader, Mail's home in
 * the layout of the Writer, Slides and Draw homes (shared/home.js; styled in theme/panes.css):
 * "Mail" over a menu on the left, and on the right what to do first. It goes as soon as an account
 * is added, and comes back if the last one is removed.
 */
function mailConnectHome(doc) {
  const win = doc.defaultView;
  const { MailServices } = ChromeUtils.importESModule("resource:///modules/MailServices.sys.mjs");
  const top = win.browsingContext?.topChromeWindow ?? win.top;
  const addAccount = () => top.openAccountSetup?.();
  const importMail = () => top.toImport?.();
  const icon = (name) => { const img = doc.createElement("img"); img.src = `resource://mailworkspace/icons/${name}.svg`; img.alt = ""; return img; };
  const el = (tag, className, ...children) => { const node = doc.createElement(tag); if (className) node.className = className; node.append(...children); return node; };
  const button = (className, iconName, label, run) => { const b = el("button", className, icon(iconName), label); b.type = "button"; b.addEventListener("click", run); return b; };
  const card = (iconName, title, text, run) => {
    const b = el("button", "mw-mh-card", el("span", "mw-mh-card-icon", icon(iconName)), el("span", "mw-mh-card-text", el("strong", "", title), el("span", "", text)));
    b.type = "button";
    b.addEventListener("click", run);
    return b;
  };

  const home = el("div", "mw-mail-home",
    el("nav", "mw-mh-menu",
      el("div", "mw-mh-brand", icon("mail"), "Mail"),
      button("active", "person_add", "Add mail account", addAccount),
      button("", "download", "Import…", importMail)),
    el("main", "mw-mh-body",
      el("h2", "", "Connect your mail"),
      el("p", "", "Add your email account to read, write and file mail here, with the agent beside you. Your password stays on this computer."),
      el("div", "mw-mh-cards",
        card("person_add", "Add mail account", "Sign in with your address and password. Gmail, Outlook, iCloud and most providers are set up for you.", addAccount),
        card("download", "Import from another app", "Bring accounts, mail, contacts and calendars from Thunderbird, Outlook, Apple Mail or SeaMonkey.", importMail))));
  home.hidden = true;
  doc.body.append(home);

  const sync = () => { home.hidden = hasMailAccount(MailServices); };
  sync();
  const listener = { onServerLoaded: sync, onServerUnloaded: () => win.setTimeout(sync, 0), onServerChanged: sync };
  MailServices.accounts.addIncomingServerListener(listener);
  win.addEventListener("unload", () => MailServices.accounts.removeIncomingServerListener(listener), { once: true });
}

/** The header as a card: initials, big subject, labelled buttons. Set once; the user may change it after. */
function mailHeaderLayout(doc) {
  const win = doc.defaultView;
  doc.documentElement.setAttribute("mw-mail", "true");
  if (Services.prefs.getIntPref(MAIL_HEADER_DONE, 0) >= 1) return;
  const customize = win.gHeaderCustomize;
  if (!customize?.customizeData) return;
  Object.assign(customize.customizeData, { showAvatar: true, showBigAvatar: false, subjectLarge: true, hideLabels: true, buttonStyle: "default" });
  try { customize.onPanelHidden?.(); } catch { /* older layout API */ }
  try { customize.updateLayout?.(); } catch { /* applied on the next message */ }
  Services.prefs.setIntPref(MAIL_HEADER_DONE, 1);
}
