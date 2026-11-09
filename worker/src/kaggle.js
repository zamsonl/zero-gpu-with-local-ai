// Starting the model server on Kaggle from the page (POST /v1/server/start).
//
// The Worker pushes the server script (kaggle-server.py) as a new version of a private Kaggle script
// and runs it, the same as "Save & Run All": GPU T4 x2, internet on. Kaggle's API is called with the
// owner's API token (Worker secret KAGGLE_API_TOKEN, or the older KAGGLE_USERNAME + KAGGLE_KEY).
//
// The script gets a launch token instead of the relay key: it lets the script register, report
// progress, poll for commands and sign off (see relay.js) and nothing else, and expires after 13
// hours. Only the latest launch's token works.
//
// The page is open to anyone with its link, so starting is limited: never while a server is up or
// starting, at most once every 4 minutes and 8 times a day; and an idle server stops by itself.

import CUSTOM_MODEL_RUNTIME from "./custom-model.py";
import {personalCacheRuntimeScript} from './personal-cache-source.js';
import SERVER_SCRIPT from "./kaggle-server.py";
import CACHE_HELPERS from "./kaggle-cache.py";
import STREAM_PROXY from "./kaggle-stream-proxy.py";
import ASYNC_JOBS from "./kaggle-jobs.py";
import NOTEBOOK_LOG from "./notebook-log.py";
import { settings } from "./config.js";
import { HttpError, json } from "./http.js";
import { getJson } from "./ollama.js";
import { readPreferences, writePreference } from "./preferences.js";
import { currentBoot, writeBoot } from "./server-control.js";
import { readTarget } from "./target.js";
import { nowIso } from "./util.js";

export const KERNEL_SLUG = "heretic-qwen-server";
const KERNEL_TITLE = "Heretic Qwen Server";
const DEFAULT_QUANT = "Q5_K_P";
// Memory sizes the script tries, largest first, until the model fits entirely on the two GPUs.
export const CONTEXTS = [131072, 98304, 81920, 65536, 49152, 32768, 24576];

export function kaggleBatch(env) {
  const batch = Number(env.KAGGLE_NUM_BATCH ?? 512);
  if (!Number.isInteger(batch) || batch < 32 || batch > 2048) throw new HttpError(500, "profile_config", "Invalid Kaggle processing batch.");
  return batch;
}

export function kaggleProfile(env, quant = DEFAULT_QUANT) {
  return `${env.KAGGLE_CACHE_ID || "unversioned"}:${quant}:kv-q8_0:b${kaggleBatch(env)}:t4x2`;
}

function allowedContexts(env) {
  const maximum = Number(env.KAGGLE_CONTEXT_MAX ?? CONTEXTS[0]);
  if (!Number.isInteger(maximum) || maximum < CONTEXTS.at(-1) || maximum > CONTEXTS[0]) throw new HttpError(500, "profile_config", "Invalid Kaggle context limit.");
  return CONTEXTS.filter((size) => size <= maximum);
}
// A launch younger than this that Kaggle still has queued or running isn't started again.
const LAUNCH_SETTLE_MS = 20 * 60_000;
const LOG_LINES = 400;
const LAUNCH_TTL_MS = 13 * 3600_000;
const MIN_GAP_MS = 4 * 60_000;
const MAX_PER_DAY = 8;
// While Kaggle queues the run, the page's status polls ask Kaggle how it's going this often at most.
const QUEUE_CHECK_MS = 30_000;
// A run Kaggle reports no status for at all, this long after the push, isn't going to start.
const SILENT_RUN_MS = 10 * 60_000;
const encoder = new TextEncoder();

export function kaggleConfigured(env) {
  return Boolean(env.KAGGLE_API_TOKEN || (env.KAGGLE_USERNAME && env.KAGGLE_KEY));
}

/** A ready, version-pinned private dataset mounted by Kaggle under /kaggle/input. */
export function cacheDataSources(env) {
  const dataset = env.KAGGLE_CACHE_DATASET;
  if (dataset === undefined || dataset === "") return [];
  if (typeof dataset !== "string" || !/^[A-Za-z0-9_-]{1,64}\/[A-Za-z0-9_-]{1,120}\/[1-9][0-9]*$/.test(dataset)) {
    throw new HttpError(500, "cache_config", "KAGGLE_CACHE_DATASET must be owner/slug/version, using a ready dataset version.");
  }
  return [dataset];
}

async function readState(db, k) {
  const row = await db.prepare("SELECT v FROM state WHERE k = ?1").bind(k).first();
  return row ? JSON.parse(row.v) : null;
}

async function writeState(db, k, value) {
  await db
    .prepare(
      `INSERT INTO state (k, v, updated_at) VALUES (?1, ?2, ?3)
       ON CONFLICT (k) DO UPDATE SET v = excluded.v, updated_at = excluded.updated_at`,
    )
    .bind(k, JSON.stringify(value), nowIso())
    .run();
}

function kaggleHeaders(env) {
  return {
    "content-type": "application/json",
    "user-agent": "heretic-qwen-relay/1",
    authorization: env.KAGGLE_API_TOKEN
      ? `Bearer ${env.KAGGLE_API_TOKEN}`
      : `Basic ${btoa(`${env.KAGGLE_USERNAME}:${env.KAGGLE_KEY}`)}`,
  };
}

/** One call to Kaggle's API (api.kaggle.com/v1/<service>/<method>, JSON in and out). */
async function kaggle(env, service, method, body) {
  const headers = kaggleHeaders(env);
  let res;
  try {
    res = await fetch(`${env.KAGGLE_API_BASE || "https://api.kaggle.com"}/v1/${service}/${method}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    throw new HttpError(502, "kaggle", "Kaggle didn't answer. Try again in a minute.");
  }
  const text = await res.text();
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    // not JSON
  }
  if (res.status === 401 || res.status === 403) {
    throw new HttpError(502, "kaggle_auth", "Kaggle refused the API token. Make a new one (Kaggle → Settings → API) and save it again.");
  }
  if (!res.ok) {
    const detail = parsed?.message || parsed?.error || text.slice(0, 200) || `status ${res.status}`;
    throw new HttpError(502, "kaggle", `Kaggle couldn't start it: ${detail}`);
  }
  return parsed ?? {};
}

/** The Kaggle username the token belongs to. */
async function kaggleUser(env) {
  if (env.KAGGLE_USERNAME) return env.KAGGLE_USERNAME;
  const info = await kaggle(env, "security.OAuthService", "IntrospectToken", { token: env.KAGGLE_API_TOKEN });
  if (!info.active || !info.username) {
    throw new HttpError(502, "kaggle_auth", "Kaggle says the API token isn't active. Make a new one (Kaggle → Settings → API) and save it again.");
  }
  return info.username;
}

async function sha256Hex(value) {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * The script with this launch's details filled in: strings and the list as JSON (valid Python
 * literals), whether pictures are known to work as Python's True or None.
 */
export function serverScript({ relay, token, quant, contexts = CONTEXTS, vision = null, cacheId = "", numBatch = 512, profileId = "", agentOnly = false, modelSpec = null, personalCacheSpec = null }) {
  let script = SERVER_SCRIPT.replace("__RELAY__", JSON.stringify(relay))
    .replace("__LAUNCH_TOKEN__", JSON.stringify(token))
    .replace("__QUANT__", JSON.stringify(quant))
    .replace("__CONTEXTS__", JSON.stringify(contexts))
    .replace("__VISION__", vision === true ? "True" : "None")
    .replace("__CACHE_ID__", () => JSON.stringify(cacheId))
    .replace("__BATCH_SIZE__", String(numBatch))
    .replace("__PROFILE_ID__", () => JSON.stringify(profileId));
  if (agentOnly) {
    if (!script.includes("AGENT_ONLY = False")) throw new Error("Agent-only notebook flag is missing.");
    script = script.replace("AGENT_ONLY = False", "AGENT_ONLY = True");
  }
  if (modelSpec) {
    if (!agentOnly) throw new Error("Custom GGUF requires an isolated personal session.");
    const marker='if __name__ == "__main__":';
    if(!script.includes(marker))throw new Error("Notebook entry point is missing.");
    script=script.replace(marker,()=>`CUSTOM_MODEL_SPEC = json.loads(${JSON.stringify(JSON.stringify(modelSpec))})\n${CUSTOM_MODEL_RUNTIME}\n${marker}`);
  }
  if(personalCacheSpec){if(!agentOnly)throw new Error('Personal cache requires an isolated session.');script=script.replace('if __name__ == "__main__":',()=>personalCacheRuntimeScript(personalCacheSpec)+'\nif __name__ == "__main__":');}
  return `${CACHE_HELPERS}\n\n${STREAM_PROXY}\n\n${ASYNC_JOBS}\n\n${NOTEBOOK_LOG}\n\n${script}`;
}

/**
 * Remembers what a Kaggle server found out about this build (the memory size that fitted, whether
 * it saw a picture), so the next start skips finding out again (relay.js calls it).
 */
export async function rememberFit(db, { num_ctx, quant, vision, num_batch, profile_id }) {
  if (num_ctx && quant) await writeState(db, "kaggle_fit", { num_ctx, quant, vision: vision === true, num_batch: num_batch ?? 512, profile_id: profile_id ?? null, at: nowIso() });
}

/** What the last server with this build found: sizes to try (from the one that fitted, down) and pictures. */
async function knownFit(db, env, quant) {
  const contexts = allowedContexts(env);
  const fit = await readState(db, "kaggle_fit");
  if (fit?.quant !== quant || fit.profile_id !== kaggleProfile(env, quant) || fit.num_batch !== kaggleBatch(env)) return { contexts, vision: null };
  const from = contexts.filter((size) => size <= fit.num_ctx);
  return { contexts: from.length ? from : contexts, vision: fit.vision === true ? true : null };
}

/** What Kaggle says about the latest run: QUEUED, RUNNING, COMPLETE, ERROR… (null if unknown). */
async function runStatus(env, launch) {
  try {
    const run = await kaggle(env, "kernels.KernelsApiService", "GetKernelSessionStatus", { userName: launch.user, kernelSlug: launch.slug });
    return { status: String(run.status ?? "").toUpperCase() || null, failureMessage: run.failureMessage || null };
  } catch (err) {
    console.error("asking Kaggle about the run failed:", err);
    return { status: null, failureMessage: null };
  }
}

/** True when the request carries the current launch's token, before it expires. */
export async function hasLaunchToken(request, db) {
  const given = request.headers.get("x-launch-token");
  if (!given) return false;
  const launch = await readState(db, "launch");
  if (!launch || !(Date.parse(launch.expires_at) > Date.now())) return false;
  if (typeof launch.token_sha256 !== "string" || launch.token_sha256.length !== 64) return false;
  return crypto.subtle.timingSafeEqual(encoder.encode(await sha256Hex(given)), encoder.encode(launch.token_sha256));
}

/** POST /v1/server/start */
export async function startServer({ env, request }) {
  const db = env.DB;
  if (!kaggleConfigured(env)) {
    throw new HttpError(409, "not_configured", "Starting from here needs your Kaggle API token saved on the server first.");
  }
  const datasetDataSources = cacheDataSources(env);
  const registered = await readTarget(db);
  if (registered && (await getJson(registered.target, "/api/version", 4_000))) {
    throw new HttpError(409, "running", "A model server is already running.");
  }
  const boot = await currentBoot(db, registered);
  if (boot && boot.stage !== "failed") throw new HttpError(409, "starting", "The server is already starting.");

  const now = Date.now();
  // The page may have lost track of a run that's still waiting for a GPU: ask Kaggle before
  // starting a second one.
  const previous = await readState(db, "launch");
  if (previous && now - Date.parse(previous.at) < LAUNCH_SETTLE_MS && !boot) {
    const { status } = await runStatus(env, previous);
    if (status === "QUEUED" || (status === "RUNNING" && !registered)) {
      const detail = status === "RUNNING" ? "Kaggle is starting the machine" : "Waiting for Kaggle to assign two GPUs";
      await writeBoot(db, { host: "kaggle", stage: "queued", detail, percent: null });
      throw new HttpError(409, "starting", "Kaggle is still starting the last run.");
    }
  }
  const recent = ((await readState(db, "launches")) ?? []).filter((at) => now - Date.parse(at) < 24 * 3600_000);
  const last = recent.at(-1);
  if (last && now - Date.parse(last) < MIN_GAP_MS) {
    throw new HttpError(409, "starting", "Kaggle was asked to start the server moments ago. Give it a few minutes.");
  }
  if (recent.length >= MAX_PER_DAY) {
    throw new HttpError(429, "too_many", `The server has been started ${MAX_PER_DAY} times in the last day. Start it from Kaggle instead.`);
  }

  const user = await kaggleUser(env);
  const token = randomToken();
  const quant = env.KAGGLE_QUANT || DEFAULT_QUANT;
  const saved = await kaggle(env, "kernels.KernelsApiService", "SaveKernel", {
    slug: `${user}/${KERNEL_SLUG}`,
    newTitle: KERNEL_TITLE,
    text: serverScript({ relay: new URL(request.url).origin, token, quant, cacheId: env.KAGGLE_CACHE_ID || "", numBatch: kaggleBatch(env), profileId: kaggleProfile(env, quant), ...(await knownFit(db, env, quant)) }),
    language: "python",
    kernelType: "script",
    isPrivate: true,
    enableGpu: true,
    enableInternet: true,
    machineShape: "NvidiaTeslaT4", // GPU T4 x2
    kernelExecutionType: "SAVE_AND_RUN_ALL",
    datasetDataSources,
    kernelDataSources: [],
    competitionDataSources: [],
    modelDataSources: [],
    categoryIds: [],
  });
  if (saved.error) throw new HttpError(502, "kaggle", `Kaggle couldn't start it: ${saved.error}`);

  const page = `https://www.kaggle.com/code/${user}/${KERNEL_SLUG}`;
  await writeState(db, "launch", {
    token_sha256: await sha256Hex(token),
    at: nowIso(),
    expires_at: new Date(now + LAUNCH_TTL_MS).toISOString(),
    user,
    slug: KERNEL_SLUG,
    version: saved.versionNumber ?? null,
    checked_at: nowIso(),
  });
  await writeState(db, "launches", [...recent, nowIso()]);
  await db.prepare("DELETE FROM state WHERE k = 'server_log:kaggle'").run();
  await writeBoot(db, { host: "kaggle", stage: "queued", detail: "Waiting for Kaggle to assign two GPUs", percent: null });
  // The Open Kaggle button goes to this notebook's page (its runs and logs) unless another link was set.
  if (!(await readPreferences(db, env)).kaggle_url) await writePreference(db, env, "kaggle_url", page);
  return json({ ok: true, url: page, version: saved.versionNumber ?? null });
}

/**
 * While a launch waits in Kaggle's queue (before the script reports anything), asks Kaggle how the
 * run is going, at most every QUEUE_CHECK_MS: a run that failed or ended shows as failed, one still
 * queued keeps its start-up fresh. Never throws; the status endpoint calls it.
 */
export async function followQueuedLaunch(env, boot) {
  if (boot?.host !== "kaggle" || boot.stage !== "queued" || !kaggleConfigured(env)) return boot;
  try {
    const launch = await readState(env.DB, "launch");
    const every = QUEUE_CHECK_MS * settings(env).timingScale;
    if (!launch || Date.now() - Date.parse(launch.checked_at) < every) return boot;
    await writeState(env.DB, "launch", { ...launch, checked_at: nowIso() });
    const run = await kaggle(env, "kernels.KernelsApiService", "GetKernelSessionStatus", {
      userName: launch.user,
      kernelSlug: launch.slug,
    });
    const status = String(run.status ?? "").toUpperCase();
    let next;
    if (["ERROR", "CANCEL_REQUESTED", "CANCEL_ACKNOWLEDGED"].includes(status)) {
      next = { host: "kaggle", stage: "failed", detail: run.failureMessage || "Kaggle stopped the run before it started.", percent: null };
    } else if (status === "COMPLETE") {
      next = { host: "kaggle", stage: "failed", detail: "The Kaggle run ended before the server started.", percent: null };
    } else if (!status && Date.now() - Date.parse(launch.at) > SILENT_RUN_MS * settings(env).timingScale) {
      // Kaggle saved the notebook but never gave the run a machine (a limited or suspended account
      // looks like this): saying "waiting" forever would hide that.
      next = {
        host: "kaggle",
        stage: "failed",
        detail: "Kaggle saved the notebook but hasn't started it. Check your Kaggle account and the notebook's page.",
        percent: null,
      };
    } else {
      next = { host: "kaggle", stage: "queued", detail: status === "RUNNING" ? "Kaggle is starting the machine" : "Waiting for Kaggle to assign two GPUs", percent: null };
    }
    // Only over the start-up this poll read: the notebook may have reported its first step while
    // Kaggle was being asked, and its own news wins.
    const at = nowIso();
    const { meta } = await env.DB.prepare("UPDATE state SET v = ?1, updated_at = ?2 WHERE k = 'boot' AND updated_at = ?3")
      .bind(JSON.stringify({ ...next, at }), at, boot.at)
      .run();
    return meta.changes ? { ...next, at } : boot;
  } catch (err) {
    console.error("checking the Kaggle run failed:", err);
    return boot;
  }
}

/**
 * GET /v1/server/log: the end of the latest Kaggle run's log, so the page can show what the server
 * did without a trip to Kaggle. A finished run's log is stored with its output; a running one's is
 * read from Kaggle's live log stream for a few seconds. Tunnel addresses are hidden (they reach the
 * model directly, without the relay).
 */
export async function kaggleServerLog({ env }) {
  if (!kaggleConfigured(env)) throw new HttpError(409, "not_configured", "The server log needs your Kaggle API token saved on the server.");
  const launch = await readState(env.DB, "launch");
  if (!launch) return json({ log: "", truncated: false, status: null, failure: null, url: null, started_at: null });
  const query = { userName: launch.user, kernelSlug: launch.slug };
  const { status, failureMessage } = await runStatus(env, launch);
  let log = "";
  try {
    const output = await kaggle(env, "kernels.KernelsApiService", "ListKernelSessionOutput", { ...query, pageSize: 1 });
    log = logText(output.log ?? "");
  } catch (err) {
    console.error("reading the stored Kaggle log failed:", err);
  }
  if (!log && (status === "RUNNING" || status === "QUEUED")) log = await liveLog(env, query);
  const lines = withoutKaggleNoise(redactTunnels(log).replace(/\r/g, "").split("\n"));
  return json({
    log: lines.slice(-LOG_LINES).join("\n").trim(),
    truncated: lines.length > LOG_LINES,
    status,
    failure: failureMessage,
    url: `https://www.kaggle.com/code/${launch.user}/${launch.slug}`,
    started_at: launch.at,
  });
}

/** Kaggle stores a run's log as JSON entries of { stream_name, time, data }; plain text passes through. */
export function logText(raw) {
  const text = String(raw ?? "").trim();
  if (!text) return "";
  let entries = null;
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) entries = parsed;
  } catch {
    // one JSON object per line, or not JSON at all
    const parsed = text.split("\n").map((line) => {
      try {
        return JSON.parse(line.trim().replace(/,$/, ""));
      } catch {
        return null;
      }
    });
    if (parsed.length && parsed.every((entry) => entry && typeof entry === "object")) entries = parsed;
  }
  if (!entries) return text;
  return entries.map((entry) => (typeof entry === "string" ? entry : String(entry?.data ?? ""))).join("");
}

/**
 * Drops what Kaggle itself appends after the run: it renders the script to HTML with nbconvert,
 * which logs "[NbConvertApp] …" lines and Python SyntaxWarnings from its own libraries (each
 * followed by the offending source line).
 */
function withoutKaggleNoise(lines) {
  const kept = [];
  for (let i = 0; i < lines.length; i++) {
    if (/^\[NbConvertApp\]/.test(lines[i])) continue;
    if (/^\/usr\/.*\/(dist|site)-packages\/.*Warning: /.test(lines[i])) {
      if (/^\s/.test(lines[i + 1] ?? "")) i++;
      continue;
    }
    kept.push(lines[i]);
  }
  return kept;
}

function redactTunnels(text) {
  return text.replace(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/g, "[tunnel address hidden]");
}

/** A running session's log so far, from Kaggle's live stream (Server-Sent Events), read briefly. */
async function liveLog(env, query) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 6_000);
  let text = "";
  try {
    const res = await fetch(`${env.KAGGLE_API_BASE || "https://api.kaggle.com"}/v1/kernels.KernelsApiService/GetKernelSessionLogsStream`, {
      method: "POST",
      headers: kaggleHeaders(env),
      body: JSON.stringify({ ...query, waitForLogsUrlSeconds: 3 }),
      signal: controller.signal,
    });
    if (!res.ok || !res.body) return "";
    if ((res.headers.get("content-type") ?? "").includes("application/json")) return logText(await res.text());
    const decoder = new TextDecoder();
    for await (const chunk of res.body) {
      text += decoder.decode(chunk, { stream: true });
      if (text.length > 400_000) break;
    }
  } catch {
    // the time budget ran out: keep what arrived
  } finally {
    clearTimeout(timer);
  }
  return text
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .filter((line) => line && line !== "END_OF_LOG")
    .map((line) => {
      try {
        const entry = JSON.parse(line);
        return typeof entry === "string" ? entry : String(entry?.data ?? "");
      } catch {
        return line + "\n";
      }
    })
    .join("");
}
