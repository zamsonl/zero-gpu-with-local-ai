// Summarize an older prefix into a checkpoint without modifying the original transcript.
import { streamChat, streamTiming } from "./chat-stream.js";
import { requireChat } from "./chats.js";
import { settings } from "./config.js";
import { compactablePrefix, contextForChat, contextMessageCost, isContextOverflow, mappedTranscript, readCheckpoint, summaryMessage, validCheckpoint } from "./context.js";
import { HttpError } from "./http.js";
import { picturesHaveGpu, readMode } from "./images.js";
import { GenerationLock } from "./lock.js";
import { createJobBudget } from "./jobs-transport.js";
import { listTranscript } from "./store.js";
import { readTarget, serverInfo } from "./target.js";
import { nowIso } from "./util.js";
import { continuationPrompt, thinkSplitter } from "./prompt.js";
import { COMPACTION_MEMORY_SCHEMA, COMPACTION_MEMORY_INSTRUCTION, parseCompactionMemory, mergeMemory } from "./compaction-memory.js";
import { compactChunks, splitCompactChunk } from "./compaction-source.js";
import {EventWriter,NDJSON_HEADERS} from './event-stream.js';
import {phaseStatus,withTransportProgress} from '../public/js/progress-status.js';

export { compactChunks } from "./compaction-source.js";

const SUMMARY_TOKENS = 4096;
const SUMMARY_MAX_CHARS = 18000;
const INSTRUCTION = COMPACTION_MEMORY_INSTRUCTION;

export async function compactSession({ env, ctx, request, params }) {
  const db = env.DB;
  const chat = await requireChat(db, params.id);
  const registered = await readTarget(db);
  if (!registered) throw new HttpError(503, "offline", "Start the model server before compacting this session.");
  if (picturesHaveGpu(await readMode(db, registered))) throw new HttpError(409, "image_mode", "Switch back to chat before compacting this session.");
  const acquired = await GenerationLock.acquire(db, chat.id, { operation: "compact" });
  if (acquired.busy) throw new HttpError(409, "busy", "Another operation is using the model right now.", { busy: acquired.busy });
  const { lock } = acquired;
  let transcript, checkpoint, prefix;
  try {
    transcript = await listTranscript(db, chat.id);
    checkpoint = validCheckpoint(await readCheckpoint(db, chat.id), transcript);
    prefix = compactablePrefix(transcript, checkpoint);
    if (!prefix.length) throw new HttpError(409, "nothing_to_compact", "There are no older messages to summarize yet. The two most recent turns stay in full.");
  } catch (error) {
    await lock.release();
    throw error;
  }
  const { readable, writable } = new TransformStream();
  ctx.waitUntil(runCompaction({ env, request, chat, registered, lock, transcript, checkpoint, prefix, writable }));
  return new Response(readable, { headers: NDJSON_HEADERS });
}

async function digestSource(messages) {
  const bytes = new TextEncoder().encode(JSON.stringify(messages));
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function runCompaction({ env, request, chat, registered, lock, transcript, checkpoint, prefix, writable }) {
  const abort = new AbortController();
  let gone = false;
  let stopped = false;
  const send = async (event) => {
    if (gone) return;
    await events.send(event);
  };
  const events=new EventWriter(writable,()=>{gone=true;abort.abort();});
  const disconnect = () => { gone = true; abort.abort();events.markGone(); };
  if (request.signal.aborted) disconnect();
  else request.signal.addEventListener("abort", disconnect, { once: true });
  lock.startHeartbeat();
  lock.watchForStop(() => { stopped = true; abort.abort(); });
  try {
    await send({ event: "start", operation: "compact", chat });
    const result = await compactChatMemory({ env, chat, registered, transcript, checkpoint, prefix, signal: abort.signal, onStatus: send });
    await send({ event: "done", operation: "compact", chat, ...result });
  } catch (error) {
    if (!gone) await send({ event: "error", code: stopped ? "stopped" : isContextOverflow(error) ? "context_limit" : "compaction_failed", message: stopped ? "Compaction stopped. Your previous memory is unchanged." : isContextOverflow(error) ? "This source was too large for the model's tokenizer. Your previous memory is unchanged." : error.message || "Compaction failed. Your previous memory is unchanged." });
  } finally {
    request.signal.removeEventListener("abort", disconnect);
    await lock.release();
    await events.close();
  }
}


/** The caller already owns the generation lock. Preserve validated memory and originals. */
export async function compactChatMemory({ env, chat, registered, transcript, checkpoint, prefix, signal, onStatus = async()=>{}, requestBudget = createJobBudget() }) {
  const abort = { signal };
  const send = onStatus;
  const { numCtx, numBatch, inferenceTransport } = serverInfo(env, registered);
  const memoryLimit = Math.min(60000, Math.max(4000, Math.floor((numCtx - SUMMARY_TOKENS - 2048) * 0.9)));
  const maxChars = Math.min(48000, Math.max(0, (numCtx - SUMMARY_TOKENS - 1024) * 3 - memoryLimit - INSTRUCTION.length - 256));
  const chunks = compactChunks(prefix, maxChars);
  let truncatedRetries = 0;
  let qualityRetries = 0;
  let memory = checkpoint?.summary ?? "";
  for (let index = 0; index < chunks.length; index++) {
    abort.signal.throwIfAborted();
    const progress=phaseStatus('compact','extracting',{chunk:index+1,chunks:chunks.length});
    await send(progress);
    const messages = [
      { role: "user", content: `${memory ? "<previous_memory>\n" + memory + "\n</previous_memory>\n\n" : ""}<conversation_source>\n${chunks[index]}\n</conversation_source>` },
      { role: "user", content: "Extract only useful new notes as the required JSON object. Existing memory is preserved separately. Later explicit corrections take precedence." },
    ];
    let answer = "", final = null, receivedOutput=false;
    try {
      for await (const part of streamChat({
      target: registered.target,
      inferenceTransport,
      requestBudget,
      reloadTarget: async () => (await readTarget(env.DB))?.target ?? null,
      // A closed thinking prefix works even when the model's chat template ignores think:false.
      path: "/api/generate",
      transform: thinkSplitter({ thinking: false }),
      body: { model: settings(env).model, prompt: continuationPrompt({ system: INSTRUCTION, messages, partial: {}, think: false }), format: COMPACTION_MEMORY_SCHEMA, raw: true, think: false, stream: true, truncate: false, shift: false, keep_alive: -1, options: { num_ctx: numCtx, num_predict: SUMMARY_TOKENS, temperature: 0.1, ...(numBatch !== 512 ? { num_batch: numBatch } : {}) } },
      signal: abort.signal, timing: streamTiming(settings(env).timingScale),
      onStatus: (status) => send(withTransportProgress(progress,status)),
      })) {
        if(!receivedOutput&&(part.message?.content||part.message?.thinking)){receivedOutput=true;await send(progress);}
        answer += part.message?.content ?? "";
        if (answer.length > SUMMARY_MAX_CHARS) { final = null; break; }
        if (part.done) final = part;
      }
    } catch (error) {
      // A language/code-heavy source can exceed the estimate. Retry smaller pieces
      // with exact truncation disabled; earlier successful chunks stay in memory.
      if (isContextOverflow(error) && chunks[index].length > 1000) {
        const current = chunks[index];
        const smaller = splitCompactChunk(current, Math.max(1000, Math.ceil(current.length / 2)));
        chunks.splice(index, 1, ...smaller);
        index--;
        continue;
      }
      throw error;
    }
    abort.signal.throwIfAborted();
    if (!final || final.done_reason === "length" || !answer.trim()) {
      if (chunks[index].length > 1000 && truncatedRetries++ < 2) {
        chunks.splice(index, 1, ...splitCompactChunk(chunks[index], Math.max(1000, Math.ceil(chunks[index].length / 2))));
        index--;
        continue;
      }
      throw new Error("The summary did not finish. Your previous memory is unchanged; try compacting again.");
    }
    let notes;
    // A valid but empty object is not evidence that this source was remembered.
    // Retry it through the quality guard instead of advancing past new facts.
    try { notes = parseCompactionMemory(answer); }
    catch (error) {
      if (qualityRetries++ < 2) { index--; continue; }
      throw error;
    }
    const updatedMemory = mergeMemory(memory, notes, `messages ${prefix[0].id}–${prefix.at(-1).id}, part ${index + 1} of ${chunks.length}`, memoryLimit);
    if (updatedMemory === memory) {
      if (qualityRetries++ < 2) { index--; continue; }
      throw new Error("The model returned only existing notes, without remembering any new source. Your previous memory is unchanged.");
    }
    memory = updatedMemory;
  }
  if (!memory.trim()) throw new Error("No useful conversation facts were extracted. Your previous memory is unchanged.");
  const beforeCost = (checkpoint ? contextMessageCost(summaryMessage(checkpoint.summary)) : 0)
    + mappedTranscript(prefix, serverInfo(env, registered).vision).reduce((sum, message) => sum + contextMessageCost(message), 0);
  if (contextMessageCost(summaryMessage(memory)) >= beforeCost) {
    throw new Error("This session is already short; compacting it would not save context. Your saved chat is unchanged.");
  }
  const throughId = prefix.at(-1).id;
  const covered = transcript.filter((message) => message.id <= throughId);
  const fingerprint = await digestSource(covered);
  const current = await listTranscript(env.DB, chat.id);
  if (await digestSource(current.filter((message) => message.id <= throughId)) !== fingerprint) throw new Error("This chat changed while compacting. Try again with the current messages.");
  // All fallible preparation must finish before committing: a failed context preview
  // must not report unchanged memory after the checkpoint has already been saved.
  const next = { summary: memory, through_id: throughId, covered_count: covered.length };
  const context = (await contextForChat(env, chat.id, { transcript, checkpoint: next })).context;
  abort.signal.throwIfAborted();
  await send(phaseStatus('compact','saving'));
  const at = nowIso();
  const result = await env.DB.prepare(
    `INSERT INTO chat_context (chat_id, summary, through_id, covered_count, source_digest, model, updated_at)
     SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7 WHERE EXISTS
       (SELECT 1 FROM chats WHERE id = ?1 AND updated_at = ?8 AND message_count = ?9)
     ON CONFLICT (chat_id) DO UPDATE SET summary = excluded.summary, through_id = excluded.through_id,
       covered_count = excluded.covered_count, source_digest = excluded.source_digest,
       model = excluded.model, updated_at = excluded.updated_at`,
  ).bind(chat.id, memory, throughId, covered.length, fingerprint, settings(env).model, at, chat.updated_at, chat.message_count).run();
  if (result.meta.changes !== 1) throw new Error("This chat changed while compacting. Try again with the current messages.");

  return { context, checkpoint: next, summarized_message_count: covered.length };
}
