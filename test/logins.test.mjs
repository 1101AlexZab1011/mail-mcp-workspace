import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

// about:logins' list logic is a plain script the page loads.
const source = await readFile(new URL("../thunderbird-addon/logins/list.js", import.meta.url), "utf8");
const scope = vm.createContext({ URL });
vm.runInContext(source, scope);
const plain = (value) => JSON.parse(JSON.stringify(value));
const login = (origin, username = "", times = {}) => ({ origin, username, ...times });

test("only web logins are listed: mail accounts stay in Settings", () => {
  assert.equal(scope.isWebLogin(login("https://accounts.google.com")), true);
  assert.equal(scope.isWebLogin(login("http://192.168.0.1")), true);
  assert.equal(scope.isWebLogin(login("imap://mail.cbs.mpg.de")), false);
  assert.equal(scope.isWebLogin(login("oauth://accounts.google.com")), false);
  assert.equal(scope.isWebLogin(login("smtp://smtp.gmail.com")), false);
});

test("a login is listed under its host, without www.", () => {
  assert.equal(scope.loginTitle(login("https://www.paypal.com")), "paypal.com");
  assert.equal(scope.loginTitle(login("https://accounts.google.com")), "accounts.google.com");
  assert.equal(scope.loginTitle(login("http://localhost:8080")), "localhost:8080");
});

test("search matches every word in the name, address or username", () => {
  const list = [login("https://www.paypal.com", "wzhik99@gmail.com"), login("https://coursera.org", "alexey"), login("https://elster.de", "")];
  assert.deepEqual(plain(scope.filterLogins(list, "wzhik")).map((l) => l.origin), ["https://www.paypal.com"]);
  assert.deepEqual(plain(scope.filterLogins(list, "COURSERA alex")).map((l) => l.origin), ["https://coursera.org"]);
  assert.deepEqual(plain(scope.filterLogins(list, "coursera wzhik")), []);
  assert.equal(scope.filterLogins(list, "  ").length, 3);
});

test("sorting by name, reversed, last used and last changed", () => {
  const list = [
    login("https://www.zoom.us", "b", { timeLastUsed: 10, timePasswordChanged: 300 }),
    login("https://amazon.de", "z", { timeLastUsed: 30, timePasswordChanged: 100 }),
    login("https://amazon.de", "a", { timeLastUsed: 20, timePasswordChanged: 200 }),
  ];
  const order = (by) => plain(scope.sortLogins(list, by)).map((l) => `${scope.loginTitle(l)}/${l.username}`);
  assert.deepEqual(order("name"), ["amazon.de/a", "amazon.de/z", "zoom.us/b"]);
  assert.deepEqual(order("name-reverse"), ["zoom.us/b", "amazon.de/z", "amazon.de/a"]);
  assert.deepEqual(order("last-used"), ["amazon.de/z", "amazon.de/a", "zoom.us/b"]);
  assert.deepEqual(order("last-changed"), ["zoom.us/b", "amazon.de/a", "amazon.de/z"]);
  assert.deepEqual(order("unknown"), order("name"));
});

test("a typed website becomes the origin a login is saved for", () => {
  assert.equal(scope.loginOrigin("example.org"), "https://example.org");
  assert.equal(scope.loginOrigin("https://www.elster.de/eportal/start"), "https://www.elster.de");
  assert.equal(scope.loginOrigin("http://localhost:3000/x"), "http://localhost:3000");
  assert.equal(scope.loginOrigin("ftp://example.org"), null);
  assert.equal(scope.loginOrigin(""), null);
  assert.equal(scope.loginOrigin("not a site"), null);
});

test("a login's icon is its host's, its www twin's or a parent domain's", () => {
  const icons = { "www.paypal.com": "pp", "google.com": "g", "elster.de": "e" };
  assert.equal(scope.siteIconFor(icons, "https://paypal.com"), "pp");
  assert.equal(scope.siteIconFor(icons, "https://accounts.google.com"), "g");
  assert.equal(scope.siteIconFor(icons, "https://www.elster.de"), "e");
  assert.equal(scope.siteIconFor(icons, "https://example.org"), null);
  assert.equal(scope.siteIconFor(icons, "not a url"), null);
});
