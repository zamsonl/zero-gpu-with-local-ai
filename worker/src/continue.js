// POST /v1/chats/:id/continue: resumes the chat's last reply when it stopped early (it hit the
// length cap, the connection dropped, or it was stopped), from the exact point it stopped,
// reasoning included. The added text is streamed like a turn and appended to that same message.

import { requireChat } from "./chats.js";
import { settings } from "./config.js";
import { mappedTranscript, planContext, readCheckpoint, requireContextSpace } from "./context.js";
import { startGeneration } from "./generation.js";
import { HttpError, badRequest, readJsonObject } from "./http.js";
import { GenerationLock } from "./lock.js";
import { readPreferences } from "./preferences.js";
import { continuationPrompt, sampling, thinkSplitter } from "./prompt.js";
import { lastMessage, listTranscript } from "./store.js";
import { readTarget, serverInfo } from "./target.js";
import { picturesHaveGpu, readMode } from "./images.js";
import {NDJSON_HEADERS} from './event-stream.js';

const CONTINUABLE = ["length", "stopped", "error"];

export async function continueReply({ env, ctx, params, request }) {
  const config = settings(env);
  const db = env.DB;
  // Optional body `{ think }`: the reasoning effort to carry on with ("medium", "low"; else the default).
  const requestedEffort = await readEffort(request);
  const chat = await requireChat(db, params.id);
  const last = await lastMessage(db, chat.id);
  if (!last || last.role !== "assistant" || !CONTINUABLE.includes(last.status) || !(last.content || last.thinking)) {
    throw badRequest("Only a reply that stopped before it finished can be continued.");
  }
  const effort=requestedEffort??([true,false,'medium','low'].includes(last.stats?.think)?last.stats.think:true);
  const registered = await readTarget(db);
  if (!registered) {
    throw new HttpError(503, "offline", "No model server has registered yet. Start the Kaggle or Colab notebook.");
  }
  if (picturesHaveGpu(await readMode(db, registered))) {
    throw new HttpError(409, "image_mode", "The GPUs are making pictures right now. Switch back to chat first.");
  }

  const acquired = await GenerationLock.acquire(db, chat.id);
  if (acquired.busy) {
    throw new HttpError(409, "busy", "Another reply is being generated right now.", { busy: acquired.busy });
  }
  const { lock } = acquired;

  let job;
  try {
    let preferences = await readPreferences(db, env);
    if (effort === false) preferences = { ...preferences, max_reply_tokens: Math.min(preferences.max_reply_tokens ?? 4096, 4096) };
    const { numCtx, numBatch, inferenceTransport } = serverInfo(env, registered);
    // A reply that had reasoning carries on with reasoning on (at the asked effort); one written
    // without it, without.
    const think = last.thinking ? effort : false;
    // Finish answer explicitly leaves a too-large reasoning trace out of the model
    // request. The original trace stays on `continued:last` and is never deleted.
    const partial = effort === false ? { ...last, thinking: "" } : last;
    const options = sampling(think, numCtx, preferences, numBatch);
    const earlier = mappedTranscript((await listTranscript(db, chat.id)).filter((m) => m.id !== last.id));
    const lastUser = earlier.findLast((m) => m.role === "user");
    if (!lastUser) throw badRequest("This reply has no question before it to continue from.");
    // The unfinished reply always goes in whole; the earlier conversation gets what room is left.
    const plan = planContext({ transcript: earlier, numCtx, think, preferences, partial, checkpoint: await readCheckpoint(db, chat.id) });
    const forceRecovery=!!last.thinking&&(effort===false||plan.context.over_budget||!!last.stats?.recovery);
    if(!forceRecovery)requireContextSpace(plan);
    const messages = plan.messages;
    job = {
      db,
      env,
      registered,
      preferences,
      plannedThink: think,
      forceRecovery,
      recoveryAnswerOnly: effort===false,
      autoCompact: plan.context.would_omit_history||plan.context.estimated_input_tokens>=plan.context.input_budget_tokens*0.9,
      lock,
      chat,
      userMessage: lastUser,
      continued: last,
      target: registered.target,
      inferenceTransport,
      path: "/api/generate",
      transform: thinkSplitter({ thinking: think && !last.content }),
      body: {
        model: config.model,
        prompt: continuationPrompt({ system: preferences.system_prompt, messages, partial, think }),
        raw: true,
        think,
        stream: true,
        truncate: false,
        shift: false,
        keep_alive: -1,
        options,
      },
      timingScale: config.timingScale,
      requestContext: plan.context,
      signal: request.signal,
    };
  } catch (err) {
    await lock.release();
    throw err;
  }
  return new Response(startGeneration(ctx, job), { headers: NDJSON_HEADERS });
}

async function readEffort(request) {
  if (!request.body) return null;
  // Count actual UTF-8 bytes while reading: Content-Length is optional and can
  // understate a streamed body. Empty bodies preserve the saved-effort default.
  const body = await readJsonObject(request, 1024, { allowEmpty: true });
  const think = body?.think;
  if (think == null) return null;
  if (think === true) return true;
  if (think === false) return false;
  if (think === "medium" || think === "low") return think;
  throw badRequest('"think" must be true, false, "medium" or "low".');
}
