import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

// The Browser's address bar logic is a plain script the Experiment loads into its scope.
const source = await readFile(new URL("../thunderbird-addon/experiments/workspace/address.js", import.meta.url), "utf8");
const scope = vm.createContext({});
vm.runInContext(source, scope);
const parse = (text) => JSON.parse(JSON.stringify(scope.parseAddress(text)));

test("a host or full URL is an address", () => {
  assert.deepEqual(parse("elster.de"), { url: "https://elster.de" });
  assert.deepEqual(parse("www.elster.de/eportal/start"), { url: "https://www.elster.de/eportal/start" });
  assert.deepEqual(parse("https://example.org/a b"), { url: "https://example.org/a b" });
  assert.deepEqual(parse("about:blank"), { url: "about:blank" });
  assert.deepEqual(parse("münchen.de"), { url: "https://münchen.de" });
  assert.deepEqual(parse("192.168.1.1:8080/x"), { url: "https://192.168.1.1:8080/x" });
});

test("local servers load over http", () => {
  assert.deepEqual(parse("localhost:3000"), { url: "http://localhost:3000" });
  assert.deepEqual(parse("127.0.0.1:47810/v1"), { url: "http://127.0.0.1:47810/v1" });
});

test("words, single words and a leading ? are searched for", () => {
  assert.deepEqual(parse("Ansässigkeitsbescheinigung beantragen"), { search: "Ansässigkeitsbescheinigung beantragen" });
  assert.deepEqual(parse("elster"), { search: "elster" });
  assert.deepEqual(parse("? elster.de"), { search: "elster.de" });
  assert.deepEqual(parse("file.txt is"), { search: "file.txt is" });
  assert.equal(scope.parseAddress("   "), null);
});
