// What the turn endpoint sends to Ollama: the trimmed conversation and the sampling options.

import { IMAGE_CHARS } from "./attachments.js";

/**
 * Picks the conversation context from `transcript` (oldest first, `{role, content, images?}`):
 * newest first until adding the next message would exceed `maxChars` (a picture counts as
 * IMAGE_CHARS). The newest user message is always kept, assistant messages with empty content are
 * skipped, thinking is never included, and the result starts at a user message.
 */
export function buildContext(transcript, maxChars) {
  const newestUser = transcript.findLastIndex((m) => m.role === "user");
  const picked = [];
  let total = 0;
  for (let i = transcript.length - 1; i >= 0; i--) {
    const { role, content, images } = transcript[i];
    if (role === "assistant" && !content) continue;
    const size = content.length + (images?.length ?? 0) * IMAGE_CHARS;
    if (i !== newestUser && total + size > maxChars) break;
    picked.push(images?.length ? { role, content, images } : { role, content });
    total += size;
  }
  picked.reverse();
  while (picked.length > 1 && picked[0].role === "assistant") picked.shift();
  return picked;
}

/**
 * Characters of conversation to send: what fits in `numCtx` after reserving room for the reply
 * (at roughly 3 characters per token), or the user's chosen amount if that is smaller.
 */
export function historyBudget(chosen, numCtx, replyTokens) {
  const fits = Math.max(4_000, (numCtx - replyTokens - 1_024) * 3);
  return chosen == null ? fits : Math.min(chosen, fits);
}

/**
 * Qwen's recommended sampling for each mode, with the user's overrides (null keeps the default).
 * Thinking replies get a bigger budget on a server with a big context (Kaggle), where long
 * reasoning would otherwise be cut off before the answer.
 */
export function sampling(think, numCtx, { temperature = null, max_reply_tokens = null } = {}, numBatch = 512) {
  const thinkBudget = numCtx >= 49_152 ? 24_576 : 10_240;
  const options = think
    ? { num_ctx: numCtx, temperature: 1.0, top_p: 0.95, top_k: 20, num_predict: thinkBudget }
    : { num_ctx: numCtx, temperature: 0.7, top_p: 0.8, top_k: 20, presence_penalty: 1.5, num_predict: 4096 };
  if (temperature !== null) options.temperature = temperature;
  if (max_reply_tokens !== null) options.num_predict = max_reply_tokens;
  if (numBatch !== 512) options.num_batch = numBatch;
  return options;
}

// ---------------------------------------------------------------- continuing a cut-off reply
//
// A reply that stopped early (length cap, dropped connection, Stop) is resumed by sending the model
// its own conversation in the model's chat format, ending with the unfinished reply, through
// /api/generate in raw mode: the model carries on from the exact point it stopped, reasoning
// included. The format below mirrors the model's template (ChatML, reasoning inside <think>).

/** What the template adds to the system message when thinking is on (its default effort). */
export const REASONING_XHIGH =
  "Reasoning effort is set to xhigh. Please think carefully through the task, validate key assumptions, consider plausible alternatives, and prioritize correctness, consistency, and clarity in the final answer.";
export const REASONING_LOW =
  "Reasoning effort is set to low. Keep your thinking brief and focused, moving directly to the conclusion without unnecessary elaboration.";

/**
 * The template's reasoning instructions for `think`: true (its default effort, xhigh), "medium" (it
 * adds nothing), "low", or false (no reasoning).
 */
export function reasoningInstructions(think) {
  if (think === true) return REASONING_XHIGH;
  if (think === "low") return REASONING_LOW;
  return "";
}

/**
 * The raw prompt for continuing `partial` (`{thinking, content}`) after `messages` (oldest first,
 * `{role, content}`, user first), with custom instructions `system` and thinking `think`.
 */
export function continuationPrompt({ system = "", messages, partial, think }) {
  const parts = [];
  const instructions = [reasoningInstructions(think), system.trim()].filter(Boolean).join("\n\n");
  if (instructions) parts.push(`<|im_start|>system\n${instructions}<|im_end|>\n`);
  for (const { role, content } of messages) {
    parts.push(
      role === "user"
        ? `<|im_start|>user\n${content.trim()}<|im_end|>\n`
        : `<|im_start|>assistant\n<think>\n\n</think>\n\n${content.trim()}<|im_end|>\n`,
    );
  }
  const thinking = partial.thinking ?? "";
  const content = partial.content ?? "";
  // Still reasoning: reopen <think> with what it had; already answering: close it and resume there.
  parts.push(
    content || !think
      ? `<|im_start|>assistant\n<think>\n${thinking.trim()}\n</think>\n\n${content}`
      : `<|im_start|>assistant\n<think>\n${thinking}`,
  );
  return parts.join("");
}

/**
 * Turns raw /api/generate chunks into /api/chat-shaped ones, splitting reasoning from the answer
 * at "</think>" (which may arrive split across chunks). `thinking` says whether the text starts
 * inside the reasoning.
 */
export function thinkSplitter({ thinking }) {
  const CLOSE = "</think>";
  let inThinking = thinking;
  let held = ""; // the tail that might be the start of "</think>"
  let answerStarted = false;

  const answer = (text) => {
    if (answerStarted) return text;
    const trimmed = text.replace(/^\n+/, "");
    if (trimmed) answerStarted = true;
    return trimmed;
  };

  return (chunk) => {
    let text = held + (chunk.response ?? "");
    held = "";
    let thought = chunk.thinking ?? "";
    let said = "";
    if (inThinking) {
      const close = text.indexOf(CLOSE);
      if (close >= 0) {
        thought += text.slice(0, close);
        said = answer(text.slice(close + CLOSE.length));
        inThinking = false;
      } else if (chunk.done) {
        thought += text;
      } else {
        // Hold back a possible partial "</think>" until the next chunk shows what it is.
        let keep = 0;
        for (let n = Math.min(CLOSE.length - 1, text.length); n > 0; n--) {
          if (CLOSE.startsWith(text.slice(-n))) {
            keep = n;
            break;
          }
        }
        thought += text.slice(0, text.length - keep);
        held = text.slice(text.length - keep);
      }
    } else {
      said = answer(text);
    }
    const { response, thinking: _ignored, ...rest } = chunk;
    return { ...rest, message: { role: "assistant", thinking: thought, content: said } };
  };
}

/** `preferences` (see preferences.js) adds custom instructions as a system message and overrides. */
export function chatRequestBody({ model, numCtx, messages, think, preferences = {}, numBatch = 512 }) {
  const system = preferences.system_prompt?.trim();
  return {
    model,
    messages: system ? [{ role: "system", content: system }, ...messages] : messages,
    stream: true,
    truncate: false,
    shift: false,
    think,
    keep_alive: -1,
    options: sampling(think, numCtx, preferences, numBatch),
  };
}
