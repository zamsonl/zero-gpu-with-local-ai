import assert from "node:assert/strict";
import { test } from "node:test";
import { LONG_INPUT_MAX_CHARS, longInputPlan, longInputWarning, runLongInputSteps, sourceProgress, confirmLongInput, longInputSourceTarget, decorateLongInputSources, isLongInputPreview, LONG_INPUT_REVISE_HINT } from "../public/js/long-input-ui.js";

test("offers section reading for oversized drafts or an inherently oversized request, not history omission", () => {
  assert.equal(longInputPlan({ draft: "x".repeat(100001) }).needed, true);
  assert.equal(longInputPlan({ attachments: [{ text: "x".repeat(120001) }] }).needed, true);
  assert.equal(longInputPlan({ draft: "small", context: { over_budget: true } }).needed, true);
  assert.equal(longInputPlan({ draft: "small", context: { would_omit_history: true, omitted_message_count: 100 } }).needed, false);
  assert.equal(longInputPlan({ draft: "x".repeat(100000) }).needed, false);
});

test("preserves a large draft for the choice while rejecting unsupported pictures and the upload ceiling", () => {
  const text = "😀 exact code AB_7\n".repeat(12000);
  const plan = longInputPlan({ draft: text });
  assert(plan.allowed && plan.needed);
  assert.equal(plan.totalChars, text.length);
  assert.equal(text.endsWith("AB_7\n"), true);
  assert.match(longInputPlan({ draft: "x".repeat(LONG_INPUT_MAX_CHARS + 1) }).reason, /upload allowance/);
  assert.match(longInputPlan({ draft: "a", attachments: [{ data: "image" }] }).reason, /Remove pictures/);
  assert.match(longInputPlan({ draft: "a", attachments: [{ reading: true }] }).reason, /finish reading/);
});

test("warning names the active GPU provider, substantial allowance use, hosted Qwen and estimated work", () => {
  const kaggle = longInputWarning({ totalChars: 120001 });
  assert.match(kaggle, /substantial amount of your Kaggle GPU allowance/);
  assert.match(kaggle, /same hosted Qwen/);
  assert.match(kaggle, /About 6 reading sections, then one answer/);
  assert.match(kaggle, /count is an estimate/);
  const colab = longInputWarning({ host: "colab", totalChunks: 8, processedChunks: 3 });
  assert.match(colab, /Colab GPU allowance/);
  assert.match(colab, /5 reading sections, then one answer/);
  assert(!colab.includes("Kaggle"));
  assert.match(longInputWarning({ totalChunks: 8, processedChunks: 8 }), /0 reading sections, then one answer/);
});

test("each confirmed reading checkpoint advances once, then the final answer ends the loop", async () => {
  const calls = [], events = [], steps = [];
  const source = { id: "owned", processed_chunks: 0, total_chunks: 2 };
  const result = await runLongInputSteps({ source, signal: new AbortController().signal,
    run: async function* (id) {
      calls.push(id);
      yield { event: "start", source: { ...source, processed_chunks: calls.length - 1 } };
      if (calls.length < 3) yield { event: "checkpoint", source: { ...source, processed_chunks: calls.length } };
      else { yield { event: "content", text: "verified answer" }; yield { event: "done", source: { ...source, processed_chunks: 2, status: "complete" }, message: { content: "verified answer" } }; }
    }, onEvent: event => events.push(event.event), onStep: active => steps.push(active) });
  assert.equal(result.complete, true);
  assert.deepEqual(calls, ["owned", "owned", "owned"]);
  assert.deepEqual(steps, [true, false, true, false, true, false]);
  assert.equal(events.filter(event => event === "content").length, 1);
});

test("Stop in the gap between sections never starts another model request", async () => {
  let stopped = false, calls = 0;
  const result = await runLongInputSteps({ source: { id: "owned", processed_chunks: 0 },
    run: async function* () { calls++; yield { event: "checkpoint", source: { id: "owned", processed_chunks: 1 } }; },
    onEvent: () => { stopped = true; }, shouldStop: () => stopped });
  assert.equal(calls, 1);
  assert.equal(result.stopped, true);
});

test("abort, dropped completion, repeated progress and model errors never silently retry", async () => {
  const abort = new AbortController(); abort.abort();
  let calls = 0;
  await assert.rejects(runLongInputSteps({ source: { id: "owned" }, signal: abort.signal, run: async function* () { calls++; } }));
  assert.equal(calls, 0);
  await assert.rejects(runLongInputSteps({ source: { id: "owned", processed_chunks: 1 }, run: async function* () { calls++; yield { event: "checkpoint", source: { id: "owned", processed_chunks: 1 } }; } }), /did not advance/);
  assert.equal(calls, 1);
  await assert.rejects(runLongInputSteps({ source: { id: "owned" }, run: async function* () { calls++; yield { event: "status", detail: "reading" }; } }), /before the reading section was confirmed/);
  assert.equal(calls, 2);
  const result = await runLongInputSteps({ source: { id: "owned" }, run: async function* () { calls++; yield { event: "error", code: "busy", message: "Another device" }; } });
  assert.equal(calls, 3); assert.equal(result.error.code, "busy"); assert.equal(result.complete, false);
  assert.equal(sourceProgress({ processed_chunks: 3, total_chunks: 3 }), "Reading complete · answer pending");
});

test("usage dialog requires an explicit confirmation; Cancel keeps processing unapproved", async () => {
  class Element extends EventTarget {
    children = []; attributes = {}; classList = { contains: () => false, add() {}, remove() {} };
    constructor(tag) { super(); this.tagName = tag; }
    append(...nodes) { this.children.push(...nodes); }
    setAttribute(name, value) { this.attributes[name] = value; }
    focus() {}
    showModal() { this.open = true; }
    close() { this.open = false; this.dispatchEvent(new Event("close")); }
    remove() {}
  }
  const original = { document: globalThis.document, window: globalThis.window };
  const body = new Element("body");
  globalThis.document = { body, createElement: tag => new Element(tag) };
  globalThis.window = { matchMedia: () => ({ matches: true }) };
  try {
    const cancelled = confirmLongInput({ totalChars: 130000 });
    const dialog = body.children.at(-1), form = dialog.children[0];
    const actions = form.children.at(-1), cancel = actions.children[0];
    cancel.dispatchEvent(new Event("click"));
    assert.equal(await cancelled, false);
    const accepted = confirmLongInput({ host: "colab", totalChunks: 4 });
    body.children.at(-1).children[0].dispatchEvent(new Event("submit", { cancelable: true }));
    assert.equal(await accepted, true);
  } finally { Object.assign(globalThis, original); }
});

test("source downloads send the configured key only in headers and accept only the exact same-origin route", async () => {
  const origin = "https://owned.example";
  const path = "/v1/chats/chat_7/long-inputs/source_9/source";
  assert.deepEqual(longInputSourceTarget(path, origin), { chatId: "chat_7", sourceId: "source_9" });
  for (const bad of ["https://other.example" + path, path + "?key=secret", path + "#x", path + "/more", "/v1/chats/chat_7/export", "javascript:alert(1)"])
    assert.equal(longInputSourceTarget(bad, origin), null, bad);
  const { api } = await import("../public/js/api.js");
  const original = { fetch: globalThis.fetch, localStorage: globalThis.localStorage };
  let observed;
  globalThis.localStorage = { getItem: () => "owned-test-key" };
  globalThis.fetch = async (url, options) => {
    observed = { url, options };
    return new Response("exact original source Ω", { headers: { "content-type": "text/plain; charset=utf-8", "content-disposition": 'attachment; filename="owned-source.txt"' } });
  };
  try {
    const result = await api.longInputSource("chat_7", "source_9");
    assert.equal(observed.url, path);
    assert.equal(observed.options.headers["x-relay-key"], "owned-test-key");
    assert(!observed.url.includes("owned-test-key"));
    assert.equal(await result.blob.text(), "exact original source Ω");
    assert.equal(result.filename, "owned-source.txt");
  } finally { Object.assign(globalThis, original); }
});

test("plain-text user messages gain real original-download anchors for complete and pending inputs", () => {
  const original = globalThis.document;
  class Element {
    children = []; attributes = {};
    constructor(tag) { this.tagName = tag; }
    setAttribute(name, value) { this.attributes[name] = value; }
    append(...nodes) { this.children.push(...nodes); }
    insertBefore(node) { this.children.push(node); }
    querySelector() { return null; }
  }
  globalThis.document = { createElement: tag => new Element(tag) };
  try {
    const first = new Element("div"), second = new Element("div");
    const edit = {}, regenerate = {};
    first.querySelector = selector => selector.includes("Edit and resend") ? edit : null;
    const root = { querySelectorAll: () => [], querySelector: selector => selector.includes(".msg-assistant") ? regenerate : selector.includes('"7"') ? first : selector.includes('"8"') ? second : null };
    const sources = [
      { id: "source_a", chat_id: "chat_1", user_message_id: 7, status: "complete", answer_message_id: 99 },
      { id: "source_b", chat_id: "chat_1", user_message_id: 8, status: "paused" },
      { id: "foreign", chat_id: "other", user_message_id: 7, status: "complete" },
    ];
    decorateLongInputSources(root, sources, "chat_1", "https://owned.example");
    assert.equal(first.children.length, 1); assert.equal(second.children.length, 1);
    const firstLink = first.children[0].children[0], secondLink = second.children[0].children[0];
    assert.equal(firstLink.tagName, "a");
    assert.equal(firstLink.textContent, "Download original");
    assert.equal(firstLink.attributes.href, "/v1/chats/chat_1/long-inputs/source_a/source");
    assert.equal(secondLink.attributes.href, "/v1/chats/chat_1/long-inputs/source_b/source");
    assert.equal(first.children[0].children[1].textContent, LONG_INPUT_REVISE_HINT);
    assert.equal(edit.hidden, true); assert.equal(edit.disabled, true);
    assert.equal(regenerate.hidden, true); assert.equal(regenerate.disabled, true);
  } finally { globalThis.document = original; }
});

test("edit/resend guard protects stored previews by message identity and before metadata is loaded", () => {
  const origin = "https://owned.example", chatId = "chat_1";
  const ordinary = { id: 7, role: "user", content: "An ordinary question" };
  assert(isLongInputPreview(ordinary, [{ chat_id: chatId, user_message_id: 7, status: "complete" }], chatId, origin));
  assert(!isLongInputPreview(ordinary, [{ chat_id: "other", user_message_id: 7 }], chatId, origin));
  const preview = { id: 8, role: "user", content: "Preview only…\n\n[Full input (105,000 characters)](/v1/chats/chat_1/long-inputs/source_7/source)\n\nQwen will read this input in 5 sections before answering." };
  const original = preview.content;
  assert(isLongInputPreview(preview, [], chatId, origin), "The metadata-loading gap must not permit replacing a full source with its preview");
  assert(!isLongInputPreview(preview, [], "other", origin));
  assert(!isLongInputPreview({ ...preview, role: "assistant" }, [], chatId, origin));
  assert(!isLongInputPreview({ ...preview, content: "A normal link: /v1/chats/chat_1/long-inputs/source_7/source" }, [], chatId, origin));
  assert.equal(preview.content, original);
});
