import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import { startStack } from "./dev-stack.mjs";

let stack;
before(async () => { stack = await startStack({ port: 8824, mockPort: 11524, state: `.test-state/long-input-${process.pid}`, vars: { TIMING_SCALE: "0.05", KAGGLE_CACHE_DATASET: "", KAGGLE_CACHE_ID: "" } }); });
after(async () => { await stack?.stop(); });
let seq = 0;
async function call(method, path, body) {
  const response = await fetch(stack.url + path, { method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  if (response.headers.get("content-type")?.includes("ndjson")) return { status: response.status, events: (await response.text()).trim().split("\n").filter(Boolean).map(JSON.parse) };
  if (response.headers.get("content-type")?.includes("application/json")) return { status: response.status, body: await response.json() };
  return { status: response.status, text: await response.text() };
}
async function chat() { const id = `long-test-${process.pid}-${seq++}`; assert.equal((await call("POST", "/v1/chats", { id })).status, 201); return id; }
async function prepare(id, content = "Read every section and preserve code EXACT_771.\n" + "archive text with facts. ".repeat(1400), patch = {}) {
  const result = await call("POST", `/v1/chats/${id}/long-inputs`, { consent: true, content, think: false, client_id: `owned-${seq++}`, ...patch });
  assert.equal(result.status, 201, JSON.stringify(result));
  return result.body;
}
const run = (id, source) => call("POST", `/v1/chats/${id}/long-inputs/${source.id}/run`, { consent: true });
const sourceRow = async id => (await call("GET", `/v1/chats/${id}/long-inputs`)).body.sources[0];

test("saving a long source makes no GPU call, is idempotent and preserves the downloadable/exported original", async () => {
  const id = await chat(), content = "Long prompt exact START_221.\n" + "x ".repeat(55000) + "\nDo not deploy; pending END_999.";
  const payload = { consent: true, content, client_id: "same-upload", think: false, attachments: [{ name: "config.txt", text: "port=8247" }] };
  const calls = stack.mock.stats().chatCalls;
  const created = await call("POST", `/v1/chats/${id}/long-inputs`, payload);
  assert.equal(created.status, 201, JSON.stringify(created));
  assert.equal(stack.mock.stats().chatCalls, calls);
  assert(created.body.source.total_chunks > 1);
  const retry = await call("POST", `/v1/chats/${id}/long-inputs`, payload);
  assert.equal(retry.status, 200);
  assert.equal(retry.body.user_message.id, created.body.user_message.id);
  assert.equal((await call("GET", `/v1/chats/${id}`)).body.messages.length, 1);
  assert.equal((await call("POST", `/v1/chats/${id}/long-inputs`, { ...payload, content: "different" })).status, 409);
  const original = await call("GET", created.body.source.source_url);
  assert(original.text.startsWith(content));
  assert(original.text.endsWith("port=8247"));
  const exported = await call("GET", `/v1/chats/${id}/export`);
  assert(exported.text.includes("END_999") && exported.text.includes("port=8247"));
  const other = await chat();
  assert.equal((await call("GET", `/v1/chats/${other}/long-inputs/${created.body.source.id}/source`)).status, 404);
  assert.equal((await call("POST", `/v1/chats/${id}/long-inputs/${created.body.source.id}/run`, {})).status, 400);
  assert.equal(stack.mock.stats().chatCalls, calls);
  await call("DELETE", `/v1/chats/${id}`);
  assert.equal((await call("GET", created.body.source.source_url)).status, 404);
});

test("each run saves one section, final result replays without another model call, and later turns receive notes", async () => {
  const id = await chat(), created = await prepare(id);
  let source = created.source, checkpoints = 0;
  while (source.processed_chunks < source.total_chunks) {
    const result = await run(id, source);
    assert.equal(result.events.at(-1).event, "checkpoint", JSON.stringify(result));
    const next = result.events.at(-1).source;
    assert.equal(next.processed_chunks, source.processed_chunks + 1);
    source = next; checkpoints++;
  }
  assert(checkpoints >= 2);
  const before = (await stack.sql(`SELECT notes FROM long_inputs WHERE id='${source.id}'`))[0].notes;
  const answered = await run(id, source);
  assert.equal(answered.events.at(-1).event, "done", JSON.stringify(answered));
  assert.equal(answered.events.at(-1).source.status, "complete");
  const request = stack.mock.lastGenerate();
  assert(request.prompt.includes("saved_long_input_notes"));
  assert.equal(request.options.num_predict, 4096);
  assert.equal(request.think, false);
  const calls = stack.mock.stats().chatCalls;
  const replay = await run(id, source);
  assert.equal(replay.events.at(-1).message.id, answered.events.at(-1).message.id);
  assert.equal(stack.mock.stats().chatCalls, calls);
  assert.equal((await call("GET", `/v1/chats/${id}`)).body.messages.length, 2);
  const next = await call("POST", `/v1/chats/${id}/turn`, { content: "What exact code was saved?", think: false });
  assert.equal(next.events.at(-1).event, "done");
  assert(stack.mock.lastChat().messages.some(message => message.content.includes(before)));
});

test("invalid section output and changed originals preserve the reading cursor and previous notes", async () => {
  const id = await chat(), created = await prepare(id);
  const first = await run(id, created.source);
  assert.equal(first.events.at(-1).event, "checkpoint");
  const before = (await stack.sql(`SELECT notes,processed_chunks FROM long_inputs WHERE id='${created.source.id}'`))[0];
  stack.mock.configure({ memoryOutput: JSON.stringify({ goals: [], constraints: [], decisions: [], facts: [], artifacts: [], next_steps: [], corrections: [] }) });
  try {
    const failed = await run(id, created.source);
    assert.equal(failed.events.at(-1).event, "error");
    assert.deepEqual((await stack.sql(`SELECT notes,processed_chunks FROM long_inputs WHERE id='${created.source.id}'`))[0], before);
  } finally { stack.mock.configure({ memoryOutput: null }); }
  const row = (await stack.sql(`SELECT source_hash FROM long_inputs WHERE id='${created.source.id}'`))[0];
  await stack.sql(`UPDATE long_inputs SET source_hash='changed' WHERE id='${created.source.id}'`);
  const calls = stack.mock.stats().chatCalls;
  assert.equal((await run(id, created.source)).events.at(-1).event, "error");
  assert.equal(stack.mock.stats().chatCalls, calls);
  await stack.sql(`UPDATE long_inputs SET source_hash='${row.source_hash}' WHERE id='${created.source.id}'`);
  assert.equal((await run(id, created.source)).events.at(-1).event, "checkpoint");
});

test("Stop saves completed sections and editing/deleting a source cleans its storage records", async () => {
  const id = await chat(), created = await prepare(id);
  stack.mock.configure({ firstTokenDelayMs: 2500 });
  try {
    const response = await fetch(`${stack.url}/v1/chats/${id}/long-inputs/${created.source.id}/run`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ consent: true }) });
    const reader = response.body.getReader(), decoder = new TextDecoder();
    let text = "", stopped = false;
    for (;;) {
      const part = await reader.read(); if (part.done) break;
      text += decoder.decode(part.value, { stream: true });
      if (!stopped && text.includes('"event":"start"')) { assert.equal((await call("POST", "/v1/stop")).body.stopped, true); stopped = true; }
    }
    const events = text.trim().split("\n").map(JSON.parse);
    assert.equal(events.at(-1).code, "stopped");
    assert.equal((await sourceRow(id)).processed_chunks, 0);
    assert.equal((await sourceRow(id)).status, "paused");
  } finally { stack.mock.configure({ firstTokenDelayMs: 0 }); }
  const edited = await call("POST", `/v1/chats/${id}/turn`, { content: "Replace the long input", think: false, replace_from: created.user_message.id });
  assert.equal(edited.events.at(-1).event, "done");
  assert.equal((await call("GET", `/v1/chats/${id}/long-inputs`)).body.sources.length, 0);
  assert.equal((await call("GET", created.source.source_url)).status, 404);
  assert.equal((await stack.sql("SELECT count(*) AS n FROM long_input_garbage"))[0].n, 0);
});

test("a newer user turn supersedes a paused source instead of mixing task order", async () => {
  const id = await chat(), created = await prepare(id);
  await call("POST", `/v1/chats/${id}/turn`, { content: "A new task", think: false });
  const calls = stack.mock.stats().chatCalls;
  const failed = await run(id, created.source);
  assert.equal(failed.events.at(-1).code, "superseded");
  assert.equal(failed.events.at(-1).source.status, "superseded");
  assert.equal(stack.mock.stats().chatCalls, calls);
});

test("overflow retries split only the current section and selected thinking applies only to the final answer", async () => {
  const id = await chat(), task = "Answer the task TASK_REAL_882 using every attached section. Preserve exact units.";
  const created = await prepare(id, task, { think: "low", attachments: [{ name: "reference.txt", text: "Source fact BUDGET_17.5. ".repeat(1800) }] });
  stack.mock.configure({ rejectPromptAboveChars: 12000 });
  let source;
  try {
    const first = await run(id, created.source);
    assert.equal(first.events.at(-1).event, "checkpoint", JSON.stringify(first));
    source = first.events.at(-1).source;
    assert.equal(source.processed_chunks, 1);
    assert(source.total_chunks > created.source.total_chunks);
    assert.equal(stack.mock.lastGenerate().think, false, "Reading always skips private reasoning");
  } finally { stack.mock.configure({ rejectPromptAboveChars: null }); }
  while (source.processed_chunks < source.total_chunks) {
    const next = await run(id, source);
    assert.equal(next.events.at(-1).event, "checkpoint", JSON.stringify(next));
    source = next.events.at(-1).source;
  }
  const final = await run(id, source);
  assert.equal(final.events.at(-1).event, "done", JSON.stringify(final));
  assert.equal(stack.mock.lastGenerate().think, "low");
  assert(stack.mock.lastGenerate().prompt.includes(`Original task prompt (verbatim):\n${task}`));
  assert(final.events.at(-1).message.thinking, "The selected effort is retained for the final answer");
});

test("storage reservations and combined exports enforce budgets before loading or using the GPU", async () => {
  const id = await chat(), created = await prepare(id, "A small source with CODE_314.");
  const bytes = created.source.bytes;
  await stack.sql(`UPDATE long_inputs SET bytes=${200 * 1024 * 1024} WHERE id='${created.source.id}'`);
  try {
    const calls = stack.mock.stats().chatCalls;
    const other = await chat();
    const rejected = await call("POST", `/v1/chats/${other}/long-inputs`, { consent: true, content: "New source", client_id: "quota-check" });
    assert.equal(rejected.status, 413);
    assert.equal(rejected.body.error.code, "storage_budget");
    const exported = await call("GET", `/v1/chats/${id}/export`);
    assert.equal(exported.status, 413);
    assert.equal(exported.body.error.code, "export_size");
    assert.match(exported.body.error.message, /individually/);
    assert.equal((await call("GET", created.source.source_url)).status, 200, "The original remains independently downloadable");
    assert.equal(stack.mock.stats().chatCalls, calls);
  } finally { await stack.sql(`UPDATE long_inputs SET bytes=${bytes} WHERE id='${created.source.id}'`); }
});
