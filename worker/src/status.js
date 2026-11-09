// GET /v1/config and GET /v1/status.
//
// Both report what the server that registered last said about itself (a Kaggle server has a bigger
// memory than a Colab one, and can see images), falling back to the deployment's defaults before
// any has. Status adds how far a starting notebook has got and whether a shutdown is pending.

import { settings } from "./config.js";
import { json } from "./http.js";
import { readActiveLock } from "./lock.js";
import { findLoadedModel, getJson } from "./ollama.js";
import { followQueuedLaunch, kaggleConfigured } from "./kaggle.js";
import { DEFAULT_IDLE_MINUTES, readPreferences } from "./preferences.js";
import { currentBoot, gpuHoursThisWeek, idleShutdownAt, shutdownRequested } from "./server-control.js";
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

/** Always 200: a failure anywhere along the way reports the server as offline. */
export async function getStatus({ env }) {
  const { model } = settings(env);
  let registered = null;
  let busy = null;
  let preferences = null;
  let boot = null;
  let stopping = false;
  let gpuHours = null;
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
    [gpuHours, idleAt] = await Promise.all([
      kaggleConfigured(env) ? gpuHoursThisWeek(env.DB) : null,
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
      gpu_hours_week: gpuHours,
      idle_shutdown_at: idleAt,
      idle_minutes: idleMinutes,
      mode,
      images_waiting: imagesWaiting,
      ...launchUrls(env, preferences),
      ...fields,
    });

  if (lookupFailed) return report("offline");
  if (!registered) return report("unregistered", { busy });

  const [version, ps] = await Promise.all([
    getJson(registered.target, "/api/version", PROBE_TIMEOUT_MS),
    getJson(registered.target, "/api/ps", PROBE_TIMEOUT_MS),
  ]);
  const fields = { target_registered_at: registered.at, busy };
  if (!version) return report("offline", fields);
  // With pictures on the GPUs the chat model is unloaded on purpose: the server is up, not idle.
  if (mode?.current === "images") return report("images", fields);
  const loaded = findLoadedModel(ps, model);
  if (!loaded) return report("idle", fields);
  return report("ready", { ...fields, loaded_ctx: loaded.context_length ?? null });
}
