// Client for the relay's /v1 API. Every failure surfaces as an ApiError with the server's code and
// human-readable message, so views can show it as is.

import { storage } from "./dom.js";

const KEY_STORAGE = "qwen.relayKey";

export class ApiError extends Error {
  /** `details` is the server's error object (e.g. `{ busy }` for 409). */
  constructor(status, code, message, details = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

/** The x-relay-key sent with every request when the relay runs with AUTH_MODE=key. */
export const relayKey = {
  get: () => storage.get(KEY_STORAGE),
  set: (value) => storage.set(KEY_STORAGE, value || null),
};

async function request(path, { method = "GET", body, signal } = {}) {
  const headers = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  const key = relayKey.get();
  if (key) headers["x-relay-key"] = key;

  let response;
  try {
    response = await fetch(path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
      cache: "no-store",
    });
  } catch (err) {
    if (signal?.aborted) throw err;
    throw new ApiError(0, "network", "Can't reach the relay. Check your internet connection.");
  }
  if (!response.ok) throw await toApiError(response);
  return response;
}

async function toApiError(response) {
  let error = {};
  try {
    error = (await response.json()).error ?? {};
  } catch {
    // not a JSON error body (a proxy or the platform answered)
  }
  return new ApiError(
    response.status,
    error.code ?? `http_${response.status}`,
    error.message ?? `The relay answered HTTP ${response.status}.`,
    error,
  );
}

const json = (response) => response.json();

export const api = {
  config: () => request("/v1/config").then(json),

  status: (signal) => request("/v1/status", { signal }).then(json),

  /** The reply another device is generating in this chat so far, or null. */
  live: (id, signal) =>
    request(`/v1/chats/${encodeURIComponent(id)}/live`, { signal })
      .then(json)
      .then((body) => body.live),

  /** Stops the reply being generated, whichever device started it. Resolves to `{ stopped, busy }`. */
  stop: (scope) => request("/v1/stop", { method: "POST", ...(scope ? {body:scope,signal:AbortSignal.timeout(10_000)} : {}) }).then(json),

  /** Starts the server on Kaggle (needs the Kaggle API token on the server). Resolves to `{ url }`. */
  startServer: () => request("/v1/server/start", { method: "POST" }).then(json),

  /** Operational logs for the selected notebook host; omitted host follows the active server. */
  serverLog: (host, signal) => request(`/v1/server/log${host ? `?host=${encodeURIComponent(host)}` : ""}`, { signal }).then(json),

  /** Asks the running notebook to shut down; only servers that take commands (Kaggle) can. */
  shutdownServer: () => request("/v1/server/shutdown", { method: "POST" }).then(json),

  /** Gives the GPUs to "chat" or "images" (the notebook runs one at a time). */
  setMode: (mode) => request("/v1/server/mode", { method: "POST", body: { mode } }).then(json),

  /** `{ images, has_more }`, newest first; `before` (ISO) pages back. */
  images: (before, signal) => request(`/v1/images${before ? `?before=${encodeURIComponent(before)}` : ""}`, { signal }).then(json),

  /** Queues a picture: `{ prompt, negative?, aspect, speed, seed? }` → `{ image }`. */
  createImage: (body) => request("/v1/images", { method: "POST", body }).then(json),

  deleteImage: (id) => request(`/v1/images/${encodeURIComponent(id)}`, { method: "DELETE" }).then(json),

  /** Where a finished picture is served: its WebP preview, or the PNG. */
  imageUrl: (id, size = "full") => `/v1/images/${encodeURIComponent(id)}/file${size === "thumb" ? "?size=thumb" : ""}`,

  /** Resolves to `{ settings, defaults, limits }`. */
  settings: () => request("/v1/settings").then(json),

  /** Saves some settings (null resets one to its default). Resolves to the full settings. */
  saveSettings: (patch) =>
    request("/v1/settings", { method: "PUT", body: patch })
      .then(json)
      .then((body) => body.settings),

  listChats: (query = "", signal) =>
    request(query ? `/v1/chats?q=${encodeURIComponent(query)}` : "/v1/chats", { signal })
      .then(json)
      .then((body) => body.chats),

  createChat: (id) =>
    request("/v1/chats", { method: "POST", body: { id } })
      .then(json)
      .then((body) => body.chat),

  /** Resolves to `{ chat, messages }`. */
  getChat: (id, signal) => request(`/v1/chats/${encodeURIComponent(id)}`, { signal }).then(json),

  /** Read the existing checkpoint only; reviewing memory never starts GPU work. */
  memory: (id, signal) => request(`/v1/chats/${encodeURIComponent(id)}/memory`, { signal }).then(json),

  /** The same context plan used by the next turn, including an optional unsent draft. */
  context: (id, body, signal) => request(id ? `/v1/chats/${encodeURIComponent(id)}/context` : "/v1/context", { method: "POST", body, signal }).then(json),

  /** Saves complete text without starting GPU work. Each reading run requires fresh consent. */
  createLongInput: (id, body, signal) => request(`/v1/chats/${encodeURIComponent(id)}/long-inputs`, { method: "POST", body, signal }).then(json),
  longInputs: (id, signal) => request(`/v1/chats/${encodeURIComponent(id)}/long-inputs`, { signal }).then(json),
  async longInputSource(id, sourceId, signal) {
    const response = await request(`/v1/chats/${encodeURIComponent(id)}/long-inputs/${encodeURIComponent(sourceId)}/source`, { signal });
    const disposition = response.headers.get("content-disposition") ?? "";
    return { blob: await response.blob(), filename: /filename="([^"]+)"/.exec(disposition)?.[1] ?? "long-input.txt" };
  },
  async *runLongInput(id, sourceId, signal) {
    const response = await request(`/v1/chats/${encodeURIComponent(id)}/long-inputs/${encodeURIComponent(sourceId)}/run`, { method: "POST", body: { consent: true }, signal });
    yield* readNdjson(response.body, signal);
  },

  /** Summarizes earlier messages without replacing the saved transcript. */
  async *compact(id, signal) {
    const response = await request(`/v1/chats/${encodeURIComponent(id)}/compact`, { method: "POST", body: {}, signal });
    yield* readNdjson(response.body, signal);
  },

  renameChat: (id, title) =>
    request(`/v1/chats/${encodeURIComponent(id)}`, { method: "PATCH", body: { title } })
      .then(json)
      .then((body) => body.chat),

  deleteChat: (id) => request(`/v1/chats/${encodeURIComponent(id)}`, { method: "DELETE" }).then(json),

  /** Resolves to `{ blob, filename }` for the chat's Markdown export. */
  async exportChat(id) {
    const response = await request(`/v1/chats/${encodeURIComponent(id)}/export`);
    const disposition = response.headers.get("content-disposition") ?? "";
    const filename = /filename="([^"]+)"/.exec(disposition)?.[1] ?? "chat.md";
    return { blob: await response.blob(), filename };
  },

  /**
   * Starts a turn and yields its NDJSON events. Errors before the stream starts (busy, offline,
   * bad input) reject the first iteration with an ApiError; aborting `signal` stops the reply.
   */
  async *turn(id, body, signal) {
    const response = await request(`/v1/chats/${encodeURIComponent(id)}/turn`, { method: "POST", body, signal });
    yield* readNdjson(response.body, signal);
  },
};

/**
 * Continues the chat's last reply where it stopped; yields the same events as a turn. `think`: the
 * reasoning effort to carry on with (true, "medium" or "low"); false finishes the answer.
 */
api.continueReply = async function* (id, signal, think = true) {
  const body = { think };
  const response = await request(`/v1/chats/${encodeURIComponent(id)}/continue`, { method: "POST", body, signal });
  yield* readNdjson(response.body, signal);
};

// A proxy may deliver many real events in one read. Async-generator yields alone
// stay in the microtask queue, starving paint, scrolling and Stop until it drains.
// Give the browser a task boundary after a short processing budget; individual
// arrivals are still delivered immediately, without a typing queue or delay.
const STREAM_DRAIN_MS = 8;
async function yieldForBrowser() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function* readNdjson(stream, signal) {
  const reader = stream.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  let finished = false;
  let drainStarted = performance.now();
  const checkAbort = () => {
    if (signal?.aborted) throw signal.reason ?? new DOMException("The operation was aborted.", "AbortError");
  };
  try {
    for (;;) {
      checkAbort();
      const { value, done } = await reader.read();
      if (done) break;
      buffer += value;
      let newline;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        checkAbort();
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line) yield JSON.parse(line);
        if (performance.now() - drainStarted >= STREAM_DRAIN_MS) {
          await yieldForBrowser();
          drainStarted = performance.now();
        }
      }
    }
    finished = true;
    checkAbort();
    if (buffer.trim()) yield JSON.parse(buffer);
  } finally {
    if (!finished) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/** 16 random bytes as base64url, the same shape the server generates. */
export function newChatId() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
