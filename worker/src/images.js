// Pictures from Qwen-Image 2.1, made on the notebook's GPU.
//
// The page queues a picture (D1 `images`). The notebook, polling /_relay/command while it is in
// image mode, takes the oldest queued one, reports each sampling step, and uploads the PNG and a
// small WebP preview, which are kept in R2 (binding IMAGES). ComfyUI never faces the internet: the
// notebook pulls the work and pushes the results.
//
// The chat model and the image model can't share the GPUs, so the notebook runs one at a time.
// POST /v1/server/mode asks it to switch (D1 state k='mode_request'); it reports how the switch is
// going (k='server_mode'); chat turns are refused while pictures have the GPUs.

import { HttpError, badRequest, json, notFound, readJsonObject, text } from "./http.js";
import { readState, writeState } from "./server-control.js";
import { readTarget } from "./target.js";
import { nowIso, randomId } from "./util.js";

/** Sizes near one megapixel in Qwen-Image's aspect ratios, multiples of 16. */
export const ASPECTS = {
  square: [1024, 1024],
  portrait: [832, 1248],
  landscape: [1248, 832],
  tall: [768, 1344],
  wide: [1344, 768],
};
/** fast: the official Turbo LoRA (8 steps, cfg 1, no negative prompt); quality: 25 steps at cfg 3. */
export const SPEEDS = { fast: { steps: 8, cfg: 1 }, quality: { steps: 25, cfg: 3 } };
export const MODES = ["chat", "images"];
const MODE_STATES = ["switching", "ready", "failed"];

const MAX_PROMPT_CHARS = 2000;
const MAX_NEGATIVE_CHARS = 1000;
const MAX_WAITING = 8; // queued + running
const LIST_LIMIT = 60;
const PNG_LIMIT = 40 * 1024 * 1024;
const THUMB_LIMIT = 2 * 1024 * 1024;
// A picture whose notebook stopped reporting for this long is not coming.
const STALE_MS = 10 * 60_000;
const MAX_DETAIL_CHARS = 200;
const COLUMNS =
  "id, prompt, negative, aspect, width, height, speed, seed, status, step, steps, error, bytes, has_thumb, created_at, started_at, updated_at, finished_at";

const toImage = (row) => (row ? { ...row, has_thumb: row.has_thumb === 1 } : null);
const fileKey = (id, kind) => (kind === "thumb" ? `images/${id}.thumb.webp` : `images/${id}.png`);

function requireBucket(env) {
  if (!env.IMAGES) throw new HttpError(503, "no_storage", "Picture storage isn't set up on this deployment.");
  return env.IMAGES;
}

// ---------------------------------------------------------------- mode

/**
 * Where the registered notebook is: the mode it last reported (and how the switch is going), and
 * the mode the page last asked for. Both only count for the server registered now.
 */
export async function readMode(db, registered) {
  if (!registered) return { current: "chat", requested: "chat", state: "ready", detail: null, percent: null };
  const [reported, request] = await Promise.all([readState(db, "server_mode"), readState(db, "mode_request")]);
  const mine = (value) => value && value.target === registered.target;
  const current = mine(reported) ? reported.mode : "chat";
  return {
    current,
    requested: mine(request) ? request.mode : current,
    state: mine(reported) ? reported.state : "ready",
    detail: mine(reported) ? reported.detail ?? null : null,
    percent: mine(reported) ? reported.percent ?? null : null,
  };
}

/** True while pictures have the GPUs, or are about to: chat turns wait for the switch back. */
export function picturesHaveGpu(mode) {
  return mode.current === "images" || mode.requested === "images";
}

async function requireControlServer(db) {
  const registered = await readTarget(db);
  if (!registered) throw new HttpError(409, "offline", "No model server is running. Start the Kaggle notebook or the updated Colab notebook first.");
  if (!registered.control) {
    throw new HttpError(409, "unsupported", "Pictures need the updated Kaggle or Colab runtime, which can switch between chat and pictures.");
  }
  return registered;
}

/** POST /v1/server/mode {mode}: asks the running notebook to give the GPUs to chat or pictures. */
export async function requestMode({ env, request }) {
  const { mode } = await readJsonObject(request);
  if (!MODES.includes(mode)) throw badRequest('mode must be "chat" or "images".');
  const registered = await requireControlServer(env.DB);
  await writeState(env.DB, "mode_request", { target: registered.target, mode });
  return json({ ok: true, mode: await readMode(env.DB, registered) });
}

/** A new server starts in chat mode with nothing running: older mode news and half-made pictures go. */
export async function resetForNewServer(db) {
  const now = nowIso();
  await db.batch([
    db.prepare("DELETE FROM state WHERE k IN ('mode_request', 'server_mode')"),
    db
      .prepare("UPDATE images SET status = 'failed', error = ?1, updated_at = ?2, finished_at = ?2 WHERE status = 'running'")
      .bind("The server stopped before this picture was finished.", now),
  ]);
}

// ---------------------------------------------------------------- the page's API

function parseNew(body) {
  const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
  if (!prompt) throw badRequest("Describe the picture first.");
  if (prompt.length > MAX_PROMPT_CHARS) throw badRequest(`Keep the description under ${MAX_PROMPT_CHARS} characters.`);
  const negative = body.negative == null ? "" : String(body.negative).trim();
  if (negative.length > MAX_NEGATIVE_CHARS) throw badRequest(`Keep "avoid" under ${MAX_NEGATIVE_CHARS} characters.`);
  const aspect = body.aspect ?? "square";
  if (!ASPECTS[aspect]) throw badRequest(`aspect must be one of ${Object.keys(ASPECTS).join(", ")}.`);
  const speed = body.speed ?? "fast";
  if (!SPEEDS[speed]) throw badRequest('speed must be "fast" or "quality".');
  let seed = body.seed;
  if (seed == null) seed = crypto.getRandomValues(new Uint32Array(1))[0];
  if (!(Number.isInteger(seed) && seed >= 0 && seed <= 0xffffffff)) throw badRequest("seed must be a whole number from 0 to 4294967295.");
  return { prompt, negative, aspect, speed, seed };
}

/** Running pictures nobody has heard about for a while failed: their notebook went away. */
async function failStale(db) {
  const cutoff = new Date(Date.now() - STALE_MS).toISOString();
  const now = nowIso();
  await db
    .prepare("UPDATE images SET status = 'failed', error = ?1, updated_at = ?2, finished_at = ?2 WHERE status = 'running' AND updated_at < ?3")
    .bind("The server stopped answering while it made this picture.", now, cutoff)
    .run();
}

/** POST /v1/images {prompt, negative?, aspect?, speed?, seed?}: queues a picture, switching to pictures if needed. */
export async function createImage({ env, request }) {
  const input = parseNew(await readJsonObject(request));
  requireBucket(env);
  const registered = await requireControlServer(env.DB);
  await failStale(env.DB);
  const waiting = await env.DB.prepare("SELECT COUNT(*) AS n FROM images WHERE status IN ('queued', 'running')").first("n");
  if (waiting >= MAX_WAITING) throw new HttpError(429, "queue_full", `${MAX_WAITING} pictures are already waiting. Let some finish first.`);
  const mode = await readMode(env.DB, registered);
  if (mode.requested !== "images") await writeState(env.DB, "mode_request", { target: registered.target, mode: "images" });
  const [width, height] = ASPECTS[input.aspect];
  const now = nowIso();
  const image = await env.DB
    .prepare(
      `INSERT INTO images (id, prompt, negative, aspect, width, height, speed, seed, status, steps, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'queued', ?9, ?10, ?10) RETURNING ${COLUMNS}`,
    )
    .bind(randomId(), input.prompt, input.negative, input.aspect, width, height, input.speed, input.seed, SPEEDS[input.speed].steps, now)
    .first();
  return json({ image: toImage(image) }, 201);
}

/** GET /v1/images?before=ISO: newest first, LIST_LIMIT at a time. */
export async function listImages({ env, url }) {
  await failStale(env.DB);
  const before = url.searchParams.get("before");
  if (before != null && Number.isNaN(Date.parse(before))) throw badRequest("before must be an ISO date.");
  const { results } = await env.DB
    .prepare(`SELECT ${COLUMNS} FROM images WHERE ?1 IS NULL OR created_at < ?1 ORDER BY created_at DESC, id LIMIT ${LIST_LIMIT + 1}`)
    .bind(before)
    .all();
  return json({ images: results.slice(0, LIST_LIMIT).map(toImage), has_more: results.length > LIST_LIMIT });
}

async function findImage(db, id) {
  const image = await db.prepare(`SELECT ${COLUMNS} FROM images WHERE id = ?1`).bind(id).first();
  if (!image) throw notFound("No such picture.");
  return image;
}

/** GET /v1/images/:id */
export async function getImage({ env, params }) {
  return json({ image: toImage(await findImage(env.DB, params.id)) });
}

/** GET /v1/images/:id/file?size=thumb|full: the stored WebP preview or PNG. */
export async function imageFile({ env, params, url }) {
  const kind = url.searchParams.get("size") === "thumb" ? "thumb" : "full";
  const image = await findImage(env.DB, params.id);
  if (image.status !== "done") throw notFound("This picture isn't finished.");
  const object = await requireBucket(env).get(fileKey(image.id, kind === "thumb" && image.has_thumb ? "thumb" : "full"));
  if (!object) throw notFound("The picture's file is missing.");
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("etag", object.httpEtag);
  // The id names one picture forever, so a browser may keep it.
  headers.set("cache-control", "private, max-age=31536000, immutable");
  if (kind === "full") headers.set("content-disposition", `inline; filename="qwen-image-${image.id}.png"`);
  return new Response(object.body, { headers });
}

/** DELETE /v1/images/:id: removes it; a picture being made is abandoned (the notebook stops it). */
export async function deleteImage({ env, params }) {
  const image = await findImage(env.DB, params.id);
  await env.DB.prepare("DELETE FROM images WHERE id = ?1").bind(image.id).run();
  if (env.IMAGES) await env.IMAGES.delete([fileKey(image.id, "full"), fileKey(image.id, "thumb")]);
  return json({ ok: true });
}

// ---------------------------------------------------------------- the notebook's side

/**
 * What /_relay/command adds for the notebook at `target`: the mode to be in, and, once it is in
 * image mode, the next picture to make (claimed here, so it's handed out once).
 */
export async function imageCommand(db, registered, target) {
  if (!registered || registered.target !== target || !registered.control) return {};
  const mode = await readMode(db, registered);
  if (mode.requested !== "images" || mode.current !== "images" || mode.state !== "ready") return { mode: mode.requested };
  await failStale(db);
  const running = await db.prepare("SELECT id FROM images WHERE status = 'running' LIMIT 1").first();
  if (running) return { mode: "images" };
  const next = await db.prepare("SELECT id FROM images WHERE status = 'queued' ORDER BY created_at, id LIMIT 1").first();
  if (!next) return { mode: "images" };
  const now = nowIso();
  const job = await db
    .prepare(
      `UPDATE images SET status = 'running', step = 0, started_at = ?2, updated_at = ?2
       WHERE id = ?1 AND status = 'queued' RETURNING id, prompt, negative, width, height, speed, seed, steps`,
    )
    .bind(next.id, now)
    .first();
  if (!job) return { mode: "images" };
  return { mode: "images", job: { ...job, cfg: SPEEDS[job.speed].cfg } };
}

/** POST /_relay/mode {target, mode, state, detail?, percent?}: how the notebook's switch is going. */
export async function reportMode(request, env) {
  let fields;
  try {
    fields = await readJsonObject(request);
  } catch {
    return text("bad mode\n", 400);
  }
  const { target, mode, state, detail, percent } = fields;
  const registered = await readTarget(env.DB);
  if (!registered || registered.target !== target) return text("not the registered server\n", 409);
  if (!MODES.includes(mode) || !MODE_STATES.includes(state)) return text("bad mode\n", 400);
  if (detail != null && typeof detail !== "string") return text("bad detail\n", 400);
  if (percent != null && !(Number.isInteger(percent) && percent >= 0 && percent <= 100)) return text("bad percent\n", 400);
  const clean = detail?.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, MAX_DETAIL_CHARS) || null;
  await writeState(env.DB, "server_mode", { target, mode, state, detail: clean, percent: percent ?? null });
  // A switch that failed leaves the notebook where it was; the page's request follows it there.
  if (state === "failed") await writeState(env.DB, "mode_request", { target, mode: mode === "images" ? "chat" : "images" });
  return Response.json({ ok: true });
}

/** POST /_relay/image-progress {id, step}: one more sampling step; answers whether to carry on. */
export async function reportImageProgress(request, env) {
  let fields;
  try {
    fields = await readJsonObject(request);
  } catch {
    return text("bad progress\n", 400);
  }
  const { id, step } = fields;
  if (typeof id !== "string" || !Number.isInteger(step) || step < 0 || step > 200) return text("bad progress\n", 400);
  const row = await env.DB
    .prepare("UPDATE images SET step = MIN(?2, steps), updated_at = ?3 WHERE id = ?1 AND status = 'running' RETURNING id")
    .bind(id, step, nowIso())
    .first();
  return Response.json({ ok: true, cancel: !row });
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

async function readBytes(request, limit) {
  if (Number(request.headers.get("content-length")) > limit) return null;
  const bytes = new Uint8Array(await request.arrayBuffer());
  return bytes.byteLength <= limit ? bytes : null;
}

/**
 * POST /_relay/image-result?id=…&kind=thumb|full|error. thumb: the WebP preview (sent first);
 * full: the PNG, which finishes the picture; error: JSON {error}, which fails it.
 */
export async function reportImageResult(request, env, url) {
  const id = url.searchParams.get("id") ?? "";
  const kind = url.searchParams.get("kind");
  const row = await env.DB.prepare("SELECT id, status FROM images WHERE id = ?1").bind(id).first();
  if (!row || row.status !== "running") return Response.json({ ok: false, cancel: true });
  const now = nowIso();
  if (kind === "error") {
    let message = "The server couldn't make this picture.";
    try {
      const fields = await readJsonObject(request);
      if (typeof fields.error === "string" && fields.error.trim()) message = fields.error.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 300);
    } catch {
      // keep the general message
    }
    await env.DB.prepare("UPDATE images SET status = 'failed', error = ?2, updated_at = ?3, finished_at = ?3 WHERE id = ?1").bind(id, message, now).run();
    return Response.json({ ok: true });
  }
  const bucket = env.IMAGES;
  if (!bucket) return text("no storage\n", 503);
  if (kind === "thumb") {
    const bytes = await readBytes(request, THUMB_LIMIT);
    if (!bytes || bytes.byteLength < 12 || String.fromCharCode(...bytes.slice(8, 12)) !== "WEBP") return text("bad thumb\n", 400);
    await bucket.put(fileKey(id, "thumb"), bytes, { httpMetadata: { contentType: "image/webp" } });
    await env.DB.prepare("UPDATE images SET has_thumb = 1, updated_at = ?2 WHERE id = ?1").bind(id, now).run();
    return Response.json({ ok: true });
  }
  if (kind !== "full") return text("bad kind\n", 400);
  const bytes = await readBytes(request, PNG_LIMIT);
  if (!bytes || !PNG_SIGNATURE.every((b, i) => bytes[i] === b)) return text("bad png\n", 400);
  await bucket.put(fileKey(id, "full"), bytes, { httpMetadata: { contentType: "image/png" } });
  await env.DB
    .prepare("UPDATE images SET status = 'done', step = steps, bytes = ?2, updated_at = ?3, finished_at = ?3 WHERE id = ?1")
    .bind(id, bytes.byteLength, now)
    .run();
  return Response.json({ ok: true });
}
