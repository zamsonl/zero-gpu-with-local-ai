// POST /v1/chats/:id/turn: checks, takes the generation lock, saves the user message, then hands
// off to the streaming generation. Anything that fails before the hand-off is a plain JSON error.

import { isImage, parseAttachments } from "./attachments.js";
import { requireChat } from "./chats.js";
import { settings } from "./config.js";
import { mappedTranscript, planContext, readCheckpoint, requireContextSpace } from "./context.js";
import { startGeneration } from "./generation.js";
import { HttpError, badRequest, readJsonObject } from "./http.js";
import { GenerationLock } from "./lock.js";
import { readPreferences } from "./preferences.js";
import { chatRequestBody } from "./prompt.js";
import { listTranscript, saveUserMessage } from "./store.js";
import { readTarget, serverInfo } from "./target.js";
import { picturesHaveGpu, readMode } from "./images.js";
import { nowIso } from "./util.js";
import { AUTO_TITLE_CHARS, expectContent, normalizeTitle } from "./validate.js";
import {NDJSON_HEADERS} from './event-stream.js';

// Room for 100K characters of text plus 120K of attached files, even in 3-byte UTF-8, plus pictures.
const TURN_BODY_LIMIT = 2 * 1024 * 1024 + 256 * 1024;

const THINK_EFFORTS = ["medium", "low"];

export async function turn({ env, ctx, request, params }) {
  const config = settings(env);
  const db = env.DB;
  const input = parseTurn(await readJsonObject(request, TURN_BODY_LIMIT));
  const chat = await requireChat(db, params.id);
  const registered = await readTarget(db);
  if (!registered) {
    throw new HttpError(503, "offline", "No model server has registered yet. Start the Kaggle or Colab notebook.");
  }
  if (picturesHaveGpu(await readMode(db, registered))) {
    throw new HttpError(409, "image_mode", "The GPUs are making pictures right now. Switch back to chat first.");
  }
  // The server that registered (Colab or Kaggle) decides how much the model can hold, and whether
  // it can see pictures.
  const { numCtx, vision, numBatch, inferenceTransport } = serverInfo(env, registered);
  if (!vision && input.attachments.some(isImage)) {
    throw new HttpError(409, "no_vision", "The model server running now can't see pictures. Start the Kaggle notebook to send them.");
  }

  const acquired = await GenerationLock.acquire(db, chat.id);
  if (acquired.busy) {
    throw new HttpError(409, "busy", "Another reply is being generated right now.", { busy: acquired.busy });
  }
  const { lock } = acquired;

  let job;
  try {
    const kept = keepBefore(await listTranscript(db, chat.id), input.replaceFrom);
    const preferences = await readPreferences(db, env);
    const plan = planContext({
      transcript: mappedTranscript([...kept, { role: "user", content: input.content, attachments: input.attachments }], vision),
      numCtx, think: input.think, preferences, checkpoint: await readCheckpoint(db, chat.id),
    });
    requireContextSpace(plan);
    const saved = await saveUserMessage(db, {
      chatId: chat.id,
      replaceFrom: input.replaceFrom,
      content: input.content,
      attachments: input.attachments,
      bucket: env.IMAGES,
      autoTitle: normalizeTitle(titleSource(kept, input), AUTO_TITLE_CHARS),
      now: nowIso(),
    });
    // Pictures from earlier in the chat go too while the server can see them; otherwise only their
    // names (in the text) do.
    const messages = plan.messages;
    job = {
      db,
      env,
      registered,
      preferences,
      plannedThink: input.think,
      autoCompact: plan.context.would_omit_history||plan.context.estimated_input_tokens>=plan.context.input_budget_tokens*0.9,
      lock,
      chat: saved.chat,
      userMessage: saved.message,
      target: registered.target,
      inferenceTransport,
      body: chatRequestBody({ model: config.model, numCtx, numBatch, messages, think: input.think, preferences }),
      requestContext: plan.context,
      timingScale: config.timingScale,
      signal: request.signal,
    };
  } catch (err) {
    await lock.release();
    throw err;
  }
  // From here on the generation owns the lock and releases it when it ends.
  return new Response(startGeneration(ctx, job), { headers: NDJSON_HEADERS });
}

function parseTurn(body) {
  const attachments = parseAttachments(body.attachments);
  // A message may be just files, with no text.
  const content = expectContent(body.content ?? "", "content", { allowEmpty: attachments.length > 0 });
  // true (the model's default effort, xhigh), false, or a lighter effort the template knows.
  if (body.think != null && typeof body.think !== "boolean" && !THINK_EFFORTS.includes(body.think)) {
    throw badRequest('"think" must be true, false, "medium" or "low".');
  }
  const replaceFrom = body.replace_from ?? null;
  if (replaceFrom !== null && !(Number.isSafeInteger(replaceFrom) && replaceFrom > 0)) {
    throw badRequest('"replace_from" must be a message id.');
  }
  return { content, attachments, think: body.think ?? true, replaceFrom };
}

/** What an untitled chat is named after: its first message, or the first file's name. */
function titleSource(kept, input) {
  const first = kept.find((m) => m.role === "user") ?? input;
  return first.content.trim() || first.attachments?.[0]?.name || "Files";
}

/** The transcript with `replaceFrom` (a user message of this chat) and everything after it removed. */
function keepBefore(transcript, replaceFrom) {
  if (replaceFrom === null) return transcript;
  const index = transcript.findIndex((m) => m.id === replaceFrom);
  if (index < 0 || transcript[index].role !== "user") {
    throw badRequest('"replace_from" must be the id of a user message in this chat.');
  }
  return transcript.slice(0, index);
}
