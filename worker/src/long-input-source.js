import { badRequest, tooLarge } from "./http.js";
import { compactChunks, readCompactChunk } from "./compaction-source.js";

export const MAX_LONG_INPUT_CHARS = 1_000_000;
export const LONG_INPUT_BODY_LIMIT = 4 * 1024 * 1024;
export const LONG_INPUT_STORAGE_LIMIT = 200 * 1024 * 1024;
export const LONG_INPUT_CHUNK_CHARS = 24000;

export function parseLongInput(body) {
  if (body.consent !== true) throw badRequest("Confirm the high GPU usage warning before preparing a long input.");
  const content = body.content ?? "";
  if (typeof content !== "string") throw badRequest('"content" must be text.');
  const files = body.attachments ?? [];
  if (!Array.isArray(files) || files.length > 10) throw badRequest("Attach at most 10 text documents.");
  let chars = content.length;
  const documents = files.map((file, index) => {
    if (!file || typeof file !== "object" || typeof file.text !== "string" || file.data != null) throw badRequest("Long input mode accepts text documents, not pictures. Describe important image details in text first.");
    const name = typeof file.name === "string" ? file.name.split(/[\\/]/).pop().replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 200) : "";
    if (!name) throw badRequest(`Document ${index + 1} needs a name.`);
    chars += file.text.length;
    return { name, text: file.text };
  });
  if (chars > MAX_LONG_INPUT_CHARS) throw tooLarge(`Long input mode currently accepts up to ${MAX_LONG_INPUT_CHARS.toLocaleString()} characters across the prompt and documents.`);
  if (!content.trim() && !documents.some(file => file.text.trim())) throw badRequest("Add a prompt or a text document.");
  const clientId = body.client_id ?? crypto.randomUUID();
  if (typeof clientId !== "string" || !/^[A-Za-z0-9_-]{1,80}$/.test(clientId)) throw badRequest("Invalid long input request identity.");
  const think = body.think ?? "medium";
  if (![true, false, "medium", "low"].includes(think)) throw badRequest('"think" must be true, false, "medium" or "low".');
  // JSON document labels prevent filenames from impersonating surrounding instructions.
  const sourceText = [content, ...documents.map(file => `\n\n[Attached document: ${JSON.stringify(file.name)}]\n${file.text}`)].join("");
  return { content, documents, chars, sourceText, clientId, think };
}

export async function sourceHash(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, "0")).join("");
}

export function longInputRanges(text, maxChars = LONG_INPUT_CHUNK_CHARS) {
  return compactChunks([{ id: 1, role: "user", content: text }], maxChars).flatMap(chunk => readCompactChunk(chunk).map(fragment => ({ start: fragment.offset, end: fragment.offset + fragment.text.length })));
}

export function longInputChunk(text, range, messageId) {
  const start = Math.max(0, range.start - 240);
  let overlapStart = start;
  if (overlapStart && /[\uD800-\uDBFF]/.test(text[overlapStart - 1]) && /[\uDC00-\uDFFF]/.test(text[overlapStart])) overlapStart++;
  return JSON.stringify({ source_format: "message-fragments-v1", fragments: [{ role: "user", message_id: messageId, offset: range.start, text: text.slice(range.start, range.end), ...(range.start ? { previous_context: text.slice(overlapStart, range.start) } : {}) }] });
}

export function splitLongInputRange(text, range) {
  const pieces = longInputRanges(text.slice(range.start, range.end), Math.max(1000, Math.ceil((range.end - range.start) / 2)));
  return pieces.map(piece => ({ start: range.start + piece.start, end: range.start + piece.end }));
}
