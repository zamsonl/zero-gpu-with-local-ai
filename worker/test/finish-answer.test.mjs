import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, before, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { startStack, WORKER_DIR } from "./dev-stack.mjs";

let stack;
const state = `.test-state/finish-answer-${process.pid}`;
before(async () => { stack = await startStack({ port: 8876, mockPort: 11676, state, vars: { TIMING_SCALE: "0.05" } }); });
after(async () => {
  await stack?.stop();
  const directory = path.resolve(WORKER_DIR, state);
  assert(directory.startsWith(path.resolve(WORKER_DIR, ".test-state") + path.sep));
  for (let attempt = 0; ; attempt++) {
    try { fs.rmSync(directory, { recursive: true, force: true }); break; }
    catch (error) { if (attempt >= 30 || !["EPERM", "EBUSY", "ENOTEMPTY"].includes(error.code)) throw error; await delay(250); }
  }
});

async function seededChat(id, { large = false, content = "" } = {}) {
  const at = new Date().toISOString();
  const response = await fetch(stack.url + "/v1/chats", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id }) });
  assert.equal(response.status, 201);
  const trace = large ? "'NEVER_REPLAY_LONG_THOUGHT ' || replace(hex(zeroblob(70000)), '00', 'x')" : "'Small pending thought'";
  await stack.sql(`INSERT INTO messages(chat_id,role,content,created_at) VALUES('${id}','user','Explain recursion','${at}'); INSERT INTO messages(chat_id,role,content,thinking,status,created_at) VALUES('${id}','assistant','${content}',${trace},'length','${at}'); UPDATE chats SET message_count=2 WHERE id='${id}';`);
  return fetch(stack.url + `/v1/chats/${id}`).then(response => response.json());
}

async function continueChat(id, body) {
  const response = await fetch(stack.url + `/v1/chats/${id}/continue`, { method: "POST", headers: { "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const text = await response.text();
  return { status: response.status, ...(response.headers.get("content-type")?.includes("ndjson") ? { events: text.split("\n").filter(Boolean).map(JSON.parse) } : { error: JSON.parse(text).error }) };
}

async function idle() {
  for (let attempt = 0; attempt < 50; attempt++) {
    const status = await fetch(stack.url + "/v1/status").then(response => response.json());
    if (!status.busy) return;
    await delay(100);
  }
  throw new Error("The continued reply did not release its lock");
}

test("Finish answer recovers an oversized thought without altering its saved trace", async () => {
  const id = "finish-long-thought";
  const before = await seededChat(id, { large: true, content: "Existing answer: " });
  const original = before.messages.at(-1);
  const finished = await continueChat(id, { think: false });
  assert.equal(finished.status, 200);
  const done = finished.events.at(-1);
  assert.equal(done.event, "done");
  assert.equal(done.message.id, original.id);
  assert.equal(done.message.thinking, original.thinking);
  assert.equal(done.message.content, original.content + " continued answer.");
  assert.equal(done.message.status, "complete");
  assert(!finished.events.some(event => event.event === "thinking"));
  const request = stack.mock.lastGenerate();
  assert.equal(request.options.num_predict, 4096);
  assert(!request.prompt.includes(original.thinking), "The oversized raw trace must not be replayed wholesale");
  assert(request.prompt.includes("<unfinished_work_notes>"));
  assert(done.message.stats.recovery.notes.includes("NEVER_REPLAY_LONG_THOUGHT"), "Useful source details survive in bounded working notes");
  assert.equal(done.message.stats.recovery.through_chars, original.thinking.length);
  assert(request.prompt.endsWith("<|im_start|>assistant\n<think>\n\n</think>\n\nExisting answer: "));
  const after = await fetch(stack.url + `/v1/chats/${id}`).then(response => response.json());
  assert.equal(after.messages.length, 2);
  assert.equal(after.messages[1].thinking, original.thinking);
  await idle();
});

test("ordinary Continue still replays reasoning and appends to the same message", async () => {
  const id = "continue-reasoning-unchanged";
  const before = await seededChat(id);
  const original = before.messages.at(-1);
  const continued = await continueChat(id);
  assert.equal(continued.status, 200);
  assert.equal(continued.events.at(-1).message.thinking, original.thinking + " and so on.");
  assert.equal(continued.events.at(-1).message.id, original.id);
  assert(stack.mock.lastGenerate().prompt.endsWith("<|im_start|>assistant\n<think>\nSmall pending thought"));
  await idle();
});

test("Answer now extracts a just-stopped initial thought before writing the answer", async () => {
  const id = "finish-stopped-initial-thought";
  await seededChat(id);
  const thought = "DRAFT_RESULT=8247; calculation is provisional and needs final verification.";
  await stack.sql(`UPDATE messages SET thinking='${thought}',status='stopped',stats='{"think":"medium"}' WHERE chat_id='${id}' AND role='assistant';`);
  const original = (await fetch(stack.url + `/v1/chats/${id}`).then(response => response.json())).messages.at(-1);
  const prior = stack.mock.requests().length;
  const finished = await continueChat(id, { think: false });
  assert.equal(finished.status, 200);
  const done = finished.events.at(-1);
  assert.equal(done.event, "done");assert.equal(done.message.id, original.id);assert.equal(done.message.thinking, thought);
  assert.equal(done.message.stats.recovery.selected_think, "medium");assert.equal(done.message.stats.recovery.answer_only, true);
  const requests = stack.mock.requests().slice(prior);
  assert.equal(requests.length, 2);assert(requests[0].body.prompt.includes("<unfinished_assistant_source"));assert.equal(requests[0].body.think, false);
  assert(requests[1].body.prompt.includes("DRAFT_RESULT=8247"));assert(requests[1].body.prompt.includes("<unfinished_work_notes>"));assert.equal(requests[1].body.think, false);
  assert.equal((await fetch(stack.url + `/v1/chats/${id}`).then(response => response.json())).messages.length, 2);
  await idle();
});

test("browser client preserves an explicit false Finish answer choice", async () => {
  const { api } = await import("../public/js/api.js");
  const originalFetch = globalThis.fetch;
  let sent;
  globalThis.fetch = async (_url, options) => { sent = JSON.parse(options.body); return new Response('{"event":"done"}\n', { headers: { "content-type": "application/x-ndjson" } }); };
  try { for await (const _ of api.continueReply("owned-test", undefined, false)); }
  finally { globalThis.fetch = originalFetch; }
  assert.deepEqual(sent, { think: false });
});
