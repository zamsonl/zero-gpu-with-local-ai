// API tests against two local stacks (run from worker/: node --test test/api.test.mjs):
//   open  127.0.0.1:8800, mock 11500, AUTH_MODE=open
//   key   127.0.0.1:8801, mock 11501, AUTH_MODE=key, starts unregistered
// Both run with TIMING_SCALE=0.05, so the turn endpoint's waits are 1/20 of production
// (retry steps 250 ms, status ticks 500 ms, first-token cap 18 s, idle timeout 6 s).

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, afterEach, before, beforeEach, describe, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { RELAY_KEY, WORKER_DIR, startStack } from "./dev-stack.mjs";
import { KAGGLE_TOKEN } from "./mock-ollama.mjs";

const TIMING_SCALE = 0.05;
const STATUS_EVERY_MS = 10_000 * TIMING_SCALE;
// The open stack can also start Kaggle runs, against the mock's stand-in for Kaggle's API.
const OPEN = {
  port: 8800,
  mockPort: 11500,
  state: ".test-state/api-open",
  vars: { KAGGLE_API_TOKEN: KAGGLE_TOKEN, KAGGLE_API_BASE: "http://127.0.0.1:11500", KAGGLE_CACHE_DATASET: "", KAGGLE_CACHE_ID: "", KAGGLE_NUM_BATCH: "512", KAGGLE_CONTEXT_MAX: "131072" },
};
const KEYED = { port: 8801, mockPort: 11501, state: ".test-state/api-key", auth: "key", register: false };
const CSP =
  "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; " +
  "font-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'";
const THINK_OPTIONS = { num_ctx: 24576, temperature: 1.0, top_p: 0.95, top_k: 20, num_predict: 2048 };
// Base64 of the first bytes of a JPEG: the mock never decodes pictures, it only records them.
const TINY_JPEG = "/9j/4AAQSkZJRgABAQ==";
const FAST_OPTIONS ={ num_ctx: 24576, temperature: 0.7, top_p: 0.8, top_k: 20, presence_penalty: 1.5, num_predict: 4096 };

let open;
let keyed;

before(async () => {
  for (const { state } of [OPEN, KEYED]) await removeState(state);
  const started = await Promise.allSettled(
    [OPEN, KEYED].map((config) => startStack({ ...config, vars: { TIMING_SCALE: String(TIMING_SCALE), ...config.vars } })),
  );
  [open, keyed] = started.map((s) => (s.status === "fulfilled" ? s.value : null));
  const failure = started.find((s) => s.status === "rejected");
  if (failure) {
    await Promise.all([open, keyed].filter(Boolean).map((stack) => stack.stop()));
    throw failure.reason;
  }
});

after(async () => {
  await Promise.all([open, keyed].filter(Boolean).map((stack) => stack.stop()));
  for (const { state } of [OPEN, KEYED]) await removeState(state);
});

// ---------------------------------------------------------------- helpers

/** Windows keeps a killed workerd's SQLite files locked for a second or two, so retry for a while. */
async function removeState(state) {
  for (let attempt = 1; ; attempt++) {
    try {
      fs.rmSync(path.resolve(WORKER_DIR, state), { recursive: true, force: true });
      return;
    } catch (err) {
      if (attempt >= 40 || !["EPERM", "EBUSY", "ENOTEMPTY"].includes(err.code)) throw err;
      await delay(250);
    }
  }
}

/** JSON-ish request; returns status, headers, raw text and parsed JSON (or null). */
async function call(stack, method, pathname, { body, headers = {} } = {}) {
  const init = { method, headers: { ...headers } };
  if (body !== undefined) {
    init.body = typeof body === "string" ? body : JSON.stringify(body);
    init.headers["content-type"] ??= "application/json";
  }
  const res = await fetch(stack.url + pathname, init);
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // not JSON
  }
  return { status: res.status, headers: res.headers, text, json };
}

const withKey = { "x-relay-key": RELAY_KEY };

async function createChat(stack, body = {}, headers = {}) {
  const res = await call(stack, "POST", "/v1/chats", { body, headers });
  assert.equal(res.status, 201, res.text);
  return res.json.chat;
}

async function getChat(stack, id, headers = {}) {
  const res = await call(stack, "GET", `/v1/chats/${id}`, { headers });
  assert.equal(res.status, 200, res.text);
  return res.json;
}

/**
 * Posts a turn and collects the NDJSON events. `onEvent(event, events)` may return "abort" to
 * drop the connection the way the Stop button does. Pre-stream errors come back as `json`.
 */
async function turn(stack, chatId, body, { headers = {}, onEvent } = {}) {
  const controller = new AbortController();
  const res = await fetch(`${stack.url}/v1/chats/${chatId}/turn`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
    signal: controller.signal,
  });
  if (!(res.headers.get("content-type") ?? "").includes("ndjson")) {
    return { status: res.status, headers: res.headers, json: await res.json(), events: [] };
  }
  const events = [];
  let aborted = false;
  try {
    for await (const event of readEvents(res.body)) {
      event.at = Date.now();
      events.push(event);
      if (onEvent?.(event, events) === "abort") {
        aborted = true;
        controller.abort();
        break;
      }
    }
  } catch (err) {
    if (!aborted) throw err;
  }
  return { status: res.status, headers: res.headers, events, aborted };
}

async function* readEvents(body) {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const part of body) {
    buffer += decoder.decode(part, { stream: true });
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (line.trim()) yield JSON.parse(line);
    }
  }
  if (buffer.trim()) yield JSON.parse(buffer);
}

/** A pre-stream turn error in the shape assertApiError expects. */
async function callTurn(pending) {
  const res = await pending;
  return { status: res.status, headers: res.headers, json: res.json, text: JSON.stringify(res.json) };
}

const kinds = (events) => events.map((e) => e.event);
const textOf = (events, kind) => events.filter((e) => e.event === kind).map((e) => e.text).join("");
const statuses = (events) => events.filter((e) => e.event === "status");

/** start first, exactly one terminal event last, no status events once tokens flow. */
function assertEventShape(events, terminal) {
  const order = kinds(events);
  assert.equal(order[0], "start", order.join(","));
  assert.equal(order.at(-1), terminal, order.join(","));
  assert.equal(order.filter((k) => k === "done" || k === "error").length, 1, order.join(","));
  const firstToken = order.findIndex((k) => k === "thinking" || k === "content");
  if (firstToken >= 0) assert.ok(!order.slice(firstToken).includes("status"), `status after tokens: ${order}`);
}

async function waitFor(check, { timeout = 10_000, interval = 100, what = "condition" } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await delay(interval);
  }
}

async function waitForLockRelease(stack, headers = {}) {
  await waitFor(async () => (await call(stack, "GET", "/v1/status", { headers })).json.busy === null, {
    what: "the generation lock to be released",
  });
}

async function register(stack, target) {
  const res = await call(stack, "POST", "/_relay/register", { body: { target }, headers: withKey });
  assert.equal(res.status, 200, res.text);
}

/** What the Kaggle notebook registers: a bigger context, pictures, its quantization, remote control. */
async function registerKaggle(stack) {
  const body = { target: stack.mock.url, host: "kaggle", num_ctx: 65536, vision: true, quant: "Q5_K_P", control: true };
  const res = await call(stack, "POST", "/_relay/register", { body, headers: withKey });
  assert.equal(res.status, 200, res.text);
}

function plantLock(stack, { chatId, heartbeatAgeMs }) {
  const at = new Date(Date.now() - heartbeatAgeMs).toISOString();
  const value = JSON.stringify({ owner: "ghost-owner", chat_id: chatId, since: at, heartbeat: at });
  return stack.sql(
    `INSERT INTO state (k, v, updated_at) VALUES ('gen_lock', '${value}', '${at}') ` +
      "ON CONFLICT (k) DO UPDATE SET v = excluded.v, updated_at = excluded.updated_at",
  );
}

function assertSecurityHeaders(headers, { html = false } = {}) {
  assert.equal(headers.get("x-robots-tag"), "noindex, nofollow");
  assert.equal(headers.get("referrer-policy"), "no-referrer");
  assert.equal(headers.get("x-content-type-options"), "nosniff");
  assert.equal(headers.get("content-security-policy"), html ? CSP : null);
}

function assertApiError(res, status, code) {
  assert.equal(res.status, status, res.text);
  assert.match(res.headers.get("content-type"), /^application\/json/);
  assert.equal(res.json?.error?.code, code, res.text);
  assert.equal(typeof res.json.error.message, "string");
  assert.ok(res.json.error.message.length > 0);
}

const pad = (prefix, length) => (prefix + " ").padEnd(length, prefix.slice(0, 1));

// ---------------------------------------------------------------- open stack

describe("open stack", () => {
  beforeEach(() => open.mock.reset());

  describe("security headers", () => {
    test("JSON API responses carry the base headers and no CSP", async () => {
      const res = await call(open, "GET", "/v1/config");
      assert.equal(res.status, 200);
      assertSecurityHeaders(res.headers);
      assert.equal(res.headers.get("cache-control"), "no-store");
    });

    test("the app shell carries the CSP", async () => {
      const res = await call(open, "GET", "/");
      assert.equal(res.status, 200);
      assert.match(res.headers.get("content-type"), /^text\/html/);
      assertSecurityHeaders(res.headers, { html: true });
    });

    test("deep links fall back to index.html with the CSP", async () => {
      const res = await call(open, "GET", "/c/some-chat-id", {
        headers: { accept: "text/html", "sec-fetch-mode": "navigate" },
      });
      assert.equal(res.status, 200);
      assert.match(res.headers.get("content-type"), /^text\/html/);
      assertSecurityHeaders(res.headers, { html: true });
    });

    test("robots.txt is served with the base headers", async () => {
      const res = await call(open, "GET", "/robots.txt");
      assert.equal(res.status, 200);
      assert.match(res.text, /Disallow: \//);
      assertSecurityHeaders(res.headers);
    });

    test("plain-text relay errors carry the base headers", async () => {
      const res = await call(open, "GET", "/_relay/status");
      assert.equal(res.status, 401);
      assertSecurityHeaders(res.headers);
    });
  });

  describe("relay endpoints", () => {
    test("/_relay/* and /api/* need the key even in open mode", async () => {
      for (const pathname of ["/_relay/status", "/api/tags"]) {
        const missing = await call(open, "GET", pathname);
        assert.equal(missing.status, 401);
        assert.equal(missing.text, "unauthorized\n");
        const wrong = await call(open, "GET", pathname, { headers: { "x-relay-key": "x".repeat(RELAY_KEY.length) } });
        assert.equal(wrong.status, 401);
        const short = await call(open, "GET", pathname, { headers: { "x-relay-key": RELAY_KEY.slice(0, -1) } });
        assert.equal(short.status, 401);
      }
      const reg = await call(open, "POST", "/_relay/register", { body: { target: open.mock.url } });
      assert.equal(reg.status, 401);
      assert.equal(reg.text, "unauthorized\n");
    });

    test("/_relay/status returns the stored target", async () => {
      const res = await call(open, "GET", "/_relay/status", { headers: withKey });
      assert.equal(res.status, 200);
      assert.equal(res.json.target, open.mock.url);
      assert.ok(!Number.isNaN(Date.parse(res.json.at)));
    });

    test("register rejects bad targets with the plain-text contract", async () => {
      const bad = [
        undefined,
        "not json",
        [],
        {},
        { target: 42 },
        { target: "https://words-here.trycloudflare.com" }, // valid in production, not under the test pattern
        { target: `${open.mock.url}/` },
        { target: "http://127.0.0.1:11500/api" },
        { target: "http://localhost:11500" },
      ];
      for (const body of bad) {
        const res = await call(open, "POST", "/_relay/register", { body, headers: withKey });
        assert.equal(res.status, 400, `body ${JSON.stringify(body)}`);
        assert.equal(res.text, "bad target\n");
      }
      const wrongMethod = await call(open, "GET", "/_relay/register", { headers: withKey });
      assert.equal(wrongMethod.status, 405);
    });

    test('register stores the target and answers {"ok":true,...}', async () => {
      const before = (await call(open, "GET", "/_relay/status", { headers: withKey })).json.at;
      const res = await call(open, "POST", "/_relay/register", { body: { target: open.mock.url }, headers: withKey });
      assert.equal(res.status, 200);
      assert.ok(res.text.includes('"ok":true'), res.text); // the notebook's literal success check
      assert.deepEqual(res.json, { ok: true, target: open.mock.url });
      const after = (await call(open, "GET", "/_relay/status", { headers: withKey })).json;
      assert.equal(after.target, open.mock.url);
      assert.ok(after.at >= before);
    });

    test("/api/* passes through to Ollama, streaming, without the relay key", async () => {
      const tags = await call(open, "GET", "/api/tags", { headers: withKey });
      assert.equal(tags.status, 200);
      assert.equal(tags.json.models[0].name, "qwen3.8-hauhau:latest");
      assertSecurityHeaders(tags.headers);

      const chat = await call(open, "POST", "/api/chat", {
        headers: withKey,
        body: { model: "qwen3.8-hauhau", messages: [{ role: "user", content: "raw" }], stream: true },
      });
      assert.equal(chat.status, 200);
      const lines = chat.text.trim().split("\n").map((l) => JSON.parse(l));
      assert.equal(lines.at(-1).done, true);
      assert.match(lines.map((l) => l.message.content).join(""), /You said: "raw"/);
      assert.equal(open.mock.lastChatHeaders()["x-relay-key"], undefined);

      const missing = await call(open, "GET", "/api/nope", { headers: withKey });
      assert.equal(missing.status, 404);
    });

    test("/api/* answers 502 when the target is unreachable", async () => {
      open.mock.setDown(true);
      const res = await call(open, "GET", "/api/tags", { headers: withKey });
      assert.equal(res.status, 502);
      assert.equal(res.text, "model server unreachable\n");
    });
  });

  describe("config and status", () => {
    test("GET /v1/config", async () => {
      const res = await call(open, "GET", "/v1/config");
      assert.deepEqual(res.json, {
        model: "qwen3.8-hauhau",
        model_label: "Heretic Qwen",
        num_ctx: 24576,
        host: "colab",
        vision: false,
        quant: null,
        can_shut_down: false,
        can_start: true,
        colab_url: "https://colab.research.google.com/drive/EXAMPLE_NOTEBOOK_ID",
        kaggle_url: null,
        auth_mode: "open",
      });
    });

    test("a Kaggle server announces its host and bigger context; turns and status use them", async () => {
      const bad = await call(open, "POST", "/_relay/register", { body: { target: open.mock.url, host: "aws" }, headers: withKey });
      assert.equal(bad.text, "bad host\n");
      const badCtx = await call(open, "POST", "/_relay/register", { body: { target: open.mock.url, num_ctx: 1000 }, headers: withKey });
      assert.equal(badCtx.text, "bad num_ctx\n");

      const reg = await call(open, "POST", "/_relay/register", { body: { target: open.mock.url, host: "kaggle", num_ctx: 65536 }, headers: withKey });
      assert.ok(reg.text.includes('"ok":true'), reg.text);
      try {
        const config = (await call(open, "GET", "/v1/config")).json;
        assert.equal(config.host, "kaggle");
        assert.equal(config.num_ctx, 65536);
        const status = (await call(open, "GET", "/v1/status")).json;
        assert.equal(status.host, "kaggle");
        assert.equal(status.num_ctx, 65536);

        const chat = await createChat(open);
        await turn(open, chat.id, { content: "big memory", think: false });
        assert.equal(open.mock.lastChat().options.num_ctx, 65536);
      } finally {
        await register(open, open.mock.url); // back to a plain registration for the other tests
      }
      assert.equal((await call(open, "GET", "/v1/config")).json.num_ctx, 24576);
    });

    test("Colab advertises the actual smaller model and registered context", async () => {
      try {
        const res=await call(open,"POST","/_relay/register",{body:{target:open.mock.url,host:"colab",num_ctx:32768,num_batch:128,quant:"Q6_K",model_size:"9B",vision:true,control:true},headers:withKey});
        assert.equal(res.status,200,res.text);
        for(const path of ["/v1/config","/v1/status"]){const value=(await call(open,"GET",path)).json;assert.equal(value.model_size,"9B");assert.equal(value.num_ctx,32768);assert.equal(value.num_batch,128);}
        const chat=await createChat(open);await turn(open,chat.id,{content:"Colab smaller model",think:false});assert.equal(open.mock.lastChat().options.num_ctx,32768);assert.equal(open.mock.lastChat().options.num_batch,128);
      } finally {await register(open,open.mock.url);}
    });

    test("Kaggle extras: vision, quant and remote control are reported; bad values are refused", async () => {
      for (const [extra, error] of [
        [{ vision: "yes" }, "bad vision\n"],
        [{ quant: "Q5 K P" }, "bad quant\n"],
        [{ control: 1 }, "bad control\n"],
        [{ model_size: "<script>" }, "bad model_size\n"],
      ]) {
        const res = await call(open, "POST", "/_relay/register", { body: { target: open.mock.url, ...extra }, headers: withKey });
        assert.equal(res.status, 400);
        assert.equal(res.text, error);
      }
      await registerKaggle(open);
      try {
        const status = (await call(open, "GET", "/v1/status")).json;
        assert.deepEqual(
          { vision: status.vision, quant: status.quant, can_shut_down: status.can_shut_down, shutting_down: status.shutting_down },
          { vision: true, quant: "Q5_K_P", can_shut_down: true, shutting_down: false },
        );
        assert.equal((await call(open, "GET", "/v1/config")).json.vision, true);
      } finally {
        await register(open, open.mock.url);
      }
      assert.equal((await call(open, "GET", "/v1/status")).json.vision, false);
    });

    test("owner jobs registration preserves supported stream caps and rejects invalid metadata", async () => {
      for (const cap of [0, 121, 301, "300"]) {
        const invalid = await call(open, "POST", "/_relay/register", { body: { target: open.mock.url, inference_transport: "jobs-v1", job_max_leg_seconds: cap }, headers: withKey });
        assert.equal(invalid.status, 400);
        assert.equal(invalid.text, "bad job_max_leg_seconds\n");
      }
      try {
        for (const cap of [120, 300]) {
          const response = await call(open, "POST", "/_relay/register", { body: { target: open.mock.url, inference_transport: "jobs-v1", job_max_leg_seconds: cap }, headers: withKey });
          assert.equal(response.status, 200);
          const status = (await call(open, "GET", "/_relay/status", { headers: withKey })).json;
          assert.equal(status.job_max_leg_seconds, cap);
          assert.equal(status.inference_transport, "jobs-v1");
        }
      } finally {
        await register(open, open.mock.url);
      }
      assert.equal((await call(open, "GET", "/_relay/status", { headers: withKey })).json.job_max_leg_seconds, undefined);
    });

    test("start-up progress shows until the new server registers", async () => {
      const progress = (body, headers = withKey) => call(open, "POST", "/_relay/progress", { body, headers });
      assert.equal((await progress({ host: "kaggle", stage: "baking" })).text, "bad stage\n");
      assert.equal((await progress({ host: "aws", stage: "loading" })).text, "bad host\n");
      assert.equal((await progress({ host: "kaggle", stage: "loading", percent: 101 })).text, "bad percent\n");
      assert.equal((await progress({ host: "kaggle", stage: "loading" }, {})).status, 401);

      const ok = await progress({ host: "kaggle", stage: "downloading", detail: " Model 40%\u0007", percent: 40 });
      assert.equal(ok.status, 200, ok.text);
      const { at, ...boot } = (await call(open, "GET", "/v1/status")).json.boot;
      assert.deepEqual(boot, { host: "kaggle", stage: "downloading", detail: "Model 40%", percent: 40 });
      assert.ok(!Number.isNaN(Date.parse(at)));

      await delay(5);
      await register(open, open.mock.url); // the server that was starting is up: start-up is over
      assert.equal((await call(open, "GET", "/v1/status")).json.boot, null);

      // A server that signs off soon after starting doesn't bring its start-up back with it.
      await progress({ host: "kaggle", stage: "connecting", detail: "Opening the tunnel to this page" });
      await call(open, "POST", "/_relay/register", { body: { target: open.mock.url, host: "kaggle" }, headers: withKey });
      await call(open, "POST", "/_relay/unregister", { body: { target: open.mock.url }, headers: withKey });
      const after = (await call(open, "GET", "/v1/status")).json;
      assert.deepEqual([after.server, after.boot], ["unregistered", null]);
      await register(open, open.mock.url);
    });

    test("shut down: only a server that takes commands; it sees the request, then signs off", async () => {
      const command = (target) => call(open, "GET", `/_relay/command?target=${encodeURIComponent(target)}`, { headers: withKey });
      const refused = await call(open, "POST", "/v1/server/shutdown"); // a Colab server doesn't poll
      assert.equal(refused.status, 409);
      assert.equal(refused.json.error.code, "unsupported");

      await registerKaggle(open);
      try {
        assert.deepEqual((await command(open.mock.url)).json, { shutdown: false, reason: null, registered: true, idle_minutes: 45, mode: "chat" });
        // A server that another one replaced stops too: nothing reaches it any more.
        assert.deepEqual((await command("https://older.trycloudflare.com")).json, {
          shutdown: true,
          reason: "replaced",
          registered: false,
          idle_minutes: 45,
        });

        const asked = await call(open, "POST", "/v1/server/shutdown");
        assert.equal(asked.status, 200, asked.text);
        assert.equal((await call(open, "GET", "/v1/status")).json.shutting_down, true);
        assert.deepEqual((await command(open.mock.url)).json, { shutdown: true, reason: "requested", registered: true, idle_minutes: 45 });

        // Signing off: a stale notebook can't remove the current server; the current one can.
        const stale = await call(open, "POST", "/_relay/unregister", { body: { target: "https://older.trycloudflare.com" }, headers: withKey });
        assert.deepEqual(stale.json, { ok: true, removed: false });
        const off = await call(open, "POST", "/_relay/unregister", { body: { target: open.mock.url }, headers: withKey });
        assert.deepEqual(off.json, { ok: true, removed: true });
        assert.equal((await call(open, "GET", "/v1/status")).json.server, "unregistered");
        assert.deepEqual((await command(open.mock.url)).json, { shutdown: false, reason: null, registered: false, idle_minutes: 45 });
      } finally {
        await register(open, open.mock.url);
      }
      // Registering again starts afresh: the spent request doesn't stop the new server.
      assert.equal((await call(open, "GET", "/v1/status")).json.shutting_down, false);
      assert.equal((await command(open.mock.url)).json.shutdown, false);
    });

    test("ready when /api/ps lists the model", async () => {
      const res = await call(open, "GET", "/v1/status");
      assert.equal(res.status, 200);
      const { target_registered_at, ...rest } = res.json;
      assert.ok(!Number.isNaN(Date.parse(target_registered_at)));
      assert.deepEqual(rest, {
        server: "ready",
        model: "qwen3.8-hauhau",
        num_ctx: 24576,
        host: "colab",
        vision: false,
        quant: null,
        can_shut_down: false,
        can_start: true,
        loaded_ctx: 24576,
        busy: null,
        boot: null,
        shutting_down: false,
        gpu_hours_week: 0,
        idle_shutdown_at: null,
        idle_minutes: 45,
        mode: { current: "chat", requested: "chat", state: "ready", detail: null, percent: null },
        images_waiting: 0,
        colab_url: "https://colab.research.google.com/drive/EXAMPLE_NOTEBOOK_ID",
        kaggle_url: null,
      });
    });

    test("idle when the server is up but the model is not loaded", async () => {
      open.mock.configure({ loaded: false });
      const res = await call(open, "GET", "/v1/status");
      assert.equal(res.json.server, "idle");
      assert.equal(res.json.loaded_ctx, null);
    });

    test("offline when the target does not answer", async () => {
      open.mock.setDown(true);
      const res = await call(open, "GET", "/v1/status");
      assert.equal(res.status, 200);
      assert.equal(res.json.server, "offline");
      assert.ok(res.json.target_registered_at);
    });
  });

  describe("chats", () => {
    test("create with a server-generated id", async () => {
      const res = await call(open, "POST", "/v1/chats", { body: {} });
      assert.equal(res.status, 201);
      const { chat } = res.json;
      assert.match(chat.id, /^[A-Za-z0-9_-]{22}$/);
      assert.equal(chat.title, "");
      assert.equal(chat.message_count, 0);
      assert.equal(chat.created_at, chat.updated_at);
      assert.ok(!Number.isNaN(Date.parse(chat.created_at)));
    });

    test("create with a client id and a messy title; repeating the create is harmless", async () => {
      const id = `client-${Date.now()}_X`;
      const res = await call(open, "POST", "/v1/chats", { body: { id, title: "  Hello \n\t  world  " } });
      assert.equal(res.status, 201);
      assert.equal(res.json.chat.id, id);
      assert.equal(res.json.chat.title, "Hello world");

      const again = await call(open, "POST", "/v1/chats", { body: { id, title: "other" } });
      assert.equal(again.status, 200);
      assert.deepEqual(again.json.chat, res.json.chat);
    });

    test("create validates its input", async () => {
      for (const body of [{ id: "bad id!" }, { id: "x".repeat(65) }, { id: "" }, { id: 7 }, { title: 5 }]) {
        assertApiError(await call(open, "POST", "/v1/chats", { body }), 400, "bad_request");
      }
      assertApiError(await call(open, "POST", "/v1/chats", { body: "{nope" }), 400, "bad_request");
      assertApiError(await call(open, "POST", "/v1/chats", { body: "[]" }), 400, "bad_request");
      assertApiError(await call(open, "POST", "/v1/chats", { body: "null" }), 400, "bad_request");
    });

    test("bodies over 200 KB are refused with 413", async () => {
      const res = await call(open, "POST", "/v1/chats", { body: { title: "x".repeat(210 * 1024) } });
      assertApiError(res, 413, "too_large");
    });

    test("get returns the chat and its messages; unknown ids are 404", async () => {
      const chat = await createChat(open, { title: "lookup" });
      const res = await call(open, "GET", `/v1/chats/${chat.id}`);
      assert.deepEqual(res.json, { chat, messages: [] });
      assertApiError(await call(open, "GET", "/v1/chats/does-not-exist"), 404, "not_found");
    });

    test("rename normalises the title and does not bump updated_at", async () => {
      const chat = await createChat(open, { title: "before" });
      await delay(20);
      const res = await call(open, "PATCH", `/v1/chats/${chat.id}`, { body: { title: "  after \n  rename " } });
      assert.equal(res.status, 200);
      assert.equal(res.json.chat.title, "after rename");
      assert.equal(res.json.chat.updated_at, chat.updated_at);

      const long = await call(open, "PATCH", `/v1/chats/${chat.id}`, { body: { title: "é".repeat(120) } });
      assert.equal(long.json.chat.title, "é".repeat(80));

      for (const body of [{ title: "   " }, { title: "" }, {}, { title: 3 }]) {
        assertApiError(await call(open, "PATCH", `/v1/chats/${chat.id}`, { body }), 400, "bad_request");
      }
      assertApiError(await call(open, "PATCH", "/v1/chats/nope-nope", { body: { title: "x" } }), 404, "not_found");
    });

    test("delete removes the chat and its messages", async () => {
      const chat = await createChat(open, { title: "doomed" });
      const done = await turn(open, chat.id, { content: "uniquewordxyzzy", think: false });
      assert.equal(kinds(done.events).at(-1), "done");

      const res = await call(open, "DELETE", `/v1/chats/${chat.id}`);
      assert.equal(res.status, 200);
      assert.deepEqual(res.json, { ok: true });
      assertApiError(await call(open, "GET", `/v1/chats/${chat.id}`), 404, "not_found");
      assert.deepEqual((await call(open, "GET", "/v1/chats?q=uniquewordxyzzy")).json.chats, []);
      const orphans = await open.sql(`SELECT COUNT(*) AS n FROM messages WHERE chat_id = '${chat.id}'`);
      assert.equal(orphans[0].n, 0);
      assertApiError(await call(open, "DELETE", `/v1/chats/${chat.id}`), 404, "not_found");
    });

    test("unknown endpoints and methods are JSON 404s", async () => {
      assertApiError(await call(open, "GET", "/v1/nope"), 404, "not_found");
      assertApiError(await call(open, "PUT", "/v1/chats"), 404, "not_found");
      assertApiError(await call(open, "GET", "/v1"), 404, "not_found");
      assertApiError(await call(open, "GET", "/v1/chats/bad%20id"), 404, "not_found");
    });
  });

  describe("list and search", () => {
    const tag = `s${Date.now()}`;

    before(async () => {
      const res = await call(open, "POST", "/v1/import", {
        body: {
          chats: [
            {
              id: `${tag}-a`,
              title: `Zebra facts ${tag}`,
              created_at: "2030-01-01T00:00:00.000Z",
              updated_at: "2030-01-02T00:00:00.000Z",
              messages: [{ role: "user", content: "Tell me about stripes, as taught at the École" }],
            },
            {
              id: `${tag}-b`,
              title: `Cooking ${tag}`,
              created_at: "2030-01-01T00:00:00.000Z",
              updated_at: "2030-01-03T00:00:00.000Z",
              messages: [
                { role: "user", content: "How long to boil an egg? 100% sure_please" },
                { role: "assistant", content: "About nine minutes for a ZEBRA-hard yolk.", thinking: "secretthought" },
              ],
            },
          ],
        },
      });
      assert.deepEqual(res.json, { imported: 2, skipped: 0 });
    });

    test("lists most recently updated first", async () => {
      const { chats } = (await call(open, "GET", "/v1/chats")).json;
      const sorted = [...chats].sort((a, b) => b.updated_at.localeCompare(a.updated_at));
      assert.deepEqual(chats.map((c) => c.id), sorted.map((c) => c.id));
      assert.deepEqual(chats.slice(0, 2).map((c) => c.id), [`${tag}-b`, `${tag}-a`]);
      assert.deepEqual(Object.keys(chats[0]).sort(), ["created_at", "id", "message_count", "title", "updated_at"]);
    });

    test("matches titles and message content, case-insensitively", async () => {
      const ids = async (q) =>
        (await call(open, "GET", `/v1/chats?q=${encodeURIComponent(q)}`)).json.chats.map((c) => c.id);
      assert.deepEqual(await ids("zebra"), [`${tag}-b`, `${tag}-a`]); // b by content, a by title
      assert.deepEqual(await ids("STRIPES"), [`${tag}-a`]);
      assert.deepEqual(await ids("ÉCOLE"), [`${tag}-a`], "ASCII letters fold around non-ASCII ones");
      assert.deepEqual(await ids(`cooking ${tag}`), [`${tag}-b`]);
      assert.deepEqual(await ids("secretthought"), [], "thinking is not searched");
      assert.deepEqual(await ids("no such words anywhere"), []);
    });

    test("wildcard characters in the query are literal, and long queries work", async () => {
      const ids = async (q) =>
        (await call(open, "GET", `/v1/chats?q=${encodeURIComponent(q)}`)).json.chats.map((c) => c.id);
      assert.deepEqual(await ids("100%"), [`${tag}-b`]);
      assert.deepEqual(await ids("sure_please"), [`${tag}-b`]);
      assert.deepEqual(await ids("%%%"), []);
      assert.deepEqual(await ids("_".repeat(60)), []);
      assert.deepEqual(await ids(`about nine minutes for a zebra-hard yolk. ${"x".repeat(150)}`), []);
      assert.deepEqual(await ids("about nine minutes for a zebra-hard yolk."), [`${tag}-b`]);
    });

    test("overlong queries are rejected", async () => {
      assertApiError(await call(open, "GET", `/v1/chats?q=${"a".repeat(201)}`), 400, "bad_request");
    });
  });

  describe("export", () => {
    test("renders markdown with thinking in a collapsed block", async () => {
      const chat = await createChat(open, { title: "Export: Ünïcode & Spaces!" });
      const t = await turn(open, chat.id, { content: "show me code", think: true });
      assert.equal(kinds(t.events).at(-1), "done");

      const res = await fetch(`${open.url}/v1/chats/${chat.id}/export`);
      assert.equal(res.status, 200);
      assert.equal(res.headers.get("content-type"), "text/markdown; charset=utf-8");
      assert.equal(res.headers.get("content-disposition"), 'attachment; filename="export-unicode-spaces.md"');
      assertSecurityHeaders(res.headers);
      const md = await res.text();
      assert.match(md, /^# Export: Ünïcode & Spaces!\n/);
      assert.match(md, /## You\n\nshow me code\n/);
      assert.match(md, /<details>\n<summary>Thinking<\/summary>\n\nThe user wrote 12 characters\. I will answer briefly\.\n\n<\/details>/);
      assert.match(md, /```python\ndef greet/);
      assert.match(md, /7\.3 tok\/s/);
    });

    test("falls back to chat.md when the title has no ASCII letters", async () => {
      const chat = await createChat(open, { title: "日本語" });
      const res = await fetch(`${open.url}/v1/chats/${chat.id}/export`);
      assert.equal(res.headers.get("content-disposition"), 'attachment; filename="chat.md"');
      assert.match(await res.text(), /^# 日本語\n/);
      assertApiError(await call(open, "GET", "/v1/chats/missing-chat/export"), 404, "not_found");
    });
  });

  describe("import", () => {
    const tag = `i${Date.now()}`;
    const payload = {
      chats: [
        {
          id: `${tag}-one`,
          title: "  Imported   one ",
          created_at: "2025-05-01T10:00:00Z",
          updated_at: "2025-05-01T11:00:00Z",
          messages: [
            { role: "user", content: "first question", created_at: "2025-05-01T10:00:00Z" },
            { role: "assistant", content: "first answer", thinking: "pondering", created_at: "2025-05-01T10:01:00Z" },
            { role: "user", content: "second question" },
            { role: "assistant", content: "", thinking: "only thoughts" },
          ],
        },
        { id: `${tag}-two`, title: "two", created_at: "2025-05-02T10:00:00Z", updated_at: "2025-05-02T10:00:00Z", messages: [] },
      ],
    };

    test("imports chats with their messages in order", async () => {
      const res = await call(open, "POST", "/v1/import", { body: payload });
      assert.equal(res.status, 200, res.text);
      assert.deepEqual(res.json, { imported: 2, skipped: 0 });

      const { chat, messages } = await getChat(open, `${tag}-one`);
      assert.deepEqual(chat, {
        id: `${tag}-one`,
        title: "Imported one",
        created_at: "2025-05-01T10:00:00.000Z",
        updated_at: "2025-05-01T11:00:00.000Z",
        message_count: 4,
      });
      assert.deepEqual(
        messages.map(({ role, content, thinking, status, stats, created_at }) => ({ role, content, thinking, status, stats, created_at })),
        [
          { role: "user", content: "first question", thinking: null, status: "complete", stats: null, created_at: "2025-05-01T10:00:00.000Z" },
          { role: "assistant", content: "first answer", thinking: "pondering", status: "complete", stats: null, created_at: "2025-05-01T10:01:00.000Z" },
          { role: "user", content: "second question", thinking: null, status: "complete", stats: null, created_at: "2025-05-01T10:00:00.000Z" },
          { role: "assistant", content: "", thinking: "only thoughts", status: "complete", stats: null, created_at: "2025-05-01T10:00:00.000Z" },
        ],
      );
      assert.ok(messages.every((m, i) => i === 0 || m.id > messages[i - 1].id));
    });

    test("is idempotent: existing chat ids are skipped entirely", async () => {
      const before = await getChat(open, `${tag}-one`);
      const res = await call(open, "POST", "/v1/import", { body: payload });
      assert.deepEqual(res.json, { imported: 0, skipped: 2 });
      assert.deepEqual(await getChat(open, `${tag}-one`), before);

      const mixed = await call(open, "POST", "/v1/import", {
        body: {
          chats: [
            { id: `${tag}-three`, title: "", messages: [{ role: "user", content: "x" }] },
            { id: `${tag}-three`, title: "dup in payload", messages: [] },
            payload.chats[1],
          ],
        },
      });
      assert.deepEqual(mixed.json, { imported: 1, skipped: 2 });
      const three = await getChat(open, `${tag}-three`);
      assert.equal(three.chat.title, "");
      assert.equal(three.messages.length, 1);
      assert.equal(three.chat.created_at, three.chat.updated_at);
    });

    test("handles large imports across many batches", async () => {
      const big = {
        id: `${tag}-big`,
        title: "big",
        created_at: "2025-06-01T00:00:00Z",
        updated_at: "2025-06-01T00:00:00Z",
        messages: Array.from({ length: 900 }, (_, i) => ({
          role: i % 2 ? "assistant" : "user",
          content: `message ${i} ${"lorem ipsum ".repeat(20)}`,
          thinking: i % 2 ? `thought ${i}` : undefined,
        })),
      };
      const small = Array.from({ length: 60 }, (_, i) => ({
        id: `${tag}-small-${i}`,
        title: `small ${i}`,
        created_at: "2025-06-02T00:00:00Z",
        updated_at: "2025-06-02T00:00:00Z",
        messages: Array.from({ length: 30 }, (_, j) => ({ role: j % 2 ? "assistant" : "user", content: `s${i}m${j}` })),
      }));
      const res = await call(open, "POST", "/v1/import", { body: { chats: [big, ...small] } });
      assert.equal(res.status, 200, res.text);
      assert.deepEqual(res.json, { imported: 61, skipped: 0 });

      const { chat, messages } = await getChat(open, `${tag}-big`);
      assert.equal(chat.message_count, 900);
      assert.equal(messages.length, 900);
      assert.deepEqual(messages.map((m) => Number(m.content.split(" ")[1])), [...Array(900).keys()]);
      assert.equal(messages[899].thinking, "thought 899");
      const last = await getChat(open, `${tag}-small-59`);
      assert.deepEqual(last.messages.map((m) => m.content), Array.from({ length: 30 }, (_, j) => `s59m${j}`));
    });

    test("validates the payload", async () => {
      const cases = [
        [{}, 400],
        [{ chats: {} }, 400],
        [{ chats: [null] }, 400],
        [{ chats: [{ id: "bad id", messages: [] }] }, 400],
        [{ chats: [{ id: `${tag}-v`, messages: "nope" }] }, 400],
        [{ chats: [{ id: `${tag}-v`, messages: [{ role: "system", content: "x" }] }] }, 400],
        [{ chats: [{ id: `${tag}-v`, messages: [{ role: "user", content: 5 }] }] }, 400],
        [{ chats: [{ id: `${tag}-v`, created_at: "yesterday-ish", messages: [] }] }, 400],
        [{ chats: [{ id: `${tag}-v`, title: 9, messages: [] }] }, 400],
        [{ chats: [{ id: `${tag}-v`, messages: [{ role: "user", content: "x".repeat(100_001) }] }] }, 413],
        [{ chats: Array.from({ length: 101 }, (_, i) => ({ id: `${tag}-n${i}`, messages: [] })) }, 413],
      ];
      for (const [body, status] of cases) {
        const res = await call(open, "POST", "/v1/import", { body });
        assertApiError(res, status, status === 413 ? "too_large" : "bad_request");
      }
      assertApiError(await call(open, "GET", `/v1/chats/${tag}-v`), 404, "not_found");
    });
  });

  describe("stop from another device", () => {
    test("with nothing running it reports that nothing was stopped", async () => {
      const res = await call(open, "POST", "/v1/stop");
      assert.equal(res.status, 200, res.text);
      assert.deepEqual(res.json, { stopped: false, busy: null });
    });

    test("cuts a streaming reply: partial saved as stopped, done carries stopped_by, GPU freed", async () => {
      open.mock.configure({ fillerTokens: 3000, tokenDelayMs: 5 });
      const chat = await createChat(open, { title: "stop me" });
      const callsBefore = open.mock.stats();
      let stopCall = null;
      const reply = await turn(open, chat.id, { content: "go long", think: false }, {
        onEvent: (event, events) => {
          if (!stopCall && events.filter((e) => e.event === "content").length === 20) {
            stopCall = call(open, "POST", "/v1/stop");
          }
        },
      });
      const stop = await stopCall;
      assert.equal(stop.json.stopped, true);
      assert.equal(stop.json.busy.chat_id, chat.id);

      assertEventShape(reply.events, "done");
      const done = reply.events.at(-1);
      assert.equal(done.stopped_by, "another_device");
      assert.equal(done.message.status, "stopped");
      assert.ok(done.message.content.length < 3000 * 6, "generation stopped early");
      assert.ok(done.message.content.startsWith(textOf(reply.events, "content")));

      await waitForLockRelease(open);
      await waitFor(() => open.mock.stats().aborted > callsBefore.aborted, { what: "the upstream request to be aborted" });
      const { messages } = await getChat(open, chat.id);
      assert.equal(messages.at(-1).status, "stopped");
    });

    test("scoped stop ignores another generation or chat and cancels only the matching live request", async () => {
      open.mock.configure({ fillerTokens: 3000, tokenDelayMs: 5 });
      const chat = await createChat(open, { title: "scoped stop" });
      let generationId, actions, actionError;
      const reply = await turn(open, chat.id, { content: "keep writing until my exact request is stopped", think: false }, {
        onEvent: (event, events) => {
          if (event.event === "start") {
            generationId = event.generation_id;
            assert.match(generationId, /^[a-f0-9-]{36}$/);
          }
          if (!actions && events.filter(item => item.event === "content").length === 20) {
            actions = (async () => {
              const oldRequest = await call(open, "POST", "/v1/stop", { body: { generation_id: "00000000-0000-0000-0000-000000000000", chat_id: chat.id } });
              assert.equal(oldRequest.status, 200);assert.equal(oldRequest.json.stopped, false);assert.equal(oldRequest.json.busy.chat_id, chat.id);
              const wrongChat = await call(open, "POST", "/v1/stop", { body: { generation_id: generationId, chat_id: "another-chat" } });
              assert.equal(wrongChat.status, 200);assert.equal(wrongChat.json.stopped, false);
              const exactRequest = await call(open, "POST", "/v1/stop", { body: { generation_id: generationId, chat_id: chat.id } });
              assert.equal(exactRequest.status, 200);assert.equal(exactRequest.json.stopped, true);
            })().catch(error => { actionError = error; });
          }
        },
      });
      await actions;if (actionError) throw actionError;
      assert.equal(reply.events.at(-1).event, "done");assert.equal(reply.events.at(-1).message.status, "stopped");
      await waitForLockRelease(open);
    });

    test("before the first token: the stream ends with error code stopped and nothing is saved", async () => {
      open.mock.failNext(524, 1000);
      const chat = await createChat(open);
      let stopCall = null;
      const reply = await turn(open, chat.id, { content: "never mind", think: false }, {
        onEvent: (event) => {
          if (event.event === "status" && !stopCall) stopCall = call(open, "POST", "/v1/stop");
        },
      });
      assert.equal((await stopCall).json.stopped, true);
      assertEventShape(reply.events, "error");
      assert.equal(reply.events.at(-1).code, "stopped");
      assert.equal(reply.events.at(-1).message_saved, null);
      await waitForLockRelease(open);
      const { messages } = await getChat(open, chat.id);
      assert.deepEqual(messages.map((m) => m.role), ["user"]);
    });

    test("clears a lock left behind by a dead reply", async () => {
      const chat = await createChat(open);
      await plantLock(open, { chatId: chat.id, heartbeatAgeMs: 10 * 60_000 });
      const stop = await call(open, "POST", "/v1/stop");
      assert.equal(stop.json.stopped, true);
      assert.equal(stop.json.busy.chat_id, chat.id);
      const reply = await turn(open, chat.id, { content: "free again", think: false });
      assert.equal(kinds(reply.events).at(-1), "done");
    });
  });

  describe("continue a reply that stopped early", () => {
    /** Starts a reply and cuts it off after `tokens` tokens, the way a dropped run ends. */
    async function cutOff(chat, { think, tokens }) {
      open.mock.configure({ errorAfterTokens: tokens });
      const res = await turn(open, chat.id, { content: "explain recursion", think });
      open.mock.configure({ errorAfterTokens: null });
      const saved = res.events.at(-1).message_saved;
      assert.equal(saved.status, "error");
      return saved;
    }

    async function continueTurn(chatId) {
      const res = await fetch(`${open.url}/v1/chats/${chatId}/continue`, { method: "POST" });
      if (!(res.headers.get("content-type") ?? "").includes("ndjson")) {
        return { status: res.status, headers: res.headers, json: await res.json(), events: [] };
      }
      const events = [];
      for await (const event of readEvents(res.body)) events.push(event);
      return { status: res.status, events };
    }

    test("mid-reasoning: picks the reasoning up where it stopped, then answers, in the same message", async () => {
      const chat = await createChat(open);
      const partial = await cutOff(chat, { think: true, tokens: 3 });
      assert.ok(partial.thinking && !partial.content, "cut off while still reasoning");

      const res = await continueTurn(chat.id);
      assert.equal(res.status, 200);
      assert.equal(res.events[0].event, "start");
      assert.equal(res.events[0].continued_message.id, partial.id);
      assert.equal(textOf(res.events, "thinking"), " and so on.");
      assert.equal(textOf(res.events, "content"), "Continued answer.");
      const done = res.events.at(-1);
      assert.equal(done.event, "done");
      assert.equal(done.message.id, partial.id, "the same message is continued, not a new one");
      assert.equal(done.message.thinking, partial.thinking + " and so on.");
      assert.equal(done.message.content, "Continued answer.");
      assert.equal(done.message.status, "complete");

      const sent = open.mock.lastGenerate();
      assert.equal(sent.raw, true);
      assert.equal(sent.options.num_ctx, 24576);
      assert.ok(sent.prompt.startsWith("<|im_start|>system\nReasoning effort is set to xhigh."), sent.prompt.slice(0, 80));
      assert.ok(sent.prompt.includes("<|im_start|>user\nexplain recursion<|im_end|>\n"));
      assert.ok(sent.prompt.endsWith(`<|im_start|>assistant\n<think>\n${partial.thinking}`), JSON.stringify(sent.prompt.slice(-120)));

      const { messages, chat: after } = await getChat(open, chat.id);
      assert.equal(messages.length, 2);
      assert.equal(after.message_count, 2);
      await waitForLockRelease(open);
    });

    test("carries on at the asked reasoning effort: low adds the template's brief-thinking line, medium adds none", async () => {
      const chat = await createChat(open);
      for (const [think, opening] of [
        ["low", "<|im_start|>system\nReasoning effort is set to low. Keep your thinking brief"],
        ["medium", "<|im_start|>user\nexplain recursion"],
      ]) {
        await cutOff(chat, { think, tokens: 3 });
        const res = await fetch(`${open.url}/v1/chats/${chat.id}/continue`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ think }),
        });
        for await (const _ of readEvents(res.body));
        assert.ok(open.mock.lastGenerate().prompt.startsWith(opening), `${think}: ${open.mock.lastGenerate().prompt.slice(0, 90)}`);
        await waitForLockRelease(open);
      }
      const bad = await fetch(`${open.url}/v1/chats/${chat.id}/continue`, { method: "POST", body: JSON.stringify({ think: "xhigh" }) });
      assert.equal(bad.status, 400);

      // Turns pass the effort to Ollama as its think level (the template reads it as reasoning_effort).
      const quick = await turn(open, chat.id, { content: "a quick one", think: "low" });
      assert.equal(kinds(quick.events).at(-1), "done");
      assert.equal(open.mock.lastChat().think, "low");
      assert.equal(open.mock.lastChat().options.num_predict, 2048, "the selected effort uses a bounded work window");
      assertApiError(await callTurn(turn(open, chat.id, { content: "nope", think: "xhigh" })), 400, "bad_request");
      await waitForLockRelease(open);
    });

    test("mid-answer: closes the reasoning and carries on with the answer", async () => {
      const chat = await createChat(open);
      const partial = await cutOff(chat, { think: false, tokens: 4 });
      assert.ok(partial.content && !partial.thinking);
      const res = await continueTurn(chat.id);
      assert.equal(textOf(res.events, "content"), " continued answer.");
      assert.equal(textOf(res.events, "thinking"), "");
      assert.equal(res.events.at(-1).message.content, partial.content + " continued answer.");
      assert.ok(open.mock.lastGenerate().prompt.endsWith(`<|im_start|>assistant\n<think>\n\n</think>\n\n${partial.content}`));
      await waitForLockRelease(open);
    });

    test("only a cut-off last reply can be continued", async () => {
      const chat = await createChat(open);
      assertApiError(await callTurn(continueTurn(chat.id)), 400, "bad_request");
      await turn(open, chat.id, { content: "hi", think: false });
      assertApiError(await callTurn(continueTurn(chat.id)), 400, "bad_request");
      assertApiError(await callTurn(continueTurn("no-such-chat")), 404, "not_found");
    });

    test("Stop while continuing keeps what was added, marked stopped", async () => {
      const chat = await createChat(open);
      const partial = await cutOff(chat, { think: false, tokens: 4 });
      open.mock.configure({ fillerTokens: 3000, tokenDelayMs: 5 });
      const controller = new AbortController();
      const res = await fetch(`${open.url}/v1/chats/${chat.id}/continue`, { method: "POST", signal: controller.signal });
      let received = 0;
      try {
        for await (const event of readEvents(res.body)) {
          if (event.event === "content" && ++received === 20) controller.abort();
        }
      } catch {
        // aborted on purpose
      }
      await waitForLockRelease(open);
      const { messages } = await getChat(open, chat.id);
      assert.equal(messages.length, 2);
      assert.equal(messages[1].status, "stopped");
      assert.ok(messages[1].content.startsWith(partial.content + " continued answer."));
    });
  });

  describe("live replies (following from another device)", () => {
    test("GET /live mirrors the reply while it streams and is empty before and after", async () => {
      open.mock.configure({ fillerTokens: 1500, tokenDelayMs: 4 });
      const chat = await createChat(open, { title: "follow me" });
      const other = await createChat(open, { title: "elsewhere" });
      assert.deepEqual((await call(open, "GET", `/v1/chats/${chat.id}/live`)).json, { live: null });

      const seen = [];
      let watcher = null;
      const reply = await turn(open, chat.id, { content: "talk for a while", think: true }, {
        onEvent: (event, events) => {
          if (!watcher && events.filter((e) => e.event === "content").length === 30) {
            watcher = (async () => {
              for (let i = 0; i < 6; i++) {
                seen.push((await call(open, "GET", `/v1/chats/${chat.id}/live`)).json.live);
                await delay(300);
              }
              return (await call(open, "GET", `/v1/chats/${other.id}/live`)).json.live;
            })();
          }
        },
      });
      const otherChat = await watcher;
      const done = reply.events.at(-1);
      assert.equal(done.event, "done");

      const snapshots = seen.filter(Boolean);
      assert.ok(snapshots.length >= 2, `expected live snapshots, got ${JSON.stringify(seen).slice(0, 200)}`);
      const first = snapshots[0];
      assert.equal(first.chat_id, chat.id);
      assert.equal(first.user_message_id, reply.events[0].user_message.id);
      assert.equal(first.owner, undefined, "the owner token is not exposed");
      const latest = snapshots.at(-1);
      assert.ok(latest.thinking.length > 0, `thinking is mirrored: ${JSON.stringify(latest).slice(0, 300)}`);
      assert.equal(latest.state, "answering");
      assert.ok(done.message.content.startsWith(snapshots.at(-1).content), "live content is a prefix of the final reply");
      assert.ok(snapshots.at(-1).content.length >= first.content.length, "content only grows");
      assert.equal(otherChat, null, "other chats show nothing");

      await waitForLockRelease(open);
      assert.deepEqual((await call(open, "GET", `/v1/chats/${chat.id}/live`)).json, { live: null });
    });
  });

  describe("start from the page (Kaggle)", () => {
    const start = () => call(open, "POST", "/v1/server/start");
    const pushedToken = () => /LAUNCH_TOKEN = "([A-Za-z0-9_-]+)"/.exec(open.mock.kagglePushes().at(-1).text)[1];
    afterEach(async () => {
      await open.sql("DELETE FROM state WHERE k IN ('launch', 'launches', 'boot', 'kaggle_fit', 'kaggle_sessions', 'server_idle')");
      open.mock.resetKaggle();
      open.mock.setDown(false);
      await register(open, open.mock.url);
    });

    test("never while a server is up; needs the Kaggle token set up", async () => {
      assertApiError(await start(), 409, "running");
      assert.equal(open.mock.kagglePushes().length, 0);
      assertApiError(await call(keyed, "POST", "/v1/server/start", { headers: withKey }), 409, "not_configured");
      assert.equal((await call(keyed, "GET", "/v1/status", { headers: withKey })).json.can_start, false);
    });

    test("pushes the server script as a private GPU T4 x2 run with a launch token, then shows it queued", async () => {
      open.mock.setDown(true);
      const started = await start();
      assert.equal(started.status, 200, started.text);
      assert.equal(started.json.url, "https://www.kaggle.com/code/tester/heretic-qwen-server");
      const { text, ...push } = open.mock.kagglePushes().at(-1);
      assert.deepEqual(push, {
        slug: "tester/heretic-qwen-server",
        newTitle: "Heretic Qwen Server",
        language: "python",
        kernelType: "script",
        isPrivate: true,
        enableGpu: true,
        enableInternet: true,
        machineShape: "NvidiaTeslaT4",
        kernelExecutionType: "SAVE_AND_RUN_ALL",
        datasetDataSources: [],
        kernelDataSources: [],
        competitionDataSources: [],
        modelDataSources: [],
        categoryIds: [],
      });
      assert.match(text, /^RELAY = "http:\/\/(127\.0\.0\.1|localhost):8800"$/m);
      assert.match(text, /^QUANT = "Q5_K_P"$/m);
      assert.ok(!/__[A-Z_]+__/.test(text), "every placeholder is filled in");
      assert.ok(!text.includes(RELAY_KEY), "the relay key never goes to Kaggle");

      const status = (await call(open, "GET", "/v1/status")).json;
      assert.equal(status.boot.stage, "queued");
      assert.equal(status.kaggle_url, "https://www.kaggle.com/code/tester/heretic-qwen-server");
      assertApiError(await start(), 409, "starting");
    });

    test("the launch token covers the notebook's own calls only, until it expires", async () => {
      open.mock.setDown(true);
      await start();
      const as = { "x-launch-token": pushedToken() };
      const progress = (headers) => call(open, "POST", "/_relay/progress", { body: { host: "kaggle", stage: "downloading", percent: 10 }, headers });
      assert.equal((await progress(as)).status, 200);
      assert.equal((await progress({ "x-launch-token": pushedToken() + "x" })).status, 401);
      assert.equal((await call(open, "GET", "/_relay/status", { headers: as })).status, 401);
      assert.equal((await call(open, "GET", "/api/tags", { headers: as })).status, 401);

      open.mock.setDown(false);
      const body = { target: open.mock.url, host: "kaggle", num_ctx: 65536, vision: true, quant: "Q5_K_P", control: true };
      const registered = await call(open, "POST", "/_relay/register", { body, headers: as });
      assert.equal(registered.status, 200, registered.text);
      const command = await call(open, "GET", `/_relay/command?target=${encodeURIComponent(open.mock.url)}`, { headers: as });
      assert.equal(command.json.registered, true);
      assert.equal((await call(open, "POST", "/_relay/unregister", { body: { target: open.mock.url }, headers: as })).json.removed, true);

      await open.sql("UPDATE state SET v = json_set(v, '$.expires_at', '2000-01-01T00:00:00.000Z') WHERE k = 'launch'");
      assert.equal((await progress(as)).status, 401);
    });

    test("a run Kaggle stops before it starts shows as failed, and can be started again", async () => {
      open.mock.setDown(true);
      await start();
      open.mock.setKaggleStatus("ERROR", "Your notebook has no GPU quota left this week.");
      await delay(30_000 * TIMING_SCALE + 200); // Kaggle is asked at most every 30 s
      const { boot } = (await call(open, "GET", "/v1/status")).json;
      assert.deepEqual([boot.stage, boot.detail], ["failed", "Your notebook has no GPU quota left this week."]);
      await open.sql("DELETE FROM state WHERE k = 'launches'"); // past the few-minute gap
      assert.equal((await start()).status, 200);
    });

    test("later starts begin at the memory size that fitted last time with the same profile", async () => {
      open.mock.setDown(true);
      await start();
      assert.match(open.mock.kagglePushes().at(-1).text, /^CONTEXTS = \[131072,98304,81920,65536,49152,32768,24576\]$/m);
      assert.match(open.mock.kagglePushes().at(-1).text, /^KNOWN_VISION = None$/m, "first run: checks pictures");
      const as = { "x-launch-token": pushedToken() };
      open.mock.setDown(false);
      const body = { target: open.mock.url, host: "kaggle", num_ctx: 65536, vision: true, quant: "Q5_K_P", control: true, num_batch: 512, profile_id: "unversioned:Q5_K_P:kv-q8_0:b512:t4x2" };
      assert.equal((await call(open, "POST", "/_relay/register", { body, headers: as })).status, 200);
      await call(open, "POST", "/_relay/unregister", { body: { target: open.mock.url }, headers: as });
      open.mock.setDown(true);
      await open.sql("DELETE FROM state WHERE k IN ('launch', 'launches', 'boot')");
      assert.equal((await start()).status, 200);
      assert.match(open.mock.kagglePushes().at(-1).text, /^CONTEXTS = \[65536,49152,32768,24576\]$/m);
      assert.match(open.mock.kagglePushes().at(-1).text, /^KNOWN_VISION = True$/m, "pictures worked last time: no check");
    });

    test("a run Kaggle still queues isn't started twice, even when the page lost track of it", async () => {
      open.mock.setDown(true);
      await start();
      await open.sql("DELETE FROM state WHERE k IN ('boot', 'launches')");
      open.mock.setKaggleStatus("QUEUED");
      assertApiError(await start(), 409, "starting");
      assert.equal(open.mock.kagglePushes().length, 1);
      assert.equal((await call(open, "GET", "/v1/status")).json.boot.stage, "queued");
    });

    test("the server log: a finished run's stored log, a running one's live stream; tunnel addresses hidden", async () => {
      const none = await call(open, "GET", "/v1/server/log?host=kaggle");
      assert.equal(none.status, 200, none.text);
      const { host, source, run_id, updated_at, ...emptyLog } = none.json;
      assert.deepEqual(emptyLog, { log: "", truncated: false, status: null, failure: null, url: null, started_at: null });
      assert.equal(host, "kaggle");

      open.mock.setDown(true);
      await start();
      open.mock.setKaggleStatus("COMPLETE");
      open.mock.setKaggleLog(
        JSON.stringify([
          { stream_name: "stdout", time: 1.2, data: "05:41:57 Heretic Qwen server starting on Kaggle\n" },
          { stream_name: "stdout", time: 340.5, data: "05:47:36 READY at https://abc-def-ghi.trycloudflare.com: 64K context\n" },
          // What Kaggle appends after the run (rendering it with nbconvert): left out of the log.
          { stream_name: "stderr", time: 9000, data: "/usr/local/lib/python3.13/dist-packages/mistune.py:435: SyntaxWarning: invalid escape sequence '\\|'\n" },
          { stream_name: "stderr", time: 9000, data: "  cells[i][c] = re.sub('\\\\\\\\\\|', '|', cell)\n" },
          { stream_name: "stderr", time: 9001, data: "[NbConvertApp] Converting notebook __script__.ipynb to html\n" },
        ]),
      );
      const finished = (await call(open, "GET", "/v1/server/log")).json;
      assert.equal(finished.log, "05:41:57 Heretic Qwen server starting on Kaggle\n05:47:36 READY at [tunnel address hidden]: 64K context");
      assert.deepEqual([finished.status, finished.truncated, finished.url], ["COMPLETE", false, "https://www.kaggle.com/code/tester/heretic-qwen-server"]);

      const cached = (await call(open, "GET", "/v1/server/log?host=kaggle")).json;
      assert.equal(cached.log, finished.log);
      assert.equal(cached.source, "kaggle");

      open.mock.setKaggleLog("");
      open.mock.setKaggleStatus("RUNNING");
      assert.equal((await call(open, "GET", "/v1/server/log")).json.log, "live line 1\nlive line 2");
      const again = (await call(open, "GET", "/v1/server/log?host=kaggle")).json;
      assert.equal(again.log, cached.log, "frequent inline polls reuse the recent fallback fetch");
      assert.equal(again.updated_at, cached.updated_at, "the timestamp reflects the fetch, not a cached poll");
      assertApiError(await call(keyed, "GET", "/v1/server/log", { headers: withKey }), 409, "not_configured");
    });

    test("GPU hours this week: a run counts from its first report to its sign-off", async () => {
      const day = 24 * 3600_000;
      const iso = (ago) => new Date(Date.now() - ago).toISOString();
      // Two hours three days ago, and one run from last month that no longer counts.
      const list = [{ start: iso(3 * day), end: iso(3 * day - 2 * 3600_000) }, { start: iso(30 * day), end: iso(30 * day - 3600_000) }];
      await open.sql(`INSERT INTO state (k, v, updated_at) VALUES ('kaggle_sessions', '${JSON.stringify({ list })}', '${iso(0)}')`);
      assert.equal((await call(open, "GET", "/v1/status")).json.gpu_hours_week, 2);

      await call(open, "POST", "/_relay/progress", { body: { host: "kaggle", stage: "installing" }, headers: withKey });
      await delay(1200);
      const running = (await call(open, "GET", "/v1/status")).json.gpu_hours_week;
      assert.ok(running >= 2 && running < 2.1, String(running));
      await registerKaggle(open);
      await call(open, "POST", "/_relay/unregister", { body: { target: open.mock.url }, headers: withKey });
      const stored = JSON.parse((await open.sql("SELECT v FROM state WHERE k = 'kaggle_sessions'"))[0].v).list;
      assert.equal(stored.length, 2, "runs older than two weeks are dropped");
      assert.ok(stored.every((s) => s.end), "the sign-off closed the run");
    });

    test("the idle countdown follows the notebook's own report", async () => {
      await registerKaggle(open);
      try {
        const target = encodeURIComponent(open.mock.url);
        assert.equal((await call(open, "GET", "/v1/status")).json.idle_shutdown_at, null, "nothing reported yet");
        await call(open, "GET", `/_relay/command?target=${target}&idle=600`, { headers: withKey });
        const at = Date.parse((await call(open, "GET", "/v1/status")).json.idle_shutdown_at);
        const expected = Date.now() + (45 * 60 - 600) * 1000;
        assert.ok(Math.abs(at - expected) < 5000, `${new Date(at).toISOString()} vs ${new Date(expected).toISOString()}`);
        await call(open, "PUT", "/v1/settings", { body: { idle_minutes: 0 } });
        assert.equal((await call(open, "GET", "/v1/status")).json.idle_shutdown_at, null, "never shuts down when idle");
      } finally {
        await call(open, "PUT", "/v1/settings", { body: { idle_minutes: null } });
        await register(open, open.mock.url);
      }
    });

    test("at most 8 starts a day", async () => {
      open.mock.setDown(true);
      const hourAgo = new Date(Date.now() - 3600_000).toISOString();
      const launches = JSON.stringify(Array(8).fill(hourAgo));
      await open.sql(`INSERT INTO state (k, v, updated_at) VALUES ('launches', '${launches}', '${hourAgo}')`);
      assertApiError(await start(), 429, "too_many");
    });
  });

  describe("attachments", () => {
    test("are sent to the model as tagged file blocks and saved with the message", async () => {
      const chat = await createChat(open);
      const files = [
        { name: "C:\\work\\app.py", type: "text/x-python", text: "print('hi')\n" },
        { name: "notes.txt", text: 'He said "ok"' },
      ];
      const reply = await turn(open, chat.id, { content: "What do these do?", think: false, attachments: files });
      assert.equal(kinds(reply.events).at(-1), "done");

      const userMessage = reply.events[0].user_message;
      assert.deepEqual(userMessage.attachments, [
        { name: "app.py", type: "text/x-python", size: 12, text: "print('hi')\n" },
        { name: "notes.txt", type: "", size: 12, text: 'He said "ok"' },
      ]);
      const sent = open.mock.lastChat().messages.at(-1).content;
      assert.ok(sent.startsWith("What do these do?\n\nAttached files (2):"), sent);
      assert.ok(sent.includes(`<file name="app.py">\nprint('hi')\n\n</file>`), sent);
      assert.ok(sent.includes(`<file name="notes.txt">\nHe said "ok"\n</file>`), sent);

      const { messages } = await getChat(open, chat.id);
      assert.equal(messages[0].attachments.length, 2);
      assert.deepEqual(messages[1].attachments, []);

      // Later turns still carry the file in the conversation history.
      await turn(open, chat.id, { content: "And line 1?", think: false });
      assert.ok(open.mock.lastChat().messages.some((m) => m.content.includes(`<file name="app.py">`)));

      const exported = await call(open, "GET", `/v1/chats/${chat.id}/export`);
      assert.ok(exported.text.includes("<summary>Attached: app.py</summary>"), exported.text);
    });

    test("a message can be just files; the chat is titled after the first one", async () => {
      const chat = await createChat(open);
      const reply = await turn(open, chat.id, { content: "", think: false, attachments: [{ name: "server.log", text: "ERROR boom" }] });
      assert.equal(kinds(reply.events).at(-1), "done");
      assert.equal(reply.events.at(-1).chat.title, "server.log");
      assert.ok(open.mock.lastChat().messages.at(-1).content.startsWith("Attached file:"));
    });

    test("pictures go alongside the text to a server that can see them; others refuse them", async () => {
      const chat = await createChat(open);
      const picture = { name: "cat.jpg", type: "image/jpeg", data: TINY_JPEG };
      const refused = await callTurn(turn(open, chat.id, { content: "What is this?", think: false, attachments: [picture] }));
      assertApiError(refused, 409, "no_vision");

      await registerKaggle(open);
      try {
        const reply = await turn(open, chat.id, {
          content: "What is this?",
          think: false,
          attachments: [picture, { name: "notes.txt", text: "a note" }],
        });
        assert.equal(kinds(reply.events).at(-1), "done");
        assert.deepEqual(reply.events[0].user_message.attachments[0], { name: "cat.jpg", type: "image/jpeg", size: 15, data: TINY_JPEG });
        const sent = open.mock.lastChat().messages.at(-1);
        assert.deepEqual(sent.images, [TINY_JPEG]);
        assert.ok(sent.content.startsWith("What is this?\n\n[Picture attached: cat.jpg]\n\nAttached file:"), sent.content);

        // Later turns send the picture again while the server can see it.
        await turn(open, chat.id, { content: "And the colour?", think: false });
        assert.deepEqual(open.mock.lastChat().messages.find((m) => m.images)?.images, [TINY_JPEG]);
      } finally {
        await register(open, open.mock.url);
      }
      // A text-only server gets the picture's name only.
      await turn(open, chat.id, { content: "Text only now", think: false });
      const history = open.mock.lastChat().messages;
      assert.ok(history.every((m) => !m.images));
      assert.ok(history.some((m) => m.content.includes("[Picture attached: cat.jpg]")));

      const exported = await call(open, "GET", `/v1/chats/${chat.id}/export`);
      assert.ok(exported.text.includes(`![cat.jpg](data:image/jpeg;base64,${TINY_JPEG})`), exported.text);
    });

    test("picture validation", async () => {
      await registerKaggle(open);
      try {
        const chat = await createChat(open);
        const send = (attachments) => turn(open, chat.id, { content: "look", think: false, attachments });
        const jpeg = (name) => ({ name, type: "image/jpeg", data: TINY_JPEG });
        assertApiError(await callTurn(send([{ ...jpeg("a.gif"), type: "image/gif" }])), 400, "bad_request");
        assertApiError(await callTurn(send([{ ...jpeg("a.jpg"), data: "not base64!" }])), 400, "bad_request");
        assertApiError(await callTurn(send([{ ...jpeg("a.jpg"), data: 42 }])), 400, "bad_request");
        assertApiError(await callTurn(send(Array.from({ length: 5 }, (_, i) => jpeg(`p${i}.jpg`)))), 400, "bad_request");
        assertApiError(await callTurn(send([{ ...jpeg("huge.jpg"), data: "A".repeat(1_300_004) }])), 413, "too_large");
        await waitForLockRelease(open);
      } finally {
        await register(open, open.mock.url);
      }
    });

    test("validation", async () => {
      const chat = await createChat(open);
      const send = (attachments, content = "look") =>
        turn(open, chat.id, { content, think: false, attachments });
      assertApiError(await callTurn(send("not a list")), 400, "bad_request");
      assertApiError(await callTurn(send(Array.from({ length: 11 }, (_, i) => ({ name: `f${i}.txt`, text: "x" })))), 400, "bad_request");
      assertApiError(await callTurn(send([{ name: "big.txt", text: "x".repeat(120_001) }])), 413, "too_large");
      assertApiError(await callTurn(send([{ name: "", text: "x" }])), 400, "bad_request");
      assertApiError(await callTurn(send([{ name: "a.txt" }])), 400, "bad_request");
      assertApiError(await callTurn(send([], "")), 400, "bad_request");
      await waitForLockRelease(open);
    });
  });

  describe("settings", () => {
    const reset = () =>
      call(open, "PUT", "/v1/settings", {
        body: { system_prompt: null, temperature: null, max_reply_tokens: null, history_chars: null, idle_minutes: null, kaggle_url: null },
      });
    afterEach(reset);

    test("defaults, limits and partial updates; null resets one field", async () => {
      await reset();
      const initial = await call(open, "GET", "/v1/settings");
      assert.equal(initial.status, 200, initial.text);
      const defaults = { system_prompt: "", temperature: null, max_reply_tokens: null, history_chars: null, idle_minutes: null, kaggle_url: "" };
      assert.deepEqual(initial.json.settings, defaults);
      assert.deepEqual(initial.json.defaults, defaults);
      assert.equal(initial.json.limits.max_reply_tokens.max, 16384);

      const put = await call(open, "PUT", "/v1/settings", { body: { system_prompt: "  Be terse.  ", temperature: 0.456 } });
      assert.equal(put.status, 200, put.text);
      assert.deepEqual(put.json.settings, { ...defaults, system_prompt: "Be terse.", temperature: 0.46 });

      const partial = await call(open, "PUT", "/v1/settings", { body: { max_reply_tokens: 2048 } });
      assert.equal(partial.json.settings.system_prompt, "Be terse.", "fields not sent are kept");
      assert.equal(partial.json.settings.max_reply_tokens, 2048);

      const cleared = await call(open, "PUT", "/v1/settings", { body: { temperature: null } });
      assert.equal(cleared.json.settings.temperature, null);
      assert.deepEqual((await call(open, "GET", "/v1/settings")).json.settings, cleared.json.settings);
    });

    test("validation", async () => {
      assertApiError(await call(open, "PUT", "/v1/settings", { body: { colour: "red" } }), 400, "bad_request");
      assertApiError(await call(open, "PUT", "/v1/settings", { body: { temperature: 2.5 } }), 400, "bad_request");
      assertApiError(await call(open, "PUT", "/v1/settings", { body: { temperature: "hot" } }), 400, "bad_request");
      assertApiError(await call(open, "PUT", "/v1/settings", { body: { max_reply_tokens: 100 } }), 400, "bad_request");
      assertApiError(await call(open, "PUT", "/v1/settings", { body: { history_chars: 5000.5 } }), 400, "bad_request");
      assertApiError(await call(open, "PUT", "/v1/settings", { body: { system_prompt: 42 } }), 400, "bad_request");
      assertApiError(await call(open, "PUT", "/v1/settings", { body: { system_prompt: "x".repeat(8001) } }), 413, "too_large");
      assertApiError(await call(open, "PUT", "/v1/settings", { body: "[1,2]" }), 400, "bad_request");
    });

    test("the Kaggle link is kept as the notebook page (never the editor); idle shutdown reaches the notebook", async () => {
      const put = (body) => call(open, "PUT", "/v1/settings", { body });
      const set = await put({ kaggle_url: "  https://www.kaggle.com/code/someone/heretic-server/edit/run/123  ", idle_minutes: 0 });
      assert.equal(set.status, 200, set.text);
      assert.equal(set.json.settings.kaggle_url, "https://www.kaggle.com/code/someone/heretic-server");
      assert.equal(set.json.settings.idle_minutes, 0);
      assert.equal((await call(open, "GET", "/v1/config")).json.kaggle_url, "https://www.kaggle.com/code/someone/heretic-server");
      assert.equal((await call(open, "GET", "/v1/status")).json.kaggle_url, "https://www.kaggle.com/code/someone/heretic-server");
      const command = await call(open, "GET", `/_relay/command?target=${encodeURIComponent(open.mock.url)}`, { headers: withKey });
      assert.equal(command.json.idle_minutes, 0);

      assert.equal((await put({ idle_minutes: 120 })).json.settings.idle_minutes, 120);
      for (const bad of [{ kaggle_url: "kaggle.com/code/x/y" }, { kaggle_url: "https://www.kaggle.com.evil.example/code/x/y" }, { kaggle_url: 7 }, { idle_minutes: 5 }, { idle_minutes: 30.5 }]) {
        assertApiError(await put(bad), 400, "bad_request");
      }
      assert.equal((await put({ kaggle_url: "" })).json.settings.kaggle_url, "");
      assert.equal((await call(open, "GET", "/v1/config")).json.kaggle_url, null);
    });

    test("turns use them: system message first, overridden options, smaller history", async () => {
      await call(open, "PUT", "/v1/settings", {
        body: { system_prompt: "Answer like a pirate.", temperature: 0.3, max_reply_tokens: 1000, history_chars: 4000 },
      });
      const chat = await createChat(open);
      await turn(open, chat.id, { content: pad("old", 4500), think: false });
      await turn(open, chat.id, { content: "now", think: true });
      const sent = open.mock.lastChat();
      assert.deepEqual(sent.messages[0], { role: "system", content: "Answer like a pirate." });
      assert.equal(sent.messages.filter((m) => m.role === "system").length, 1);
      assert.deepEqual(sent.options, { ...THINK_OPTIONS, temperature: 0.3, num_predict: 1000 });
      // 4000 chars of history: the 4500-char first message no longer fits.
      assert.ok(!sent.messages.some((m) => m.content.startsWith("old")), "old turn trimmed by history_chars");
      assert.equal(sent.messages.at(-1).content, "now");
    });
  });

  describe("turn", () => {
    test("happy path: events, persistence, stats and the exact Ollama request", async () => {
      const chat = await createChat(open);
      const content = "   Hello\n\nthere,   model. Please explain recursion in one line.   ";
      const res = await turn(open, chat.id, { content, think: true });
      assert.equal(res.status, 200);
      assert.equal(res.headers.get("content-type"), "application/x-ndjson; charset=utf-8");
      assert.equal(res.headers.get("cache-control"), "no-store, no-transform");
      assert.equal(res.headers.get("x-accel-buffering"), "no");
      assertSecurityHeaders(res.headers);
      assertEventShape(res.events, "done");

      const [start] = res.events;
      assert.equal(start.user_message.role, "user");
      assert.equal(start.user_message.content, content);
      assert.equal(start.user_message.chat_id, chat.id);
      assert.equal(start.chat.title, "Hello there, model. Please explain recursion in one line.");
      assert.equal(start.chat.message_count, 1);

      const order = kinds(res.events);
      assert.ok(order.lastIndexOf("thinking") < order.indexOf("content"), "thinking streams before content");
      const done = res.events.at(-1);
      assert.equal(done.message.role, "assistant");
      assert.equal(done.message.status, "complete");
      assert.equal(done.message.content, textOf(res.events, "content"));
      assert.equal(done.message.thinking, textOf(res.events, "thinking"));
      assert.match(done.message.content, /^You said: "Hello there, model\. Please explain/);
      assert.equal(done.message.stats.tokens_per_sec, 7.3);
      // When the parts arrived: the first token, and the reasoning stretch with its token count.
      assert.equal(typeof done.message.stats.first_token_ms, "number");
      assert.equal(typeof done.message.stats.thinking_ms, "number");
      assert.ok(done.message.stats.thinking_tokens > 0);
      assert.equal(done.message.stats.think, true);
      assert.equal(done.message.stats.done_reason, "stop");
      assert.equal(done.message.stats.eval_count, res.events.filter((e) => e.event === "thinking" || e.event === "content").length);
      assert.ok(Number.isInteger(done.message.stats.prompt_eval_count));
      assert.ok(Number.isInteger(done.message.stats.total_ms));
      assert.equal(done.chat.message_count, 2);
      assert.ok(done.chat.updated_at >= start.chat.updated_at);

      const stored = await getChat(open, chat.id);
      assert.deepEqual(stored.messages, [start.user_message, done.message]);
      assert.deepEqual(stored.chat, done.chat);

      assert.deepEqual(open.mock.lastChat(), {
        model: "qwen3.8-hauhau",
        messages: [{ role: "user", content }],
        stream: true,
        truncate: false,
        shift: false,
        think: true,
        keep_alive: -1,
        options: THINK_OPTIONS,
      });
      assert.equal((await call(open, "GET", "/v1/status")).json.busy, null);
    });

    test("think=false sends the fast options and streams no thinking", async () => {
      const chat = await createChat(open, { title: "kept title" });
      const res = await turn(open, chat.id, { content: "quick one", think: false });
      assertEventShape(res.events, "done");
      assert.ok(!kinds(res.events).includes("thinking"));
      assert.equal(res.events.at(-1).message.thinking, null);
      assert.equal(res.events[0].chat.title, "kept title", "an existing title is not replaced");
      const sent = open.mock.lastChat();
      assert.equal(sent.think, false);
      assert.deepEqual(sent.options, FAST_OPTIONS);
    });

    test("think defaults to true", async () => {
      const chat = await createChat(open);
      await turn(open, chat.id, { content: "no think field" });
      assert.equal(open.mock.lastChat().think, true);
      assert.deepEqual(open.mock.lastChat().options, THINK_OPTIONS);
    });

    test("tokens reach the client as they are generated", async () => {
      open.mock.configure({ tokenDelayMs: 60 });
      const chat = await createChat(open);
      const res = await turn(open, chat.id, { content: "stream please", think: false });
      const tokens = res.events.filter((e) => e.event === "content");
      assert.ok(tokens.length > 10);
      assert.ok(tokens.at(-1).at - tokens[0].at > 400, "tokens arrived in one burst; the stream is buffered");
    });

    test("context: earlier turns are sent without thinking", async () => {
      const chat = await createChat(open);
      const first = await turn(open, chat.id, { content: "first", think: true });
      const firstReply = first.events.at(-1).message;
      assert.ok(firstReply.thinking);
      await turn(open, chat.id, { content: "second", think: true });
      assert.deepEqual(open.mock.lastChat().messages, [
        { role: "user", content: "first" },
        { role: "assistant", content: firstReply.content },
        { role: "user", content: "second" },
      ]);
    });

    test("context: earlier turns are summarized before omission, recent turns remain verbatim", async () => {
      const id = `trim-${Date.now()}`;
      const ten = (label) => pad(label, 13_000);
      await call(open, "POST", "/v1/import", {
        body: {
          chats: [
            {
              id,
              title: "trim",
              messages: [
                { role: "user", content: ten("u1") },
                { role: "assistant", content: ten("a1") },
                { role: "user", content: ten("u2") },
                { role: "assistant", content: ten("a2") },
                { role: "user", content: ten("u3") },
                { role: "assistant", content: "", thinking: "thought but never answered" },
              ],
            },
          ],
        },
      });
      const original = (await getChat(open, id)).messages;
      const res = await turn(open, id, { content: "final", think: false });
      assert.equal(kinds(res.events).at(-1), "done");
      const sent = open.mock.lastChat().messages;
      assert.equal(sent[0].role, "user");
      assert(sent[0].content.startsWith("Earlier conversation summary"));
      assert(sent[0].content.includes("u1"), "Older source is represented by validated memory instead of dropped");
      assert.deepEqual(sent.slice(1), [
        { role: "user", content: ten("u3") },
        { role: "user", content: "final" },
      ]);
      assert.equal(res.events.at(-1).message.stats.context.auto_compacted, true);
      assert.equal(res.events.at(-1).message.stats.context.summarized_message_count, 4);
      assert.deepEqual((await getChat(open, id)).messages.slice(0, original.length), original);
    });

    test("context: an oversized newest message is rejected before changing history", async () => {
      const chat = await createChat(open);
      await turn(open, chat.id, { content: "warm-up", think: false });
      const before = await getChat(open, chat.id);
      const huge = pad("huge", 60_000);
      const res = await turn(open, chat.id, { content: huge, think: false });
      assert.equal(res.status, 413, res.status === 413 ? undefined : `Oversized turn response: ${JSON.stringify(res.json)}\nWorker output:\n${open.output()}`);
      assert.equal(res.json.error.code, "context_limit");
      assert.deepEqual(await getChat(open, chat.id), before);
    });

    test("replace_from regenerates the last reply", async () => {
      const chat = await createChat(open);
      await turn(open, chat.id, { content: "q1", think: false });
      await turn(open, chat.id, { content: "q2", think: false });
      const before = (await getChat(open, chat.id)).messages;
      assert.equal(before.length, 4);

      const res = await turn(open, chat.id, { content: "q2", think: false, replace_from: before[2].id });
      assertEventShape(res.events, "done");
      const after = await getChat(open, chat.id);
      assert.deepEqual(after.messages.slice(0, 2), before.slice(0, 2));
      assert.deepEqual(after.messages.map((m) => m.content.slice(0, 2)), ["q1", before[1].content.slice(0, 2), "q2", "Yo"]);
      assert.ok(after.messages[2].id > before[3].id, "the replaced messages are new rows");
      assert.equal(after.chat.message_count, 4);
      assert.deepEqual(open.mock.lastChat().messages, [
        { role: "user", content: "q1" },
        { role: "assistant", content: before[1].content },
        { role: "user", content: "q2" },
      ]);
    });

    test("replace_from with new content edits and resends", async () => {
      const chat = await createChat(open);
      await turn(open, chat.id, { content: "original question", think: false });
      await turn(open, chat.id, { content: "follow-up", think: false });
      const [firstUser] = (await getChat(open, chat.id)).messages;

      const res = await turn(open, chat.id, { content: "edited question", think: false, replace_from: firstUser.id });
      assert.equal(res.events[0].chat.message_count, 1);
      assert.equal(res.events[0].chat.title, "original question", "the title stays once set");
      const after = await getChat(open, chat.id);
      assert.deepEqual(after.messages.map((m) => m.role), ["user", "assistant"]);
      assert.equal(after.messages[0].content, "edited question");
      assert.deepEqual(open.mock.lastChat().messages, [{ role: "user", content: "edited question" }]);
    });

    test("replace_from must be a user message of this chat", async () => {
      const chat = await createChat(open);
      await turn(open, chat.id, { content: "only", think: false });
      const [user, assistant] = (await getChat(open, chat.id)).messages;
      const other = await createChat(open);
      await turn(open, other.id, { content: "elsewhere", think: false });
      const [foreign] = (await getChat(open, other.id)).messages;

      for (const replace_from of [assistant.id, foreign.id, 999_999_999, 0, -1, 1.5, "1", user.id + 0.5]) {
        const res = await turn(open, chat.id, { content: "x", think: false, replace_from });
        assertApiError({ ...res, text: JSON.stringify(res.json) }, 400, "bad_request");
      }
      assert.deepEqual((await getChat(open, chat.id)).messages, [user, assistant], "nothing changed");
      const ok = await turn(open, chat.id, { content: "still works", think: false });
      assert.equal(kinds(ok.events).at(-1), "done", "a refused replace_from released the lock");
    });

    test("input validation and pre-stream errors", async () => {
      const chat = await createChat(open);
      const cases = [
        [{}, 400, "bad_request"],
        [{ content: "" }, 400, "bad_request"],
        [{ content: " \n\t " }, 400, "bad_request"],
        [{ content: 5 }, 400, "bad_request"],
        [{ content: "hi", think: "yes" }, 400, "bad_request"],
        [{ content: "x".repeat(100_001) }, 413, "too_large"],
      ];
      for (const [body, status, code] of cases) {
        const res = await turn(open, chat.id, body);
        assertApiError({ ...res, text: JSON.stringify(res.json) }, status, code);
      }
      await registerKaggle(open);
      try {
        const max = await turn(open, chat.id, { content: "y".repeat(100_000), think: false });
        assert.equal(kinds(max.events).at(-1), "done", "exactly 100 000 chars is allowed when the model input window can hold it");
      } finally {
        await register(open, open.mock.url);
      }
      const missing = await turn(open, "no-such-chat", { content: "hi" });
      assertApiError({ ...missing, text: JSON.stringify(missing.json) }, 404, "not_found");
    });

    test("busy: a second turn gets 409 while one generates; Stop saves the partial reply", async () => {
      open.mock.configure({ fillerTokens: 3000, tokenDelayMs: 5 });
      const a = await createChat(open, { title: "long one" });
      const b = await createChat(open, { title: "waiting one" });
      const callsBefore = open.mock.stats();

      // While the reply streams: try a second turn, read the status and try to delete the chat.
      // Only once those are answered does the client hang up, like pressing Stop.
      let busyChecks = null;
      let checked = false;
      const long = await turn(open, a.id, { content: "go long", think: false }, {
        onEvent: (event, events) => {
          const tokens = events.filter((e) => e.event === "content").length;
          if (tokens === 20 && !busyChecks) {
            busyChecks = (async () => {
              const second = await turn(open, b.id, { content: "me too", think: false });
              const status = (await call(open, "GET", "/v1/status")).json;
              const del = await call(open, "DELETE", `/v1/chats/${a.id}`);
              return { second, status, del };
            })().finally(() => (checked = true));
          }
          return checked && tokens >= 40 ? "abort" : undefined;
        },
      });
      assert.ok(long.aborted, "the reply finished before the checks did");
      const { second, status, del } = await busyChecks;

      assert.equal(second.status, 409);
      assert.equal(second.json.error.code, "busy");
      assert.equal(second.json.error.busy.chat_id, a.id);
      assert.equal(second.json.error.busy.since, status.busy.since);
      assert.equal(status.busy.chat_id, a.id);
      assertApiError(del, 409, "busy");

      await waitForLockRelease(open);
      const { messages } = await getChat(open, a.id);
      const partial = messages.at(-1);
      assert.equal(partial.role, "assistant");
      assert.equal(partial.status, "stopped");
      assert.equal(partial.stats, null);
      assert.ok(partial.content.startsWith(textOf(long.events, "content")));
      assert.ok(partial.content.length < 3000 * 6, "generation stopped early");
      await waitFor(() => open.mock.stats().aborted > callsBefore.aborted, { what: "the upstream request to be aborted" });

      open.mock.configure({ fillerTokens: 0 });
      const retry = await turn(open, b.id, { content: "me too", think: false });
      assert.equal(kinds(retry.events).at(-1), "done");
    });

    test("Stop before the first token saves nothing and stops retrying", async () => {
      open.mock.failNext(524, 1000);
      const chat = await createChat(open);
      const res = await turn(open, chat.id, { content: "never answered", think: false }, {
        onEvent: (event, events) => (statuses(events).length >= 3 ? "abort" : undefined),
      });
      assert.ok(res.aborted);
      await waitForLockRelease(open);
      const calls = open.mock.stats().chatCalls;
      await delay(STATUS_EVERY_MS * 4);
      assert.equal(open.mock.stats().chatCalls, calls, "no retries after the client left");
      const { messages, chat: stored } = await getChat(open, chat.id);
      assert.deepEqual(messages.map((m) => m.role), ["user"]);
      assert.equal(stored.message_count, 1);
    });

    test("stale lock: a fresh lock is respected, one silent for over 30 s is taken over", async () => {
      const chat = await createChat(open);
      await plantLock(open, { chatId: "ghost-chat", heartbeatAgeMs: 20_000 });
      try {
        const blocked = await turn(open, chat.id, { content: "blocked?", think: false });
        assert.equal(blocked.status, 409);
        assert.equal(blocked.json.error.busy.chat_id, "ghost-chat");
        assert.equal((await call(open, "GET", "/v1/status")).json.busy.chat_id, "ghost-chat");

        await plantLock(open, { chatId: "ghost-chat", heartbeatAgeMs: 31_000 });
        assert.equal((await call(open, "GET", "/v1/status")).json.busy, null, "a stale lock is not reported busy");
        const res = await turn(open, chat.id, { content: "taking over", think: false });
        assertEventShape(res.events, "done");
        assert.deepEqual(await open.sql("SELECT k FROM state WHERE k = 'gen_lock'"), [], "released after the turn");
      } finally {
        await open.sql("DELETE FROM state WHERE k = 'gen_lock' AND json_extract(v, '$.owner') = 'ghost-owner'");
      }
    });

    test("524 before the first token is retried with status events, then succeeds", async () => {
      open.mock.failNext(524, 2);
      const chat = await createChat(open);
      const res = await turn(open, chat.id, { content: "eventually", think: false });
      assertEventShape(res.events, "done");
      const seen = statuses(res.events).map((s) => `${s.state}:${s.attempt}`);
      assert.deepEqual(
        seen.filter((s) => !s.startsWith("waiting")),
        ["connecting:1", "retrying:2", "connecting:2", "retrying:3", "connecting:3"],
      );
      const retrying = statuses(res.events).filter((s) => s.state === "retrying");
      assert.ok(retrying.every((s) => /HTTP 524/.test(s.detail)), JSON.stringify(retrying));
      assert.equal(open.mock.stats().chatCalls, 3);
      assert.equal(res.events.at(-1).message.status, "complete");
    });

    test("502, 503 and 530 are retried too; other statuses fail at once", async () => {
      for (const status of [502, 503, 530]) {
        open.mock.reset();
        open.mock.failNext(status, 1);
        const chat = await createChat(open);
        const res = await turn(open, chat.id, { content: `after ${status}`, think: false });
        assert.equal(kinds(res.events).at(-1), "done", `HTTP ${status}`);
      }
      open.mock.reset();
      open.mock.failNext(500, 1);
      const chat = await createChat(open);
      const res = await turn(open, chat.id, { content: "boom", think: false });
      assertEventShape(res.events, "error");
      const error = res.events.at(-1);
      assert.equal(error.code, "upstream");
      assert.match(error.message, /HTTP 500/);
      assert.equal(error.message_saved, null);
      assert.equal(open.mock.stats().chatCalls, 1);
      assert.deepEqual((await getChat(open, chat.id)).messages.map((m) => m.role), ["user"]);
      await waitForLockRelease(open);
    });

    test("the target is re-read from D1 before every retry", async () => {
      const chat = await createChat(open);
      await register(open, "http://127.0.0.1:9"); // nothing listens there
      try {
        let reRegistered = null;
        const res = await turn(open, chat.id, { content: "colab moved", think: false }, {
          onEvent: (event) => {
            if (event.event === "status" && event.state === "retrying" && !reRegistered) {
              reRegistered = register(open, open.mock.url);
            }
          },
        });
        await reRegistered;
        assertEventShape(res.events, "done");
        assert.ok(statuses(res.events).some((s) => s.state === "retrying" && /not reachable/.test(s.detail)));
      } finally {
        await register(open, open.mock.url);
      }
    });

    test("offline: gives up after the first-token window with status ticks along the way", async () => {
      open.mock.setDown(true);
      const chat = await createChat(open);
      const startedAt = Date.now();
      const res = await turn(open, chat.id, { content: "anyone there?", think: false });
      const elapsed = Date.now() - startedAt;
      assertEventShape(res.events, "error");
      const error = res.events.at(-1);
      assert.equal(error.code, "offline");
      assert.equal(error.message_saved, null);

      const windowMs = 6 * 60_000 * TIMING_SCALE;
      assert.ok(elapsed >= windowMs * 0.95 && elapsed < windowMs + 10_000, `gave up after ${elapsed} ms`);
      const ticks = statuses(res.events);
      assert.ok(ticks.some((s) => s.state === "waiting"));
      const gaps = res.events.slice(1).map((e, i) => e.at - res.events[i].at);
      assert.ok(Math.max(...gaps) < STATUS_EVERY_MS * 2, `longest silence ${Math.max(...gaps)} ms`);
      await waitForLockRelease(open);
      assert.deepEqual((await getChat(open, chat.id)).messages.map((m) => m.role), ["user"]);
    });

    test("while the model loads, a loading status is reported", async () => {
      open.mock.configure({ loaded: false, loadDelayMs: 1500 });
      const chat = await createChat(open);
      const res = await turn(open, chat.id, { content: "cold start", think: false });
      assertEventShape(res.events, "done");
      const loading = statuses(res.events).filter((s) => s.state === "loading");
      assert.ok(loading.length >= 1, JSON.stringify(statuses(res.events)));
      assert.equal(loading[0].attempt, 1);
    });

    test("hitting num_predict ends with status length", async () => {
      open.mock.configure({ fillerTokens: 5000, tokenDelayMs: 0 });
      const chat = await createChat(open);
      const res = await turn(open, chat.id, { content: "write forever", think: false });
      assertEventShape(res.events, "done");
      const { message } = res.events.at(-1);
      assert.equal(message.status, "length");
      assert.equal(message.stats.done_reason, "length");
      assert.equal(message.stats.eval_count, 4096);
      assert.equal((await getChat(open, chat.id)).messages.at(-1).status, "length");
    });

    test("an Ollama error mid-stream saves the partial reply as error", async () => {
      open.mock.configure({ errorAfterTokens: 15 });
      const chat = await createChat(open);
      const res = await turn(open, chat.id, { content: "fail midway", think: true });
      assertEventShape(res.events, "error");
      const error = res.events.at(-1);
      assert.equal(error.code, "upstream");
      assert.match(error.message, /simulated failure/);
      assert.equal(error.message_saved.status, "error");
      assert.equal(error.message_saved.thinking, textOf(res.events, "thinking"));
      assert.equal(error.message_saved.content, textOf(res.events, "content"));
      assert.ok(error.message_saved.content.length > 0);
      const stored = await getChat(open, chat.id);
      assert.deepEqual(stored.messages.at(-1), error.message_saved);
      assert.equal(stored.chat.message_count, 2);
      await waitForLockRelease(open);
    });

    test("an Ollama error before any token saves nothing", async () => {
      open.mock.configure({ errorAfterTokens: 0 });
      const chat = await createChat(open);
      const res = await turn(open, chat.id, { content: "fail at once", think: true });
      assertEventShape(res.events, "error");
      assert.equal(res.events.at(-1).code, "upstream");
      assert.equal(res.events.at(-1).message_saved, null);
      assert.equal(open.mock.stats().chatCalls, 1, "not retried");
    });

    test("a dropped connection mid-reply is an error, not a retry", async () => {
      open.mock.configure({ dropAfterTokens: 5 });
      const chat = await createChat(open);
      const res = await turn(open, chat.id, { content: "drop me", think: false });
      assertEventShape(res.events, "error");
      const error = res.events.at(-1);
      assert.equal(error.code, "upstream");
      assert.match(error.message, /dropped/);
      assert.equal(error.message_saved.status, "error");
      assert.equal(error.message_saved.content, textOf(res.events, "content"));
      assert.equal(open.mock.stats().chatCalls, 1);
    });

    test("a model that goes silent mid-reply times out and the lock is freed", async () => {
      open.mock.configure({ stallAfterTokens: 6 });
      const chat = await createChat(open);
      const res = await turn(open, chat.id, { content: "stall", think: false });
      assertEventShape(res.events, "error");
      const error = res.events.at(-1);
      assert.equal(error.code, "upstream");
      assert.match(error.message, /stopped responding/);
      assert.equal(error.message_saved.status, "error");
      await waitForLockRelease(open);
      await waitFor(() => open.mock.stats().active === 0, { what: "the stalled upstream request to close" });
    });
  });
  describe("pictures", () => {
    const target = () => open.mock.url;
    const asNotebook = { headers: withKey };
    const command = async () => (await call(open, "GET", `/_relay/command?target=${encodeURIComponent(target())}`, asNotebook)).json;
    const reportMode = (mode, state, extra = {}) =>
      call(open, "POST", "/_relay/mode", { body: { target: target(), mode, state, ...extra }, ...asNotebook });
    const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("picture bytes")]);
    const WEBP = Buffer.concat([Buffer.from("RIFF"), Buffer.from([16, 0, 0, 0]), Buffer.from("WEBPVP8 preview")]);
    const sendResult = (id, kind, body, type) =>
      fetch(`${open.url}/_relay/image-result?id=${id}&kind=${kind}`, { method: "POST", body, headers: { ...withKey, "content-type": type } }).then((r) => r.json());

    beforeEach(async () => {
      await open.sql("DELETE FROM images");
      await registerKaggle(open);
    });
    after(async () => {
      await open.sql("DELETE FROM images");
      await register(open, open.mock.url);
    });

    test("need an updated server that supports switching", async () => {
      await register(open, open.mock.url);
      assertApiError(await call(open, "POST", "/v1/images", { body: { prompt: "a lighthouse at dusk" } }), 409, "unsupported");
    });

    test("Colab uses the same image queue, GPU handoff, progress and binary result routes", async () => {
      const registered = await call(open, "POST", "/_relay/register", { body: { target: target(), host: "colab", num_ctx: 98304, num_batch: 256, quant: "Q5_K_P", vision: true, control: true, inference_transport: "jobs-v1" }, ...asNotebook });
      assert.equal(registered.status, 200, registered.text);
      const created = await call(open, "POST", "/v1/images", { body: { prompt: "Colab image parity fixture", speed: "fast" } });
      assert.equal(created.status, 201, created.text);
      const id = created.json.image.id;
      assert.equal((await command()).mode, "images");
      assert.equal((await reportMode("images", "ready")).status, 200);
      assert.equal((await command()).job.id, id);
      assert.equal((await call(open, "POST", "/_relay/image-progress", { body: { id, step: 4 }, ...asNotebook })).status, 200);
      assert.equal((await sendResult(id, "full", PNG, "image/png")).ok, true);
      assert.equal((await call(open, "GET", `/v1/images/${id}`)).json.image.status, "done");
      assert.equal((await call(open, "POST", "/v1/server/mode", { body: { mode: "chat" } })).status, 200);
      assert.equal((await command()).mode, "chat");
      assert.equal((await reportMode("chat", "ready")).status, 200);
      const status = (await call(open, "GET", "/v1/status")).json;
      assert.equal(status.host, "colab");
      assert.equal(status.num_ctx, 98304);
      assert.equal(status.mode.current, "chat");
    });

    test("a queued picture switches the notebook to pictures, which then takes it once", async () => {
      const created = await call(open, "POST", "/v1/images", { body: { prompt: "  a lighthouse at dusk ", aspect: "wide", speed: "quality", seed: 42 } });
      assert.equal(created.status, 201, created.text);
      const { image } = created.json;
      assert.deepEqual([image.prompt, image.width, image.height, image.steps, image.seed, image.status], ["a lighthouse at dusk", 1344, 768, 25, 42, "queued"]);

      const status = (await call(open, "GET", "/v1/status")).json;
      assert.equal(status.mode.requested, "images");
      assert.equal(status.mode.current, "chat");
      assert.equal(status.images_waiting, 1);
      assert.deepEqual(pick(await command(), ["mode", "job"]), { mode: "images" }, "no job before the switch is done");

      assert.equal((await reportMode("images", "switching", { detail: "Starting the picture model", percent: 90 })).status, 200);
      assert.equal((await call(open, "GET", "/v1/status")).json.mode.detail, "Starting the picture model");
      assert.equal((await reportMode("images", "ready")).status, 200);
      const first = await command();
      assert.equal(first.job.id, image.id);
      assert.deepEqual([first.job.cfg, first.job.steps, first.job.width], [3, 25, 1344]);
      assert.equal((await command()).job, undefined, "handed out once");
      assert.equal((await call(open, "GET", "/v1/status")).json.server, "images");
    });

    test("steps, the preview and the PNG finish a picture, and the files are served", async () => {
      const { image } = (await call(open, "POST", "/v1/images", { body: { prompt: "a red bicycle", speed: "fast" } })).json;
      assert.equal(image.steps, 8);
      await reportMode("images", "ready");
      assert.equal((await command()).job.cfg, 1);
      const progress = await call(open, "POST", "/_relay/image-progress", { body: { id: image.id, step: 3 }, ...asNotebook });
      assert.deepEqual(progress.json, { ok: true, cancel: false });
      assert.equal((await call(open, "GET", `/v1/images/${image.id}`)).json.image.step, 3);

      assert.equal((await sendResult(image.id, "thumb", WEBP, "image/webp")).ok, true);
      assert.equal((await sendResult(image.id, "full", PNG, "image/png")).ok, true);
      const done = (await call(open, "GET", `/v1/images/${image.id}`)).json.image;
      assert.deepEqual([done.status, done.step, done.bytes, done.has_thumb], ["done", 8, PNG.length, true]);

      const full = await fetch(`${open.url}/v1/images/${image.id}/file`);
      assert.equal(full.headers.get("content-type"), "image/png");
      assert.match(full.headers.get("cache-control"), /immutable/);
      assert.deepEqual(Buffer.from(await full.arrayBuffer()), PNG);
      const thumb = await fetch(`${open.url}/v1/images/${image.id}/file?size=thumb`);
      assert.equal(thumb.headers.get("content-type"), "image/webp");
      assert.deepEqual(Buffer.from(await thumb.arrayBuffer()), WEBP);

      const list = (await call(open, "GET", "/v1/images")).json;
      assert.deepEqual(list.images.map((i) => i.id), [image.id]);
      assert.equal(list.has_more, false);
    });

    test("bad uploads are refused and a reported error fails the picture", async () => {
      const { image } = (await call(open, "POST", "/v1/images", { body: { prompt: "a red bicycle" } })).json;
      await reportMode("images", "ready");
      await command();
      const bad = await fetch(`${open.url}/_relay/image-result?id=${image.id}&kind=full`, { method: "POST", body: "not a png", headers: withKey });
      assert.equal(bad.status, 400);
      await sendResult(image.id, "error", JSON.stringify({ error: "The picture came out blank" }), "application/json");
      const failed = (await call(open, "GET", `/v1/images/${image.id}`)).json.image;
      assert.deepEqual([failed.status, failed.error], ["failed", "The picture came out blank"]);
      assertApiError(await call(open, "GET", `/v1/images/${image.id}/file`), 404, "not_found");
    });

    test("deleting a picture being made tells the notebook to stop", async () => {
      const { image } = (await call(open, "POST", "/v1/images", { body: { prompt: "a red bicycle" } })).json;
      await reportMode("images", "ready");
      await command();
      assert.equal((await call(open, "DELETE", `/v1/images/${image.id}`)).status, 200);
      const progress = await call(open, "POST", "/_relay/image-progress", { body: { id: image.id, step: 2 }, ...asNotebook });
      assert.equal(progress.json.cancel, true);
      assert.equal((await sendResult(image.id, "full", PNG, "image/png")).cancel, true);
    });

    test("chat waits while pictures have the GPUs, and comes back on request", async () => {
      await call(open, "POST", "/v1/images", { body: { prompt: "a red bicycle" } });
      const chat = await createChat(open);
      assertApiError(await callTurn(turn(open, chat.id, { content: "hello" })), 409, "image_mode");
      assert.equal((await call(open, "POST", "/v1/server/mode", { body: { mode: "chat" } })).json.mode.requested, "chat");
      assert.equal((await command()).mode, "chat");
      await reportMode("chat", "ready");
      assert.equal((await call(open, "GET", "/v1/status")).json.mode.current, "chat");
      assertApiError(await call(open, "POST", "/v1/server/mode", { body: { mode: "videos" } }), 400, "bad_request");
    });

    test("a failed switch leaves the server chatting", async () => {
      await call(open, "POST", "/v1/server/mode", { body: { mode: "images" } });
      await reportMode("images", "failed", { detail: "only 12 GB of disk free for pictures" });
      const { mode } = (await call(open, "GET", "/v1/status")).json;
      assert.deepEqual([mode.requested, mode.state, mode.detail], ["chat", "failed", "only 12 GB of disk free for pictures"]);
    });

    test("a fresh server fails the picture its predecessor was making; one moving tunnels keeps going", async () => {
      const { image } = (await call(open, "POST", "/v1/images", { body: { prompt: "a red bicycle" } })).json;
      await reportMode("images", "ready");
      await command();
      const again = { target: target(), host: "kaggle", num_ctx: 65536, control: true, mode: "images" };
      assert.equal((await call(open, "POST", "/_relay/register", { body: again, ...asNotebook })).status, 200);
      assert.equal((await call(open, "GET", `/v1/images/${image.id}`)).json.image.status, "running");
      assert.equal((await call(open, "GET", "/v1/status")).json.mode.current, "images");
      await registerKaggle(open);
      const failed = (await call(open, "GET", `/v1/images/${image.id}`)).json.image;
      assert.equal(failed.status, "failed");
      assert.equal((await call(open, "GET", "/v1/status")).json.mode.current, "chat");
    });

    test("input is checked and the queue is bounded", async () => {
      assertApiError(await call(open, "POST", "/v1/images", { body: { prompt: "   " } }), 400, "bad_request");
      assertApiError(await call(open, "POST", "/v1/images", { body: { prompt: "x", aspect: "panorama" } }), 400, "bad_request");
      assertApiError(await call(open, "POST", "/v1/images", { body: { prompt: "x", seed: -1 } }), 400, "bad_request");
      for (let i = 0; i < 8; i++) assert.equal((await call(open, "POST", "/v1/images", { body: { prompt: `picture ${i}` } })).status, 201);
      assertApiError(await call(open, "POST", "/v1/images", { body: { prompt: "one more" } }), 429, "queue_full");
    });
  });
});

/** The named fields of an object that are present. */
function pick(object, keys) {
  return Object.fromEntries(keys.filter((k) => object[k] !== undefined).map((k) => [k, object[k]]));
}

// ---------------------------------------------------------------- key stack

describe("key stack (AUTH_MODE=key)", () => {
  test("/v1 requires the key; assets stay public", async () => {
    for (const pathname of ["/v1/config", "/v1/status", "/v1/chats", "/v1/nope"]) {
      assertApiError(await call(keyed, "GET", pathname), 401, "unauthorized");
      assertApiError(await call(keyed, "GET", pathname, { headers: { "x-relay-key": "wrong" } }), 401, "unauthorized");
    }
    assertApiError(await call(keyed, "POST", "/v1/chats", { body: {} }), 401, "unauthorized");

    const config = await call(keyed, "GET", "/v1/config", { headers: withKey });
    assert.equal(config.status, 200);
    assert.equal(config.json.auth_mode, "key");

    const shell = await call(keyed, "GET", "/");
    assert.equal(shell.status, 200);
    assertSecurityHeaders(shell.headers, { html: true });
  });

  test("a fresh deployment reports unregistered and refuses turns with 503 offline", async () => {
    const status = await call(keyed, "GET", "/v1/status", { headers: withKey });
    assert.equal(status.status, 200);
    assert.equal(status.json.server, "unregistered");
    assert.equal(status.json.target_registered_at, null);
    assert.equal(status.json.busy, null);

    assert.deepEqual((await call(keyed, "GET", "/_relay/status", { headers: withKey })).json, {});
    const proxy = await call(keyed, "GET", "/api/tags", { headers: withKey });
    assert.equal(proxy.status, 503);
    assert.equal(proxy.text, "no model server registered yet\n");

    const chat = await createChat(keyed, {}, withKey);
    const res = await turn(keyed, chat.id, { content: "hello?" }, { headers: withKey });
    assertApiError({ ...res, text: JSON.stringify(res.json) }, 503, "offline");
    assert.deepEqual((await getChat(keyed, chat.id, withKey)).messages, [], "nothing saved");
  });

  test("after registration the stack is ready and turns work with the key", async () => {
    await register(keyed, keyed.mock.url);
    const status = await call(keyed, "GET", "/v1/status", { headers: withKey });
    assert.equal(status.json.server, "ready");

    const chat = await createChat(keyed, {}, withKey);
    const denied = await turn(keyed, chat.id, { content: "no key" });
    assertApiError({ ...denied, text: JSON.stringify(denied.json) }, 401, "unauthorized");
    const res = await turn(keyed, chat.id, { content: "with key", think: false }, { headers: withKey });
    assertEventShape(res.events, "done");
  });
});
