// The key-protected relay surface the notebooks and raw Ollama clients use. Its contract predates
// the chat API and must not change: plain-text errors, and register answers {"ok":true,…}.
//
//   POST /_relay/register    { target, host?, num_ctx?, vision?, quant?, control? }
//   POST /_relay/unregister  { target }               the notebook is shutting down
//   POST /_relay/progress    { host, stage, detail?, percent? }   start-up progress for the page
//   GET  /_relay/command?target=…   → { shutdown, reason, registered, idle_minutes, mode?, job? }  (polled)
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
  clearShutdown,
  closeKaggleSession,
  commandFor,
  endBoot,
  openKaggleSession,
  recordIdle,
  writeBoot,
} from "./server-control.js";
import { HOSTS, clearTarget, readTarget, validBatch, validProfileId, validModelSize, validInferenceTransport, writeTarget } from "./target.js";
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
      if (target && url.searchParams.has("idle") && Number.isInteger(idle) && idle >= 0) await recordIdle(env.DB, target, idle);
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
  const { target, host, num_ctx, vision, quant, control, mode, num_batch, profile_id, inference_transport, model_size } = fields;
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
  await writeTarget(env.DB, { target, host, num_ctx, vision, quant, control, num_batch, profile_id, inference_transport, model_size });
  // A notebook in image mode that registers again (its tunnel moved) carries on making pictures;
  // any other registration is a server starting afresh in chat mode.
  if (mode === "images") {
    await writeState(env.DB, "server_mode", { target, mode: "images", state: "ready", detail: null, percent: null });
    await writeState(env.DB, "mode_request", { target, mode: "images" });
  } else {
    await resetForNewServer(env.DB);
  }
  await Promise.all([clearShutdown(env.DB, target), endBoot(env.DB, host ?? "colab")]);
  if (host === "kaggle") await rememberFit(env.DB, { num_ctx, quant, vision, num_batch, profile_id });
  return Response.json({ ok: true, target });
}

async function unregister(request, env) {
  const fields = await body(request);
  if (!fields || typeof fields.target !== "string") return text("bad target\n", 400);
  const current = await readTarget(env.DB);
  const removed = await clearTarget(env.DB, fields.target);
  if (removed) await endBoot(env.DB, current.host ?? "colab");
  if (removed && current.host === "kaggle") await closeKaggleSession(env.DB);
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
  // A Kaggle run's GPU time starts with its first report and ends if it fails.
  if (host === "kaggle" && stage === "installing") await openKaggleSession(env.DB);
  if (host === "kaggle" && stage === "failed") await closeKaggleSession(env.DB);
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
