// The model server the notebook registered last (D1 `state` row k='target'): its tunnel URL, and
// what it said about itself — which host runs it (Colab or Kaggle), its context size, whether the
// model can see images, which quantization it loaded, and whether it takes remote commands (Kaggle
// polls for "shut down") — so the relay can follow the server without a redeploy.

import { settings } from "./config.js";
import { nowIso } from "./util.js";

const KEY = "target";
export const validModelSize = value => typeof value === "string" && /^[1-9][0-9]?B$/.test(value);
export const HOSTS = ["colab", "kaggle"];
export const validBatch = (value) => Number.isInteger(value) && value >= 32 && value <= 2048;
export const validProfileId = (value) => typeof value === "string" && /^[A-Za-z0-9_.:-]{1,200}$/.test(value);
export const validInferenceTransport = (value) => value === "jobs-v1";
export const validJobLegSeconds = (value) => value === 120 || value === 300;

/**
 * @returns {Promise<{target: string, at: string, host?: string, num_ctx?: number, vision?: boolean,
 *   quant?: string, control?: boolean} | null>}
 */
export async function readTarget(db) {
  const row = await db.prepare("SELECT v FROM state WHERE k = ?1").bind(KEY).first();
  return row ? JSON.parse(row.v) : null;
}

export async function writeTarget(db, { target, host, num_ctx, vision, quant, control, num_batch, profile_id, inference_transport, job_max_leg_seconds, job_control, model_size, thinking }) {
  const value = {
    target,
    at: nowIso(),
    ...(host ? { host } : {}),
    ...(validModelSize(model_size) ? { model_size } : {}),
    ...(num_ctx ? { num_ctx } : {}),
    ...(vision ? { vision: true } : {}),
    ...(quant ? { quant } : {}),
    ...(control ? { control: true } : {}),
    ...(validBatch(num_batch) ? { num_batch } : {}),
    ...(validProfileId(profile_id) ? { profile_id } : {}),
    ...(validInferenceTransport(inference_transport) ? { inference_transport } : {}),
    ...(validJobLegSeconds(job_max_leg_seconds) ? { job_max_leg_seconds } : {}),
    ...(job_control === true ? { job_control: true } : {}),
    ...(typeof thinking === "boolean" ? { thinking } : {}),
  };
  await db
    .prepare(
      `INSERT INTO state (k, v, updated_at) VALUES (?1, ?2, ?3)
       ON CONFLICT (k) DO UPDATE SET v = excluded.v, updated_at = excluded.updated_at`,
    )
    .bind(KEY, JSON.stringify(value), value.at)
    .run();
  return value;
}

/** Forgets the server if `target` is still the one registered (a newer server is left alone). */
export async function clearTarget(db, target) {
  const current = await readTarget(db);
  if (!current || current.target !== target) return false;
  await db.prepare("DELETE FROM state WHERE k = ?1 AND v = ?2").bind(KEY, JSON.stringify(current)).run();
  return true;
}

/** The server to talk to: what it registered, falling back to the deployment's defaults. */
export function serverInfo(env, registered) {
  const config = settings(env);
  return {
    host: registered?.host ?? "colab",
    numCtx: registered?.num_ctx ?? config.numCtx,
    vision: registered?.vision === true,
    quant: registered?.quant ?? null,
    control: registered?.control === true,
    numBatch: validBatch(registered?.num_batch) ? registered.num_batch : 512,
    profileId: validProfileId(registered?.profile_id) ? registered.profile_id : null,
    inferenceTransport: validInferenceTransport(registered?.inference_transport) ? registered.inference_transport : null,
  };
}
