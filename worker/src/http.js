// Response helpers, the API error type and bounded request-body reading.

export const JSON_BODY_LIMIT = 200 * 1024;

export class HttpError extends Error {
  /** `extra` is merged into the error object of the JSON body (e.g. `{ busy }`). */
  constructor(status, code, message, extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

export const badRequest = (message) => new HttpError(400, "bad_request", message);
export const notFound = (message = "Not found.") => new HttpError(404, "not_found", message);
export const tooLarge = (message) => new HttpError(413, "too_large", message);

export function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

export function errorJson(err) {
  return json({ error: { code: err.code, message: err.message, ...err.extra } }, err.status);
}

export function text(body, status = 200) {
  return new Response(body, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
  });
}

/**
 * Parses a JSON object body of at most `limit` bytes. Rejects with 413 `too_large` past the limit
 * (checked while streaming, so a missing or lying content-length cannot get around it) and 400
 * `bad_request` for anything that is not a JSON object.
 */
export async function readJsonObject(request, limit = JSON_BODY_LIMIT, { allowEmpty = false } = {}) {
  const raw = await readBodyText(request, limit);
  if (allowEmpty && !raw.trim()) return {};
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    throw badRequest("The request body is not valid JSON.");
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw badRequest("The request body must be a JSON object.");
  }
  return value;
}

async function readBodyText(request, limit) {
  const tooBig = () => tooLarge(`The request body is larger than ${Math.round(limit / 1024)} KB.`);
  if (Number(request.headers.get("content-length")) > limit) throw tooBig();
  if (!request.body) return "";

  const reader = request.body.getReader();
  const parts = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel().catch(() => {});
      throw tooBig();
    }
    parts.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.byteLength;
  }
  return new TextDecoder().decode(bytes);
}
