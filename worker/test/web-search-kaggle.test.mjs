// Web search over the Kaggle connection: the Worker talks to the notebook's real Python job server
// (kaggle-stream-proxy.py + kaggle-jobs.py, test/jobs-proxy-fixture.py) registered as jobs-v1, the
// way a Kaggle notebook registers, with its web route (kaggle-web.py): searches and page reads go
// through the notebook, as they do from Kaggle. The fake model and fake web stand behind it; no GPU,
// no live site.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { after, before, beforeEach, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { startStack, WORKER_DIR } from "./dev-stack.mjs";

const PORT = 8877;
const MOCK_PORT = 11577;
let stack, jobsProxy;
const state = `.test-state/web-search-kaggle-${process.pid}`;
const WEB_KEY = "w".repeat(20) + "_-" + "K".repeat(21);
before(async () => {
  stack = await startStack({
    port: PORT,
    mockPort: MOCK_PORT,
    state,
    vars: { TIMING_SCALE: "0.05", WEB_SEARCH_BASE: `http://127.0.0.1:${MOCK_PORT}/__web`, WEB_PAGE_REWRITE: `http://127.0.0.1:${MOCK_PORT}/__web/page` },
  });
  const child = spawn("python", ["test/jobs-proxy-fixture.py", stack.mock.url], { cwd: WORKER_DIR, windowsHide: true, stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, FIXTURE_WEB_KEY: WEB_KEY } });
  jobsProxy = {
    close: async () => {
      if (child.exitCode !== null) return;
      const exited = once(child, "exit");
      child.stdin.end("\n");
      const timer = setTimeout(() => child.kill(), 5000);
      try { await exited; } finally { clearTimeout(timer); }
    },
  };
  let output = "", errors = "";
  child.stderr.on("data", (chunk) => { errors = (errors + chunk).slice(-2000); });
  jobsProxy.url = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error("Jobs fixture startup timed out: " + errors)); }, 15000);
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.stdout.on("data", (chunk) => {
      output += chunk;
      if (output.includes("\n")) { clearTimeout(timer); try { resolve(JSON.parse(output.split("\n")[0]).url); } catch (error) { reject(error); } }
    });
  });
  // What kaggle-server.py registers (its /_relay/register call), minus the picture and profile details.
  const registered = await fetch(stack.url + "/_relay/register", {
    method: "POST",
    headers: { "x-relay-key": stack.relayKey, "content-type": "application/json" },
    body: JSON.stringify({ target: jobsProxy.url, host: "kaggle", num_ctx: 98304, num_batch: 512, job_max_leg_seconds: 300, inference_transport: "jobs-v1", vision: false, quant: "Q5_K_P", control: true, mode: "chat", web_key: WEB_KEY }),
  });
  assert.equal(registered.status, 200, await registered.text());
});
after(async () => {
  await jobsProxy?.close();
  await stack?.stop();
  const directory = path.resolve(WORKER_DIR, state);
  assert(directory.startsWith(path.resolve(WORKER_DIR, ".test-state") + path.sep));
  for (let attempt = 0; ; attempt++) {
    try { fs.rmSync(directory, { recursive: true, force: true }); break; }
    catch (error) { if (attempt >= 30 || !["EPERM", "EBUSY", "ENOTEMPTY"].includes(error.code)) throw error; await delay(250); }
  }
});
beforeEach(async () => {
  stack.mock.reset();
  stack.mock.configure({ tokenDelayMs: 0 });
  await call("PUT", "/v1/settings", { max_reply_tokens: null, history_chars: null, system_prompt: null });
});

async function call(method, uri, body) {
  const response = await fetch(stack.url + uri, { method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const text = await response.text();
  const ndjson = response.headers.get("content-type")?.includes("ndjson");
  return { status: response.status, ...(ndjson ? { events: text.split("\n").filter(Boolean).map((line) => JSON.parse(line)) } : { body: text ? JSON.parse(text) : null }) };
}
const chat = async (id) => { assert.equal((await call("POST", "/v1/chats", { id })).status, 201); return id; };
const terminal = (result) => {
  const last = result.events?.at(-1);
  assert(last && ["done", "error"].includes(last.event), "Missing terminal event: " + JSON.stringify(result).slice(0, 2000) + "\n" + stack.output?.());
  return last;
};
const chats = () => stack.mock.requests().filter((request) => request.path === "/api/chat").map((request) => request.body);
const search = (query) => ({ name: "web_search", arguments: { query } });
const viaNotebook = async () => (await (await fetch(jobsProxy.url + "/__fixture/stats")).json()).web;

test("the Kaggle server is registered on the jobs transport", async () => {
  const status = (await call("GET", "/v1/status")).body;
  assert.equal(status.server, "ready", JSON.stringify(status).slice(0, 500));
});

test("a notebook web key must be URL-safe and 43-128 characters; it is never shown in the status", async () => {
  for (const web_key of ["short", "x".repeat(129), "k".repeat(42) + "!", 42]) {
    const response = await fetch(stack.url + "/_relay/register", { method: "POST", headers: { "x-relay-key": stack.relayKey, "content-type": "application/json" }, body: JSON.stringify({ target: jobsProxy.url, web_key }) });
    assert.equal(response.status, 400, String(web_key));
    assert.equal(await response.text(), "bad web_key\n");
  }
  assert(!JSON.stringify((await call("GET", "/v1/status")).body).includes(WEB_KEY));
});

test("over the Kaggle job server: think, search, read a page, answer, and save the Sources", async () => {
  const id = await chat("kaggle-web-loop");
  const before = await viaNotebook();
  stack.mock.configure({ thinkingTokens: 40, toolRounds: [[search("mock news")], [{ name: "open_page", arguments: { url: "https://news.test/article" } }]] });
  const result = await call("POST", `/v1/chats/${id}/turn`, { content: "What is new?", think: "medium" });
  assert.equal(result.status, 200);
  const done = terminal(result);
  assert.equal(done.event, "done", JSON.stringify(done));
  assert.equal(done.message.status, "complete");
  assert.match(done.message.content, /I used 2 web results\.$/);
  const web = done.message.stats.web;
  assert.equal(web.calls, 2);
  assert.equal(web.rounds, 3);
  assert.equal(web.searches[0].query, "mock news");
  assert.equal(web.pages[0].url, "https://news.test/article");
  assert.deepEqual((await call("GET", `/v1/chats/${id}`)).body.messages.at(-1).stats.web, web);
  // Every model call went through the job server with the tools, and each later call carries the
  // earlier tool calls and their results.
  const bodies = chats();
  assert.equal(bodies.length, 3);
  for (const body of bodies) assert.deepEqual(body.tools.map((tool) => tool.function.name), ["web_search", "open_page"]);
  assert.deepEqual(bodies[1].messages.at(-2).tool_calls, [{ function: { name: "web_search", arguments: { query: "mock news" } } }]);
  assert.equal(bodies[1].messages.at(-1).role, "tool");
  assert.match(bodies[2].messages.at(-1).content, /<web_page url="https:\/\/news\.test\/article" title="Mock & Article">/);
  // The search and the page read were made by the notebook, not by the Worker.
  assert.equal(await viaNotebook() - before, 2);
  assert.equal(web.searches[0].source, "duckduckgo");
  // The thinking before each tool call reached the page.
  assert(result.events.some((event) => event.event === "thinking" || event.thinking), "No thinking was streamed");
});

test("over the Kaggle job server: web off sends no tools", async () => {
  const id = await chat("kaggle-web-off");
  stack.mock.configure({ toolRounds: [[search("never")]] });
  const done = terminal(await call("POST", `/v1/chats/${id}/turn`, { content: "Offline answer", think: false, web: false }));
  assert.equal(done.event, "done");
  assert.equal(chats().length, 1);
  assert.equal(chats()[0].tools, undefined);
  assert.deepEqual(stack.mock.webRequests(), []);
});

test("over the Kaggle job server: Stop during a search ends the reply at once", async () => {
  const id = await chat("kaggle-web-stop");
  stack.mock.configure({ webDelayMs: 6000, toolRounds: [[search("slow")]] });
  const response = await fetch(`${stack.url}/v1/chats/${id}/turn`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ content: "Look this up", think: true }) });
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const events = [];
  let buffer = "", stoppedAt = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    for (let at; (at = buffer.indexOf("\n")) >= 0; ) {
      const event = JSON.parse(buffer.slice(0, at));
      buffer = buffer.slice(at + 1);
      events.push(event);
      if (event.state === "searching" && !stoppedAt) { stoppedAt = Date.now(); assert.equal((await call("POST", "/v1/stop", {})).status, 200); }
    }
  }
  assert(stoppedAt, "The search never started");
  assert.equal(events.at(-1).event, "done", JSON.stringify(events.at(-1)));
  assert.equal(events.at(-1).message.status, "stopped");
  assert(Date.now() - stoppedAt < 5000, "Stop waited for the slow search");
  assert.equal(chats().length, 1, "Nothing more was asked of the model");
});

test("over the Kaggle job server: a cut answer after a search continues with its web results", async () => {
  const id = await chat("kaggle-web-continue");
  stack.mock.configure({ doneReason: "length", toolRounds: [[search("cats")]] });
  const first = terminal(await call("POST", `/v1/chats/${id}/turn`, { content: "Tell me about cats", think: false }));
  assert.equal(first.event, "done");
  assert.equal(first.message.status, "length");
  stack.mock.configure({ doneReason: null });
  const continued = terminal(await call("POST", `/v1/chats/${id}/continue`, { think: false }));
  assert.equal(continued.event, "done", JSON.stringify(continued));
  assert.match(stack.mock.lastGenerate().prompt, /Web results gathered for this reply/);
  assert.deepEqual(continued.message.stats.web, first.message.stats.web);
});

test("over the Kaggle job server: the notebook refusing an address is the tool's answer, with no second try from Cloudflare", async () => {
  const id = await chat("kaggle-web-refused");
  stack.mock.configure({ toolRounds: [[{ name: "open_page", arguments: { url: "https://example.org/" } }]] });
  const done = terminal(await call("POST", `/v1/chats/${id}/turn`, { content: "Read it", think: false }));
  assert.equal(done.event, "done", JSON.stringify(done));
  assert.equal(chats()[1].messages.at(-1).content, "open_page failed: it is not a public web address.");
  assert.deepEqual(stack.mock.webRequests(), []);
});
