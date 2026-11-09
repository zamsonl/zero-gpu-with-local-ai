// Opens Ollama's /api/chat stream through the Colab tunnel and yields its NDJSON objects from the
// first token through `done`. Until the first token arrives it rides out the tunnel's bad moments
// (Cloudflare 524 while the model loads, a notebook restarting under a new URL) by retrying, and
// reports progress through `onStatus` so clients can show what is happening.

import { IdleTimeout, UpstreamError, findLoadedModel, getJson, readNdjson } from "./ollama.js";
import { sleep } from "./util.js";
import { JobsTransportError, streamJobRecords } from "./jobs-transport.js";

/** The model server stayed unreachable for the whole first-token window. */
export class OfflineError extends Error {}

class DeadlineReached extends Error {}

const DROPPED = "The connection to the model server dropped mid-reply.";

export function streamTiming(scale = 1) {
  return {
    firstTokenMs: 6 * 60_000 * scale, // give up when no token has arrived after this long
    retryStepMs: 5_000 * scale, // retry waits grow 5 s, 10 s, 15 s, …
    retryMaxMs: 30_000 * scale, // … capped here
    statusEveryMs: 10_000 * scale, // before the first token, clients hear from us at least this often
    idleMs: 120_000 * scale, // longest silence tolerated from the model server
    probeMs: 5_000,
  };
}

/**
 * @param {object} o
 * @param {string} o.target               the target registered when the turn started
 * @param {() => Promise<string|null>} o.reloadTarget  reads the registered target again
 * @param {object} o.body                 the /api/chat request body
 * @param {AbortSignal} o.signal          aborted when the client goes away
 * @param {ReturnType<typeof streamTiming>} o.timing
 * @param {(status: {state: string, detail: string, attempt: number}) => void} o.onStatus
 */
export async function* streamChat({ target, reloadTarget, body, signal, timing, onStatus, path = "/api/chat", transform = null, inferenceTransport = null, requestBudget = null }) {
  const deadline = Date.now() + timing.firstTokenMs;
  const status = new StatusTicker(onStatus, timing.statusEveryMs);
  const job = { payload: JSON.stringify(body), model: body.model, signal, deadline, timing, status, path, transform };
  try {
    if (inferenceTransport === "jobs-v1") {
      // A leg reconnect keeps the same job identity/cursor. A rotated tunnel
      // must authenticate that existing job; it never starts a new inference.
      yield* jobStream({ ...job, target, requestBudget, reloadTarget });
      return;
    }
    for (let attempt = 1; ; attempt++) {
      signal.throwIfAborted();
      // Colab may have re-registered under a new tunnel URL since the last attempt.
      if (attempt > 1) target = (await reloadTarget().catch(() => null)) ?? target;
      status.set("connecting", "Waiting for Qwen to start responding", attempt);

      const outcome = yield* attemptStream({ ...job, target, attempt });
      if (outcome.done) return;

      const left = deadline - Date.now();
      if (left <= 0) throw giveUp();
      const wait = Math.min(timing.retryStepMs * attempt, timing.retryMaxMs, left);
      status.set("retrying", `${outcome.retry}. Retrying in ${Math.ceil(wait / 1000)} s`, attempt + 1);
      status.hold("waiting", `Waiting to retry (attempt ${attempt + 1})`, attempt + 1);
      await sleep(wait, signal);
      if (Date.now() >= deadline) throw giveUp();
    }
  } finally {
    status.stop();
  }
}

/** Resumable tunnel legs, with the same first-token and Stop semantics as direct streams. */
async function* jobStream({ target, payload, signal, deadline, status, path, transform, requestBudget, reloadTarget }) {
  const controller = new AbortController();
  const forwardAbort = () => controller.abort(signal.reason);
  signal.addEventListener("abort", forwardAbort, { once: true });
  if (signal.aborted) controller.abort(signal.reason);
  const timer = setTimeout(() => controller.abort(new DeadlineReached()), Math.max(0, deadline - Date.now()));
  let started = false;
  status.set("connecting", "Waiting for Qwen to start responding", 1);
  try {
    // jobs-v1 itself proves the server is present; omit the parallel /api/ps
    // probe so multi-chunk compaction shares a predictable external-call budget.
    for await (const part of streamJobRecords({ target, path, payload, signal: controller.signal, requestBudget, reloadTarget })) {
      const raw = part.value;
      if (raw.error) throw new UpstreamError(`The model server reported an error: ${raw.error}`);
      if (part.upstreamStatus !== null && part.upstreamStatus >= 300) throw new UpstreamError(`The model server answered HTTP ${part.upstreamStatus}.`);
      const chunk = transform ? transform(raw) : raw;
      if (!started) {
        if (!isFirstToken(chunk)) continue;
        started = true; clearTimeout(timer); status.stop();
      }
      yield chunk;
      if (chunk.done) return;
    }
    throw new UpstreamError(DROPPED, { code: 'upstream_eof' });
  } catch (error) {
    if (signal.aborted) throw signal.reason;
    if (controller.signal.reason instanceof DeadlineReached) throw giveUp();
    if (error instanceof JobsTransportError) throw new UpstreamError(error.message, { code: error.code, cause: error });
    throw error;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", forwardAbort);
    controller.abort();
  }
}

/** One request to the model server (/api/chat, or /api/generate to continue a reply). Returns `{done: true}` after yielding the reply, or `{retry: reason}`. */
async function* attemptStream({ target, attempt, payload, model, signal, deadline, timing, status, path, transform }) {
  const controller = new AbortController();
  const forwardAbort = () => controller.abort(signal.reason);
  signal.addEventListener("abort", forwardAbort, { once: true });
  const deadlineTimer = setTimeout(
    () => controller.abort(new DeadlineReached()),
    Math.max(0, deadline - Date.now()),
  );
  let started = false;

  // In parallel, ask whether the model is loaded so clients can say "loading" instead of "waiting".
  getJson(target, "/api/ps", timing.probeMs, controller.signal).then((ps) => {
    if (ps && !findLoadedModel(ps, model) && !started && !controller.signal.aborted) {
      status.set("loading", "The server is loading the model", attempt);
    }
  });

  try {
    const response = await fetch(`${target}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: payload,
      signal: controller.signal,
    });
    if (!response.ok) {
      if (isRetryableStatus(response.status)) {
        await response.body?.cancel();
        return { retry: `The server answered HTTP ${response.status}` };
      }
      throw new UpstreamError(`The model server answered HTTP ${response.status}: ${await errorText(response)}`);
    }

    for await (const raw of readNdjson(response.body, { signal: controller.signal, idleMs: timing.idleMs })) {
      // /api/generate replies are reshaped into /api/chat's {message: {thinking, content}} form.
      const chunk = transform && !raw.error ? transform(raw) : raw;
      if (chunk.error) throw new UpstreamError(`The model server reported an error: ${chunk.error}`);
      if (!started) {
        if (!isFirstToken(chunk)) continue;
        started = true;
        clearTimeout(deadlineTimer);
        status.stop();
      }
      yield chunk;
      if (chunk.done) return { done: true };
    }
    if (started) throw new UpstreamError(DROPPED, { code: 'upstream_eof' });
    return { retry: "The server closed the connection before replying" };
  } catch (err) {
    if (signal.aborted) throw signal.reason;
    if (err instanceof UpstreamError) throw err;
    if (started) {
      throw new UpstreamError(err instanceof IdleTimeout ? "The model server stopped responding mid-reply." : DROPPED, { code: err instanceof IdleTimeout || err instanceof TypeError ? 'upstream_connection' : null, cause: err });
    }
    if (controller.signal.reason instanceof DeadlineReached) return { retry: "The server did not answer in time" };
    if (err instanceof IdleTimeout) return { retry: "The server went quiet before replying" };
    return { retry: "The server is not reachable" };
  } finally {
    clearTimeout(deadlineTimer);
    signal.removeEventListener("abort", forwardAbort);
    controller.abort(); // stops the /api/ps probe if it is still running
  }
}

function giveUp() {
  return new OfflineError("The model server has not answered for 6 minutes. Check that the Kaggle or Colab notebook is running.");
}

function isRetryableStatus(status) {
  return status === 502 || status === 503 || status === 504 || (status >= 520 && status <= 530);
}

function isFirstToken(chunk) {
  return Boolean(chunk.done || chunk.message?.content || chunk.message?.thinking);
}

async function errorText(response) {
  const body = (await response.text().catch(() => "")).slice(0, 300);
  try {
    return JSON.parse(body).error ?? body;
  } catch {
    return body || response.statusText;
  }
}

/** Emits the current status now and repeats it every `everyMs` until changed or stopped. */
class StatusTicker {
  #emit;
  #everyMs;
  #current = null;
  #timer = null;

  constructor(emit, everyMs) {
    this.#emit = emit;
    this.#everyMs = everyMs;
  }

  set(state, detail, attempt) {
    this.#current = { state, detail, attempt };
    this.#fire();
  }

  /** Changes what the next tick repeats without emitting now. */
  hold(state, detail, attempt) {
    this.#current = { state, detail, attempt };
  }

  stop() {
    clearTimeout(this.#timer);
    this.#current = null;
  }

  #fire() {
    clearTimeout(this.#timer);
    if (!this.#current) return;
    this.#emit({ ...this.#current });
    this.#timer = setTimeout(() => this.#fire(), this.#everyMs);
  }
}
