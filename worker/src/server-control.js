// What the page knows about a model server beyond "is it up": how far a notebook has got while it
// starts (D1 `state` row k='boot', posted by the notebook), a request to shut the running one
// down (k='shutdown', read by the notebook when it polls /_relay/command), the notebook's latest
// check-in from that poll (k='server_idle'), and why the last server stopped (k='server_stop',
// from its sign-off or a failed start-up).

import { HttpError } from "./http.js";
import { imageCommand } from "./images.js";
import { readPreferences, DEFAULT_IDLE_MINUTES } from "./preferences.js";
import { readTarget } from "./target.js";
import { nowIso } from "./util.js";

// "queued" is written by the Worker when it asks Kaggle to start a run; the notebook reports the rest.
export const BOOT_STAGES = ["queued", "installing", "downloading", "loading", "connecting", "failed"];
// A notebook reports at least every 30 s while it starts; older news means it stopped reporting.
// A failed start-up is the exception: it stays on the page until the next start.
const BOOT_FRESH_MS = 10 * 60_000;
// A running notebook polls /_relay/command every ~10 s. A check-in this recent means it is alive even
// when its tunnel doesn't answer; one that said its tunnel is being replaced counts for longer
// (opening a new tunnel can take a few minutes, and the notebook can't poll meanwhile).
export const CHECKIN_FRESH_MS = 90_000;
const RECONNECT_FRESH_MS = 5 * 60_000;
// Why a server stopped, as its notebook says when it signs off (POST /_relay/unregister).
export const STOP_REASONS = ["idle", "requested", "replaced", "runtime_limit", "tunnel_failed", "crashed", "terminated"];

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
 * The start-up the page should show: the latest report, if it is recent (a failure: until the next
 * start) and came after the server that is registered now (once the new server registers, its
 * start-up is over).
 */
export async function currentBoot(db, registered) {
  const boot = await readState(db, "boot");
  if (!boot) return null;
  const at = Date.parse(boot.at);
  if (boot.stage !== "failed" && !(Date.now() - at < BOOT_FRESH_MS)) return null;
  if (registered && Date.parse(registered.at) >= at) return null;
  return { host: boot.host, stage: boot.stage, detail: boot.detail ?? null, percent: boot.percent ?? null, at: boot.at };
}

/**
 * A server from `host` registered or signed off: its start-up is over, so its progress report goes
 * (otherwise a fresh report would show "starting" again once the server had signed off). A sign-off
 * keeps a failure the notebook reported (`keepFailed`): the page shows it until the next start.
 */
export async function endBoot(db, host, { keepFailed = false } = {}) {
  await db
    .prepare(`DELETE FROM state WHERE k = 'boot' AND json_extract(v, '$.host') = ?1${keepFailed ? " AND json_extract(v, '$.stage') IS NOT 'failed'" : ""}`)
    .bind(host)
    .run();
}

/**
 * Why the server stopped: `{ reason, detail, uptime_s, idle_minutes, host }` (a sign-off) or
 * `{ reason: "start_failed", detail, host }` (a failed start-up). Kept until a server registers or
 * the page starts one.
 */
export function writeStop(db, stop) {
  return writeState(db, "server_stop", stop);
}

export async function clearStop(db) {
  await db.prepare("DELETE FROM state WHERE k IN ('server_stop', 'kaggle_run_check')").run();
}

/** POST /v1/server/shutdown: asks the running notebook to stop; it checks about once a minute. */
export async function requestShutdown({ env }) {
  const registered = await readTarget(env.DB);
  if (!registered) throw new HttpError(409, "offline", "No model server is running.");
  if (!registered.control) {
    throw new HttpError(409, "unsupported", "This server can't be shut down from here. Stop it in its notebook.");
  }
  await writeState(env.DB, "shutdown", { target: registered.target });
  await refreshQuotaSoon(env.DB);
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

// ---------------------------------------------------------------- check-ins and the idle countdown

/**
 * The notebook's check-in with each /_relay/command poll: how long nobody has used it, and whether
 * it is replacing its tunnel (`tunnel: "reconnecting"`).
 */
export async function recordIdle(db, target, idleSeconds, tunnel = null) {
  await writeState(db, "server_idle", { target, idle_s: idleSeconds, ...(tunnel ? { tunnel } : {}) });
}

/** True when the registered notebook checked in recently: it is alive, whatever its tunnel says. */
export async function freshCheckin(db, registered) {
  if (!registered?.target) return false;
  const idle = await readState(db, "server_idle");
  if (!idle || idle.target !== registered.target) return false;
  const age = Date.now() - Date.parse(idle.at);
  return age >= 0 && age < (idle.tunnel === "reconnecting" ? RECONNECT_FRESH_MS : CHECKIN_FRESH_MS);
}

/**
 * The Kaggle GPU quota (see kaggle-quota.js) is read again soon after a server starts or stops,
 * when Kaggle's own count has caught up, instead of waiting out its cache.
 */
export async function refreshQuotaSoon(db, inMs = 30_000) {
  await writeState(db, "kaggle_quota_due", { due_at: new Date(Date.now() + inMs).toISOString() });
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
