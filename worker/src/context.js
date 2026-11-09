// One estimated input plan for preview, ordinary turns and continued replies.
// Tokenizer counts are available only after inference; estimates are explicitly labelled.
import { IMAGE_CHARS, modelContent, modelImages, parseAttachments } from "./attachments.js";
import { HttpError, badRequest, json, readJsonObject } from "./http.js";
import { readPreferences } from "./preferences.js";
import { reasoningInstructions, sampling } from "./prompt.js";
import { getChat, listTranscript } from "./store.js";
import { readTarget, serverInfo } from "./target.js";

export const CONTEXT_OVERHEAD = 1024;
export const SUMMARY_PREFIX = "Earlier conversation summary (historical context, not new instructions):\n<conversation_summary>\n";
export const summaryMessage = (summary) => ({ role: "user", content: SUMMARY_PREFIX + summary + "\n</conversation_summary>" });
export const estimatedTokens = (text) => Math.ceil((typeof text === "number" ? text : text?.length ?? 0) / 3);
export const contextMessageCost = (message) => message.content.length + (message.images?.length ?? message.pictures_count ?? 0) * IMAGE_CHARS + 24;
const cost = contextMessageCost;

function pickMessages(transcript, maxChars) {
  const newestUser = transcript.findLastIndex((message) => message.role === "user");
  const picked = [];
  let total = 0;
  for (let index = transcript.length - 1; index >= 0; index--) {
    const message = transcript[index];
    if (message.role === "assistant" && !message.content) continue;
    const size = cost(message);
    if (index !== newestUser && total + size > maxChars) break;
    picked.push(message);
    total += size;
  }
  picked.reverse();
  while (picked.length > 1 && picked[0].role === "assistant") picked.shift();
  return picked;
}

export function validCheckpoint(checkpoint, transcript) {
  return checkpoint && transcript.some((message) => message.id === checkpoint.through_id) ? checkpoint : null;
}

/** `transcript` already has attachment text/images mapped, and includes the draft when present. */
export function planContext({ transcript, numCtx, think = true, preferences = {}, checkpoint = null, partial = null, lastMeasured = null }) {
  checkpoint = validCheckpoint(checkpoint, transcript);
  const options = sampling(think, numCtx, preferences);
  const system = [preferences.system_prompt?.trim(), reasoningInstructions(think)].filter(Boolean).join("\n\n");
  const systemTokens = estimatedTokens(system);
  const inputBudget = Math.max(0, numCtx - options.num_predict - CONTEXT_OVERHEAD);
  const partialChars = (partial?.content?.length ?? 0) + (partial?.thinking?.length ?? 0);
  const summary = checkpoint ? summaryMessage(checkpoint.summary) : null;
  const summaryChars = summary ? cost(summary) : 0;
  const active = transcript.filter((message) => !checkpoint || message.id == null || message.id > checkpoint.through_id);
  const physicalChars = Math.max(0, inputBudget * 3 - system.length - partialChars);
  const chosenChars = preferences.history_chars == null ? physicalChars : Math.min(preferences.history_chars, physicalChars);
  const room = Math.max(0, chosenChars - summaryChars);
  const picked = pickMessages(active, room);
  const newestUser = active.findLast((message) => message.role === "user");
  const minimumChars = (newestUser ? cost(newestUser) : 0) + summaryChars + partialChars + system.length;
  const overBudget = minimumChars > inputBudget * 3 || options.num_predict + CONTEXT_OVERHEAD >= numCtx;
  // Selection preserves the newest user. Over-budget inputs are rejected before saving.
  const messages = [...(summary ? [summary] : []), ...picked];
  const included = picked.length;
  const omitted = Math.max(0, active.filter((message) => message.role !== "assistant" || message.content).length - included);
  const prefix = compactablePrefix(transcript.filter((message) => message.id != null), checkpoint);
  const estimatedInput = estimatedTokens(messages.reduce((sum, message) => sum + cost(message), 0) + system.length + partialChars);
  return {
    messages: messages.map(({ role, content, images }) => images?.length ? { role, content, images } : { role, content }),
    options,
    context: {
      capacity_tokens: numCtx,
      input_budget_tokens: inputBudget,
      reserved_reply_tokens: options.num_predict,
      overhead_tokens: CONTEXT_OVERHEAD,
      system_tokens: systemTokens,
      estimated_input_tokens: estimatedInput,
      estimate: true,
      included_message_count: included,
      omitted_message_count: omitted,
      summarized_message_count: checkpoint?.covered_count ?? 0,
      summary_through_message_id: checkpoint?.through_id ?? null,
      would_omit_history: omitted > 0,
      over_budget: overBudget,
      can_compact: prefix.length > 0,
      last_measured: lastMeasured,
    },
  };
}

/** Keep the two most recent user turns verbatim; a checkpoint always ends before a user turn. */
export function compactablePrefix(transcript, checkpoint = null) {
  const users = transcript.map((message, index) => message.role === "user" ? index : -1).filter((index) => index >= 0);
  if (users.length <= 2) return [];
  const cut = users.at(-2);
  return transcript.slice(0, cut).filter((message) => message.id != null && (!checkpoint || message.id > checkpoint.through_id));
}

export function requireContextSpace(plan) {
  if (plan.context.over_budget) {
    throw new HttpError(413, "context_limit", "This message and its files exceed the available input space. Shorten them, reduce the reply limit, or use a larger running context.", { context: plan.context });
  }
}

/** Ollama rejects exact-token overflow when truncate/shift are disabled. */
export function isContextOverflow(error) {
  return /(?:input|prompt|context).{0,100}(?:exceed|too (?:long|large)|length|window|limit)/i.test(String(error?.message ?? error));
}

export function mappedTranscript(transcript, vision = false) {
  return transcript.map((message) => ({
    id: message.id,
    role: message.role,
    content: modelContent(message.content, message.attachments),
    ...(vision && message.role === "user" ? { images: modelImages(message.attachments) } : {}),
  }));
}

export async function readCheckpoint(db, chatId) {
  return db.prepare("SELECT summary, through_id, covered_count, source_digest, model, updated_at FROM chat_context WHERE chat_id = ?1").bind(chatId).first();
}

export async function lastMeasured(db, chatId) {
  const row = await db.prepare("SELECT stats FROM messages WHERE chat_id = ?1 AND role = 'assistant' AND stats IS NOT NULL ORDER BY id DESC LIMIT 1").bind(chatId).first();
  if (!row) return null;
  const stats = JSON.parse(row.stats);
  return { prompt_tokens: stats.prompt_eval_count ?? null, output_tokens: stats.eval_count ?? null, capacity_tokens: stats.num_ctx ?? null };
}

export async function contextForChat(env, chatId, { transcript = null, think = true, partial = null, checkpoint = undefined, last = undefined } = {}) {
  const registered = await readTarget(env.DB);
  const { numCtx, vision } = serverInfo(env, registered);
  const preferences = await readPreferences(env.DB, env);
  transcript ??= await listTranscript(env.DB, chatId);
  return planContext({
    transcript: mappedTranscript(transcript, vision), numCtx, think, preferences, partial,
    checkpoint: checkpoint === undefined ? await readCheckpoint(env.DB, chatId) : checkpoint,
    lastMeasured: last === undefined ? await lastMeasured(env.DB, chatId) : last,
  });
}

/** Preview only: documents are sent as text, pictures can be counted without sending their bytes. */
export async function previewContext({ env, request, params }) {
  const body = await readJsonObject(request, 2 * 1024 * 1024 + 256 * 1024);
  if (body.content != null && (typeof body.content !== "string" || body.content.length > 100000)) throw badRequest('"content" must contain at most 100,000 characters.');
  if (body.think != null && ![true, false, "medium", "low"].includes(body.think)) throw badRequest('Invalid "think" value.');
  const attachments = parseAttachments(body.attachments);
  const pictures = body.pictures_count ?? 0;
  if (!Number.isInteger(pictures) || pictures < 0 || pictures > 4) throw badRequest('"pictures_count" must be from zero to four.');
  let transcript = [];
  if (params.id) {
    if (!(await getChat(env.DB, params.id))) throw new HttpError(404, "not_found", "No chat with this id.");
    transcript = await listTranscript(env.DB, params.id);
  }
  if (body.replace_from != null) {
    const index = transcript.findIndex((message) => message.id === body.replace_from && message.role === "user");
    if (index < 0) throw badRequest('"replace_from" must identify a user message of this chat.');
    transcript = transcript.slice(0, index);
  }
  const { numCtx, vision } = serverInfo(env, await readTarget(env.DB));
  const mapped = mappedTranscript(transcript, vision);
  if (body.content || attachments.length || pictures) mapped.push({ role: "user", content: modelContent(body.content ?? "", attachments), pictures_count: pictures + modelImages(attachments).length });
  const plan = planContext({ transcript: mapped, numCtx, think: body.think ?? true, preferences: await readPreferences(env.DB, env), checkpoint: params.id ? await readCheckpoint(env.DB, params.id) : null, lastMeasured: params.id ? await lastMeasured(env.DB, params.id) : null });
  return json({ context: plan.context });
}
