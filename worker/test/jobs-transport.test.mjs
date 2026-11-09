import assert from "node:assert/strict";
import test from "node:test";
import { JobsTransportError, createJobBudget, eligibleJobPayload, jobStartBytes, jobResponse, memberText, streamJobRecords } from "../src/jobs-transport.js";

const identity = { id: "fixture_job_identity_0123456789", token: "fixture_job_bearer_token_0123456789_01234567890123456789" };
const encoder = new TextEncoder();
const record = (cursor, value) => JSON.stringify({ cursor, record: value }) + "\n";
const heartbeat = (cursor) => JSON.stringify({ cursor, heartbeat: true }) + "\n";
const terminal = (cursor, status = "completed", error = null, upstreamStatus = 200) => JSON.stringify({ cursor, done: true, status, error, upstreamStatus }) + "\n";
const acknowledgement = () => Response.json({ ...identity, cursor: 0 }, { status: 202 });
function fixture(legs, { start = null } = {}) {
  const calls = []; let leg = 0, starts = 0;
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, ...options });
    if (options.method === "DELETE") return Response.json({ cancelled: true });
    if (options.method === "POST") { starts++; return start ? start(starts, options) : acknowledgement(); }
    const next = legs[leg++];
    if (next instanceof Error) throw next;
    if (typeof next === "function") return next(options);
    return next instanceof Response ? next : new Response(next ?? "");
  };
  return { fetchImpl, calls, get starts() { return starts; } };
}
function options(server, extra = {}) {
  return { target: "https://fixture.trycloudflare.com", payload: '{"model":"fixture","stream":true}', identity, fetchImpl: server.fetchImpl, retryMs: 0, ...extra };
}
async function collect(server, extra) {
  const values = []; for await (const part of streamJobRecords(options(server, extra))) values.push(part);
  return values;
}
function deletes(server) { return server.calls.filter((call) => call.method === "DELETE"); }

test("bounded legs resume the same job without replaying already delivered model records", async () => {
  const server = fixture([
    heartbeat(0) + record(0, { message: { content: "A" } }),
    record(0, { message: { content: "A" } }) + record(1, { message: { content: "B" } }) + record(2, { done: true }),
  ]);
  const values = await collect(server);
  assert.equal(server.starts, 1);
  assert.deepEqual(values.map((part) => part.value), [{ message: { content: "A" } }, { message: { content: "B" } }, { done: true }]);
  assert.equal(server.calls[2].url, `https://fixture.trycloudflare.com/_jobs/${identity.id}/stream?cursor=1&max_seconds=90`);
  assert.equal(deletes(server).length, 1);
});

test('two-hour personal requests can use heartbeat-protected five-minute legs within the free request budget',async()=>{
  const server=fixture([...Array.from({length:23},()=>heartbeat(0)),record(0,{message:{thinking:'First output after long prefill.'}})+record(1,{done:true})]);
  const values=await collect(server,{legSeconds:300,prefillLegSeconds:300,maxJobMs:2*60*60_000});
  assert.equal(values.length,2);assert.equal(server.starts,1);assert.equal(server.calls.length,26);assert.equal(deletes(server).length,1);
  assert(server.calls.filter(call=>!call.method).every(call=>call.url.endsWith('max_seconds=300')));
  for(const invalid of [0,301,Infinity])await assert.rejects(collect(fixture([]),{legSeconds:invalid}),/Invalid job stream leg/);
});

test("lost start acknowledgement retries identical id, token and request bytes", async () => {
  let firstBody;
  const server = fixture([record(0, { done: true })], { start: (attempt, request) => {
    if (attempt === 1) { firstBody = request.body; throw new Error("ACK was lost after start"); }
    assert.deepEqual(request.body, firstBody);
    return acknowledgement();
  } });
  await collect(server);
  assert.equal(server.starts, 2);
  assert.equal(deletes(server).length, 1);
});

test("transient start HTTP failures retry the same identity", async () => {
  const server = fixture([record(0, { done: true })], { start: (attempt) => attempt === 1 ? new Response("unavailable", { status: 524 }) : acknowledgement() });
  await collect(server); assert.equal(server.starts, 2);
});

test("network failure after a full record resumes from its next cursor", async () => {
  const body = new ReadableStream({ start(controller) {
    controller.enqueue(encoder.encode(record(0, { message: { content: "kept" } })));
    setTimeout(() => controller.error(new Error("socket reset")), 1);
  } });
  const server = fixture([new Response(body), record(1, { done: true })]);
  assert.deepEqual((await collect(server)).map((part) => part.value), [{ message: { content: "kept" } }, { done: true }]);
  assert.match(server.calls[2].url, /cursor=1&/);
  assert.equal(server.starts, 1);
});

test("truncated final envelope is discarded and fetched again at the saved cursor", async () => {
  const server = fixture([record(0, { message: { content: "A" } }) + '{"cursor":1,"record":{"message":', record(1, { message: { content: "B" } }) + record(2, { done: true })]);
  assert.equal((await collect(server)).length, 3);
  assert.match(server.calls[2].url, /cursor=1&/);
});

test("raw JSON body bytes preserve int64, float spelling, escaped text and Unicode", () => {
  const body = '{ "model":"測試", "options":{"seed":9223372036854775807,"temperature":1.000},"prompt":"\\u0041" }';
  const wrapper = new TextDecoder().decode(jobStartBytes("/api/generate", encoder.encode(body), identity.id, identity.token));
  assert.equal(memberText(wrapper, "body"), body);
  assert.equal(JSON.parse(wrapper).job_id, identity.id);
});

test("raw origin records preserve lexical int64 and escaped Unicode bytes", async () => {
  const raw = '{ "seed":9223372036854775807,"spelling":1.000,"text":"\\u0041","done":true }';
  const server = fixture(['{"cursor":0,"record":' + raw + '}\n']);
  const [part] = await collect(server);
  assert.equal(part.line, raw + "\n");
});

test("member extraction handles nested arrays, braces inside strings and escaped member keys", () => {
  const raw = '{"a":["}\\\"",{"x":[1,2]}],"done":true}';
  assert.equal(memberText('{"cursor":0,"rec\\u006frd":' + raw + ',"x":1}', "record"), raw);
});

test("heartbeat callback keeps the outer raw API alive while no model token exists", async () => {
  const server = fixture([heartbeat(0) + heartbeat(0) + record(0, { done: true })]);
  let beats = 0; await collect(server, { onHeartbeat: () => beats++ }); assert.equal(beats, 2);
});

test("consumer break explicitly cancels the known active job", async () => {
  const server = fixture([record(0, { message: { content: "partial" } })]);
  for await (const part of streamJobRecords(options(server))) { assert.equal(part.value.message.content, "partial"); break; }
  assert.equal(deletes(server).length, 1);
  assert.equal(deletes(server)[0].headers.authorization, `Bearer ${identity.token}`);
});

test("abort after a lost start ACK still DELETEs with a fresh cleanup signal", async () => {
  const abort = new AbortController();
  const server = fixture([], { start: () => { abort.abort(new Error("user Stop")); throw new Error("lost ACK"); } });
  await assert.rejects(collect(server, { signal: abort.signal }), /user Stop/);
  assert.equal(deletes(server).length, 1);
  assert.equal(deletes(server)[0].signal.aborted, false);
});

test("upstream job failure remains explicit with its original error code and HTTP status", async () => {
  const server = fixture([terminal(0, "failed", { code: "upstream_http", message: "Input was too long" }, 400)]);
  await assert.rejects(collect(server), (error) => error instanceof JobsTransportError && error.code === "upstream_http" && error.upstreamStatus === 400 && /too long/.test(error.message));
});

test("completed job without an Ollama done record is an explicit EOF error", async () => {
  const server = fixture([record(0, { message: { content: "partial" } }) + terminal(1)]);
  await assert.rejects(collect(server), (error) => error.code === "upstream_eof");
  assert.equal(deletes(server).length, 1);
});

test("Ollama error record is forwarded once and ends the raw stream", async () => {
  const server = fixture([record(0, { error: "context length exceeded" }) + terminal(1, "failed")]);
  assert.deepEqual((await collect(server)).map((part) => part.value), [{ error: "context length exceeded" }]);
});

test("cursor gaps are fatal rather than silently omitting output", async () => {
  const server = fixture([record(2, { done: true })]);
  await assert.rejects(collect(server), (error) => error.code === "cursor_gap");
});

test("heartbeat cannot advance past unread model records", async () => {
  const server = fixture([heartbeat(1)]);
  await assert.rejects(collect(server), (error) => error.code === "cursor_gap");
});

test("invalid job identity or acknowledgement cannot leak into a new job", async () => {
  const server = fixture([], { start: () => Response.json({ id: "other", token: identity.token, cursor: 0 }, { status: 202 }) });
  await assert.rejects(collect(server), (error) => error.code === "invalid_start");
  assert.equal(server.starts, 1); assert.equal(deletes(server).length, 1);
});

test("authorization and job identities never appear in URLs", async () => {
  const server = fixture([record(0, { done: true })]); await collect(server);
  for (const call of server.calls) { assert(!call.url.includes(identity.token)); assert(!new URL(call.url).searchParams.has("token")); }
});

test("fatal HTTP errors are not retried or replaced by a different model job", async () => {
  const server = fixture([Response.json({ error: { code: "not_found", message: "Expired" } }, { status: 404 })]);
  await assert.rejects(collect(server), (error) => error.code === "not_found" && error.status === 404);
  assert.equal(server.starts, 1);
});

test("reconnect request budget leaves a reserved DELETE and stays below Workers plan limit", async () => {
  const server = fixture([heartbeat(0), heartbeat(0), heartbeat(0)]);
  await assert.rejects(collect(server, { maxRequests: 4 }), (error) => error.code === "request_limit");
  assert.equal(server.calls.length, 4); assert.equal(deletes(server).length, 1);
});

test("repeated empty legs stop with bounded requests", async () => {
  const server = fixture(["", "", "", ""]);
  await assert.rejects(collect(server, { maxFailures: 2 }), (error) => error.code === "empty_legs");
  assert.equal(server.calls.length, 5);
});

test("metadata size is bounded and cleanup still runs", async () => {
  const server = fixture([], { start: () => new Response(" ".repeat(5000)) });
  await assert.rejects(collect(server), (error) => error.code === "response_limit");
  assert.equal(deletes(server).length, 1);
});

test("eligible raw bodies retain byte identity and explicit stream:false bypasses jobs", () => {
  const request = new Request("https://relay.example/api/chat", { method: "POST", headers: { "content-type": "application/json" } });
  const bytes = encoder.encode('{"model":"x","options":{"seed":9223372036854775807}}');
  assert.equal(eligibleJobPayload(request, bytes), bytes);
  assert.equal(eligibleJobPayload(request, '{"stream":false}'), null);
  assert.equal(eligibleJobPayload(request, '[1]'), null);
  assert.equal(eligibleJobPayload(request, new ReadableStream()), null);
});

test("compressed, large, unknown media and query-bearing raw calls retain synchronous behavior", () => {
  const make = (url, headers = {}) => new Request(url, { method: "POST", headers });
  assert.equal(eligibleJobPayload(make("https://relay.example/api/chat", { "content-encoding": "gzip" }), "{}"), null);
  assert.equal(eligibleJobPayload(make("https://relay.example/api/chat", { "content-type": "text/plain" }), "{}"), null);
  assert.equal(eligibleJobPayload(make("https://relay.example/api/chat?q=1"), "{}"), null);
  assert.equal(eligibleJobPayload(make("https://relay.example/api/chat"), "{}", 1), null);
  assert.equal(eligibleJobPayload(make("https://relay.example/api/other"), "{}"), null);
});

test("pre-aborted consumer never starts or cancels a model job", async () => {
  const controller = new AbortController(); controller.abort(new Error("already stopped"));
  const server = fixture([]);
  await assert.rejects(collect(server, { signal: controller.signal }), /already stopped/);
  assert.equal(server.calls.length, 0);
});

test("raw response preserves an early JSON HTTP422 and original error bytes", async () => {
  const raw = '{ "error":"input too long", "seed":9223372036854775807 }';
  const server = fixture(['{"cursor":0,"upstreamStatus":422,"record":' + raw + '}\n' + terminal(1, "failed", { code: "upstream_http_error", message: "HTTP422" }, 422)]);
  const response = await jobResponse(options(server));
  assert.equal(response.status, 422);
  assert.equal(await response.text(), raw + "\n");
});

test("plain-text origin503 upstreamError envelope retains useful status and message", async () => {
  const server = fixture([JSON.stringify({ cursor: 0, upstreamStatus: 503, upstreamError: { status: 503, body: "model warming up" } }) + "\n"]);
  const response = await jobResponse(options(server));
  assert.equal(response.status, 503);
  const body = await response.json();
  assert.equal(body.error, "model warming up"); assert.equal(body.code, "upstream_http_error"); assert.equal(body.upstream_status, 503);
});

test("late upstream failure after outer heartbeat is explicit NDJSON under committed200", async () => {
  const server = fixture([heartbeat(0) + JSON.stringify({ cursor: 0, upstreamError: { status: 503, body: "late failure" } }) + "\n"]);
  const response = await jobResponse(options(server));
  assert.equal(response.status, 200);
  const body = await response.text();
  assert(body.startsWith(" ".repeat(16_384) + "\n"));
  assert.equal(JSON.parse(body.trim()).error, "late failure");
});

test("known failed HTTP status in heartbeat waits for error body before committing", async () => {
  const server = fixture([JSON.stringify({ cursor: 0, heartbeat: true, upstreamStatus: 404 }) + "\n" + '{"cursor":0,"upstreamStatus":404,"record":{"error":"missing model"}}\n']);
  const response = await jobResponse(options(server));
  assert.equal(response.status, 404); assert.equal((await response.json()).error, "missing model");
});

test("raw response applies backpressure and cleans up only after queued records are read", async () => {
  const server = fixture([Array.from({ length: 100 }, (_, index) => record(index, index === 99 ? { done: true } : { message: { content: String(index) } })).join("")]);
  const response = await jobResponse(options(server));
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(deletes(server).length, 0, "The whole job must not be buffered before a consumer reads");
  const body = await response.text(); assert.equal(body.trim().split("\n").length, 100);
  assert.equal(deletes(server).length, 1);
});

test("raw response reader cancellation DELETEs active GPU work", async () => {
  const server = fixture([heartbeat(0) + record(0, { message: { content: "queued" } })]);
  const response = await jobResponse(options(server));
  await response.body.cancel(new Error("tab closed"));
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(deletes(server).length, 1);
});

test("multiple compact chunks share one request budget and reserve every cleanup", async () => {
  const first = fixture([record(0, { done: true })]);
  const second = fixture([record(0, { done: true })]);
  const third = fixture([]);
  const requestBudget = createJobBudget(6);
  await collect(first, { requestBudget }); await collect(second, { requestBudget });
  assert.equal(requestBudget.used, 6);
  await assert.rejects(collect(third, { requestBudget }), (error) => error.code === "request_limit");
  assert.equal(third.calls.length, 0); assert.equal(requestBudget.used, 6);
});

test("read failures follow a rotated tunnel using the same authenticated job and cursor only", async () => {
  const server = fixture([record(0, { message: { content: "kept" } }), new Error("old tunnel gone"), record(1, { done: true })]);
  const values = await collect(server, { reloadTarget: async () => "https://replacement.trycloudflare.com" });
  assert.equal(values.length, 2); assert.equal(server.starts, 1);
  const reads = server.calls.filter((call) => call.method !== "POST" && call.method !== "DELETE");
  assert.match(reads.at(-1).url, /^https:\/\/replacement\.trycloudflare\.com\//);
  assert.match(reads.at(-1).url, /cursor=1&/);
  assert.match(deletes(server)[0].url, /^https:\/\/replacement\.trycloudflare\.com\//);
});

test("a replacement server without this job fails404 and never starts another inference", async () => {
  const server = fixture([new Error("old tunnel gone"), Response.json({ error: { code: "not_found", message: "No such job" } }, { status: 404 })]);
  await assert.rejects(collect(server, { reloadTarget: async () => "https://new-server.trycloudflare.com" }), (error) => error.code === "not_found" && error.status === 404);
  assert.equal(server.starts, 1);
  assert.match(deletes(server)[0].url, /^https:\/\/fixture\.trycloudflare\.com\//, "Cleanup stays on the last confirmed job owner");
});

test("raw waitUntil keeps cancellation DELETE alive after the client disconnects", async () => {
  const server = fixture([heartbeat(0) + record(0, { message: { content: "partial" } })]);
  let lifetime;
  const response = await jobResponse(options(server, { waitUntil: (promise) => { lifetime = promise; } }));
  assert(lifetime instanceof Promise);
  await response.body.cancel(new Error("Ctrl+C"));
  await lifetime;
  assert.equal(deletes(server).length, 1);
});

test("stalled headers time out before job idle expiry, while an attached body keeps its full leg allowance", async () => {
  const server = fixture([
    (options) => new Promise((resolve, reject) => {
      options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
    }),
    () => new Response(new ReadableStream({ start(controller) {
      setTimeout(() => { controller.enqueue(encoder.encode(record(0, { done: true }))); controller.close(); }, 40);
    } })),
  ]);
  const values = await collect(server, { requestMs: 10, reloadTarget: async () => "https://healthy.trycloudflare.com" });
  assert.equal(values.at(-1).value.done, true);
  assert.equal(server.starts, 1);
  const reads = server.calls.filter((call) => call.method !== "POST" && call.method !== "DELETE");
  assert.equal(reads.length, 2); assert.equal(reads[0].signal.aborted, true);
  assert.match(reads[1].url, /^https:\/\/healthy\.trycloudflare\.com\//);
  assert.equal(deletes(server).length, 1);
});

test("silent prefill uses15s legs until an actual model record, then keeps90s streaming legs", async () => {
  const server = fixture([heartbeat(0), heartbeat(0), record(0, { message: { content: "first" } }), record(1, { done: true })]);
  const values = await collect(server);
  const reads = server.calls.filter(call => call.method !== "POST" && call.method !== "DELETE");
  assert.deepEqual(reads.map(call => Number(new URL(call.url).searchParams.get("max_seconds"))), [15, 15, 15, 90]);
  assert.deepEqual(reads.map(call => Number(new URL(call.url).searchParams.get("cursor"))), [0, 0, 0, 1]);
  assert.equal(values.length, 2); assert.equal(server.starts, 1); assert.equal(deletes(server).length, 1);
});

test("buffered silent leg closes before the header deadline and switches to full legs after output", async () => {
  const reads = [];
  const server = fixture(Array.from({ length: 4 }, (_, index) => (options) => {
    const requested = Number(new URL(server.calls.at(-1).url).searchParams.get("max_seconds"));
    reads.push(requested);
    if (index === 3) return new Response(record(1, { done: true }));
    // Reproduce a tunnel that exposes neither headers nor heartbeats until the
    // finite silent response closes. A normal90ms leg exceeds the30ms deadline.
    return new Promise((resolve, reject) => {
      const abort = () => { clearTimeout(timer); reject(options.signal.reason); };
      const timer = setTimeout(() => {
        options.signal.removeEventListener("abort", abort);
        resolve(new Response(index < 2 ? heartbeat(0) : record(0, { message: { content: "ready" } })));
      }, requested * 1000);
      options.signal.addEventListener("abort", abort, { once: true });
    });
  }));
  const values = await collect(server, { legSeconds: 0.09, prefillLegSeconds: 0.015, requestMs: 30, maxFailures: 0 });
  assert.deepEqual(reads, [0.015, 0.015, 0.015, 0.09]);
  assert.deepEqual(values.map(part => part.value), [{ message: { content: "ready" } }, { done: true }]);
  assert.equal(server.starts, 1); assert.equal(deletes(server).length, 1);
});

test("prefill duration never enlarges a caller's shorter leg", async () => {
  const server = fixture([record(0, { done: true })]);
  await collect(server, { legSeconds: 0.02 });
  assert.equal(new URL(server.calls[1].url).searchParams.get("max_seconds"), "0.02");
});

test("invalid prefill durations fail before creating a model job", async () => {
  for (const prefillLegSeconds of [0, -1, NaN, Infinity, 301, "15"]) {
    const server = fixture([]);
    await assert.rejects(collect(server, { prefillLegSeconds }), TypeError);
    assert.equal(server.calls.length, 0);
  }
});
