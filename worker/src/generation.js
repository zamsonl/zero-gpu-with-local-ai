// Runs one reply in the background (ctx.waitUntil) and streams it to the client as NDJSON events.
// The response body is the readable side of a TransformStream. The client is gone (closed tab,
// dropped connection, Ctrl+C) when the request's signal aborts or a write to it fails; then the
// upstream request is aborted and whatever was generated so far is saved as 'stopped'. (On
// Cloudflare a write to a gone client can keep succeeding for a long time, so the signal is what
// notices it promptly.) The page's own Stop button asks for a stop through POST /v1/stop instead,
// like another device would. Another device can stop it too (POST /v1/stop): the
// reply is cut the same way and this client gets the saved partial with a `stopped_by` note.
// The generation lock is always released at the end.

import { OfflineError, streamChat, streamTiming } from "./chat-stream.js";
import { LiveReply } from "./live.js";
import { isContextOverflow } from "./context.js";
import { UpstreamError } from "./ollama.js";
import { saveAssistantMessage, updateAssistantMessage, lastMessage } from "./store.js";
import { readTarget } from "./target.js";
import { nowIso } from "./util.js";
import {EventWriter} from './event-stream.js';
import {createJobBudget} from './jobs-transport.js';
import {prepareChatPlan,recoverReasoning,thinkingWorkBody,interruptedWorkCode,isWorkBudgetError} from './reasoning-recovery.js';
import {chatRequestBody,continuationPrompt} from './prompt.js';
import {requireChat} from './chats.js';
import {phaseStatus,withTransportProgress} from '../public/js/progress-status.js';

class ClientGone extends Error {}
class StopRequested extends Error {}

/**
 * @param {ExecutionContext} ctx
 * @param {object} job  `{ db, lock, chat, userMessage, target, body, timingScale, signal }` (`signal`:
 *   the request's, aborted when the client disconnects), plus for a
 *   continued reply `{ continued, path, transform }` (the message being continued and how to call
 *   /api/generate); its new text is appended to that message instead of saving a new one.
 * @returns {ReadableStream} the response body
 */
export function startGeneration(ctx, job) {
  const { readable, writable } = new TransformStream();
  ctx.waitUntil(generate(writable, job));
  return readable;
}

async function generate(writable, { db, lock, chat, userMessage, target, body, timingScale, signal = null, continued = null, path, transform, requestContext = null, inferenceTransport = null, env = null, registered = null, preferences = {}, plannedThink = body.think, autoCompact = false, forceRecovery = false, recoveryAnswerOnly = false }) {
  const abort = new AbortController();
  const events = new EventWriter(writable, () => abort.abort(new ClientGone()));
  if (signal?.aborted) events.markGone();
  else signal?.addEventListener("abort", () => events.markGone(), { once: true });
  const before = { content: continued?.content ?? "", thinking: continued?.thinking ?? "" };
  const reply = { ...before };
  const grew = () => reply.content !== before.content || reply.thinking !== before.thinking;
  let stoppedRemotely = false;
  let recovery=continued?.stats?.recovery??null;
  let storedMessageId=continued?.id??null;
  let recoveryChanged=false,persistenceFailed=false;
  const requestBudget=createJobBudget();
  let preparedProgress=null;
  const clock = replyClock();
  const live = new LiveReply(db, { owner: crypto.randomUUID(), chatId: chat.id, userMessageId: userMessage.id, assistantMessageId:continued?.id, ...before });
  lock.startHeartbeat();
  lock.watchForStop(() => {
    stoppedRemotely = true;
    abort.abort(new StopRequested());
  });
  try {
    await events.send(continued ? { event: "start", generation_id: lock.id, continued_message: continued, chat, context: requestContext } : { event: "start", generation_id: lock.id, user_message: userMessage, chat, context: requestContext });

    if(env&&registered&&autoCompact&&!forceRecovery){
      const promptPartial=continued&&plannedThink===false?{...continued,thinking:''}:continued;
      const plan=await prepareChatPlan({env,chatId:chat.id,registered,think:plannedThink,preferences,partial:promptPartial,signal:abort.signal,onStatus:status=>{live.update(status);return events.send(status);},requestBudget});
      requestContext=plan.context;
      preparedProgress=phaseStatus('generation','preparing',{context:requestContext});
      live.update(preparedProgress);
      await events.send(preparedProgress);
      body=path==='/api/generate'?{...body,prompt:continuationPrompt({system:preferences.system_prompt,messages:plan.messages,partial:promptPartial,think:plannedThink})}:chatRequestBody({model:body.model,numCtx:body.options.num_ctx,numBatch:body.options.num_batch??512,messages:plan.messages,think:plannedThink,preferences});
    }
    // The total context/reply reservation stays logical. Each inference window
    // is shorter so unfinished reasoning can be checkpointed before job expiry.
    body=thinkingWorkBody(body,plannedThink);
    let final = null,initialError=null;
    if(!forceRecovery)try{
    const chunks = streamChat({
      target,
      inferenceTransport,
      requestBudget,
      reloadTarget: async () => (await readTarget(db))?.target ?? null,
      body,
      path,
      transform,
      signal: abort.signal,
      timing: streamTiming(timingScale),
      onStatus: (status) => {
        const progress=preparedProgress?withTransportProgress(preparedProgress,status):{event:'status',...status};
        live.update(progress);
        return events.send(progress);
      },
    });
    for await (const chunk of chunks) {
      const { thinking, content } = chunk.message ?? {};
      if (thinking || content) live.update({ thinking, content });
      if (thinking) {
        clock.thought();
        reply.thinking += thinking;
        await events.send({ event: "thinking", text: thinking });
      }
      if (content) {
        clock.answered();
        reply.content += content;
        await events.send({ event: "content", text: content });
      }
      if (chunk.done) final = chunk;
    }
    }catch(error){initialError=error;}
    const canRecover=env&&registered&&!abort.signal.aborted&&!events.gone&&!stoppedRemotely&&reply.thinking;
    const needsRecovery=forceRecovery||canRecover&&(initialError&&(isContextOverflow(initialError)||isWorkBudgetError(initialError)||!reply.content.trim()&&interruptedWorkCode(initialError))||final?.done&&!reply.content.trim());
    if(initialError&&!needsRecovery)throw initialError;
    if(needsRecovery){
      const savingProgress=phaseStatus('reasoning_recovery','saving');
      live.update(savingProgress);await events.send(savingProgress);
      // Archive the exhausted trace before spending another model call. Every later
      // working-note checkpoint and final answer rewrites this same assistant row.
      if(!storedMessageId){
        const archived=await store(reply,{status:'length',stats:checkpointStats()});
        if(!archived)throw new Error('This chat was deleted while saving the unfinished reply.');
        live.update({assistantMessageId:archived.message.id});
      }
      const recovered=await recoverReasoning({env,chatId:chat.id,registered,reply,previousRecovery:recovery,continuedId:storedMessageId,answerOnly:recoveryAnswerOnly,think:plannedThink,selectedThink:recoveryAnswerOnly?(continued?.stats?.recovery?.selected_think??continued?.stats?.think??plannedThink):plannedThink,initialPasses:forceRecovery?0:1,interruptions:interruptedWorkCode(initialError)?1:0,pauseForBudget:isWorkBudgetError(initialError),signal:abort.signal,requestBudget,
        onStatus:status=>{live.update(status);return events.send(status);},
        onThinking:async text=>{clock.thought();reply.thinking+=text;live.update({thinking:text});await events.send({event:'thinking',text});},
        onContent:async text=>{clock.answered();reply.content+=text;live.update({content:text});await events.send({event:'content',text});},
        onCheckpoint:async value=>{recovery={...value};recoveryChanged=true;const saved=await store(reply,{status:'length',stats:checkpointStats()});if(!saved)throw new Error('This chat was deleted while saving the working notes.');},
      });
      final=recovered.final;recovery=recovered.recovery;
      requestContext=recovered.context??requestContext;
    }
    if(!final)throw new Error('The model response ended without a final record.');

    const saved = await store(reply, {
      status: final.done_reason === "length" ? "length" : "complete",
      stats: { ...replyStats(final), ...clock.stats(), think: plannedThink, work_window_tokens:plannedThink?body.options?.num_predict:undefined, num_ctx: body.options?.num_ctx, num_batch: body.options?.num_batch ?? 512, context: requestContext, ...(recovery?{recovery}:{}) },
    });
    if (saved) {
      await live.finish();
      await lock.release();
      await events.send({ event: "done", message: saved.message, chat: saved.chat });
    } else {
      await live.finish();
      await lock.release();
      await events.send(errorEvent("not_found", "This chat was deleted while the reply was being written.", null));
    }
  } catch (err) {
    await fail(err);
  } finally {
    // The saved message is in place by now, so followers switch straight from live to final.
    await live.finish();
    await lock.release();
    await events.close();
  }

  /** Saves the reply: a new message, or the continued one rewritten with its added text. */
  async function store(text, { status, stats }) {
    const fields = { ...text, status, stats, now: nowIso() };
    try{const saved=await(storedMessageId?updateAssistantMessage(db,chat.id,storedMessageId,fields):saveAssistantMessage(db,chat.id,fields));if(saved)storedMessageId=saved.message.id;return saved;}
    catch(error){
      persistenceFailed=true;
      // A committed save with a lost DB acknowledgement must not append a second answer.
      const saved=await lastMessage(db,chat.id).catch(()=>null);
      if(saved?.role==='assistant'&&(storedMessageId?saved.id===storedMessageId:saved.id>userMessage.id)&&saved.content===text.content&&(saved.thinking??'')===(text.thinking??'')&&saved.status===status&&JSON.stringify(saved.stats??null)===JSON.stringify(stats??null)){
        storedMessageId=saved.id;persistenceFailed=false;const current=await requireChat(db,chat.id);return {message:saved,chat:current};
      }
      throw error;
    }
  }

  function checkpointStats(){return {...(continued?.stats??{}),...clock.stats(),think:plannedThink,work_window_tokens:plannedThink?body.options?.num_predict:undefined,num_ctx:body.options?.num_ctx,num_batch:body.options?.num_batch??512,context:requestContext,...(recovery?{recovery}:{})};}

  async function fail(err) {
    const stopped = events.gone || stoppedRemotely;
    let saved = null;
    // A continued reply is only rewritten if something was added to it.
    if (!persistenceFailed&&(continued ? grew()||recoveryChanged : reply.content || reply.thinking)) {
      try {
        const checkpoint=['work_checkpoint','recovery_paused'].includes(err?.code);
        saved = await store(reply, { status: stopped ? "stopped" : checkpoint ? 'length' : "error", stats: recovery||plannedThink?checkpointStats():null });
      } catch (saveErr) {
        console.error("saving the partial reply failed:", saveErr);
      }
    }
    if (events.gone) return;
    // A terminal event promises the caller can immediately send/continue again.
    await live.finish();
    await lock.release();
    if (stoppedRemotely) {
      await events.send(
        saved
          ? { event: "done", message: saved.message, chat: saved.chat, stopped_by: "another_device" }
          : errorEvent("stopped", "Stopped from another device before anything was written.", null),
      );
      return;
    }
    if (err instanceof OfflineError) {
      await events.send(errorEvent("offline", err.message, saved));
    } else if (err instanceof UpstreamError) {
      await events.send(isContextOverflow(err)
        ? errorEvent("context_limit", "The model could not fit this prompt. Compact the session, shorten the latest message and files, or reduce the reply limit.", saved)
        : errorEvent("upstream", err.message, saved));
    } else if(err?.code==='recovery_paused'){
      await events.send(errorEvent('recovery_paused',err.message,saved));
    } else if(err?.code==='work_checkpoint'){
      await events.send(errorEvent('work_checkpoint',err.message,saved));
    } else if(err?.code==='recovery_failed'){
      await events.send(errorEvent('recovery_failed',err.message,saved));
    } else if(err?.code==='auto_compaction_failed'){
      await events.send(errorEvent('auto_compaction_failed',err.message,saved));
    } else if(err?.status===413&&err?.code==='context_limit'){
      await events.send(errorEvent('context_limit',err.message,saved));
    } else {
      console.error("turn failed:", err);
      await events.send(errorEvent("internal", "The server failed while writing the reply.", saved));
    }
  }
}

function errorEvent(code, message, saved) {
  return { event: "error", code, message, message_saved: saved?.message ?? null };
}

/**
 * When the reply's parts arrived: the first token (after the request reached the model server),
 * and the stretch the model spent reasoning, in milliseconds, with the number of reasoning chunks
 * (Ollama streams about one token per chunk).
 */
function replyClock() {
  const started = Date.now();
  let first = null;
  let thinkFrom = null;
  let thinkTo = null;
  let chunks = 0;
  return {
    thought() {
      const now = Date.now();
      first ??= now;
      thinkFrom ??= now;
      thinkTo = now;
      chunks++;
    },
    answered() {
      first ??= Date.now();
    },
    stats() {
      return {
        first_token_ms: first == null ? null : first - started,
        thinking_ms: thinkFrom == null ? null : thinkTo - thinkFrom,
        thinking_tokens: chunks || null,
      };
    },
  };
}

function replyStats(done) {
  const evalSeconds = (done.eval_duration ?? 0) / 1e9;
  return {
    eval_count: done.eval_count ?? null,
    tokens_per_sec: done.eval_count && evalSeconds > 0 ? Math.round((done.eval_count / evalSeconds) * 10) / 10 : null,
    prompt_eval_count: done.prompt_eval_count ?? null,
    total_ms: done.total_duration != null ? Math.round(done.total_duration / 1e6) : null,
    done_reason: done.done_reason ?? null,
  };
}
