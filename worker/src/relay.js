// The key-protected relay surface the notebooks and raw Ollama clients use. Its contract predates
// the chat API and must not change: plain-text errors, and register answers {"ok":true,…}.
//
//   POST /_relay/register    { target, host?, num_ctx?, vision?, quant?, control? }
//   POST /_relay/unregister  { target, reason?, detail?, uptime_s?, idle_minutes? }   the notebook is
//                            shutting down, and why (reason: idle, requested, replaced, runtime_limit,
//                            tunnel_failed, crashed or terminated); older notebooks send only target
//   POST /_relay/progress    { host, stage, detail?, percent? }   start-up progress for the page
//   GET  /_relay/command?target=…&idle=…&tunnel=…   → { shutdown, reason, registered, idle_minutes, mode?, job? }
//                            (polled; idle, and tunnel=reconnecting, are the notebook's check-in)
//   POST /_relay/mode        { target, mode, state, detail?, percent? }   switching chat <-> pictures
//   POST /_relay/image-progress  { id, step }  → { ok, cancel }
//   POST /_relay/image-result?id=…&kind=thumb|full|error   a finished picture (see images.js)
//   GET  /_relay/status      → the registered server
//   *    /api/*              → streamed through to the registered Ollama server

import { hasRelayKey } from "./auth.js";
import { hasLaunchToken, rememberFit } from "./kaggle.js";
import { settings } from "./config.js";
import { HttpError, readJsonObject, text } from "./http.js";
import {
  BOOT_STAGES,
  STOP_REASONS,
  clearShutdown,
  clearStop,
  commandFor,
  endBoot,
  readState,
  recordIdle,
  refreshQuotaSoon,
  writeBoot,
  writeStop,
} from "./server-control.js";
import { HOSTS, clearTarget, readTarget, validBatch, validProfileId, validModelSize, validInferenceTransport, validJobLegSeconds, validWebKey, writeTarget } from "./target.js";
import { rawBatchDefault } from "./raw-options.js";
import { eligibleJobPayload, jobResponse } from "./jobs-transport.js";
import { reportImageProgress, reportImageResult, reportMode, resetForNewServer } from "./images.js";
import { writeState } from "./server-control.js";
import { reportNotebookLog } from "./notebook-log.js";

const QUANT = /^[A-Za-z0-9_.-]{1,40}$/;
const MAX_DETAIL_CHARS = 200;

// What a notebook started from the page may call with its launch token instead of the relay key.
const NOTEBOOK_PATHS = [
  "/_relay/register",
  "/_relay/unregister",
  "/_relay/progress",
  "/_relay/log",
  "/_relay/command",
  "/_relay/mode",
  "/_relay/image-progress",
  "/_relay/image-result",
];

/** Handles /_relay/* and /api/*. */
export async function handleRelay(request, env, url, ctx = null) {
  const config = settings(env);
  const allowed =
    (await hasRelayKey(request, config.relayKey)) ||
    (NOTEBOOK_PATHS.includes(url.pathname) && (await hasLaunchToken(request, env.DB)));
  if (!allowed) return text("unauthorized\n", 401);

  const post = (handler) => (request.method === "POST" ? handler(request, env, config) : text("method not allowed\n", 405));
  switch (url.pathname) {
    case "/_relay/register":
      return post(register);
    case "/_relay/unregister":
      return post(unregister);
    case "/_relay/progress":
      return post(progress);
    case "/_relay/log":
      return post(reportNotebookLog);
    case "/_relay/mode":
      return post(reportMode);
    case "/_relay/image-progress":
      return post(reportImageProgress);
    case "/_relay/image-result":
      return request.method === "POST" ? reportImageResult(request, env, url) : text("method not allowed\n", 405);
    case "/_relay/command": {
      const target = url.searchParams.get("target");
      // The notebook says how long nobody has used it, for the page's idle countdown.
      const idle = Number(url.searchParams.get("idle"));
      const tunnel = url.searchParams.get("tunnel") === "reconnecting" ? "reconnecting" : null;
      if (target && url.searchParams.has("idle") && Number.isInteger(idle) && idle >= 0) await recordIdle(env.DB, target, idle, tunnel);
      return Response.json(await commandFor(env.DB, env, target));
    }
    case "/_relay/status":
      return Response.json((await readTarget(env.DB)) ?? {});
  }
  if (url.pathname.startsWith("/api/")) return proxy(request, env, url, ctx);
  return text("not found\n", 404);
}

/** The JSON body, or null when it isn't a JSON object (each endpoint answers that its own way). */
async function body(request) {
  try {
    return await readJsonObject(request);
  } catch (err) {
    if (err instanceof HttpError) return null;
    throw err;
  }
}

/**
 * `host` ("colab" | "kaggle"), `num_ctx` (the context the server loaded the model with), `vision`
 * (the model accepts images), `quant` (which quantization it runs) and `control` (it polls
 * /_relay/command) are optional; older notebooks send only `target`.
 */
async function register(request, env, config) {
  const fields = await body(request);
  if (!fields) return text("bad target\n", 400);
  const { target, host, num_ctx, vision, quant, control, mode, num_batch, profile_id, inference_transport, job_max_leg_seconds, model_size, web_key } = fields;
  if (typeof target !== "string" || !config.targetPattern.test(target)) return text("bad target\n", 400);
  if (host != null && !HOSTS.includes(host)) return text("bad host\n", 400);
  if (num_ctx != null && !(Number.isInteger(num_ctx) && num_ctx >= 2048 && num_ctx <= 262_144)) {
    return text("bad num_ctx\n", 400);
  }
  if (vision != null && typeof vision !== "boolean") return text("bad vision\n", 400);
  if (model_size != null && !validModelSize(model_size)) return text("bad model_size\n", 400);
  if (quant != null && !(typeof quant === "string" && QUANT.test(quant))) return text("bad quant\n", 400);
  if (control != null && typeof control !== "boolean") return text("bad control\n", 400);
  if (mode != null && mode !== "chat" && mode !== "images") return text("bad mode\n", 400);
  if (num_batch != null && !validBatch(num_batch)) return text("bad num_batch\n", 400);
  if (profile_id != null && !validProfileId(profile_id)) return text("bad profile_id\n", 400);
  if (inference_transport != null && !validInferenceTransport(inference_transport)) return text("bad inference_transport\n", 400);
  if (job_max_leg_seconds != null && !validJobLegSeconds(job_max_leg_seconds)) return text("bad job_max_leg_seconds\n", 400);
  if (web_key != null && !validWebKey(web_key)) return text("bad web_key\n", 400);
  await writeTarget(env.DB, { target, host, num_ctx, vision, quant, control, num_batch, profile_id, inference_transport, job_max_leg_seconds, model_size, web_key });
  // A notebook in image mode that registers again (its tunnel moved) carries on making pictures;
  // any other registration is a server starting afresh in chat mode.
  if (mode === "images") {
    await writeState(env.DB, "server_mode", { target, mode: "images", state: "ready", detail: null, percent: null });
    await writeState(env.DB, "mode_request", { target, mode: "images" });
  } else {
    await resetForNewServer(env.DB);
  }
  // A running server has no "last stop" to explain.
  await Promise.all([clearShutdown(env.DB, target), endBoot(env.DB, host ?? "colab"), clearStop(env.DB)]);
  if (host === "kaggle") await rememberFit(env.DB, { num_ctx, quant, vision, num_batch, profile_id });
  return Response.json({ ok: true, target });
}

/** Free text from a notebook, made safe to show: one line, at most MAX_DETAIL_CHARS. */
function cleanDetail(detail) {
  return detail?.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, MAX_DETAIL_CHARS) || null;
}

async function unregister(request, env) {
  const fields = await body(request);
  if (!fields || typeof fields.target !== "string") return text("bad target\n", 400);
  const { reason, detail, uptime_s, idle_minutes } = fields;
  if (reason != null && !STOP_REASONS.includes(reason)) return text("bad reason\n", 400);
  if (detail != null && typeof detail !== "string") return text("bad detail\n", 400);
  if (uptime_s != null && !(Number.isFinite(uptime_s) && uptime_s >= 0 && uptime_s <= 7 * 24 * 3600)) return text("bad uptime_s\n", 400);
  if (idle_minutes != null && !(Number.isInteger(idle_minutes) && idle_minutes > 0 && idle_minutes <= 24 * 60)) return text("bad idle_minutes\n", 400);
  const current = await readTarget(env.DB);
  const removed = await clearTarget(env.DB, fields.target);
  // The notebook's own failure report (if any) stays on the page until the next start.
  if (removed) await endBoot(env.DB, current.host ?? "colab", { keepFailed: true });
  // Why it stopped, for the page: from the server it was showing (or when none was registered),
  // never from an older one signing off after another took over.
  if (reason && (removed || !current)) {
    await writeStop(env.DB, {
      reason,
      detail: cleanDetail(detail),
      uptime_s: uptime_s == null ? null : Math.round(uptime_s),
      idle_minutes: reason === "idle" ? idle_minutes ?? null : null,
      host: current?.host ?? null,
    });
  }
  if (removed && current.host === "kaggle") await refreshQuotaSoon(env.DB);
  return Response.json({ ok: true, removed });
}

async function progress(request, env) {
  const fields = await body(request);
  if (!fields) return text("bad progress\n", 400);
  const { host, stage, detail, percent } = fields;
  if (!HOSTS.includes(host)) return text("bad host\n", 400);
  if (!BOOT_STAGES.includes(stage)) return text("bad stage\n", 400);
  if (detail != null && typeof detail !== "string") return text("bad detail\n", 400);
  if (percent != null && !(Number.isInteger(percent) && percent >= 0 && percent <= 100)) return text("bad percent\n", 400);
  const clean = detail?.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, MAX_DETAIL_CHARS) || null;
  await writeBoot(env.DB, { host, stage, detail: clean, percent: percent ?? null });
  if (stage === "failed") {
    // A failed start-up is also why the server stopped, unless the notebook signed off with its own
    // reason moments ago (a crash while serving reports both: the sign-off says more).
    const stop = await readState(env.DB, "server_stop");
    if (!(stop && stop.reason !== "start_failed" && Date.now() - Date.parse(stop.at) < 2 * 60_000)) {
      await writeStop(env.DB, { reason: "start_failed", detail: clean, uptime_s: null, idle_minutes: null, host });
    }
    if (host === "kaggle") await refreshQuotaSoon(env.DB);
  }
  return Response.json({ ok: true });
}

/** Streams the request through to the registered Ollama server, minus the relay key and host. */
async function proxy(request, env, url, ctx) {
  const registered = await readTarget(env.DB);
  if (!registered) return text("no model server registered yet\n", 503);

  const headers = new Headers(request.headers);
  headers.delete("x-relay-key");
  headers.delete("host");
  let upstream;
  try {
    const outgoing = await rawBatchDefault(request, registered.num_batch, undefined, { bufferWithoutBatch: validInferenceTransport(registered.inference_transport) });
    if (outgoing.changed) headers.delete("content-length");
    const jobPayload = validInferenceTransport(registered.inference_transport) ? eligibleJobPayload(request, outgoing.body) : null;
    if (jobPayload) return await jobResponse({ target: registered.target, path: url.pathname, payload: jobPayload, signal: request.signal, reloadTarget: async () => (await readTarget(env.DB))?.target ?? null, waitUntil: ctx ? (promise) => ctx.waitUntil(promise) : null });
    upstream = await fetch(registered.target + url.pathname + url.search, {
      method: request.method,
      headers,
      body: ["GET", "HEAD"].includes(request.method) ? undefined : outgoing.body,
      // A client that goes away (the terminal's Ctrl+C) stops the model too.
      signal: request.signal,
    });
  } catch {
    return text("model server unreachable\n", 502);
  }
  return new Response(upstream.body, { status: upstream.status, headers: upstream.headers });
}
