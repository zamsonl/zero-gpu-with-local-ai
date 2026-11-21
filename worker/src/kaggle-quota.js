// The Kaggle account's own GPU allowance for the week, as Kaggle counts it (GET /v1/status →
// kaggle_quota): Kaggle's GetAcceleratorQuotaStatistics, read with the Worker's API token.
//
// Kaggle answers e.g. {"quotaRefreshTime":"2026-11-21T00:00:00Z","gpuQuota":{"timeUsed":"9331.6s",
// "timeReserved":"0s","totalTimeAllowed":"108000s",…}}: durations are seconds strings, and what is left
// is the allowance minus the time used and the time held for a running session.
//
// The answer is kept in D1 (`state` k='kaggle_quota') for about 5 minutes, and read again sooner after
// a server starts or stops (k='kaggle_quota_due', see server-control.js) or once the weekly reset has
// passed. Status polls never wait on Kaggle for long: a refresh runs in the background
// (ctx.waitUntil); only the very first one is waited for, briefly. When Kaggle fails, the last good
// answer stays (with when it was read) and Kaggle is asked again on the next cycle, not every poll.

import { settings } from "./config.js";
import { kaggle, kaggleConfigured } from "./kaggle.js";
import { readState, writeState } from "./server-control.js";
import { nowIso } from "./util.js";

const QUOTA_FRESH_MS = 5 * 60_000;
const QUOTA_TIMEOUT_MS = 8_000;
// With nothing read yet, a status poll waits this long for the first answer before going without.
const FIRST_WAIT_MS = 2_500;

/** "9331.6s" → 9331.6; anything else → NaN. */
function seconds(value) {
  const match = /^(\d+(?:\.\d+)?)s$/.exec(typeof value === "string" ? value.trim() : "");
  return match ? Number(match[1]) : NaN;
}

/**
 * Kaggle's answer as the page gets it: `{ used_s, total_s, reserved_s, remaining_s, refreshes_at,
 * fetched_at }` (whole seconds; ISO times), or null when it isn't a usable GPU quota.
 */
export function parseQuota(body, fetchedAt = nowIso()) {
  const gpu = body?.gpuQuota;
  const total = seconds(gpu?.totalTimeAllowed);
  const used = seconds(gpu?.timeUsed);
  const held = seconds(gpu?.timeReserved);
  if (!(total > 0) || !(used >= 0)) return null;
  const reserved = held >= 0 ? held : 0;
  const refresh = Date.parse(body?.quotaRefreshTime ?? "");
  return {
    used_s: Math.round(used),
    total_s: Math.round(total),
    reserved_s: Math.round(reserved),
    remaining_s: Math.max(0, Math.floor(total - used - reserved)),
    refreshes_at: Number.isFinite(refresh) ? new Date(refresh).toISOString() : null,
    fetched_at: fetchedAt,
  };
}

/** One read from Kaggle; null when it fails or the answer isn't usable (never throws). */
async function readQuota(env) {
  try {
    return parseQuota(await kaggle(env, "kernels.KernelsApiService", "GetAcceleratorQuotaStatistics", {}, { timeout: QUOTA_TIMEOUT_MS }));
  } catch (err) {
    console.warn(`Kaggle GPU quota unavailable: ${err?.message ?? err}`);
    return null;
  }
}

/**
 * The quota for /v1/status: the kept answer, refreshed when it is due (in the background when there
 * is one to show meanwhile). Null when Kaggle isn't set up or has never answered. Never throws.
 */
export async function kaggleQuota(env, ctx = null) {
  if (!kaggleConfigured(env)) return null;
  try {
    const [kept, due] = await Promise.all([readState(env.DB, "kaggle_quota"), readState(env.DB, "kaggle_quota_due")]);
    const value = kept?.value ?? null;
    const now = Date.now();
    const tried = Date.parse(kept?.tried_at ?? "");
    const passed = (iso) => {
      const at = Date.parse(iso ?? "");
      return at <= now && !(tried >= at);
    };
    const stale = !(now - tried < QUOTA_FRESH_MS * settings(env).timingScale) || passed(due?.due_at) || passed(value?.refreshes_at);
    if (!stale) return value;
    // Claimed before asking, so the status polls of several open pages don't all ask at once.
    await writeState(env.DB, "kaggle_quota", { value, tried_at: nowIso() });
    const refresh = readQuota(env).then(async (fresh) => {
      if (fresh) await writeState(env.DB, "kaggle_quota", { value: fresh, tried_at: fresh.fetched_at });
    }).catch((err) => console.warn(`keeping the Kaggle GPU quota failed: ${err?.message ?? err}`));
    ctx?.waitUntil?.(refresh);
    if (value) return value;
    await Promise.race([refresh, new Promise((resolve) => setTimeout(resolve, FIRST_WAIT_MS))]);
    return (await readState(env.DB, "kaggle_quota"))?.value ?? null;
  } catch (err) {
    console.error("reading the Kaggle GPU quota failed:", err);
    return null;
  }
}
