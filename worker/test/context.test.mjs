import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { planContext, compactablePrefix, summaryMessage } from "../src/context.js";
import { compactChunks } from "../src/compact.js";
import { readCompactChunk } from "../src/compaction-source.js";
import { rawBatchDefault } from "../src/raw-options.js";
import { startStack, WORKER_DIR } from "./dev-stack.mjs";

test("planner charges system, reply, images and continuation; oversized latest input is explicit", () => {
  const regular = planContext({ transcript: [{ role: "user", content: "hello" }], numCtx: 24576 });
  assert.equal(regular.context.reserved_reply_tokens, 10240);
  assert.equal(regular.context.input_budget_tokens, 13312);
  assert(regular.context.estimated_input_tokens > 1);
  const huge = planContext({ transcript: [{ role: "user", content: "x".repeat(39000), images: ["image"] }], numCtx: 24576, preferences: { system_prompt: "s".repeat(8000) } });
  assert.equal(huge.context.over_budget, true);
  const continued = planContext({ transcript: [{ role: "user", content: "question" }], numCtx: 24576, partial: { thinking: "x".repeat(40000) } });
  assert.equal(continued.context.over_budget, true);
  const existing = [{ id: 1, role: "user", content: "one" }, { id: 2, role: "assistant", content: "a" }, { id: 3, role: "user", content: "two" }, { id: 4, role: "assistant", content: "b" }];
  const draft = planContext({ transcript: [...existing, { role: "user", content: "unsent" }], numCtx: 24576 });
  assert.equal(draft.context.can_compact, false, "unsent draft cannot make older saved turns eligible");
  const pictures = planContext({ transcript: [{ role: "user", content: "", pictures_count: 4 }], numCtx: 24576, think: false });
  assert(pictures.context.estimated_input_tokens >= 4000);
});

test("checkpoint retains memory, covers exact prefix, and reports omitted history", () => {
  const transcript = Array.from({ length: 12 }, (_, i) => ({ id: i + 1, role: i % 2 ? "assistant" : "user", content: "content".repeat(300) }));
  const checkpoint = { through_id: 4, covered_count: 4, summary: "The original goal is A." };
  const plan = planContext({ transcript, numCtx: 24576, checkpoint, preferences: { history_chars: 4000 } });
  assert.deepEqual(plan.messages[0], summaryMessage(checkpoint.summary));
  assert.equal(plan.context.summarized_message_count, 4);
  assert.equal(plan.context.would_omit_history, true);
  assert.equal(plan.context.can_compact, true);
  assert.deepEqual(compactablePrefix(transcript, checkpoint).map((m) => m.id), [5, 6, 7, 8]);
  const edited = planContext({ transcript: transcript.slice(0, 2), numCtx: 24576, checkpoint });
  assert.equal(edited.context.summarized_message_count, 0);
});

test("bounded compaction slices every source character including oversized messages", () => {
  const source = [{ id: 1, role: "user", content: "A".repeat(9000) }, { id: 2, role: "assistant", content: "last detail B" }];
  const parts = compactChunks(source, 2000);
  assert(parts.length > 4);
  assert(parts.every((part) => part.length <= 2000));
  const fragments = parts.flatMap(readCompactChunk);
  for (const message of source) {
    const owned = fragments.filter(fragment => fragment.message_id === message.id);
    assert(owned.every(fragment => fragment.role === message.role));
    assert.equal(owned.map(fragment => fragment.text).join(""), message.content);
  }
});

let stack, jobsProxy;
const state = ".test-state/context";
before(async () => {
  stack = await startStack({ port: 8812, mockPort: 11512, state, vars: { TIMING_SCALE: "0.05", KAGGLE_CACHE_DATASET: "", KAGGLE_CACHE_ID: "" } });
});
after(async () => { await jobsProxy?.close(); await stack?.stop(); });

async function startJobsProxy() {
  const child = spawn("python", ["test/jobs-proxy-fixture.py", stack.mock.url], { cwd: WORKER_DIR, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  let output = "", errors = "";
  child.stderr.on("data", (chunk) => { errors = (errors + chunk).slice(-2000); });
  const url = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error("Python jobs fixture did not start: " + errors)); }, 15_000);
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("exit", (code) => { clearTimeout(timer); if (!output.includes("\n")) reject(new Error(`Python jobs fixture exited${code}: ${errors}`)); });
    child.stdout.on("data", (chunk) => {
      output += chunk;
      if (output.includes("\n")) { clearTimeout(timer); try { resolve(JSON.parse(output.split("\n")[0]).url); } catch (error) { reject(error); } }
    });
  });
  return { url, close: async () => {
    if (child.exitCode !== null) return;
    const exited = once(child, "exit"); child.stdin.end("\n");
    const timer = setTimeout(() => child.kill(), 5000);
    try { await exited; } finally { clearTimeout(timer); }
  } };
}

async function call(method, uri, body, headers = {}) {
  const response = await fetch(stack.url + uri, { method, headers: { "content-type": "application/json", ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  if (response.headers.get("content-type")?.includes("ndjson")) {
    const text = await response.text();
    return { status: response.status, events: text.trim().split("\n").filter((line) => line.trim()).map(JSON.parse) };
  }
  return { status: response.status, body: await response.json() };
}

let sequence = 0;
async function importedChat(turns = 6, length = 5000) {
  const id = `context-${Date.now()}-${sequence++}`;
  const messages = Array.from({ length: turns * 2 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: `original-${i} ` + "x".repeat(length), created_at: "2026-10-01T00:00:00Z" }));
  const imported = await call("POST", "/v1/import", { chats: [{ id, title: "Context test", created_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-01T00:00:00Z", messages }] });
  assert.equal(imported.status, 200);
  return id;
}
const preview = (id, body = {}) => call("POST", `/v1/chats/${id}/context`, body);
const compact = (id) => call("POST", `/v1/chats/${id}/compact`, {});

test("oversized message is rejected before persistence and preview uses the same estimate", async () => {
  const created = await call("POST", "/v1/chats", {});
  const id = created.body.chat.id;
  const body = { content: "z".repeat(100000), think: true };
  assert.equal((await preview(id, body)).body.context.over_budget, true);
  const sent = await call("POST", `/v1/chats/${id}/turn`, body);
  assert.equal(sent.status, 413);
  assert.equal(sent.body.error.code, "context_limit");
  assert.deepEqual((await call("GET", `/v1/chats/${id}`)).body.messages, []);
});

test("compaction preserves transcript/export/search and subsequent turns use memory plus suffix", async () => {
  const id = await importedChat();
  const original = (await call("GET", `/v1/chats/${id}`)).body.messages;
  const before = (await preview(id)).body.context;
  assert(before.would_omit_history && before.can_compact);
  const result = await compact(id);
  assert.equal(result.events.at(-1).event, "done", JSON.stringify(result.events));
  assert.equal(result.events.at(-1).context.summarized_message_count, 8);
  assert(result.events.at(-1).context.estimated_input_tokens < before.estimated_input_tokens);
  assert.deepEqual((await call("GET", `/v1/chats/${id}`)).body.messages, original);
  const exported = await fetch(`${stack.url}/v1/chats/${id}/export`).then((r) => r.text());
  assert(exported.includes("original-0"));
  const searched = await call("GET", "/v1/chats?q=original-0");
  assert(searched.body.chats.some((chat) => chat.id === id));
  const sent = await call("POST", `/v1/chats/${id}/turn`, { content: "Next request", think: false });
  assert.equal(sent.events.at(-1).event, "done");
  const request = stack.mock.lastChat();
  assert(request.messages[0].content.includes("<conversation_summary>"));
  assert(!request.messages.some((m) => m.content === original[0].content), "The original full message is replaced by its durable notes");
  assert(request.messages.some((m) => m.content.includes("original-8")));
  assert.equal(sent.events.at(-1).message.stats.num_ctx, 24576);
});

test("large compaction covers all older messages across bounded requests", async () => {
  const id = await importedChat(18, 10000);
  const result = await compact(id);
  const statuses = result.events.filter((event) => event.state === "compacting");
  assert(statuses.length > 1);
  assert.equal(result.events.at(-1).event, "done", JSON.stringify(result.events));
  assert.equal(result.events.at(-1).summarized_message_count, 32);
  assert.equal((await call("GET", `/v1/chats/${id}`)).body.messages.length, 36);
});

test("compaction forces answer mode independently of stored long reasoning and reply preferences", async () => {
  const id = await importedChat();
  const original = (await call("GET", `/v1/chats/${id}`)).body.messages;
  await stack.sql(`UPDATE messages SET thinking = replace(hex(zeroblob(20000)), '00', 'old-reasoning ') WHERE id = ${original[1].id}`);
  const result = await compact(id);
  assert.equal(result.events.at(-1).event, "done", JSON.stringify(result.events));
  const request = stack.mock.lastGenerate();
  assert.equal(request.raw, true);
  assert.equal(request.think, false);
  assert(request.prompt.endsWith("<|im_start|>assistant\n<think>\n\n</think>\n\n"));
  assert(!request.prompt.includes("old-reasoning"));
  assert(request.options.num_predict <= 4096);
  assert.equal(request.format.additionalProperties, false);
  assert.equal((await call("GET", `/v1/chats/${id}`)).body.messages[1].thinking.length, 280000);
});

test("truncated compaction retains prior memory; editing covered messages invalidates it", async () => {
  const id = await importedChat();
  assert.equal((await compact(id)).events.at(-1).event, "done");
  const previous = await stack.sql(`SELECT * FROM chat_context WHERE chat_id = '${id}'`);
  await call("POST", `/v1/chats/${id}/turn`, { content: "new turn", think: false });
  stack.mock.configure({ doneReason: "length" });
  const failed = await compact(id);
  stack.mock.configure({ doneReason: null });
  assert.equal(failed.events.at(-1).event, "error");
  assert.deepEqual(await stack.sql(`SELECT * FROM chat_context WHERE chat_id = '${id}'`), previous);
  const messages = (await call("GET", `/v1/chats/${id}`)).body.messages;
  const edited = await call("POST", `/v1/chats/${id}/turn`, { content: "correct original", replace_from: messages[0].id, think: false });
  assert.equal(edited.events.at(-1).event, "done");
  assert.deepEqual(await stack.sql(`SELECT * FROM chat_context WHERE chat_id = '${id}'`), []);
});

test("successive compactions preserve exact old memory and append later corrections", async () => {
  const id = await importedChat();
  const messages = (await call("GET", `/v1/chats/${id}`)).body.messages;
  await stack.sql(`UPDATE messages SET content='Project ORBIT_913 uses port 8123. ' || content WHERE id=${messages[0].id}`);
  assert.equal((await compact(id)).events.at(-1).event, "done");
  const first = (await stack.sql(`SELECT summary FROM chat_context WHERE chat_id='${id}'`))[0].summary;
  assert(first.includes("ORBIT_913"));
  await stack.sql(`UPDATE messages SET content='Correction: port 8247 replaces 8123. ' || content WHERE id=${messages[8].id}`);
  await call("POST", `/v1/chats/${id}/turn`, { content: "Keep working", think: false });
  await call("POST", `/v1/chats/${id}/turn`, { content: "Keep all constraints", think: false });
  stack.mock.configure({ memoryOutput: JSON.stringify({ goals: [], constraints: [], decisions: [], facts: [], artifacts: [], next_steps: [], corrections: [`[message ${messages[8].id}] Port 8247 replaces the earlier port 8123.`] }) });
  try {
    assert.equal((await compact(id)).events.at(-1).event, "done");
    const second = (await stack.sql(`SELECT summary FROM chat_context WHERE chat_id='${id}'`))[0].summary;
    assert(second.startsWith(first + "\n\n"), "Previous memory must never be rewritten by the model");
    assert(second.includes("ORBIT_913"));
    assert(second.includes("8247 replaces"));
  } finally { stack.mock.configure({ memoryOutput: null }); }
});

test("invalid memory never overwrites a valid checkpoint; truncated extraction retries safely", async () => {
  const id = await importedChat();
  stack.mock.configure({ memoryTruncations: 1 });
  assert.equal((await compact(id)).events.at(-1).event, "done");
  await call("POST", `/v1/chats/${id}/turn`, { content: "Next", think: false });
  const previous = await stack.sql(`SELECT * FROM chat_context WHERE chat_id='${id}'`);
  stack.mock.configure({ memoryOutput: ' continued answer.' });
  try {
    const failed = await compact(id);
    assert.equal(failed.events.at(-1).event, "error");
    assert.match(failed.events.at(-1).message, /valid durable memory/);
    assert.deepEqual(await stack.sql(`SELECT * FROM chat_context WHERE chat_id='${id}'`), previous);
  } finally { stack.mock.configure({ memoryOutput: null, memoryTruncations: 0 }); }
});

test("empty extraction cannot silently cover a new correction after an existing checkpoint", async () => {
  const id = await importedChat();
  const original = (await call("GET", `/v1/chats/${id}`)).body.messages;
  await stack.sql(`UPDATE messages SET content='Critical correction: production port is 8471, replacing 8123. ' || content WHERE id=${original[8].id}`);
  assert.equal((await compact(id)).events.at(-1).event, "done");
  await call("POST", `/v1/chats/${id}/turn`, { content: "Next topic one", think: false });
  await call("POST", `/v1/chats/${id}/turn`, { content: "Next topic two", think: false });
  const previous = await stack.sql(`SELECT * FROM chat_context WHERE chat_id='${id}'`);
  const messages = (await call("GET", `/v1/chats/${id}`)).body.messages;
  const calls = stack.mock.stats().chatCalls;
  stack.mock.configure({ memoryOutput: JSON.stringify({ goals: [], constraints: [], decisions: [], facts: [], artifacts: [], next_steps: [], corrections: [] }) });
  try {
    const failed = await compact(id);
    assert.equal(failed.events.at(-1).event, "error", "An old nonempty checkpoint must not make an empty new extraction successful");
    assert.match(failed.events.at(-1).message, /no useful notes/);
    assert.equal(stack.mock.stats().chatCalls - calls, 3, "Empty extraction gets only two quality retries");
    assert.deepEqual(await stack.sql(`SELECT * FROM chat_context WHERE chat_id='${id}'`), previous);
    assert.deepEqual((await call("GET", `/v1/chats/${id}`)).body.messages, messages);
  } finally { stack.mock.configure({ memoryOutput: null }); }
  const sent = await call("POST", `/v1/chats/${id}/turn`, { content: "Which port?", think: false });
  assert.equal(sent.events.at(-1).event, "done");
  assert(stack.mock.lastChat().messages.some(message => message.content.includes("production port is 8471")), "Uncompacted correction remains in the next request");
});

test("duplicate-only extraction cannot advance a checkpoint over a new correction", async () => {
  const id = await importedChat(3);
  const source = (await call("GET", `/v1/chats/${id}`)).body.messages;
  await stack.sql(`UPDATE messages SET content='Critical correction: production port is 8471, replacing 8123. ' || content WHERE id=${source[2].id}`);
  const note = `[message ${source[0].id}] Previously saved exact code OLD_712.`;
  const output = JSON.stringify({ goals: [], constraints: [], decisions: [], facts: [note], artifacts: [], next_steps: [], corrections: [] });
  stack.mock.configure({ memoryOutput: output });
  try {
    assert.equal((await compact(id)).events.at(-1).event, "done");
    await call("POST", `/v1/chats/${id}/turn`, { content: "Next topic", think: false });
    const previous = await stack.sql(`SELECT * FROM chat_context WHERE chat_id='${id}'`);
    const original = (await call("GET", `/v1/chats/${id}`)).body.messages;
    const calls = stack.mock.stats().chatCalls;
    const failed = await compact(id);
    assert.equal(failed.events.at(-1).event, "error");
    assert.match(failed.events.at(-1).message, /only existing notes/);
    assert.equal(stack.mock.stats().chatCalls - calls, 3);
    assert.deepEqual(await stack.sql(`SELECT * FROM chat_context WHERE chat_id='${id}'`), previous);
    assert.deepEqual((await call("GET", `/v1/chats/${id}`)).body.messages, original);
  } finally { stack.mock.configure({ memoryOutput: null }); }
});

test("context preparation failure leaves the existing checkpoint uncommitted", async () => {
  const id = await importedChat();
  assert.equal((await compact(id)).events.at(-1).event, "done");
  await call("POST", `/v1/chats/${id}/turn`, { content: "Next topic", think: false });
  const previous = await stack.sql(`SELECT * FROM chat_context WHERE chat_id='${id}'`);
  const assistantId = (await call("GET", `/v1/chats/${id}`)).body.messages.at(-1).id;
  // The optional measured-statistics lookup must fail before the checkpoint write.
  await stack.sql(`UPDATE messages SET stats='not-json' WHERE id=${assistantId}`);
  try {
    const failed = await compact(id);
    assert.equal(failed.events.at(-1).event, "error");
    assert.deepEqual(await stack.sql(`SELECT * FROM chat_context WHERE chat_id='${id}'`), previous);
  } finally { await stack.sql(`UPDATE messages SET stats=NULL WHERE id=${assistantId}`); }
});

test("compaction can be stopped cross-device, keeps prior checkpoint, and prevents concurrent deletion", async () => {
  const id = await importedChat();
  assert.equal((await compact(id)).events.at(-1).event, "done");
  await call("POST", `/v1/chats/${id}/turn`, { content: "another question", think: false });
  const previous = await stack.sql(`SELECT * FROM chat_context WHERE chat_id = '${id}'`);
  stack.mock.configure({ firstTokenDelayMs: 2500 });
  const response = await fetch(`${stack.url}/v1/chats/${id}/compact`, { method: "POST" });
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "", stopped = false;
  for (;;) {
    const part = await reader.read();
    if (part.done) break;
    text += decoder.decode(part.value, { stream: true });
    if (!stopped && text.includes('"event":"start"')) {
      const status = await call("GET", "/v1/status");
      assert.equal(status.body.busy.operation, "compact");
      assert.equal((await call("DELETE", `/v1/chats/${id}`)).status, 409);
      assert.equal((await call("POST", "/v1/stop")).body.stopped, true);
      stopped = true;
    }
  }
  stack.mock.configure({ firstTokenDelayMs: 0 });
  const events = text.trim().split("\n").map(JSON.parse);
  assert.equal(events.at(-1).code, "stopped");
  assert.deepEqual(await stack.sql(`SELECT * FROM chat_context WHERE chat_id = '${id}'`), previous);
  assert.equal((await call("DELETE", `/v1/chats/${id}`)).status, 200);
  assert.deepEqual(await stack.sql(`SELECT * FROM chat_context WHERE chat_id = '${id}'`), []);
});

test("editing after coverage preserves memory and continued replies use its summary", async () => {
  const id = await importedChat();
  assert.equal((await compact(id)).events.at(-1).event, "done");
  const previous = await stack.sql(`SELECT * FROM chat_context WHERE chat_id = '${id}'`);
  const original = (await call("GET", `/v1/chats/${id}`)).body.messages;
  stack.mock.configure({ errorAfterTokens: 2 });
  const edited = await call("POST", `/v1/chats/${id}/turn`, { content: "edited recent question", replace_from: original.at(-2).id, think: false });
  stack.mock.configure({ errorAfterTokens: null });
  assert.equal(edited.events.at(-1).event, "error");
  assert.deepEqual(await stack.sql(`SELECT * FROM chat_context WHERE chat_id = '${id}'`), previous);
  const continued = await call("POST", `/v1/chats/${id}/continue`, {});
  assert.equal(continued.events.at(-1).event, "done", JSON.stringify(continued.events));
  assert(stack.mock.lastGenerate().prompt.includes("<conversation_summary>"));
  assert(!stack.mock.lastGenerate().prompt.includes(original[0].content));
});

test("exact upstream overflow is explicit and compact retries smaller chunks without losing coverage", async () => {
  const created = await call("POST", "/v1/chats", {});
  stack.mock.configure({ rejectPromptAboveChars: 100 });
  try {
    const overflow = await call("POST", `/v1/chats/${created.body.chat.id}/turn`, { content: "unicode/code-like input".repeat(30), think: false });
    assert.equal(overflow.events.at(-1).code, "context_limit");
    assert.equal(stack.mock.lastChat().truncate, false);
    assert.equal(stack.mock.lastChat().shift, false);
  } finally { stack.mock.configure({ rejectPromptAboveChars: null }); }
  const id = await importedChat();
  const failures = stack.mock.stats().failed;
  stack.mock.configure({ rejectPromptAboveChars: 12000 });
  try {
    const result = await compact(id);
    assert.equal(result.events.at(-1).event, "done", JSON.stringify(result.events));
    assert.equal(result.events.at(-1).summarized_message_count, 8);
    assert(stack.mock.stats().failed > failures, "compaction exercised real upstream rejection before retrying smaller chunks");
    assert.equal((await call("GET", `/v1/chats/${id}`)).body.messages.length, 12);
  } finally { stack.mock.configure({ rejectPromptAboveChars: null }); }
});

test("a summary that saves no room leaves the previous checkpoint and original messages untouched", async () => {
  const id = await importedChat(4, 5);
  const original = (await call("GET", `/v1/chats/${id}`)).body.messages;
  await stack.sql(`INSERT INTO chat_context (chat_id,summary,through_id,covered_count,source_digest,model,updated_at) VALUES ('${id}','Old memory',${original[1].id},2,'fixture','qwen3.8-hauhau','2026-10-01T00:00:00Z')`);
  const previous = await stack.sql(`SELECT * FROM chat_context WHERE chat_id = '${id}'`);
  stack.mock.configure({ fillerTokens: 80 });
  try {
    const result = await compact(id);
    assert.equal(result.events.at(-1).event, "error");
    assert.match(result.events.at(-1).message, /would not save context/);
    assert.deepEqual(await stack.sql(`SELECT * FROM chat_context WHERE chat_id = '${id}'`), previous);
    assert.deepEqual((await call("GET", `/v1/chats/${id}`)).body.messages, original);
  } finally { stack.mock.configure({ fillerTokens: 0 }); }
});

const profileId = "cache-fixture:Q5_K_P:kv-q8_0:b256:t4x2";
async function registerBatchProfile(extra = {}) {
  return call("POST", "/_relay/register", { target: stack.mock.url, host: "kaggle", num_ctx: 98304, num_batch: 256, profile_id: profileId, vision: true, quant: "Q5_K_P", ...extra }, { "x-relay-key": stack.relayKey });
}
async function registerLegacy() {
  return call("POST", "/_relay/register", { target: stack.mock.url }, { "x-relay-key": stack.relayKey });
}

test("runtime registration validates and retains the batch/profile without changing legacy defaults", async () => {
  for (const extra of [{ num_batch: 31 }, { num_batch: 2049 }, { num_batch: 32.5 }, { num_batch: "256" }, { profile_id: "bad profile" }, { profile_id: "x".repeat(201) }]) {
    const response = await fetch(stack.url + "/_relay/register", { method: "POST", headers: { "content-type": "application/json", "x-relay-key": stack.relayKey }, body: JSON.stringify({ target: stack.mock.url, ...extra }) });
    assert.equal(response.status, 400);
  }
  try {
    assert.equal((await registerBatchProfile()).body.ok, true);
    for (const endpoint of ["/v1/config", "/v1/status", "/_relay/status"]) {
      const result = await call("GET", endpoint, undefined, { "x-relay-key": stack.relayKey });
      assert.equal(result.body.num_batch, 256);
      assert.equal(result.body.profile_id, profileId);
    }
  } finally { await registerLegacy(); }
  const legacy = (await call("GET", "/v1/config")).body;
  assert.equal(legacy.num_batch, undefined);
  assert.equal(legacy.profile_id, undefined);
});

test("turns, continuation and compaction keep the registered batch that fits the larger context", async () => {
  await registerBatchProfile();
  try {
    const id = await importedChat();
    const compacted = await compact(id);
    assert.equal(compacted.events.at(-1).event, "done");
    assert.equal(stack.mock.lastGenerate().options.num_batch, 256);
    assert.equal(stack.mock.lastGenerate().options.num_ctx, 98304);
    const sent = await call("POST", `/v1/chats/${id}/turn`, { content: "Continue our work", think: false });
    assert.equal(sent.events.at(-1).message.stats.num_batch, 256);
    assert.equal(stack.mock.lastChat().options.num_batch, 256);
    stack.mock.configure({ errorAfterTokens: 2 });
    await call("POST", `/v1/chats/${id}/turn`, { content: "A partial answer", think: false });
    stack.mock.configure({ errorAfterTokens: null });
    const continued = await call("POST", `/v1/chats/${id}/continue`, {});
    assert.equal(continued.events.at(-1).event, "done");
    assert.equal(stack.mock.lastGenerate().options.num_batch, 256);
    assert.equal(stack.mock.lastGenerate().options.num_ctx, 98304);
  } finally { stack.mock.configure({ errorAfterTokens: null }); await registerLegacy(); }
});

test("raw inference receives the batch default, preserves explicit options and other proxy calls", async () => {
  await registerBatchProfile();
  const headers = { "x-relay-key": stack.relayKey };
  try {
    await call("POST", "/api/chat", { model: "qwen3.8-hauhau", messages: [{ role: "user", content: "raw" }], options: { num_ctx: 98304 }, stream: true }, headers);
    assert.equal(stack.mock.lastChat().options.num_batch, 256);
    assert.equal(stack.mock.lastChat().options.num_ctx, 98304);
    await call("POST", "/api/chat", { model: "qwen3.8-hauhau", messages: [{ role: "user", content: "explicit" }], options: { num_batch: 128, temperature: 0.4 }, stream: true }, headers);
    assert.equal(stack.mock.lastChat().options.num_batch, 128);
    assert.equal(stack.mock.lastChat().options.temperature, 0.4);
    await call("POST", "/api/generate", { model: "qwen3.8-hauhau", prompt: "raw generation", stream: true }, headers);
    assert.equal(stack.mock.lastGenerate().options.num_batch, 256);
    assert.equal((await call("GET", "/api/version", undefined, headers)).status, 200);
  } finally { await registerLegacy(); }
});

test("bounded raw-body editing preserves exact numeric values, malformed bytes and oversized streams", async () => {
  const request = (source, pathname = "/api/chat") => new Request("https://relay.test" + pathname, { method: "POST", headers: { "content-type": "application/json" }, body: source });
  const integerSource = '{ "model":"qwen", "options":{"seed":9223372036854775807, "stop":["}","\\\""]} }';
  const result = await rawBatchDefault(request(integerSource), 256);
  assert(result.changed);
  assert(result.body.includes('"seed":9223372036854775807'));
  assert.equal(JSON.parse(result.body).options.num_batch, 256);
  const upper = await rawBatchDefault(request('{"Options":{"temperature":0.2}}'), 256);
  assert.equal(JSON.parse(upper.body).Options.num_batch, 256);
  for (const source of ['{not json}', '{"options":[]}', '{"options":{"num_batch":null}}', '{"options":{"num_batch":128}}', '{"options":{},"Options":{}}']) {
    const unchanged = await rawBatchDefault(request(source), 256);
    assert.equal(unchanged.changed, false);
    assert.equal(await new Response(unchanged.body).text(), source);
  }
  const segments = ["abcd", "efghi", "jklmnop"];
  const stream = new ReadableStream({ start(controller) { for (const part of segments) controller.enqueue(new TextEncoder().encode(part)); controller.close(); } });
  const oversized = await rawBatchDefault(new Request("https://relay.test/api/chat", { method: "POST", body: stream, duplex: "half", headers: { "content-type": "application/json" } }), 256, 8);
  assert.equal(oversized.changed, false);
  assert.equal(await new Response(oversized.body).text(), segments.join(""));
  const unrelated = request('{"keep":"exact"}', "/api/create");
  const unmodified = await rawBatchDefault(unrelated, 256);
  assert.equal(unmodified.body, unrelated.body);
});

test("jobs-v1 registration is optional, exact and retained only on the registered server", async () => {
  jobsProxy = await startJobsProxy();
  for (const inference_transport of ["jobs-v2", "direct", true, {}, ""]) {
    const response = await fetch(stack.url + "/_relay/register", { method: "POST", headers: { "content-type": "application/json", "x-relay-key": stack.relayKey }, body: JSON.stringify({ target: jobsProxy.url, inference_transport }) });
    assert.equal(response.status, 400);
  }
  assert.equal((await call("POST", "/_relay/register", { target: jobsProxy.url, inference_transport: "jobs-v1" }, { "x-relay-key": stack.relayKey })).status, 200);
  assert.equal((await call("GET", "/_relay/status", undefined, { "x-relay-key": stack.relayKey })).body.inference_transport, "jobs-v1");
  await registerLegacy();
  assert.equal((await call("GET", "/_relay/status", undefined, { "x-relay-key": stack.relayKey })).body.inference_transport, undefined);
});

test("real Worker turn, continuation and compaction use the Python jobs protocol", async () => {
  const target = { target: jobsProxy.url, host: "kaggle", num_ctx: 98304, num_batch: 256, inference_transport: "jobs-v1", vision: true };
  await call("POST", "/_relay/register", target, { "x-relay-key": stack.relayKey });
  try {
    const id = await importedChat();
    const original = (await call("GET", `/v1/chats/${id}`)).body.messages;
    const compacted = await compact(id);
    assert.equal(compacted.events.at(-1).event, "done", JSON.stringify(compacted.events));
    assert.deepEqual((await call("GET", `/v1/chats/${id}`)).body.messages, original);
    assert.equal(stack.mock.lastGenerate().options.num_batch, 256);
    const sent = await call("POST", `/v1/chats/${id}/turn`, { content: "Jobs route turn", think: false });
    assert.equal(sent.events.at(-1).event, "done", JSON.stringify(sent.events));
    stack.mock.configure({ errorAfterTokens: 2 });
    const partial = await call("POST", `/v1/chats/${id}/turn`, { content: "Partial jobs reply", think: false });
    assert.equal(partial.events.at(-1).event, "error");
    stack.mock.configure({ errorAfterTokens: null });
    const continued = await call("POST", `/v1/chats/${id}/continue`, {});
    assert.equal(continued.events.at(-1).event, "done", JSON.stringify(continued.events));
    assert.equal(stack.mock.lastGenerate().options.num_batch, 256);
    assert.equal(stack.mock.lastGenerate().options.num_ctx, 98304);
    // Two valid picture turns exceed the raw per-request2.25MiB cap after
    // assembly; website jobs retain the proxy's prior4MiB inference allowance.
    const pictureChat = (await call("POST", "/v1/chats", {})).body.chat.id;
    const data = "A".repeat(1_280_000);
    for (let index = 0; index < 2; index++) {
      const pictureTurn = await call("POST", `/v1/chats/${pictureChat}/turn`, { content: `Picture turn${index}`, think: false, attachments: [{ name: `picture${index}.png`, type: "image/png", data }] });
      assert.equal(pictureTurn.events.at(-1).event, "done", JSON.stringify(pictureTurn.events));
    }
    assert.equal(stack.mock.lastChat().messages.flatMap((message) => message.images ?? []).length, 2);
    assert(stack.mock.lastChat().messages.flatMap((message) => message.images ?? []).every((image) => image.length === data.length));
  } finally { stack.mock.configure({ errorAfterTokens: null }); await registerLegacy(); }
});

test("raw jobs reconnect real short legs without restarting inference, including servers without a batch field", async () => {
  const headers = { "x-relay-key": stack.relayKey };
  await call("POST", "/_relay/register", { target: jobsProxy.url, inference_transport: "jobs-v1" }, headers);
  const before = stack.mock.stats().chatCalls;
  const legsBefore = (await fetch(jobsProxy.url + "/__fixture/stats").then((response) => response.json())).legs;
  stack.mock.configure({ firstTokenDelayMs: 900 });
  try {
    const response = await call("POST", "/api/chat", { model: "qwen3.8-hauhau", messages: [{ role: "user", content: "Single inference across reconnects" }], stream: true, think: false }, headers);
    assert.equal(response.status, 200);
    assert.equal(response.events.at(-1).done, true);
    assert.equal(stack.mock.stats().chatCalls - before, 1);
    assert.equal(stack.mock.lastChat().options?.num_batch, undefined);
    const legsAfter = (await fetch(jobsProxy.url + "/__fixture/stats").then((value) => value.json())).legs;
    assert(legsAfter - legsBefore >= 2, "Real Python HTTP legs were reattached during prefill");
    assert.match(response.events.map((part) => part.message?.content ?? "").join(""), /Single inference across reconnects/);
  } finally { stack.mock.configure({ firstTokenDelayMs: 0 }); await registerLegacy(); }
});

test("bounded raw collector can buffer jobs without injecting a missing batch default", async () => {
  const source = '{"model":"x","options":{"seed":9223372036854775807}}';
  const request = new Request("https://relay.example/api/chat", { method: "POST", headers: { "content-type": "application/json" }, body: source });
  const outgoing = await rawBatchDefault(request, undefined, undefined, { bufferWithoutBatch: true });
  assert.equal(outgoing.changed, false); assert.equal(await new Response(outgoing.body).text(), source);
});
