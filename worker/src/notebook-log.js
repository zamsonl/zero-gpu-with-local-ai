// Bounded authenticated notebook operational-log ingestion.
import { HttpError, json, readJsonObject, text } from "./http.js";
import { HOSTS } from "./target.js";
import { hasRelayKey } from "./auth.js";

export const LOG_MAX_LINES = 400;
export const LOG_MAX_CHARS = 64 * 1024;
const LOG_BATCH_LINES = 40;
const LOG_LINE_CHARS = 2000;
const RUN_ID = /^[A-Za-z0-9_-]{8,80}$/;
const STATES = ["RUNNING", "COMPLETE", "ERROR"];
const keyFor = (host) => `server_log:${host}`;

/** Extra defense for explicit operational messages. No secrets should be logged by callers. */
export function cleanLogLine(value, secrets = []) {
  let line = String(value).replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "").replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  for (const secret of secrets) if (typeof secret === "string" && secret.length >= 4) line = line.split(secret).join("[redacted]");
  return line
    .replace(/https:\/\/[a-z0-9-]+\.trycloudflare\.com(?::\d+)?/gi, "[tunnel address hidden]")
    .replace(/\bKGAT_[A-Za-z0-9_-]+\b/g, "[redacted]")
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9+/_=.-]+/gi, "$1 [redacted]")
    .replace(/\b(authorization|x-relay-key|x-launch-token|api[_-]?key|access[_-]?token|launch[_-]?token|relay[_-]?key)\s*[:=]\s*["']?[^\s,;"']+["']?/gi, "$1=[redacted]")
    .slice(0, LOG_LINE_CHARS);
}

/** Validate before any storage mutation. Repeated seq is an idempotent retry. */
export function logBatch(fields, secrets = []) {
  const { host, run_id, started_at, seq, lines, status = "RUNNING" } = fields;
  if (!HOSTS.includes(host) || typeof run_id !== "string" || !RUN_ID.test(run_id)) throw new HttpError(400, "bad_log", "Bad log host or run ID.");
  if (typeof started_at !== "string" || !Number.isFinite(Date.parse(started_at)) || Date.parse(started_at) > Date.now() + 5 * 60_000) throw new HttpError(400, "bad_log", "Bad log start time.");
  if (!Number.isSafeInteger(seq) || seq < 0 || !STATES.includes(status)) throw new HttpError(400, "bad_log", "Bad log sequence or status.");
  if (!Array.isArray(lines) || lines.length > LOG_BATCH_LINES || !lines.every((line) => typeof line === "string" && line.length <= LOG_LINE_CHARS)) throw new HttpError(400, "bad_log", "Bad log lines.");
  return { host, run_id, started_at: new Date(started_at).toISOString(), seq, lines: lines.map((line) => cleanLogLine(line, secrets)).filter(Boolean), status };
}

export function appendLog(previous, batch, at = new Date().toISOString()) {
  const same = previous?.run_id === batch.run_id;
  if (previous && !same && Date.parse(batch.started_at) <= Date.parse(previous.started_at)) throw new HttpError(409, "stale_log", "A newer notebook run owns this log.");
  if (!same && batch.seq !== 0) throw new HttpError(409, "stale_log", "The first log batch must use sequence zero.");
  if (same && previous.started_at !== batch.started_at) throw new HttpError(409, "stale_log", "This log run has a different start time.");
  if (same && batch.seq <= previous.seq) return previous;
  const lines = [...(same ? previous.lines : []), ...batch.lines];
  let chars = lines.reduce((n, line) => n + line.length + 1, 0);
  let dropped = 0;
  while (lines.length > LOG_MAX_LINES || chars > LOG_MAX_CHARS) { chars -= lines.shift().length + 1; dropped++; }
  return { host: batch.host, run_id: batch.run_id, started_at: batch.started_at, seq: batch.seq, lines,
    status: same && previous.status !== "RUNNING" && batch.status === "RUNNING" ? previous.status : batch.status,
    truncated: Boolean((same && previous.truncated) || dropped), updated_at: at };
}

/** POST /_relay/log, protected by the relay's existing notebook authentication. */
export async function reportNotebookLog(request, env) {
  try {
    const batch = logBatch(await readJsonObject(request, 96 * 1024), [env.RELAY_KEY, env.KAGGLE_API_TOKEN, env.KAGGLE_KEY, request.headers.get("x-launch-token")]);
    if (batch.host !== "kaggle" && !(await hasRelayKey(request, env.RELAY_KEY))) return text("this launch token cannot report Colab logs\n", 403);
    const key = keyFor(batch.host);
    for (let attempt = 0; attempt < 4; attempt++) {
      const row = await env.DB.prepare("SELECT v FROM state WHERE k = ?1").bind(key).first();
      const previous = row ? JSON.parse(row.v) : null;
      const next = appendLog(previous, batch);
      if (next === previous) return json({ ok: true, duplicate: true });
      const raw = JSON.stringify(next);
      const result = row
        ? await env.DB.prepare("UPDATE state SET v = ?1, updated_at = ?2 WHERE k = ?3 AND v = ?4").bind(raw, next.updated_at, key, row.v).run()
        : await env.DB.prepare("INSERT OR IGNORE INTO state (k, v, updated_at) VALUES (?1, ?2, ?3)").bind(key, raw, next.updated_at).run();
      if (result.meta.changes) return json({ ok: true });
    }
    return text("log busy; retry\n", 503);
  } catch (err) {
    if (err instanceof HttpError) return text(`${err.message}\n`, err.status);
    throw err;
  }
}

export async function clearNotebookLog(db, host) {
  await db.prepare("DELETE FROM state WHERE k = ?1").bind(keyFor(host)).run();
}
