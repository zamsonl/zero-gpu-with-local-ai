// Host-aware startup/runtime logs; old Kaggle notebooks retain their API fallback.
import { HttpError, json } from "./http.js";
import { kaggleServerLog } from "./kaggle.js";
import { currentBoot, readState } from "./server-control.js";
import { readTarget, HOSTS } from "./target.js";
import { settings } from "./config.js";
import { readPreferences } from "./preferences.js";
const FALLBACK_TTL_MS = 10_000;
const fallbackCache = new Map();
const keyFor = (host) => `server_log:${host}`;

/** Host-aware log feed. The original Kaggle API path remains available for old running notebooks. */
export async function serverLog({ env, url }) {
  const explicit = url?.searchParams.get("host");
  if (explicit && !HOSTS.includes(explicit)) throw new HttpError(400, "bad_request", "Unknown notebook host.");
  const target = await readTarget(env.DB);
  const boot = await currentBoot(env.DB, target);
  const host = explicit || boot?.host || target?.host || (target ? "colab" : "kaggle");
  const [reported, launch] = await Promise.all([readState(env.DB, keyFor(host)), host === "kaggle" ? readState(env.DB, "launch") : null]);
  const valid = reported && (host !== "kaggle" || !launch || Date.parse(reported.started_at) >= Date.parse(launch.at) - 5 * 60_000);
  const { colabUrl, kaggleUrl } = settings(env);
  const page = host === "colab" ? colabUrl || null : launch ? `https://www.kaggle.com/code/${launch.user}/${launch.slug}` : (await readPreferences(env.DB, env)).kaggle_url || kaggleUrl || null;
  if (valid) return json({ host, source: "reported", run_id: reported.run_id, log: reported.lines.join("\n"), truncated: reported.truncated,
    status: reported.status, failure: null, url: page, started_at: reported.started_at, updated_at: reported.updated_at });
  if (host === "colab") return json({ host, source: "unavailable", run_id: null, log: "", truncated: false, status: null, failure: null, url: page,
    started_at: null, updated_at: null, message: "Waiting for this Colab notebook to send logs. Older notebooks need the updated startup cell." });
  if (!explicit) return kaggleServerLog({ env });
  const cacheKey = `${env.KAGGLE_API_BASE || "kaggle"}:${launch?.at || "none"}:${launch?.user || ""}`;
  let cached = fallbackCache.get(cacheKey);
  if (!cached || cached.until <= Date.now()) {
    const pending = kaggleServerLog({ env }).then(async (response) => ({ body: await response.json(), status: response.status }));
    cached = { until: Date.now() + FALLBACK_TTL_MS, updated_at: new Date().toISOString(), pending };
    fallbackCache.set(cacheKey, cached);
    if (fallbackCache.size > 8) fallbackCache.delete(fallbackCache.keys().next().value);
    pending.catch(() => { if (fallbackCache.get(cacheKey) === cached) fallbackCache.delete(cacheKey); });
  }
  const fallback = await cached.pending;
  return json({ ...fallback.body, host, source: "kaggle", run_id: launch?.at || null, updated_at: cached.updated_at }, fallback.status);
}
