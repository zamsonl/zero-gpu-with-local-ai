// JSON source envelopes keep message attribution attached to every fragment and retry.
// `text` covers each source character exactly once; `previous_context` is read-only overlap.
import { modelContent } from "./attachments.js";

const FORMAT = "message-fragments-v1";
const OVERLAP_CHARS = 240;
const encode = fragments => JSON.stringify({ source_format: FORMAT, fragments });

function requireLimit(maxChars) {
  if (!Number.isSafeInteger(maxChars) || maxChars < 1000) {
    throw new Error("Too little room to summarize this session.");
  }
}

/** Decode our own envelope; quoted user text cannot manufacture fragment metadata. */
export function readCompactChunk(chunk) {
  const value = JSON.parse(chunk);
  if (value?.source_format !== FORMAT || !Array.isArray(value.fragments) || !value.fragments.length) {
    throw new TypeError("Invalid compaction source envelope.");
  }
  return value.fragments.map(fragment => {
    if (!fragment || !["user", "assistant", "system"].includes(fragment.role)
        || !Number.isSafeInteger(fragment.message_id) || fragment.message_id < 1
        || !Number.isSafeInteger(fragment.offset) || fragment.offset < 0
        || typeof fragment.text !== "string"
        || (fragment.previous_context != null && (typeof fragment.previous_context !== "string"
          || fragment.previous_context.length > OVERLAP_CHARS))) {
      throw new TypeError("Invalid compaction source fragment.");
    }
    return { role: fragment.role, message_id: fragment.message_id, offset: fragment.offset,
      text: fragment.text, ...(fragment.previous_context ? { previous_context: fragment.previous_context } : {}) };
  });
}

function unicodeEnd(text, index) {
  return index > 0 && index < text.length && /[\uD800-\uDBFF]/.test(text[index - 1])
    && /[\uDC00-\uDFFF]/.test(text[index]) ? index - 1 : index;
}

function overlapBefore(fragment, start) {
  const preceding = (fragment.previous_context ?? "") + fragment.text.slice(Math.max(0, start - OVERLAP_CHARS), start);
  let offset = Math.max(0, preceding.length - OVERLAP_CHARS);
  if (offset && /[\uD800-\uDBFF]/.test(preceding[offset - 1]) && /[\uDC00-\uDFFF]/.test(preceding[offset])) offset++;
  return preceding.slice(offset);
}

function piece(fragment, start, end) {
  const overlap = overlapBefore(fragment, start);
  return { role: fragment.role, message_id: fragment.message_id, offset: fragment.offset + start,
    text: fragment.text.slice(start, end), ...(overlap ? { previous_context: overlap } : {}) };
}

// Prefer a paragraph, line, sentence or word boundary near the maximum safe end.
// Exceptionally long unbroken input is still represented exactly, with bounded overlap.
function semanticEnd(text, start, end) {
  if (end >= text.length) return end;
  const lower = start + Math.max(1, Math.floor((end - start) / 2));
  const tail = text.slice(lower, end);
  for (const pattern of [/\n\s*\n/g, /\n/g, /[.!?][ \t]+/g, /\s+/gu]) {
    let boundary = null;
    for (const match of tail.matchAll(pattern)) boundary = lower + match.index + match[0].length;
    if (boundary != null) return unicodeEnd(text, boundary);
  }
  return unicodeEnd(text, end);
}

function largestEnd(fragment, start, maxChars) {
  let low = start, high = fragment.text.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (encode([piece(fragment, start, mid)]).length <= maxChars) low = mid;
    else high = mid - 1;
  }
  const end = unicodeEnd(fragment.text, low);
  if (end <= start) throw new Error("Too little room to summarize this source fragment.");
  return semanticEnd(fragment.text, start, end);
}

function pack(fragments, maxChars) {
  requireLimit(maxChars);
  const chunks = [];
  let pending = [];
  const flush = () => { if (pending.length) chunks.push(encode(pending)); pending = []; };
  for (const fragment of fragments) {
    let start = 0;
    do {
      const remaining = piece(fragment, start, fragment.text.length);
      if (encode([...pending, remaining]).length <= maxChars) {
        pending.push(remaining);
        break;
      }
      // A message that fits on its own should never be split just to fill the previous chunk.
      if (pending.length) { flush(); continue; }
      const end = largestEnd(fragment, start, maxChars);
      chunks.push(encode([piece(fragment, start, end)]));
      start = end;
    } while (start < fragment.text.length);
  }
  flush();
  return chunks;
}

/** Bounded source chunks, with every role and message ID preserved on continuations. */
export function compactChunks(messages, maxChars) {
  const fragments = messages.map(message => ({ role: message.role, message_id: message.id, offset: 0,
    text: modelContent(message.content, message.attachments) }));
  // Check source metadata once before generating any requests.
  if (fragments.length) readCompactChunk(encode(fragments));
  return pack(fragments, maxChars);
}

/** Retry a source chunk at a smaller bound without losing its attribution or prior overlap. */
export function splitCompactChunk(chunk, maxChars) {
  return pack(readCompactChunk(chunk), maxChars);
}
