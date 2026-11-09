// Supply the serving profile's batch default to raw inference clients. Other
// requests, explicit options and bodies that cannot safely be edited pass through.
import { validBatch } from "./target.js";

export const RAW_OPTIONS_LIMIT = 2 * 1024 * 1024 + 256 * 1024;

export async function rawBatchDefault(request, numBatch, maxBytes = RAW_OPTIONS_LIMIT, { bufferWithoutBatch = false } = {}) {
  const path = new URL(request.url).pathname;
  const untouched = () => ({ body: request.body, changed: false });
  if ((!validBatch(numBatch) && !bufferWithoutBatch) || request.method !== "POST" || !["/api/chat", "/api/generate"].includes(path) || !request.body) return untouched();
  const type = (request.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  const encoding = request.headers.get("content-encoding");
  if ((type && type !== "application/json") || (encoding && encoding !== "identity")) return untouched();
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) return untouched();

  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const part = await reader.read();
    if (part.done) break;
    chunks.push(part.value);
    total += part.value.byteLength;
    if (total > maxBytes) {
      // Rebuild the original stream from buffered bytes plus its unread suffix;
      // an unknown-length large request keeps streaming without being parsed.
      return { body: restoreStream(chunks, reader), changed: false };
    }
  }
  reader.releaseLock();
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  // A jobs-capable server may omit its batch default. Reuse this bounded body
  // collector without injecting options; the raw transport still keeps all bytes.
  if (!validBatch(numBatch)) return { body: bytes, changed: false };
  let value, source;
  try { source = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); value = JSON.parse(source); }
  catch { return { body: bytes, changed: false }; }
  if (!value || typeof value !== "object" || Array.isArray(value)) return { body: bytes, changed: false };
  const members = objectMembers(source).filter((member) => member.key.toLowerCase() === "options");
  // Duplicate aliases have decoder-dependent merge behavior. Keep them intact.
  if (members.length > 1) return { body: bytes, changed: false };
  const member = members[0];
  const options = member ? JSON.parse(source.slice(member.start, member.end)) : undefined;
  if (options != null && (typeof options !== "object" || Array.isArray(options))) return { body: bytes, changed: false };
  if (options && Object.prototype.hasOwnProperty.call(options, "num_batch")) return { body: bytes, changed: false };
  let outgoing;
  if (!member) {
    const close = source.trimEnd().length - 1;
    outgoing = source.slice(0, close) + (Object.keys(value).length ? "," : "") + `"options":{"num_batch":${numBatch}}` + source.slice(close);
  } else if (options === null) {
    outgoing = source.slice(0, member.start) + `{"num_batch":${numBatch}}` + source.slice(member.end);
  } else {
    const close = member.end - 1;
    outgoing = source.slice(0, close) + (Object.keys(options).length ? "," : "") + `"num_batch":${numBatch}` + source.slice(close);
  }
  // Editing the original JSON text preserves int64 seeds and every caller option
  // exactly; parse/stringify of the complete payload would round large integers.
  return { body: outgoing, changed: true };
}

/** Top-level value spans in JSON that has already passed JSON.parse. */
function objectMembers(source) {
  const members = [];
  const skipSpace = (at) => { while (/\s/.test(source[at] ?? "") && at < source.length) at++; return at; };
  const stringEnd = (at) => {
    for (at++; at < source.length; at++) {
      if (source[at] === "\\") at++;
      else if (source[at] === '"') return at + 1;
    }
    return at;
  };
  const valueEnd = (at) => {
    if (source[at] === '"') return stringEnd(at);
    if (source[at] === "{" || source[at] === "[") {
      let depth = 0;
      for (; at < source.length; at++) {
        const char = source[at];
        if (char === '"') at = stringEnd(at) - 1;
        else if (char === "{" || char === "[") depth++;
        else if ((char === "}" || char === "]") && --depth === 0) return at + 1;
      }
      return at;
    }
    while (at < source.length && !/[\s,}]/.test(source[at])) at++;
    return at;
  };
  let at = skipSpace(source.indexOf("{") + 1);
  while (source[at] !== "}") {
    const endKey = stringEnd(at);
    const key = JSON.parse(source.slice(at, endKey));
    const start = skipSpace(skipSpace(endKey) + 1);
    const end = valueEnd(start);
    members.push({ key, start, end });
    at = skipSpace(end);
    if (source[at] === ",") at = skipSpace(at + 1);
  }
  return members;
}

function restoreStream(prefix, reader) {
  let index = 0;
  return new ReadableStream({
    async pull(controller) {
      if (index < prefix.length) { controller.enqueue(prefix[index++]); return; }
      try {
        const { done, value } = await reader.read();
        if (done) { reader.releaseLock(); controller.close(); }
        else controller.enqueue(value);
      } catch (error) { controller.error(error); }
    },
    cancel(reason) { return reader.cancel(reason); },
  });
}
