// Resumable Ollama transport. One model job survives bounded tunnel connections.
// Origin JSON bytes stay intact; reconnects resume an authenticated cursor.
const encoder = new TextEncoder();
const RETRY_STATUS = new Set([502, 503, 504, 520, 521, 522, 523, 524, 525, 526, 527, 530]);
const MAX_PAYLOAD = 2 * 1024 * 1024 + 256 * 1024;
export const JOB_PAYLOAD_LIMIT = 4 * 1024 * 1024;

export class JobsTransportError extends Error {
  constructor(code, message, { status = 502, upstreamStatus = null } = {}) {
    super(message);
    this.name = "JobsTransportError";
    this.code = code;
    this.status = status;
    this.upstreamStatus = upstreamStatus;
  }
}

/** Return raw JSON bytes eligible for jobs, otherwise null without consuming streams. */
export function eligibleJobPayload(request, body, maxBytes = MAX_PAYLOAD) {
  const url = new URL(request.url);
  if (request.method !== "POST" || url.search || !["/api/chat", "/api/generate"].includes(url.pathname)) return null;
  const type = (request.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  const encoding = request.headers.get("content-encoding");
  if ((type && type !== "application/json") || (encoding && encoding !== "identity")) return null;
  const bytes = typeof body === "string" ? encoder.encode(body)
    : body instanceof Uint8Array ? body : body instanceof ArrayBuffer ? new Uint8Array(body) : null;
  if (!bytes || bytes.byteLength > maxBytes) return null;
  try {
    const value = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes));
    if (!value || typeof value !== "object" || Array.isArray(value) || (value.stream != null && value.stream !== true)) return null;
    return bytes;
  } catch { return null; }
}

function randomIdentity(bytes) {
  const value = new Uint8Array(bytes);
  crypto.getRandomValues(value);
  return btoa(String.fromCharCode(...value)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

export function jobStartBytes(path, payload, id, token) {
  if (!["/api/chat", "/api/generate"].includes(path)) throw new TypeError("Unsupported model job path.");
  const bytes = typeof payload === "string" ? encoder.encode(payload) : payload;
  if (!(bytes instanceof Uint8Array)) throw new TypeError("Invalid model job payload.");
  if (bytes.byteLength > JOB_PAYLOAD_LIMIT) throw new JobsTransportError("payload_limit", "The assembled model request exceeded the 4 MiB relay limit. Compact the session or remove older pictures.", { status: 413 });
  const prefix = encoder.encode(JSON.stringify({ target: path, job_id: id, token }).slice(0, -1) + ',"body":');
  const result = new Uint8Array(prefix.length + bytes.length + 1);
  result.set(prefix); result.set(bytes, prefix.length); result[result.length - 1] = 125;
  return result;
}

/** Share one invocation's external request allowance across multiple summaries. */
export function createJobBudget(limit = 40) {
  if (!Number.isInteger(limit) || limit < 3 || limit > 45) throw new TypeError("Invalid job request budget.");
  return { used: 0, limit };
}

/**
 * Yields {value, line}; line is the origin record's original JSON text plus LF.
 * The same id/token and next cursor are reused after upload ACK or stream loss.
 * Breaking/aborting the iterator cancels the known model job, even if POST's ACK
 * was lost. Reaching a leg boundary never cancels or restarts model inference.
 *
 * maxRequests reserves its final request for DELETE. Default 40 leaves room below
 * Workers' 50-external-subrequest plan limit for the caller's probes/other work.
 */
export async function* streamJobRecords({
  target, path = "/api/chat", payload, signal,
  fetchImpl = fetch, legSeconds = 90, prefillLegSeconds = 15, maxRequests = 40,
  maxJobMs = 30 * 60_000, requestMs = 30_000, idleMs = 30_000,
  retryMs = 1000, maxFailures = 18, identity = null, onHeartbeat = null, requestBudget = null,
  reloadTarget = null, recoveryMs = 90_000,
}) {
  if (!Number.isFinite(legSeconds) || legSeconds <= 0 || legSeconds > 300) throw new TypeError("Invalid job stream leg duration.");
  if (!Number.isFinite(prefillLegSeconds) || prefillLegSeconds <= 0 || prefillLegSeconds > 300) throw new TypeError("Invalid prefill stream leg duration.");
  if (!Number.isInteger(maxRequests) || maxRequests < 3 || maxRequests > 45) throw new TypeError("Invalid job request budget.");
  const id = identity?.id ?? randomIdentity(24), token = identity?.token ?? randomIdentity(32);
  if (!/^[A-Za-z0-9_-]{24,128}$/.test(id) || !/^[A-Za-z0-9_-]{43,128}$/.test(token)) throw new TypeError("Invalid job identity.");
  const startBody = jobStartBytes(path, payload, id, token);
  const budget = requestBudget ?? createJobBudget(maxRequests);
  if (!Number.isInteger(budget.limit) || budget.limit < 3 || budget.limit > 45 || !Number.isInteger(budget.used) || budget.used < 0 || budget.used > budget.limit) throw new TypeError("Invalid shared job request budget.");
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(new JobsTransportError("job_timeout", "The model job exceeded its runtime limit.")), maxJobMs);
  const activeSignal = signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal;
  const auth = { authorization: `Bearer ${token}` };
  let cursor = 0, attemptedStart = false, acknowledged = false, receivedRecord = false;

  const call = async (url, options, timeoutMs) => {
    activeSignal.throwIfAborted();
    if (budget.used >= budget.limit - 1) throw new JobsTransportError("request_limit", "This operation exceeded its model connection limit. Please retry with less history.");
    budget.used++;
    if (options.method === "POST") attemptedStart = true;
    const headers = new AbortController();
    const headersTimer = setTimeout(() => headers.abort(new Error("The model job did not return headers in time.")), Math.min(requestMs, timeoutMs));
    try {
      // A tunnel that never returns headers must be retried well before the
      // notebook's120s idle reaper. Once headers arrive, this shorter timer is
      // cleared and the normal90s response leg keeps its full body allowance.
      return await fetchImpl(url, { ...options, signal: AbortSignal.any([activeSignal, headers.signal, AbortSignal.timeout(timeoutMs)]) });
    } finally { clearTimeout(headersTimer); }
  };
  const pause = (failures) => delay(Math.min(retryMs * Math.max(1, failures), 5000), activeSignal);

  try {
    const startDeadline = Date.now() + recoveryMs;
    for (let failures = 0; !acknowledged;) {
      activeSignal.throwIfAborted();
      try {
        const response = await call(`${target}/_jobs`, { method: "POST", headers: { "content-type": "application/json" }, body: startBody }, Math.max(1, Math.min(requestMs, startDeadline - Date.now())));
        if (!response.ok) {
          const error = await responseError(response);
          if (!RETRY_STATUS.has(response.status)) throw error;
          throw new RetryableJobError(error.message);
        }
        const reply = JSON.parse(await limitedText(response.body, 4096));
        if (reply.id !== id || reply.token !== token || reply.cursor !== 0) throw new JobsTransportError("invalid_start", "The model job returned an invalid acknowledgement.");
        acknowledged = true;
      } catch (error) {
        activeSignal.throwIfAborted();
        if (error instanceof JobsTransportError) throw error;
        if (++failures > maxFailures || Date.now() >= startDeadline) throw new JobsTransportError("start_unreachable", "The model job could not be started reliably.");
        await pause(failures);
      }
    }

    let failures = 0, recoveryDeadline = null, candidateTarget = null;
    const refreshTarget = async () => {
      const current = await reloadTarget?.().catch(() => null);
      if (typeof current === "string" && current) candidateTarget = current;
    };
    for (;;) {
      activeSignal.throwIfAborted();
      const legStarted = Date.now();
      let legProgress = false;
      try {
        const readTarget = candidateTarget ?? target;
        // A finite short response also crosses tunnels that buffer silent-prefill
        // heartbeats. Once model records flow, retain the normal streaming leg.
        const activeLegSeconds = receivedRecord ? legSeconds : Math.min(prefillLegSeconds, legSeconds);
        const timeoutMs = recoveryDeadline === null ? activeLegSeconds * 1000 + requestMs : Math.max(1, Math.min(activeLegSeconds * 1000 + requestMs, recoveryDeadline - Date.now()));
        const response = await call(`${readTarget}/_jobs/${id}/stream?cursor=${cursor}&max_seconds=${activeLegSeconds}`, { headers: auth }, timeoutMs);
        if (!response.ok) {
          const error = await responseError(response);
          if (!RETRY_STATUS.has(response.status)) throw error;
          throw new RetryableJobError(error.message);
        }
        // Only a successful authenticated read proves the new tunnel owns this
        // same job. A new server's404 is fatal and never triggers a fresh POST.
        target = readTarget; candidateTarget = null;
        for await (const line of boundedLines(response.body, activeSignal, idleMs)) {
          if (!line.trim()) continue;
          let envelope;
          try { envelope = JSON.parse(line); }
          catch { throw new JobsTransportError("invalid_envelope", "The model job returned unreadable transport data."); }
          if (!envelope || typeof envelope !== "object" || !Number.isSafeInteger(envelope.cursor) || envelope.cursor < 0) {
            throw new JobsTransportError("invalid_cursor", "The model job returned an invalid cursor.");
          }
          if (Object.hasOwn(envelope, "record")) {
            if (envelope.cursor < cursor) continue; // A replayed line must not duplicate output.
            if (envelope.cursor !== cursor) throw new JobsTransportError("cursor_gap", "The model job omitted part of its response.");
            const raw = memberText(line, "record");
            const value = envelope.record;
            if (!raw || !value || typeof value !== "object" || Array.isArray(value)) throw new JobsTransportError("invalid_record", "The model returned an invalid response record.");
            cursor++; receivedRecord = true; legProgress = true; failures = 0; recoveryDeadline = null;
            const upstreamStatus = validStatus(envelope.upstreamStatus) ? envelope.upstreamStatus : null;
            yield { value, line: raw + "\n", upstreamStatus };
            if (value.done === true || Object.hasOwn(value, "error") || (upstreamStatus !== null && upstreamStatus >= 300)) return;
          } else if (Object.hasOwn(envelope, "upstreamError")) {
            if (envelope.cursor < cursor) continue;
            if (envelope.cursor !== cursor) throw new JobsTransportError("cursor_gap", "The model job omitted part of its response.");
            const status = envelope.upstreamError?.status;
            if (!validStatus(status)) throw new JobsTransportError("invalid_envelope", "The model job returned an invalid upstream status.");
            cursor++;
            throw new JobsTransportError("upstream_http_error", String(envelope.upstreamError.body || `The model answered HTTP ${status}.`).slice(0, 1000), { status, upstreamStatus: status });
          } else if (envelope.heartbeat === true) {
            if (envelope.cursor !== cursor) throw new JobsTransportError("cursor_gap", "The model job omitted part of its response.");
            legProgress = true; failures = 0; recoveryDeadline = null;
            await onHeartbeat?.({ upstreamStatus: validStatus(envelope.upstreamStatus) ? envelope.upstreamStatus : null });
          } else if (envelope.done === true) {
            if (envelope.cursor !== cursor) throw new JobsTransportError("cursor_gap", "The model job omitted part of its response.");
            if (envelope.status === "completed") throw new JobsTransportError("upstream_eof", "The model stream ended before completion. Please retry.");
            throw new JobsTransportError(envelope.error?.code || "job_failed", envelope.error?.message || "The model job failed.", { upstreamStatus: envelope.upstreamStatus, status: validStatus(envelope.upstreamStatus) && envelope.upstreamStatus >= 300 ? envelope.upstreamStatus : 502 });
          } else throw new JobsTransportError("invalid_envelope", "The model job returned an unsupported transport record.");
        }
      } catch (error) {
        activeSignal.throwIfAborted();
        if (error instanceof JobsTransportError) throw error;
        recoveryDeadline ??= Date.now() + recoveryMs;
        if (++failures > maxFailures || Date.now() >= recoveryDeadline) throw new JobsTransportError("stream_unreachable", "The model connection could not be restored. Please retry.");
        await refreshTarget();
        await pause(failures);
        continue;
      }
      // EOF closes only this leg. Reattach to the same job and next cursor.
      if (!legProgress && Date.now() - legStarted < 1000) {
        recoveryDeadline ??= Date.now() + recoveryMs;
        if (++failures > maxFailures || Date.now() >= recoveryDeadline) throw new JobsTransportError("empty_legs", "The model connection repeatedly closed without progress.");
        await refreshTarget();
        await pause(failures);
      }
    }
  } finally {
    clearTimeout(timer);
    if (attemptedStart) {
      // Do not use the aborted request's signal for cleanup. The identity is known
      // before POST, so this also covers a model start whose reply was lost.
      try {
        budget.used++;
        const response = await fetchImpl(`${target}/_jobs/${id}`, { method: "DELETE", headers: auth, signal: AbortSignal.timeout(Math.min(requestMs, 5000)) });
        await response.body?.cancel();
      } catch { /* The server also has bounded idle/runtime cleanup. */ }
    }
  }
}

class RetryableJobError extends Error {}
const validStatus = (value) => Number.isInteger(value) && value >= 200 && value <= 599;

/** Build the raw Ollama response with bounded buffering and outer keepalives.
 * Wait for the first record/heartbeat/error to choose the best known HTTP status.
 * Errors discovered after keepalives committed HTTP 200 remain explicit NDJSON.
 */
export async function jobResponse(options) {
  const abort = new AbortController();
  const signal = options.signal ? AbortSignal.any([options.signal, abort.signal]) : abort.signal;
  let controller, wake = null, gone = false, settled = false, resolveReady, rejectReady;
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  const commit = (status) => { if (!settled) { settled = true; resolveReady(status); } };
  const notify = () => { const resume = wake; wake = null; resume?.(); };
  const write = async (value) => {
    signal.throwIfAborted();
    while (!gone && controller.desiredSize <= 0) { await new Promise((resolve) => { wake = resolve; }); signal.throwIfAborted(); }
    if (gone) throw new Error("The raw inference client disconnected.");
    controller.enqueue(typeof value === "string" ? encoder.encode(value) : value);
  };
  const disconnect = () => { notify(); if (!settled) { settled = true; rejectReady(signal.reason); } };
  signal.addEventListener("abort", disconnect, { once: true });
  const body = new ReadableStream({
    start(value) { controller = value; },
    pull() { notify(); },
    cancel(reason) { gone = true; abort.abort(reason); notify(); },
  });
  const run = async () => {
    try {
      for await (const part of streamJobRecords({ ...options, signal, onHeartbeat: async (metadata) => {
        await options.onHeartbeat?.(metadata);
        // If the HTTP failure is already known, wait for its error record before
        // selecting a status. Otherwise an initial heartbeat keeps prefill alive.
        if (metadata.upstreamStatus !== null && metadata.upstreamStatus >= 300 && !settled) return;
        commit(200); await write(" ".repeat(16_384) + "\n");
      } })) {
        commit(part.upstreamStatus !== null && part.upstreamStatus >= 300 ? part.upstreamStatus : 200);
        await write(part.line);
      }
    } catch (error) {
      if (!signal.aborted && !gone) {
        commit(error instanceof JobsTransportError ? error.status : 502);
        await write(JSON.stringify({ error: error.message || "The model connection failed.", code: error.code || "model_connection", ...(error.upstreamStatus ? { upstream_status: error.upstreamStatus } : {}) }) + "\n").catch(() => {});
      } else if (!settled) { settled = true; rejectReady(signal.reason ?? error); }
    } finally {
      signal.removeEventListener("abort", disconnect);
      if (!gone) { try { controller.close(); } catch { /* Already cancelled. */ } }
    }
  };
  // The readable response owns this work. Cancellation aborts the generator,
  // whose finally DELETEs the model job using a separate cleanup signal.
  const running = run();
  // After a raw client's disconnect, keep the cancellation DELETE alive within
  // Workers' waitUntil grace. The visible response still streams immediately.
  options.waitUntil?.(running);
  void running;
  const status = await ready;
  return new Response(body, { status, headers: { "content-type": "application/x-ndjson", "cache-control": "no-store, no-transform" } });
}

async function responseError(response) {
  const source = await limitedText(response.body, 4096).catch(() => "");
  let parsed;
  try { parsed = JSON.parse(source); } catch { /* Generic HTTP message below. */ }
  return new JobsTransportError(parsed?.error?.code || "job_http", parsed?.error?.message || `The model job answered HTTP ${response.status}.`, { status: response.status });
}

async function limitedText(body, limit) {
  if (!body) return "";
  const reader = body.getReader(), decoder = new TextDecoder("utf-8", { fatal: true });
  let result = "", bytes = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) return result + decoder.decode();
      bytes += part.value.byteLength;
      if (bytes > limit) throw new JobsTransportError("response_limit", "The model job returned oversized transport metadata.");
      result += decoder.decode(part.value, { stream: true });
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

async function* boundedLines(body, signal, idleMs) {
  if (!body) throw new Error("Missing job stream body.");
  const reader = body.getReader(), decoder = new TextDecoder("utf-8", { fatal: true });
  const cancel = () => { reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", cancel, { once: true });
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await idleRead(reader.read(), idleMs);
      signal.throwIfAborted();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
        if (line.length > 2 * 1024 * 1024) throw new JobsTransportError("record_limit", "The model job returned an oversized transport record.");
        yield line;
      }
      if (buffer.length > 2 * 1024 * 1024) throw new JobsTransportError("record_limit", "The model job returned an oversized transport record.");
    }
    // A truncated final envelope belongs to the failed leg, not to the model
    // job. Reconnect at the last fully delivered cursor instead of parsing it.
  } finally {
    signal.removeEventListener("abort", cancel);
    await reader.cancel().catch(() => {}); reader.releaseLock();
  }
}

function idleRead(read, ms) {
  let timer;
  return Promise.race([read, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Job stream went quiet.")), ms); })])
    .finally(() => clearTimeout(timer));
}

function delay(ms, signal) {
  signal.throwIfAborted();
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const stop = () => { clearTimeout(timer); signal.removeEventListener("abort", stop); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", stop); resolve(); }, ms);
    signal.addEventListener("abort", stop, { once: true });
  });
}

/** Extract an already validated JSON object's original top-level member text. */
export function memberText(source, wanted) {
  const whitespace = (at) => { while (at < source.length && /\s/.test(source[at])) at++; return at; };
  const stringEnd = (at) => {
    for (at++; at < source.length; at++) {
      if (source[at] === "\\") at++;
      else if (source[at] === '"') return at + 1;
    }
    return at;
  };
  const valueEnd = (at) => {
    if (source[at] === '"') return stringEnd(at);
    if (source[at] === "{" || source[at] === "[") {
      let depth = 0;
      for (; at < source.length; at++) {
        const char = source[at];
        if (char === '"') at = stringEnd(at) - 1;
        else if (char === "{" || char === "[") depth++;
        else if ((char === "}" || char === "]") && --depth === 0) return at + 1;
      }
      return at;
    }
    while (at < source.length && !/[\s,}]/.test(source[at])) at++;
    return at;
  };
  let at = whitespace(source.indexOf("{") + 1), found = null;
  while (at < source.length && source[at] !== "}") {
    const keyEnd = stringEnd(at), key = JSON.parse(source.slice(at, keyEnd));
    const start = whitespace(whitespace(keyEnd) + 1), end = valueEnd(start);
    if (key === wanted) found = source.slice(start, end);
    at = whitespace(end); if (source[at] === ",") at = whitespace(at + 1);
  }
  return found;
}
