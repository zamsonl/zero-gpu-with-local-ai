// Typed view of the Worker's vars and secrets.

const DEFAULT_TARGET_PATTERN = "^https://[a-z0-9-]+\\.trycloudflare\\.com$";

const cache = new WeakMap();

export function settings(env) {
  let value = cache.get(env);
  if (!value) {
    value = Object.freeze({
      model: env.MODEL || "qwen3.8-hauhau",
      // What people see; the Ollama model id above stays internal.
      modelLabel: env.MODEL_LABEL || "Heretic Qwen",
      numCtx: positiveInt(env.NUM_CTX, 24576),
      historyChars: positiveInt(env.HISTORY_CHARS, 42000),
      colabUrl: env.COLAB_URL || "",
      kaggleUrl: env.KAGGLE_URL || "",
      // Anything other than an explicit "open" fails closed.
      authMode: env.AUTH_MODE === "open" ? "open" : "key",
      relayKey: env.RELAY_KEY || "",
      targetPattern: new RegExp(env.TARGET_PATTERN || DEFAULT_TARGET_PATTERN),
      // Test-only: shrinks the turn endpoint's waits (retries, status ticks, timeouts). 1 in production.
      timingScale: scale(env.TIMING_SCALE),
    });
    cache.set(env, value);
  }
  return value;
}

function positiveInt(raw, fallback) {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

function scale(raw) {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 && n <= 1 ? n : 1;
}
