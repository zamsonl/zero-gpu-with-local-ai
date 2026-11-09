import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { ServerLogFeed, createStartupLog } from "../public/js/server-log-feed.js";

// Exercise the real client and view with controlled transport/timing. Log text is intentionally
// hostile HTML in one case: the display must keep it as text rather than create markup.
class Element {
  constructor(tag) {
    this.tagName = tag; this.children = []; this.attributes = {}; this.dataset = {};
    this.scrollHeight = 300; this.scrollTop = 260; this.clientHeight = 100;
  }
  set textContent(value) { this.value = String(value); this.children = []; }
  get textContent() { return (this.value || "") + this.children.map(child => typeof child === "string" ? child : child.textContent).join(""); }
  set innerHTML(_) { throw new Error("Untrusted log content must not become HTML"); }
  append(...children) { this.children.push(...children); }
  setAttribute(name, value) { this.attributes[name] = value; }
  addEventListener() {}
  querySelector(selector) {
    for (const child of this.children) {
      if (typeof child === "string") continue;
      if (selector.startsWith(".") ? child.className?.split(" ").includes(selector.slice(1)) : child.tagName === selector) return child;
      const nested = child.querySelector(selector); if (nested) return nested;
    }
    return null;
  }
}

const original = { fetch: globalThis.fetch, document: globalThis.document, localStorage: globalThis.localStorage, setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout };
let clock, timers, serial, calls, reply, feeds;
const flush = () => new Promise(resolve => setImmediate(resolve));
const result = (log = "runtime ready", extra = {}) => ({ host: "kaggle", source: "reported", started_at: new Date().toISOString(), updated_at: new Date().toISOString(), log, ...extra });
const response = value => new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
async function advance(ms) {
  const end = clock + ms;
  for (;;) {
    const due = [...timers].filter(([, timer]) => timer.at <= end).sort((a,b) => a[1].at - b[1].at)[0];
    if (!due) break;
    clock = due[1].at; timers.delete(due[0]); due[1].fn(); await flush();
  }
  clock = end; await flush();
}
function feed(host, callback = () => {}) { const instance = new ServerLogFeed(host, callback); feeds.push(instance); return instance; }

beforeEach(() => {
  clock = 0; timers = new Map(); serial = 0; calls = []; feeds = [];
  const document = new EventTarget(); document.visibilityState = "visible"; document.createElement = tag => new Element(tag);
  globalThis.document = document; globalThis.localStorage = { getItem: () => null };
  globalThis.setTimeout = (fn, ms) => { const id = ++serial; timers.set(id, { fn, at: clock + ms }); return id; };
  globalThis.clearTimeout = id => timers.delete(id);
  reply = async () => response(result());
  globalThis.fetch = async (url, options) => { calls.push({ url, options }); return reply(url, options); };
});
afterEach(() => {
  for (const instance of feeds) instance.stop();
  Object.assign(globalThis, original);
});

test("requests the selected host, bypasses cache, and polls again after five seconds", async () => {
  const updates = []; const instance = feed("colab", value => updates.push(value));
  await instance.start();
  assert.equal(calls[0].url, "/v1/server/log?host=colab");
  assert.equal(calls[0].options.cache, "no-store");
  assert(calls[0].options.signal instanceof AbortSignal);
  await advance(4999); assert.equal(calls.length, 1);
  await advance(1); assert.equal(calls.length, 2); assert.equal(updates.length, 2);
});

test("transient failures retain the last log and retry rather than ending the feed", async () => {
  const updates = []; const instance = feed("kaggle", value => updates.push(value));
  await instance.start();
  reply = async () => { throw new Error("temporary disconnect"); };
  await advance(5000);
  assert.equal(updates.at(-1).result.log, "runtime ready"); assert(updates.at(-1).error);
  reply = async () => response(result("model loaded"));
  await advance(5000);
  assert.equal(updates.at(-1).result.log, "model loaded"); assert.equal(updates.at(-1).error, null);
});

test("hidden tabs pause requests and resume when visible", async () => {
  const instance = feed("colab"); await instance.start();
  document.visibilityState = "hidden"; document.dispatchEvent(new Event("visibilitychange"));
  await advance(20000); assert.equal(calls.length, 1);
  document.visibilityState = "visible"; document.dispatchEvent(new Event("visibilitychange"));
  await flush(); assert.equal(calls.length, 2);
});

test("a stopped host cannot publish a late response over the next host's log", async () => {
  const pending = deferred(); const updates = [];
  reply = () => pending.promise;
  const previous = feed("kaggle", value => updates.push(["kaggle", value]));
  const starting = previous.start(); previous.stop();
  assert.equal(calls[0].options.signal.aborted, true);
  reply = async () => response(result("Colab ready", { host: "colab" }));
  await feed("colab", value => updates.push(["colab", value])).start();
  pending.resolve(response(result("old Kaggle session"))); await starting;
  assert.deepEqual(updates.map(([host]) => host), ["colab"]);
  assert.equal(updates[0][1].result.log, "Colab ready");
});

test("stopping cancels polling even after a request rejects", async () => {
  const pending = deferred(); const updates = [];
  reply = () => pending.promise;
  const instance = feed("colab", value => updates.push(value)); const starting = instance.start();
  instance.stop(); pending.reject(new Error("aborted")); await starting; await advance(30000);
  assert.equal(updates.length, 0); assert.equal(calls.length, 1); assert.equal(timers.size, 0);
});

test("inline log shows the newest eight lines as literal text and respects scroll position", async () => {
  const malicious = '<img src=x onerror="throw Error(1)">';
  reply = async () => response(result(Array.from({length: 11}, (_,i) => `line ${i}`).concat(malicious).join("\n")));
  const panel = createStartupLog("kaggle"); feeds.push(panel); await flush();
  const body = panel.element.querySelector("pre");
  assert.equal(body.textContent.split("\n").length, 8);
  assert(body.textContent.startsWith("line 4\n")); assert(body.textContent.endsWith(malicious));
  assert.equal(body.children.length, 0); assert.equal(body.scrollTop, 300);
  body.scrollTop = 0; body.scrollHeight = 500;
  reply = async () => response(result("a newer update")); await advance(5000);
  assert.equal(body.textContent, "a newer update"); assert.equal(body.scrollTop, 0);
});

test("a new Colab wait suppresses the previous session's saved log", async () => {
  const now = Date.now();
  reply = async () => response(result("old private operational state", { started_at: new Date(now - 60000).toISOString() }));
  const panel = createStartupLog("colab", { notBefore: now }); feeds.push(panel); await flush();
  const body = panel.element.querySelector("pre");
  assert.match(body.textContent, /Waiting for the new notebook session/); assert(!body.textContent.includes("old private"));
  reply = async () => response(result("new session started", { started_at: new Date(now).toISOString() }));
  await advance(5000); assert.equal(body.textContent, "new session started");
});
