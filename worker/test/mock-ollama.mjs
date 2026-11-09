// Fake Ollama server for local tests.
//
//   node test/mock-ollama.mjs --port 11500        (or import { startMockOllama })
//
// Ollama API: GET /api/version, /api/tags, /api/ps and streaming POST /api/chat. A chat reply echoes
// the last user message and the context size; it streams thinking tokens first when the request
// has `think` on (true or an effort), adds a fenced code block when the last user message contains the word "code",
// and stops at options.num_predict tokens with done_reason "length". Stats are synthetic but
// fixed: eval_duration is 137 ms per token, so tokens_per_sec comes out at 7.3.
//
// Control API (always answers, even while "down"):
//   GET  /__mock/config            current behaviour
//   POST /__mock/config  {...}     merge into the behaviour:
//        tokenDelayMs        delay between tokens (default 5)
//        firstTokenDelayMs   delay before the first token
//        loadDelayMs         extra delay when the model is not loaded (it is loaded afterwards)
//        loaded              whether /api/ps lists the model
//        fillerTokens        extra content tokens per reply (makes generation long)
//        doneReason          force done_reason on the final chunk
//        errorAfterTokens    send {"error": …} after this many tokens
//        dropAfterTokens     destroy the connection after this many tokens
//        stallAfterTokens    go silent (connection kept open) after this many tokens
//   POST /__mock/fail   {status, count}   the next `count` chat calls answer HTTP `status`
//   POST /__mock/down | /__mock/up        while down, every /api/* connection is destroyed
//   GET  /__mock/last-chat                the last /api/chat request body (or null)
//   GET  /__mock/last-chat-headers        the request headers of that call (or null)
//   GET  /__mock/stats                    {chatCalls, completed, aborted, failed, active}
//   POST /__mock/reset                    back to defaults, counters zeroed

import http from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";

const DEFAULT_MODEL = "qwen3.8-hauhau";
const MS_PER_TOKEN = 137;

const DEFAULT_BEHAVIOUR = Object.freeze({
  tokenDelayMs: 5,
  firstTokenDelayMs: 0,
  loadDelayMs: 0,
  loaded: true,
  fillerTokens: 0,
  doneReason: null,
  errorAfterTokens: null,
  errorMessage: 'mock: simulated failure',
  dropAfterTokens: null,
  eofAfterTokens: null,
  stallAfterTokens: null,
  rawErrorAfterTokens: null,
  rawDropAfterTokens: null,
  rawEofAfterTokens: null,
  rawStallAfterTokens: null,
  rejectPromptAboveChars: null,
  memoryOutput: null,
  memoryOutputs: null,
  agentOutput: null,
  memoryTruncations: 0,
  thinkingTokens: 0,
  rawThinkingTokens: 0,
  draftOutput: null,
});

export const KAGGLE_TOKEN = "test-kaggle-token";

class MockOllama {
  constructor(model) {
    this.model = model;
    this.reset();
  }

  reset() {
    this.behaviour = { ...DEFAULT_BEHAVIOUR };
    this.loadedCtx = 24576;
    this.down = false;
    this.failures = { status: 0, count: 0 };
    this.lastChat = null;
    this.lastGenerate = null;
    this.lastChatHeaders = null;
    this.requests = [];
    this.stats = { chatCalls: 0, completed: 0, aborted: 0, failed: 0, active: 0 };
    // Kaggle's API (api.kaggle.com/v1/...), for the Start button.
    this.kaggle = { pushes: [], status: "QUEUED", failureMessage: "", statusCalls: 0, log: "" };
  }

  configure(patch) {
    for (const [key, value] of Object.entries(patch ?? {})) {
      if (!(key in DEFAULT_BEHAVIOUR)) throw new Error(`unknown mock setting: ${key}`);
      this.behaviour[key] = value;
    }
    return { ...this.behaviour };
  }

  failNext(status, count = 1) {
    this.failures = { status, count };
  }

  async handle(req, res) {
    const { pathname } = new URL(req.url, "http://mock");
    try {
      if (pathname.startsWith("/__mock/")) return await this.control(req, res, pathname);
      if (req.method === "POST" && pathname.startsWith("/v1/")) return await this.kaggleApi(req, res, pathname);
      if (this.down) return req.socket.destroy();
      if (req.method === "GET" && pathname === "/api/version") return sendJson(res, { version: "0.12.6-mock" });
      if (req.method === "GET" && pathname === "/api/tags") return sendJson(res, { models: [this.modelInfo()] });
      if (req.method === "GET" && pathname === "/api/ps") {
        const models = this.behaviour.loaded ? [{ ...this.modelInfo(), context_length: this.loadedCtx }] : [];
        return sendJson(res, { models });
      }
      if (req.method === "POST" && pathname === "/api/chat") return await this.chat(req, res);
      if (req.method === "POST" && pathname === "/api/generate") return await this.generate(req, res);
      res.writeHead(404, { "content-type": "text/plain" }).end("404 page not found");
    } catch (err) {
      if (!res.headersSent) sendJson(res, { error: String(err.message ?? err) }, 400);
      else res.destroy();
    }
  }

  /** Kaggle's API for one user, "tester", whose API token is "test-kaggle-token". */
  async kaggleApi(req, res, pathname) {
    if (req.headers.authorization !== `Bearer ${KAGGLE_TOKEN}`) return sendJson(res, { code: 16, message: "Unauthenticated" }, 401);
    const body = await readJson(req);
    switch (pathname) {
      case "/v1/security.OAuthService/IntrospectToken":
        return sendJson(res, { active: body.token === KAGGLE_TOKEN, username: "tester" });
      case "/v1/kernels.KernelsApiService/SaveKernel":
        this.kaggle.pushes.push(body);
        return sendJson(res, { ref: `/code/${body.slug}`, url: `https://www.kaggle.com/code/${body.slug}`, versionNumber: this.kaggle.pushes.length });
      case "/v1/kernels.KernelsApiService/GetKernelSessionStatus":
        this.kaggle.statusCalls++;
        return sendJson(res, { status: this.kaggle.status, failureMessage: this.kaggle.failureMessage });
      case "/v1/kernels.KernelsApiService/ListKernelSessionOutput":
        return sendJson(res, { files: [], log: this.kaggle.log });
      case "/v1/kernels.KernelsApiService/GetKernelSessionLogsStream": {
        // A running session's log as Server-Sent Events, ending with Kaggle's sentinel.
        res.writeHead(200, { "content-type": "text/event-stream" });
        for (const data of ["live line 1\n", "live line 2\n"]) res.write(`data: ${JSON.stringify({ stream_name: "stdout", time: 1, data })}\n\n`);
        return res.end("data: END_OF_LOG\n\n");
      }
    }
    return sendJson(res, { message: `no such method ${pathname}` }, 404);
  }

  async control(req, res, pathname) {
    const route = `${req.method} ${pathname.slice("/__mock".length)}`;
    switch (route) {
      case "GET /config":
        return sendJson(res, this.behaviour);
      case "POST /config":
        return sendJson(res, this.configure(await readJson(req)));
      case "POST /fail": {
        const { status, count = 1 } = await readJson(req);
        this.failNext(status, count);
        return sendJson(res, this.failures);
      }
      case "POST /down":
      case "POST /up":
        this.down = pathname.endsWith("/down");
        return sendJson(res, { down: this.down });
      case "GET /last-chat":
        return sendJson(res, this.lastChat);
      case "GET /last-chat-headers":
        return sendJson(res, this.lastChatHeaders);
      case "GET /stats":
        return sendJson(res, this.stats);
      case "POST /reset":
        this.reset();
        return sendJson(res, { ok: true });
      default:
        return sendJson(res, { error: `no mock control ${route}` }, 404);
    }
  }

  async chat(req, res) {
    const body = await readJson(req);
    this.lastChat = body;
    this.requests.push({path:'/api/chat',body});
    this.lastChatHeaders = { ...req.headers };
    this.stats.chatCalls++;
    if (this.failures.count > 0) {
      this.failures.count--;
      this.stats.failed++;
      res.writeHead(this.failures.status, { "content-type": "text/plain" });
      return res.end(`error code: ${this.failures.status}`);
    }

    const b = { ...this.behaviour };
    if (b.rejectPromptAboveChars != null && JSON.stringify(body.messages ?? []).length > b.rejectPromptAboveChars) {
      this.stats.failed++;
      return sendJson(res, { error: "the input length exceeds the context length" }, 400);
    }
    const startedAt = performance.now();
    let open = true;
    this.stats.active++;
    res.on("close", () => {
      open = false;
      this.stats.active--;
      if (!res.writableFinished) this.stats.aborted++;
    });

    if (!b.loaded) {
      await delay(b.loadDelayMs);
      this.behaviour.loaded = true;
    }
    this.loadedCtx = body.options?.num_ctx ?? this.loadedCtx;
    await delay(b.firstTokenDelayMs);

    const lastUser = [...(body.messages ?? [])].reverse().find((m) => m.role === "user")?.content ?? "";
    // Any think level (true, "medium", "low") reasons first, like the real model.
    const thinking = body.think === true || body.think === "medium" || body.think === "low" ? [...tokenize(thinkingText(lastUser)), ...filler(b.thinkingTokens)] : [];
    const content = [...tokenize(body.format?.properties?.action ? (b.agentOutput ?? '{"action":"answer","message":"Mock agent done."}') : replyText(lastUser, body.messages ?? [])), ...filler(b.fillerTokens)];
    const tokens = [...thinking.map((t) => ["thinking", t]), ...content.map((t) => ["content", t])];
    const limit = body.options?.num_predict ?? Infinity;

    res.writeHead(200, { "content-type": "application/x-ndjson" });
    let produced = 0;
    for (const [kind, text] of tokens) {
      if (!open) return;
      if (produced >= limit) break;
      if (produced === b.errorAfterTokens) return res.end(line({ error: b.errorMessage }));
      if (produced === b.dropAfterTokens) return req.socket.destroy();
      if (produced === b.eofAfterTokens) return res.end();
      if (produced === b.stallAfterTokens) return; // stays open until the client hangs up
      const message = { role: "assistant", content: kind === "content" ? text : "" };
      if (kind === "thinking") message.thinking = text;
      await write(res, line({ model: body.model, created_at: new Date().toISOString(), message, done: false }));
      produced++;
      if (b.tokenDelayMs > 0) await delay(b.tokenDelayMs);
      else await new Promise(setImmediate);
    }
    if (!open) return;
    res.end(
      line({
        model: body.model,
        created_at: new Date().toISOString(),
        message: { role: "assistant", content: "" },
        done: true,
        done_reason: b.doneReason ?? (produced < tokens.length ? "length" : "stop"),
        total_duration: Math.round((performance.now() - startedAt) * 1e6),
        load_duration: 0,
        prompt_eval_count: Math.ceil(JSON.stringify(body.messages ?? []).length / 4),
        prompt_eval_duration: 1e6,
        eval_count: produced,
        eval_duration: produced * MS_PER_TOKEN * 1e6,
      }),
    );
    this.stats.completed++;
  }

  /**
   * Raw continuation (POST /api/generate, raw: true). Inside an open <think> it finishes the reasoning
   * (with "</think>" split across two chunks, as real tokenizers do) and then answers; otherwise it
   * just continues the answer.
   */
  async generate(req, res) {
    const body = await readJson(req);
    this.lastGenerate = body;
    this.requests.push({path:'/api/generate',body});
    this.stats.chatCalls++;
    const b = { ...this.behaviour };
    if (b.rejectPromptAboveChars != null && String(body.prompt ?? "").length > b.rejectPromptAboveChars) {
      this.stats.failed++;
      return sendJson(res, { error: "the input length exceeds the context length" }, 400);
    }
    let open = true;
    this.stats.active++;
    res.on("close", () => {
      open = false;
      this.stats.active--;
      if (!res.writableFinished) this.stats.aborted++;
    });
    const prompt = String(body.prompt ?? "");
    const memoryRequest = Boolean(body.format?.properties?.goals);
    const source = prompt.split("<conversation_source>\n").at(-1).split("\n</conversation_source>")[0];
    const memory = Object.fromEntries(["goals", "constraints", "decisions", "facts", "artifacts", "next_steps", "corrections"].map(key => [key, []]));
    memory.facts = [source.slice(0, 160) + " mock detail".repeat(b.fillerTokens)];
    const draft = /<unfinished_assistant_source start="(\d+)" end="(\d+)">\n([\s\S]*?)\n<\/unfinished_assistant_source>/.exec(prompt);
    if(draft)memory.facts=[`[draft ${draft[1]}-${draft[2]}] ${draft[3].slice(0,100)} ... ${draft[3].slice(-100)}`];
    const truncatedMemory = memoryRequest && b.memoryTruncations > 0;
    if (truncatedMemory) this.behaviour.memoryTruncations--;
    const reply = prompt.slice(prompt.lastIndexOf("<|im_start|>assistant\n"));
    const thinkingOpen = reply.includes("<think>") && !reply.includes("</think>");
    const queuedMemory=memoryRequest&&b.memoryOutputs?.length?this.behaviour.memoryOutputs.shift():null;
    const tokens = memoryRequest ? tokenize((draft?b.draftOutput:null) ?? queuedMemory ?? b.memoryOutput ?? JSON.stringify(memory)) : thinkingOpen
      ? [" and so", " on.", ...filler(b.rawThinkingTokens), "</th", "ink>\n\n", "Continued ", "answer.", ...filler(b.fillerTokens)]
      : [" continued", " answer.", ...filler(b.fillerTokens)];
    const limit = body.options?.num_predict ?? Infinity;
    await delay(b.firstTokenDelayMs);
    res.writeHead(200, { "content-type": "application/x-ndjson" });
    let produced = 0;
    for (const text of tokens) {
      if (!open) return;
      if (produced >= limit) break;
      if (!memoryRequest) {
        if (produced === b.rawErrorAfterTokens) return res.end(line({ error: b.errorMessage }));
        if (produced === b.rawDropAfterTokens) return req.socket.destroy();
        if (produced === b.rawEofAfterTokens) return res.end();
        if (produced === b.rawStallAfterTokens) return;
      }
      await write(res, line({ model: body.model, created_at: new Date().toISOString(), response: text, done: false }));
      produced++;
      if (b.tokenDelayMs > 0) await delay(b.tokenDelayMs);
      else await new Promise(setImmediate);
    }
    if (!open) return;
    res.end(
      line({
        model: body.model,
        created_at: new Date().toISOString(),
        response: "",
        done: true,
        done_reason: truncatedMemory ? "length" : b.doneReason ?? (produced < tokens.length ? "length" : "stop"),
        eval_count: produced,
        eval_duration: produced * MS_PER_TOKEN * 1e6,
        prompt_eval_count: Math.ceil(prompt.length / 4),
        total_duration: 1e6,
      }),
    );
    this.stats.completed++;
  }

  modelInfo() {
    return {
      name: `${this.model}:latest`,
      model: `${this.model}:latest`,
      size: 12_000_000_000,
      details: { family: "qwen3", parameter_size: "27B", quantization_level: "IQ3_M" },
    };
  }
}

function replyText(lastUser, messages) {
  const echo = lastUser.replace(/\s+/g, " ").trim().slice(0, 80);
  let text = `You said: "${echo}". I can see ${messages.length} message${messages.length === 1 ? "" : "s"} of context.`;
  if (/\bcode\b/i.test(lastUser)) {
    text += '\n\n```python\ndef greet(name):\n    return f"Hello, {name}!"\n\nprint(greet("mock"))\n```\n';
  }
  return text;
}

function thinkingText(lastUser) {
  return `The user wrote ${lastUser.length} characters. I will answer briefly.`;
}

function tokenize(text) {
  return text.match(/\s*\S+|\s+/g) ?? [];
}

function filler(count) {
  return Array.from({ length: count }, (_, i) => ` word${i}`);
}

function line(value) {
  return JSON.stringify(value) + "\n";
}

async function write(res, chunk) {
  if (!res.write(chunk)) await new Promise((resolve) => res.once("drain", resolve).once("close", resolve));
}

function sendJson(res, value, status = 200) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" }).end(JSON.stringify(value));
}

async function readJson(req) {
  let raw = "";
  for await (const part of req) raw += part;
  return raw ? JSON.parse(raw) : {};
}

/**
 * Starts the mock on 127.0.0.1. The returned handle drives it in-process with the same operations
 * the /__mock/ control endpoints expose.
 */
export async function startMockOllama({ port = 0, model = DEFAULT_MODEL } = {}) {
  const mock = new MockOllama(model);
  const server = http.createServer((req, res) => mock.handle(req, res));
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  const url = `http://127.0.0.1:${server.address().port}`;
  return {
    url,
    configure: (patch) => mock.configure(patch),
    failNext: (status, count) => mock.failNext(status, count),
    setDown: (down) => {
      mock.down = down;
    },
    lastChat: () => mock.lastChat,
    lastGenerate: () => mock.lastGenerate,
    lastChatHeaders: () => mock.lastChatHeaders,
    requests: () => [...mock.requests],
    kagglePushes: () => mock.kaggle.pushes,
    setKaggleStatus: (status, failureMessage = "") => Object.assign(mock.kaggle, { status, failureMessage }),
    setKaggleLog: (log) => Object.assign(mock.kaggle, { log }),
    resetKaggle: () => {
      mock.kaggle = { pushes: [], status: "QUEUED", failureMessage: "", statusCalls: 0, log: "" };
    },
    stats: () => ({ ...mock.stats }),
    reset: () => mock.reset(),
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

if (import.meta.main) {
  const { values } = parseArgs({ options: { port: { type: "string", default: "11500" } } });
  const mock = await startMockOllama({ port: Number(values.port) });
  console.log(`MOCK ${mock.url}`);
  const shutdown = () => mock.close().then(() => process.exit(0));
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
