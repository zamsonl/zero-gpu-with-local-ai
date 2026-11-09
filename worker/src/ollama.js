// Low-level Ollama HTTP helpers shared by /v1/status and the turn endpoint.

/** A failure reported by, or about, the model server that retrying will not fix. */
export class UpstreamError extends Error {
  constructor(message, { code = null, cause } = {}) {
    super(message, cause ? { cause } : undefined);
    if (code) this.code = code;
  }
}

/** No bytes arrived from the model server within the idle window. */
export class IdleTimeout extends Error {}

/** GET `{target}{path}` as JSON. Resolves null on any failure, non-2xx or timeout; never throws. */
export async function getJson(target, path, timeoutMs, signal) {
  const signals = [AbortSignal.timeout(timeoutMs)];
  if (signal) signals.push(signal);
  try {
    const response = await fetch(target + path, { signal: AbortSignal.any(signals) });
    if (!response.ok) {
      await response.body?.cancel();
      return null;
    }
    return await response.json();
  } catch {
    return null;
  }
}

/** The `/api/ps` entry for `model` (tag ignored), or null when it is not loaded. */
export function findLoadedModel(ps, model) {
  const base = (name) => String(name ?? "").split(":")[0];
  return ps?.models?.find((m) => base(m.name ?? m.model) === base(model)) ?? null;
}

/**
 * Parses an NDJSON body into objects. Aborting `signal` cancels the body (which closes the upstream
 * connection) and rejects with the signal's reason; a gap of more than `idleMs` between chunks
 * rejects with IdleTimeout. Leaving the loop early also cancels the body.
 */
export async function* readNdjson(body, { signal, idleMs }) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const cancel = () => reader.cancel().catch(() => {});
  signal.addEventListener("abort", cancel, { once: true });
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await withIdleTimeout(reader.read(), idleMs);
      signal.throwIfAborted();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line) yield parseLine(line);
      }
    }
    const rest = (buffer + decoder.decode()).trim();
    if (rest) yield parseLine(rest);
  } finally {
    signal.removeEventListener("abort", cancel);
    cancel();
  }
}

function parseLine(line) {
  try {
    return JSON.parse(line);
  } catch {
    throw new UpstreamError("The model server sent an unreadable response.");
  }
}

function withIdleTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new IdleTimeout()), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
