// GET /v1/config and GET /v1/status.
//
// Both report what the server that registered last said about itself (a Kaggle server has a bigger
// memory than a Colab one, and can see images), falling back to the deployment's defaults before
// any has. Status adds how far a starting notebook has got, whether a shutdown is pending, why the
// last server stopped (`last_stop`) and the Kaggle account's GPU time left this week (`kaggle_quota`).
//
// `server`: "ready" | "idle" (up, model not loaded) | "images" | "reconnecting" (the tunnel doesn't
// answer but the notebook checked in moments ago: it is alive, not to be started again) | "offline"
// | "unregistered".

import { settings } from "./config.js";
import { json } from "./http.js";
import { readActiveLock } from "./lock.js";
import { findLoadedModel, getJson } from "./ollama.js";
import { followQueuedLaunch, kaggleConfigured, kaggleRunEnded } from "./kaggle.js";
import { kaggleQuota } from "./kaggle-quota.js";
import { DEFAULT_IDLE_MINUTES, readPreferences } from "./preferences.js";
import { currentBoot, freshCheckin, idleShutdownAt, readState, shutdownRequested } from "./server-control.js";
import { readTarget, serverInfo, validBatch, validProfileId, validModelSize } from "./target.js";
import { readMode } from "./images.js";

const PROBE_TIMEOUT_MS = 6_000;

/** Where clients send people to start a server, per host. The Kaggle link is set in Settings. */
function launchUrls(env, preferences) {
  const { colabUrl, kaggleUrl } = settings(env);
  // Links saved before 2026-10-16 point at the editor (/edit), which starts a GPU session when
  // opened; the notebook's own page is what the buttons want.
  const kaggle = (preferences?.kaggle_url || kaggleUrl || "").replace(/\/edit(?:\/.*)?$/, "");
  return { colab_url: colabUrl, kaggle_url: kaggle || null };
}

function describeServer(env, registered) {
  const { host, numCtx, vision, quant, control } = serverInfo(env, registered);
  return { ...(validModelSize(registered?.model_size) ? { model_size: registered.model_size } : {}), num_ctx: numCtx, host, vision, quant, can_shut_down: control, can_start: kaggleConfigured(env),
    ...(validBatch(registered?.num_batch) ? { num_batch: registered.num_batch } : {}),
    ...(validProfileId(registered?.profile_id) ? { profile_id: registered.profile_id } : {}),
  };
}

export async function getConfig({ env }) {
  const { model, modelLabel, authMode } = settings(env);
  const [registered, preferences] = await Promise.all([
    readTarget(env.DB).catch(() => null),
    readPreferences(env.DB, env),
  ]);
  return json({
    model,
    model_label: modelLabel,
    ...describeServer(env, registered),
    ...launchUrls(env, preferences),
    auth_mode: authMode,
  });
}

/**
 * Why the server that isn't running stopped: its own sign-off or failed start-up (when it came
 * after the registration on file), else, for a Kaggle server that went silent, what Kaggle says
 * about its run. Null when nothing is known.
 */
async function lastStop(env, ctx, registered) {
  const stop = await readState(env.DB, "server_stop");
  if (stop && !(registered && Date.parse(registered.at) > Date.parse(stop.at))) {
    return {
      reason: stop.reason,
      detail: stop.detail ?? null,
      at: stop.at,
      ...(stop.uptime_s != null ? { uptime_s: stop.uptime_s } : {}),
      ...(stop.idle_minutes != null ? { idle_minutes: stop.idle_minutes } : {}),
    };
  }
  if (registered?.host === "kaggle") {
    const ended = await kaggleRunEnded(env, ctx);
    if (ended) return ended;
  }
  return null;
}

/** Always 200: a failure anywhere along the way reports the server as offline. */
export async function getStatus({ env, ctx }) {
  const { model } = settings(env);
  let registered = null;
  let busy = null;
  let preferences = null;
  let boot = null;
  let stopping = false;
  let quota = null;
  let idleAt = null;
  let idleMinutes = DEFAULT_IDLE_MINUTES;
  let mode = null;
  let imagesWaiting = 0;
  let lookupFailed = false;
  try {
    [registered, busy, preferences] = await Promise.all([
      readTarget(env.DB),
      readActiveLock(env.DB),
      readPreferences(env.DB, env),
    ]);
    [boot, stopping] = await Promise.all([currentBoot(env.DB, registered), shutdownRequested(env.DB, registered?.target)]);
    boot = await followQueuedLaunch(env, boot);
    idleMinutes = preferences.idle_minutes ?? DEFAULT_IDLE_MINUTES;
    [mode, imagesWaiting] = await Promise.all([
      readMode(env.DB, registered),
      env.DB.prepare("SELECT COUNT(*) AS n FROM images WHERE status IN ('queued', 'running')").first("n"),
    ]);
    [quota, idleAt] = await Promise.all([
      kaggleQuota(env, ctx),
      idleShutdownAt(env.DB, registered, idleMinutes, busy),
    ]);
  } catch (err) {
    console.error("status lookup failed:", err);
    lookupFailed = true;
  }
  const report = (server, fields = {}) =>
    json({
      server,
      model,
      ...describeServer(env, registered),
      target_registered_at: null,
      loaded_ctx: null,
      busy: null,
      boot,
      shutting_down: stopping,
      kaggle_quota: quota,
      idle_shutdown_at: idleAt,
      idle_minutes: idleMinutes,
      mode,
      images_waiting: imagesWaiting,
      last_stop: null,
      ...launchUrls(env, preferences),
      ...fields,
    });
  // Not running: say why, when it is known. Never fails the status.
  const stopped = () => lastStop(env, ctx, registered).catch((err) => {
    console.error("last stop lookup failed:", err);
    return null;
  });

  if (lookupFailed) return report("offline");
  if (!registered) return report("unregistered", { busy, last_stop: await stopped() });

  const [version, ps] = await Promise.all([
    getJson(registered.target, "/api/version", PROBE_TIMEOUT_MS),
    getJson(registered.target, "/api/ps", PROBE_TIMEOUT_MS),
  ]);
  const fields = { target_registered_at: registered.at, busy };
  if (!version) {
    // One slow or failed probe doesn't make a live notebook "offline": if it checked in moments
    // ago (or said it is replacing its tunnel), it is reconnecting, and must not be started again.
    if (await freshCheckin(env.DB, registered).catch(() => false)) return report("reconnecting", fields);
    return report("offline", { ...fields, last_stop: await stopped() });
  }
  // With pictures on the GPUs the chat model is unloaded on purpose: the server is up, not idle.
  if (mode?.current === "images") return report("images", fields);
  const loaded = findLoadedModel(ps, model);
  if (!loaded) return report("idle", fields);
  return report("ready", { ...fields, loaded_ctx: loaded.context_length ?? null });
}
