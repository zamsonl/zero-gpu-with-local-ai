// Explicit opt-in, resumable reading. Every model call uses the already hosted Qwen.
import { HttpError, badRequest, json, notFound, readJsonObject } from "./http.js";
import { requireChat } from "./chats.js";
import { GenerationLock } from "./lock.js";
import { getChat, listMessages, listTranscript, toMessage } from "./store.js";
import { readTarget, serverInfo } from "./target.js";
import { picturesHaveGpu, readMode } from "./images.js";
import { settings } from "./config.js";
import { readPreferences } from "./preferences.js";
import { mappedTranscript, planContext, readCheckpoint, requireContextSpace, isContextOverflow } from "./context.js";
import { continuationPrompt, thinkSplitter } from "./prompt.js";
import { streamChat, streamTiming } from "./chat-stream.js";
import { createJobBudget } from "./jobs-transport.js";
import { COMPACTION_MEMORY_INSTRUCTION, COMPACTION_MEMORY_SCHEMA, mergeMemory, parseCompactionMemory } from "./compaction-memory.js";
import { nowIso, randomId } from "./util.js";
import { normalizeTitle } from "./validate.js";
import { LONG_INPUT_COLUMNS, publicLongInput, deleteLongInputObjects, retryLongInputCleanup } from "./long-input-store.js";
import { parseLongInput, sourceHash, longInputRanges, longInputChunk, splitLongInputRange, LONG_INPUT_BODY_LIMIT, LONG_INPUT_STORAGE_LIMIT } from "./long-input-source.js";
import {phaseStatus,withTransportProgress} from '../public/js/progress-status.js';

const NDJSON = { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store" };
const EXTRACT_TOKENS = 4096;
const EXTRACT_INSTRUCTION = COMPACTION_MEMORY_INSTRUCTION + " This is a newly submitted long prompt and its reference documents. Extract every task, constraint, prohibition and question needed to answer it later, along with relevant evidence. Do not execute the task during this reading pass. Preserve exact quotations where wording or code matters. Include character offsets as well as the actual source message ID. Each source section must produce useful source-attributed notes; never claim unread sections were reviewed.";

function bucket(env) {
  if (!env.IMAGES) throw new HttpError(503, "no_storage", "Long input storage is not configured.");
  return env.IMAGES;
}
async function getSource(db, chatId, sourceId) {
  const row = await db.prepare(`SELECT ${LONG_INPUT_COLUMNS} FROM long_inputs WHERE id=?1 AND chat_id=?2`).bind(sourceId, chatId).first();
  if (!row) throw notFound("No long input with this id in this chat.");
  return row;
}
async function userForSource(db, source) {
  return (await listMessages(db, source.chat_id)).find(message => message.id === source.user_message_id);
}

/** Prepare an original and reading plan. No model call happens here, even when offline. */
export async function createLongInput({ env, request, params }) {
  const chat = await requireChat(env.DB, params.id);
  const input = parseLongInput(await readJsonObject(request, LONG_INPUT_BODY_LIMIT));
  const hash = await sourceHash(input.sourceText);
  const existing = await env.DB.prepare(`SELECT ${LONG_INPUT_COLUMNS} FROM long_inputs WHERE chat_id=?1 AND client_id=?2`).bind(chat.id, input.clientId).first();
  if (existing) {
    if (existing.source_hash !== hash || existing.think !== JSON.stringify(input.think)) throw new HttpError(409, "request_changed", "This request identity already belongs to different text or thinking settings.");
    if (!existing.user_message_id) throw new HttpError(409, "preparing", "This input is still being saved. Retry shortly with the same request identity.");
    return json({ source: publicLongInput(existing), chat: await getChat(env.DB, chat.id), user_message: await userForSource(env.DB, existing) });
  }
  const acquired = await GenerationLock.acquire(env.DB, chat.id, { operation: "long_input_prepare" });
  if (acquired.busy) throw new HttpError(409, "busy", "Wait for the current operation before saving this long input.", { busy: acquired.busy });
  const { lock } = acquired;
  lock.startHeartbeat();
  const id = randomId(), key = `long-inputs/${chat.id}/${id}.txt`, at = nowIso();
  const bytes = new TextEncoder().encode(input.sourceText).byteLength;
  const ranges = longInputRanges(input.sourceText);
  let reserved = false, stored = false, saved = null;
  try {
    await retryLongInputCleanup(env.DB, bucket(env));
    const inserted = await env.DB.prepare(`INSERT INTO long_inputs (id,chat_id,client_id,source_key,source_hash,bytes,total_chars,prompt_chars,think,chunk_plan,total_chunks,status,created_at,updated_at)
      SELECT ?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,'ready',?12,?12
      WHERE (SELECT COALESCE(SUM(bytes),0) FROM long_inputs)+(SELECT COALESCE(SUM(bytes),0) FROM long_input_garbage)+?6<=?13`).bind(id, chat.id, input.clientId, key, hash, bytes, input.chars, input.content.length, JSON.stringify(input.think), JSON.stringify(ranges), ranges.length, at, LONG_INPUT_STORAGE_LIMIT).run();
    if (inserted.meta.changes !== 1) throw new HttpError(413, "storage_budget", "Long input storage has reached its 200 MiB safety budget. Delete unused source chats before uploading more.");
    reserved = true;
    await bucket(env).put(key, input.sourceText, { httpMetadata: { contentType: "text/plain; charset=utf-8" } });
    stored = true;
    const preview = input.content.length > 2000 ? input.content.slice(0, 1600) + "\n\n…\n\n" + input.content.slice(-400) : input.content;
    const names = input.documents.length ? `\n\nDocuments: ${input.documents.map(file => file.name).join(", ")}` : "";
    const content = `${preview || "Read the attached documents."}${names}\n\n[Full input (${input.chars.toLocaleString()} characters)](/v1/chats/${chat.id}/long-inputs/${id}/source)\n\nQwen will read this input in ${ranges.length} sections before answering.`;
    const committed = await env.DB.batch([
      env.DB.prepare("INSERT INTO messages(chat_id,role,content,created_at) SELECT ?1,'user',?2,?3 WHERE EXISTS(SELECT 1 FROM chats WHERE id=?1) RETURNING *").bind(chat.id, content, at),
      env.DB.prepare("UPDATE long_inputs SET user_message_id=(SELECT id FROM messages WHERE chat_id=?2 AND content=?3 ORDER BY id DESC LIMIT 1) WHERE id=?1").bind(id, chat.id, content),
      env.DB.prepare("UPDATE chats SET title=CASE WHEN title='' THEN ?2 ELSE title END,updated_at=?3,message_count=(SELECT count(*) FROM messages WHERE chat_id=?1) WHERE id=?1 RETURNING *").bind(chat.id, normalizeTitle(input.content.trim() || input.documents[0]?.name || "Long input", 60), at),
    ]);
    if (!committed[0].results.length || !committed[2].results.length) throw new Error("The chat was removed while saving the input.");
    saved = { message: toMessage(committed[0].results[0]), chat: committed[2].results[0] };
    return json({ source: publicLongInput(await getSource(env.DB, chat.id, id)), chat: saved.chat, user_message: saved.message }, 201);
  } catch (error) {
    if (!saved) {
      // A creation transaction can commit while its response is lost. Never remove the
      // original unless the reservation was demonstrably still unlinked and removed.
      const removed = reserved ? await env.DB.prepare("DELETE FROM long_inputs WHERE id=?1 AND user_message_id IS NULL").bind(id).run() : null;
      if (removed?.meta.changes === 1) await deleteLongInputObjects(env.DB, bucket(env), [key]);
    }
    throw error;
  } finally { await lock.release(); }
}

export async function listLongInputs({ env, params }) {
  await requireChat(env.DB, params.id);
  const { results } = await env.DB.prepare(`SELECT ${LONG_INPUT_COLUMNS} FROM long_inputs WHERE chat_id=?1 AND user_message_id IS NOT NULL ORDER BY created_at DESC LIMIT 50`).bind(params.id).all();
  return json({ sources: results.map(publicLongInput) });
}

export async function longInputSource({ env, params }) {
  await requireChat(env.DB, params.id);
  const source = await getSource(env.DB, params.id, params.source_id);
  const object = await bucket(env).get(source.source_key);
  if (!object) throw notFound("The saved original is unavailable.");
  return new Response(object.body, { headers: { "content-type": "text/plain; charset=utf-8", "content-disposition": `attachment; filename="qwen-long-input-${source.id}.txt"`, "cache-control": "no-store" } });
}

/** One request reads one section, or (after all sections) writes the final answer. */
export async function runLongInput({ env, ctx, request, params }) {
  const body = await readJsonObject(request, 1024);
  if (body.consent !== true) throw badRequest("Confirm that processing may consume substantial Kaggle GPU usage.");
  const chat = await requireChat(env.DB, params.id);
  const source = await getSource(env.DB, chat.id, params.source_id);
  const registered = await readTarget(env.DB);
  if (!registered) throw new HttpError(503, "offline", "Start the Kaggle or Colab model server to read this input.");
  if (picturesHaveGpu(await readMode(env.DB, registered))) throw new HttpError(409, "image_mode", "Switch back to chat before processing this input.");
  const acquired = await GenerationLock.acquire(env.DB, chat.id, { operation: "long_input" });
  if (acquired.busy) throw new HttpError(409, "busy", "Another operation is using the model. Your reading progress is saved.", { busy: acquired.busy });
  const { readable, writable } = new TransformStream();
  ctx.waitUntil(runStep({ env, request, chat, source, registered, lock: acquired.lock, writable }));
  return new Response(readable, { headers: NDJSON });
}

async function runStep({ env, request, chat, source: original, registered, lock, writable }) {
  const writer = writable.getWriter(), encoder = new TextEncoder(), abort = new AbortController();
  let gone = false, stopped = false, source = original;
  const send = async event => { if (!gone) { try { await writer.write(encoder.encode(JSON.stringify(event) + "\n")); } catch { gone = true; abort.abort(); } } };
  const disconnect = () => { gone = true; abort.abort(); };
  request.signal.addEventListener("abort", disconnect, { once: true });
  if (request.signal.aborted) disconnect();
  lock.startHeartbeat();
  lock.watchForStop(() => { stopped = true; abort.abort(); });
  try {
    // Re-read after taking the global lock: retries must not repeat committed work.
    source = await getSource(env.DB, chat.id, source.id);
    const user = await userForSource(env.DB, source);
    if (!user) throw new Error("The source message was removed. The original reading request is no longer active.");
    await send({ event: "start", operation: "long_input", source: publicLongInput(source), user_message: user, chat: await getChat(env.DB, chat.id) });
    if (source.status === "complete") {
      const message = (await listMessages(env.DB, chat.id)).find(item => item.id === source.answer_message_id);
      if (!message) throw new Error("The saved answer was removed.");
      await send({ event: "done", source: publicLongInput(source), message, chat: await getChat(env.DB, chat.id) });
      return;
    }
    const transcript = await listTranscript(env.DB, chat.id);
    if (transcript.findLast(item => item.role === "user")?.id !== source.user_message_id) throw new HttpError(409, "superseded", "A newer message was added to this chat. This saved input cannot resume out of order; submit it again as a new request.");
    const object = await bucket(env).get(source.source_key);
    if (!object) throw new Error("The full saved input is unavailable; reading progress has not advanced.");
    const text = await object.text();
    if (await sourceHash(text) !== source.source_hash) throw new Error("The saved input changed; reading progress has not advanced.");
    abort.signal.throwIfAborted();
    const profile = serverInfo(env, registered);
    if (source.processed_chunks < source.total_chunks) {
      source = await scanSection({ env, source, text, profile, registered, abort, send });
      await send({ event: "checkpoint", source: publicLongInput(source) });
    } else {
      source = await answerSource({ env, source, text, chat, profile, registered, abort, send });
    }
  } catch (error) {
    const status = error.code === "superseded" ? "superseded" : stopped || gone ? "paused" : "error";
    await env.DB.prepare("UPDATE long_inputs SET status=?2,error=?3,updated_at=?4 WHERE id=?1 AND status!='complete'").bind(source.id, status, String(error.message || "Processing interrupted").slice(0, 500), nowIso()).run();
    source = await getSource(env.DB, chat.id, source.id);
    if (!gone) await send({ event: "error", code: stopped ? "stopped" : error.code === "superseded" ? "superseded" : isContextOverflow(error) ? "context_limit" : "long_input_failed", message: stopped ? "Stopped. Completed sections and the original input are saved; resume when ready." : error.message || "Reading failed. Completed sections are saved.", source: publicLongInput(source), message_saved: null });
  } finally {
    request.signal.removeEventListener("abort", disconnect);
    await lock.release();
    try { await (gone ? writer.abort() : writer.close()); } catch { /* disconnected */ }
  }
}

async function scanSection({ env, source, text, profile, registered, abort, send }) {
  let ranges = JSON.parse(source.chunk_plan), qualityRetries = 0, splits = 0;
  const budget = createJobBudget();
  const memoryLimit = Math.min(60000, Math.max(4000, Math.floor((profile.numCtx - EXTRACT_TOKENS - 2048) * 0.9)));
  for (;;) {
    abort.signal.throwIfAborted();
    const range = ranges[source.processed_chunks];
    const progress=phaseStatus('long_input','reading',{chunk:source.processed_chunks+1,chunks:ranges.length});
    await send(progress);
    const messages = [{ role: "user", content: `${source.notes ? `<previous_memory>\n${source.notes}\n</previous_memory>\n\n` : ""}<conversation_source>\n${longInputChunk(text, range, source.user_message_id)}\n</conversation_source>` }];
    let answer = "", final = null;
    try {
      for await (const part of modelParts({ env, profile, registered, abort, budget, send, progress, body: { model: settings(env).model, prompt: continuationPrompt({ system: EXTRACT_INSTRUCTION, messages, partial: {}, think: false }), raw: true, format: COMPACTION_MEMORY_SCHEMA, think: false, stream: true, truncate: false, shift: false, keep_alive: -1, options: { num_ctx: profile.numCtx, num_predict: EXTRACT_TOKENS, temperature: 0.1, num_batch: profile.numBatch } } })) {
        answer += part.message?.content ?? "";
        if (answer.length > 18000) break;
        if (part.done) final = part;
      }
      if (!final || final.done_reason === "length") throw new Error("The section notes did not finish. Reading progress has not advanced.");
    } catch (error) {
      if ((isContextOverflow(error) || /notes did not finish/.test(error.message)) && range.end - range.start > 1000 && splits++ < 8) {
        ranges.splice(source.processed_chunks, 1, ...splitLongInputRange(text, range));
        continue;
      }
      throw error;
    }
    let notes, memory;
    try {
      notes = parseCompactionMemory(answer);
      memory = mergeMemory(source.notes, notes, `source ${source.id}, characters ${range.start}–${range.end}`, memoryLimit);
      if (memory === source.notes) throw new Error("The model returned only existing notes. This section has not been marked read.");
    } catch (error) { if (qualityRetries++ < 2 && error.code !== "memory_limit") continue; throw error; }
    abort.signal.throwIfAborted();
    await send(phaseStatus('long_input','saving'));
    const changed = await env.DB.prepare("UPDATE long_inputs SET notes=?2,processed_chunks=processed_chunks+1,total_chunks=?3,chunk_plan=?4,status=?5,error=NULL,updated_at=?6 WHERE id=?1 AND processed_chunks=?7 AND source_hash=?8")
      .bind(source.id, memory, ranges.length, JSON.stringify(ranges), source.processed_chunks + 1 === ranges.length ? "answering" : "scanning", nowIso(), source.processed_chunks, source.source_hash).run();
    if (changed.meta.changes !== 1) throw new Error("Reading progress changed on another request. Refresh the saved input.");
    return getSource(env.DB, source.chat_id, source.id);
  }
}

async function answerSource({ env, source, text, chat, profile, registered, abort, send }) {
  const preferences = { ...await readPreferences(env.DB, env), max_reply_tokens: 4096 };
  const think = JSON.parse(source.think);
  const plan = planContext({ transcript: mappedTranscript(await listTranscript(env.DB, chat.id), profile.vision), numCtx: profile.numCtx, think, preferences, checkpoint: await readCheckpoint(env.DB, chat.id) });
  // A normal-sized task prompt stays literal in the final call. Very long instruction prompts
  // are represented by the sourced requirements extracted from every section, not a cut-off prefix.
  if (source.prompt_chars > 0 && source.prompt_chars <= 12000) plan.messages.push({ role: "user", content: `Original task prompt (verbatim):\n${text.slice(0, source.prompt_chars)}` });
  const exactChars = plan.messages.reduce((total, message) => total + message.content.length + (message.images?.length ?? 0) * 3000 + 24, 0) + (preferences.system_prompt?.length ?? 0) + 1500;
  if (exactChars > (profile.numCtx - 4096 - 1024) * 3) throw new Error("The saved reading notes and task exceed the available answer context. Progress is saved; use a larger running context or a smaller task.");
  requireContextSpace(plan);
  const progress=phaseStatus('long_input','preparing_answer');
  await send(progress);
  const instructions = [preferences.system_prompt, "Answer the user's saved long input using the source-attributed reading notes. The original source remains available through its full-input link. Preserve exact requirements and later corrections, and acknowledge uncertainty rather than inventing omitted details."].filter(Boolean).join("\n\n");
  let answer = "", thinking = "", final = null;
  for await (const part of modelParts({ env, profile, registered, abort, budget: createJobBudget(), send, progress, thinking: think !== false, body: { model: settings(env).model, prompt: continuationPrompt({ system: instructions, messages: plan.messages, partial: {}, think }), raw: true, think, stream: true, truncate: false, shift: false, keep_alive: -1, options: { ...plan.options, num_predict: 4096, num_batch: profile.numBatch } } })) {
    const text = part.message?.content ?? "";
    answer += text;
    const thought = part.message?.thinking ?? "";
    thinking += thought;
    if (thought) await send({ event: "thinking", text: thought });
    if (text) await send({ event: "content", text });
    if (part.done) final = part;
  }
  if (!final || !(answer.trim() || (final.done_reason === "length" && thinking))) throw new Error("The answer did not finish. All section notes are saved; resume to retry the answer pass.");
  abort.signal.throwIfAborted();
  await send(phaseStatus('long_input','saving'));
  const at = nowIso(), stats = JSON.stringify({ num_ctx: profile.numCtx, num_batch: profile.numBatch, think, prompt_eval_count: final.prompt_eval_count, eval_count: final.eval_count, long_input_id: source.id, source_sections: source.total_chunks });
  // Answer and job completion are one D1 transaction, so a lost done event can be replayed
  // without another model call or a duplicate assistant message.
  const committed = await env.DB.batch([
    env.DB.prepare("INSERT INTO messages(chat_id,role,content,status,stats,created_at,thinking) SELECT ?1,'assistant',?2,?3,?4,?5,?7 WHERE EXISTS(SELECT 1 FROM long_inputs WHERE id=?6 AND status!='complete') RETURNING *").bind(chat.id, answer, final.done_reason === "length" ? "length" : "complete", stats, at, source.id, thinking || null),
    env.DB.prepare("UPDATE long_inputs SET status='complete',answer_message_id=(SELECT id FROM messages WHERE chat_id=?2 AND stats=?3 ORDER BY id DESC LIMIT 1),error=NULL,updated_at=?4 WHERE id=?1").bind(source.id, chat.id, stats, at),
    env.DB.prepare("UPDATE chats SET updated_at=?2,message_count=(SELECT count(*) FROM messages WHERE chat_id=?1) WHERE id=?1 RETURNING *").bind(chat.id, at),
  ]);
  if (!committed[0].results.length || !committed[2].results.length) throw new Error("The chat was removed while saving the answer.");
  const saved = { message: toMessage(committed[0].results[0]), chat: committed[2].results[0] };
  source = { ...source, status: "complete", answer_message_id: saved.message.id, error: null, updated_at: at };
  await send({ event: "done", source: publicLongInput(source), message: saved.message, chat: saved.chat });
  return source;
}

async function* modelParts({ env, profile, registered, abort, budget, send, body, progress, thinking = false }) {
  const base=progress??phaseStatus('long_input',body.format?'reading':'preparing_answer');
  let outputPhase=null;
  for await(const part of streamChat({ target: registered.target, inferenceTransport: profile.inferenceTransport, requestBudget: budget, reloadTarget: async () => (await readTarget(env.DB))?.target ?? null, path: "/api/generate", transform: thinkSplitter({ thinking }), body, signal: abort.signal, timing: streamTiming(settings(env).timingScale), onStatus: status => send(withTransportProgress(base,status)) })){
    const next=part.message?.thinking?phaseStatus('long_input','thinking'):part.message?.content?(body.format?base:phaseStatus('long_input','answering')):null;
    if(next&&next.phase!==outputPhase){outputPhase=next.phase;await send(next);}
    yield part;
  }
}
