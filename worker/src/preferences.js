// Model preferences shared by every device and the terminal client: custom instructions, sampling
// overrides and how much of the conversation is sent as context. Stored as one D1 `state` row
// (k='preferences'). Per-device choices (text size, theme, Enter behaviour) live in the browser.
//
//   GET /v1/settings  → { settings, defaults, limits }
//   PUT /v1/settings  → { settings }   body: any subset of the fields; null resets one to default

import { json, badRequest, readJsonObject, tooLarge } from "./http.js";
import { nowIso } from "./util.js";

const KEY = "preferences";
const LEGACY_HISTORY_DEFAULT = 42_000;
/** How long a Kaggle server waits without a request before it shuts itself down (saves GPU hours). */
export const DEFAULT_IDLE_MINUTES = 45;
const KAGGLE_NOTEBOOK = /^https:\/\/(?:www\.)?kaggle\.com\/code\/([A-Za-z0-9_-]{1,64})\/([A-Za-z0-9_-]{1,120})(?:[/?#].*)?$/;

export const LIMITS = Object.freeze({
  system_prompt: { maxChars: 8_000 },
  temperature: { min: 0, max: 2 },
  max_reply_tokens: { min: 256, max: 16_384 },
  history_chars: { min: 4_000, max: 400_000 },
  idle_minutes: { min: 10, max: 720, off: 0 },
  kaggle_url: { maxChars: 300 },
});

/** Defaults: no instructions, the recommended sampling for each mode, memory sized to the server. */
export function defaultPreferences(env) {
  return {
    system_prompt: "",
    temperature: null, // null: 1.0 with thinking, 0.7 without (Qwen's recommendation)
    max_reply_tokens: null, // null: 24576 thinking on large contexts, 10240 on small ones; 4096 without
    history_chars: null, // null: as much as fits the server's context (see prompt.js historyBudget)
    idle_minutes: null, // null: DEFAULT_IDLE_MINUTES; 0: never shut down on its own
    kaggle_url: "", // the Kaggle notebook the Open button goes to; "" falls back to KAGGLE_URL
  };
}

/** Never throws: a missing or unreadable row means defaults. */
export async function readPreferences(db, env) {
  const defaults = defaultPreferences(env);
  try {
    const row = await db.prepare("SELECT v FROM state WHERE k = ?1").bind(KEY).first();
    if (!row) return defaults;
    const stored = JSON.parse(row.v);
    // 42000 was the fixed default before memory followed the server's size; treat it as automatic.
    if (stored.history_chars === LEGACY_HISTORY_DEFAULT) stored.history_chars = null;
    return { ...defaults, ...pick(stored, Object.keys(defaults)) };
  } catch (err) {
    console.error("reading preferences failed:", err);
    return defaults;
  }
}

export async function getSettings({ env }) {
  return json({ settings: await readPreferences(env.DB, env), defaults: defaultPreferences(env), limits: LIMITS });
}

export async function putSettings({ env, request }) {
  const body = await readJsonObject(request);
  const defaults = defaultPreferences(env);
  const unknown = Object.keys(body).filter((k) => !(k in defaults));
  if (unknown.length) throw badRequest(`Unknown setting: ${unknown.join(", ")}.`);

  const next = { ...(await readPreferences(env.DB, env)) };
  for (const [key, value] of Object.entries(body)) next[key] = value === null ? defaults[key] : validate(key, value);

  await store(env.DB, next);
  return json({ settings: next });
}

/** Sets one preference from the server side (validated like PUT /v1/settings). */
export async function writePreference(db, env, key, value) {
  await store(db, { ...(await readPreferences(db, env)), [key]: validate(key, value) });
}

function store(db, preferences) {
  return db
    .prepare(
      `INSERT INTO state (k, v, updated_at) VALUES (?1, ?2, ?3)
       ON CONFLICT (k) DO UPDATE SET v = excluded.v, updated_at = excluded.updated_at`,
    )
    .bind(KEY, JSON.stringify(preferences), nowIso())
    .run();
}

function validate(key, value) {
  switch (key) {
    case "system_prompt":
      if (typeof value !== "string") throw badRequest('"system_prompt" must be a string.');
      if (value.length > LIMITS.system_prompt.maxChars) {
        throw tooLarge(`"system_prompt" is longer than ${LIMITS.system_prompt.maxChars} characters.`);
      }
      return value.trim();
    case "temperature":
      return number(key, value, LIMITS.temperature, { integer: false });
    case "max_reply_tokens":
      return number(key, value, LIMITS.max_reply_tokens, { integer: true });
    case "history_chars":
      return number(key, value, LIMITS.history_chars, { integer: true });
    case "idle_minutes":
      return value === LIMITS.idle_minutes.off ? 0 : number(key, value, LIMITS.idle_minutes, { integer: true });
    case "kaggle_url":
      return kaggleNotebook(value);
  }
  throw badRequest(`Unknown setting: ${key}.`);
}

/**
 * "" clears it; otherwise a kaggle.com/code/<user>/<notebook> link, kept as the notebook's page (its
 * runs, logs and Edit button). Never the editor itself: opening that starts a GPU session.
 */
function kaggleNotebook(value) {
  if (typeof value !== "string") throw badRequest('"kaggle_url" must be a link.');
  const link = value.trim();
  if (!link) return "";
  const match = link.length <= LIMITS.kaggle_url.maxChars && KAGGLE_NOTEBOOK.exec(link);
  if (!match) throw badRequest("The Kaggle link should look like https://www.kaggle.com/code/your-name/your-notebook.");
  return `https://www.kaggle.com/code/${match[1]}/${match[2]}`;
}

function number(key, value, { min, max }, { integer }) {
  const ok = typeof value === "number" && Number.isFinite(value) && (!integer || Number.isInteger(value));
  if (!ok || value < min || value > max) {
    throw badRequest(`"${key}" must be ${integer ? "a whole number" : "a number"} from ${min} to ${max}, or null for the default.`);
  }
  return integer ? value : Math.round(value * 100) / 100;
}

function pick(object, keys) {
  return Object.fromEntries(keys.filter((k) => object && k in object).map((k) => [k, object[k]]));
}
