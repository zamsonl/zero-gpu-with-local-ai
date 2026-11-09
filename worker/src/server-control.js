// What the page knows about a model server beyond "is it up": how far a notebook has got while it
// starts (D1 `state` row k='boot', posted by the notebook), and a request to shut the running one
// down (k='shutdown', read by the notebook when it polls /_relay/command).

import { HttpError } from "./http.js";
import { imageCommand } from "./images.js";
import { readPreferences, DEFAULT_IDLE_MINUTES } from "./preferences.js";
import { readTarget } from "./target.js";
import { nowIso } from "./util.js";

// "queued" is written by the Worker when it asks Kaggle to start a run; the notebook reports the rest.
export const BOOT_STAGES = ["queued", "installing", "downloading", "loading", "connecting", "failed"];
// A notebook reports at least every 30 s while it starts; older news means it stopped reporting.
const BOOT_FRESH_MS = 10 * 60_000;

export async function readState(db, k) {
  const row = await db.prepare("SELECT v FROM state WHERE k = ?1").bind(k).first();
  return row ? JSON.parse(row.v) : null;
}

export async function writeState(db, k, value) {
  const at = nowIso();
  await db
    .prepare(
      `INSERT INTO state (k, v, updated_at) VALUES (?1, ?2, ?3)
       ON CONFLICT (k) DO UPDATE SET v = excluded.v, updated_at = excluded.updated_at`,
    )
    .bind(k, JSON.stringify({ ...value, at }), at)
    .run();
}

/** Body (validated by the caller): `{ host, stage, detail?, percent? }`. */
export function writeBoot(db, boot) {
  return writeState(db, "boot", boot);
}

/**
 * The start-up the page should show: the latest report, if it is recent and came after the server
 * that is registered now (once the new server registers, its start-up is over).
 */
export async function currentBoot(db, registered) {
  const boot = await readState(db, "boot");
  if (!boot) return null;
  const at = Date.parse(boot.at);
  if (!(Date.now() - at < BOOT_FRESH_MS)) return null;
  if (registered && Date.parse(registered.at) >= at) return null;
  return { host: boot.host, stage: boot.stage, detail: boot.detail ?? null, percent: boot.percent ?? null, at: boot.at };
}

/**
 * A server from `host` registered or signed off: its start-up is over, so its progress report goes
 * (otherwise a fresh report would show "starting" again once the server had signed off).
 */
export async function endBoot(db, host) {
  await db.prepare("DELETE FROM state WHERE k = 'boot' AND json_extract(v, '$.host') = ?1").bind(host).run();
}

/** POST /v1/server/shutdown: asks the running notebook to stop; it checks about once a minute. */
export async function requestShutdown({ env }) {
  const registered = await readTarget(env.DB);
  if (!registered) throw new HttpError(409, "offline", "No model server is running.");
  if (!registered.control) {
    throw new HttpError(409, "unsupported", "This server can't be shut down from here. Stop it in its notebook.");
  }
  await writeState(env.DB, "shutdown", { target: registered.target });
  return Response.json({ ok: true, shutdown: "requested" });
}

/** True when a shutdown was requested for the server at `target`. */
export async function shutdownRequested(db, target) {
  if (!target) return false;
  const request = await readState(db, "shutdown");
  return request?.target === target;
}

/** A new registration from `target` starts it afresh: an older request to stop it is spent. */
export async function clearShutdown(db, target) {
  if (await shutdownRequested(db, target)) await db.prepare("DELETE FROM state WHERE k = 'shutdown'").run();
}

/**
 * GET /_relay/command?target=…: what the notebook at `target` should do next. It stops when asked
 * to, and when another server has registered since (nothing reaches it any more, so running on
 * would only spend GPU hours). `registered: false` tells it to register again.
 */
export async function commandFor(db, env, target) {
  const [current, requested, preferences] = await Promise.all([
    readTarget(db),
    shutdownRequested(db, target),
    readPreferences(db, env),
  ]);
  const idle_minutes = preferences.idle_minutes ?? DEFAULT_IDLE_MINUTES;
  if (!current) return { shutdown: false, reason: null, registered: false, idle_minutes };
  if (current.target !== target) return { shutdown: true, reason: "replaced", registered: false, idle_minutes };
  // mode ("chat" | "images") and, in image mode, the next picture to make (see images.js).
  const images = requested ? {} : await imageCommand(db, current, target);
  return { shutdown: requested, reason: requested ? "requested" : null, registered: true, idle_minutes, ...images };
}

// ---------------------------------------------------------------- GPU time and the idle countdown
//
// Kaggle gives 30 GPU hours a week. Each run is recorded from its first report (the machine is
// up) to its sign-off or failure (D1 `state` row k='kaggle_sessions'), so the page can show the
// hours used in the last 7 days. A run that vanished without signing off counts up to Kaggle's
// 12-hour limit.

const SESSION_CAP_MS = 12 * 3600_000;
const WEEK_MS = 7 * 24 * 3600_000;

async function sessions(db) {
  return (await readState(db, "kaggle_sessions"))?.list ?? [];
}

/** A Kaggle run has started (its first progress report); opens a session unless one is open. */
export async function openKaggleSession(db) {
  const list = await sessions(db);
  const now = Date.now();
  const open = list.find((s) => !s.end && now - Date.parse(s.start) < SESSION_CAP_MS);
  if (open) return;
  const kept = list.filter((s) => now - Date.parse(s.end ?? s.start) < 2 * WEEK_MS);
  await writeState(db, "kaggle_sessions", { list: [...kept, { start: nowIso(), end: null }] });
}

/** The Kaggle run ended (signed off or failed): closes the open session. */
export async function closeKaggleSession(db) {
  const list = await sessions(db);
  if (!list.some((s) => !s.end)) return;
  const end = nowIso();
  await writeState(db, "kaggle_sessions", { list: list.map((s) => (s.end ? s : { ...s, end })) });
}

/** Hours of Kaggle GPU time in the last 7 days, to one decimal. */
export async function gpuHoursThisWeek(db) {
  const now = Date.now();
  let ms = 0;
  for (const s of await sessions(db)) {
    const start = Date.parse(s.start);
    const end = Math.min(s.end ? Date.parse(s.end) : now, start + SESSION_CAP_MS, now);
    ms += Math.max(0, end - Math.max(start, now - WEEK_MS));
  }
  return Math.round((ms / 3600_000) * 10) / 10;
}

/** The notebook's report of how long nobody has used it (sent with each /_relay/command poll). */
export async function recordIdle(db, target, idleSeconds) {
  await writeState(db, "server_idle", { target, idle_s: idleSeconds });
}

/**
 * When the running server will shut itself down for being idle (ISO), from its latest report; null
 * when it isn't idle-tracked, shutting down when idle is off, or a reply is being generated.
 */
export async function idleShutdownAt(db, registered, idleMinutes, busy) {
  if (!registered?.control || !idleMinutes || busy) return null;
  const idle = await readState(db, "server_idle");
  if (!idle || idle.target !== registered.target) return null;
  const at = Date.parse(idle.at) + (idleMinutes * 60 - idle.idle_s) * 1000;
  return new Date(Math.max(at, Date.now())).toISOString();
}
