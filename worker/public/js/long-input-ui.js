// Opt-in long-input policy and resumable browser orchestration. All AI work uses hosted Qwen.
import { h } from "./dom.js";
import { confirmDialog } from "./dialogs.js";

export const LONG_INPUT_MAX_CHARS = 1_000_000;
export const NORMAL_PROMPT_CHARS = 100_000;
export const NORMAL_DOCUMENT_CHARS = 120_000;
const ESTIMATED_SECTION_CHARS = 24_000;
export const LONG_INPUT_REVISE_HINT = "To revise this long input, download the original and submit the revised text as a new long input.";

/** Only our exact source-download route is eligible for an authenticated client download. */
export function longInputSourceTarget(href, origin) {
  if (!href) return null;
  let url;
  try { url = new URL(href, origin); } catch { return null; }
  if (url.origin !== origin || url.search || url.hash) return null;
  const matched = /^\/v1\/chats\/([A-Za-z0-9_-]{1,64})\/long-inputs\/([A-Za-z0-9_-]{1,64})\/source$/.exec(url.pathname);
  return matched ? { chatId: matched[1], sourceId: matched[2] } : null;
}

/** A saved source message is a preview, so ordinary edit/regenerate must never resend it. */
export function isLongInputPreview(message, sources, chatId, origin) {
  if (!message || message.role !== "user") return false;
  if (sources.some(source => source.chat_id === chatId && source.user_message_id === message.id)) return true;
  // Protect the interval before source metadata loads, and older inputs outside the list page.
  // Both the generated source link and its reading-plan footer must be present.
  const text = message.content ?? "";
  if (!/Qwen will read this input in \d+ sections before answering\.\s*$/.test(text)) return false;
  for (const matched of text.matchAll(/\[Full input \([^\)\r\n]{1,80} characters\)\]\(([^\)\r\n]+)\)/g)) {
    if (longInputSourceTarget(matched[1], origin)?.chatId === chatId) return true;
  }
  return false;
}

/** User messages intentionally render as plain text; attach a real source control from metadata. */
export function decorateLongInputSources(root, sources, chatId, origin) {
  for (const old of root.querySelectorAll(".long-input-controls")) old.remove();
  for (const source of sources) {
    if (source.chat_id !== chatId || !Number.isSafeInteger(source.user_message_id) || source.user_message_id < 1) continue;
    const href = source.source_url || `/v1/chats/${encodeURIComponent(chatId)}/long-inputs/${encodeURIComponent(source.id)}/source`;
    const target = longInputSourceTarget(href, origin);
    if (!target || target.chatId !== chatId || target.sourceId !== source.id) continue;
    const main = root.querySelector(`.msg-user[data-message-id="${source.user_message_id}"] .msg-main`);
    if (!main) continue;
    const edit = main.querySelector('[aria-label="Edit and resend"]');
    if (edit) { edit.hidden = true; edit.disabled = true; edit.title = LONG_INPUT_REVISE_HINT; }
    const link = h("a", { class: "long-input-original", href, download: true, text: "Download original", title: LONG_INPUT_REVISE_HINT });
    const controls = h("div", { class: "long-input-controls" }, link, h("p", { class: "long-input-revise", text: LONG_INPUT_REVISE_HINT }));
    main.insertBefore(controls, main.querySelector(".msg-actions"));
    if (Number.isSafeInteger(source.answer_message_id)) {
      const regenerate = root.querySelector(`.msg-assistant[data-message-id="${source.answer_message_id}"] .msg-regenerate`);
      if (regenerate) { regenerate.hidden = true; regenerate.disabled = true; regenerate.title = LONG_INPUT_REVISE_HINT; }
    }
  }
}

export function longInputPlan({ draft = "", attachments = [], context = null } = {}) {
  const textChars = draft.length;
  const documentChars = attachments.reduce((sum, file) => sum + (file.text?.length ?? 0), 0);
  const totalChars = textChars + documentChars;
  const needed = textChars > NORMAL_PROMPT_CHARS || documentChars > NORMAL_DOCUMENT_CHARS || Boolean(context?.over_budget);
  const reading = attachments.some(file => file.reading);
  const pictures = attachments.some(file => typeof file.data === "string");
  const reason = totalChars > LONG_INPUT_MAX_CHARS ? `This input exceeds the ${LONG_INPUT_MAX_CHARS.toLocaleString()}-character upload allowance. Split it into smaller submissions.`
    : pictures ? "Long-input processing currently reads text and text-based documents. Remove pictures to use this option."
    : reading ? "Wait for the attached files to finish reading."
    : totalChars === 0 ? "Add a prompt or document first." : null;
  return { needed, allowed: !reason, reason, totalChars, documentChars, estimatedSections: Math.max(1, Math.ceil(totalChars / ESTIMATED_SECTION_CHARS)) };
}

export function longInputWarning({ host = "kaggle", totalChars = 0, totalChunks = null, processedChunks = 0 } = {}) {
  const provider = host === "colab" ? "Colab" : "Kaggle";
  const estimated = totalChunks == null;
  const sections = Math.max(0, (totalChunks ?? Math.max(1, Math.ceil(totalChars / ESTIMATED_SECTION_CHARS))) - processedChunks);
  const passes = `${estimated ? "About " : ""}${sections.toLocaleString()} ${sections === 1 ? "reading section" : "reading sections"}, then one answer. ${estimated ? "The section count is an estimate; it is confirmed after upload. " : ""}`;
  return `Qwen will read this input in sections, then write an answer. This can take many minutes and use a substantial amount of your ${provider} GPU allowance. Every section uses the same hosted Qwen. ${passes}You can stop and resume. Completed reading sections stay saved; an interrupted section may need to run again.`;
}

export function confirmLongInput(options) {
  return confirmDialog({ title: "Process long input?", message: longInputWarning(options), confirmLabel: "Process with Qwen" });
}

/** Each HTTP request performs one saved reading section or the final answer. Never auto-retry errors. */
export async function runLongInputSteps({ source, run, signal, onEvent = () => {}, onStep = () => {}, shouldStop = () => false }) {
  let current = source;
  for (;;) {
    signal?.throwIfAborted();
    if (shouldStop()) return { source: current, stopped: true, complete: false };
    let checkpoint = false;
    let terminal = false;
    const before = current.processed_chunks ?? 0;
    onStep(true);
    try {
      for await (const event of run(current.id, signal)) {
        signal?.throwIfAborted();
        if (event.source) current = event.source;
        onEvent(event);
        if (event.event === "checkpoint") { checkpoint = true; terminal = true; }
        if (event.event === "done") return { source: current, complete: true };
        if (event.event === "error") return { source: current, complete: false, error: event };
      }
    } finally { onStep(false); }
    if (!terminal || !checkpoint) throw new Error("The connection closed before the reading section was confirmed. Resume to check saved progress.");
    if ((current.processed_chunks ?? 0) <= before) throw new Error("Reading progress did not advance. Resume after checking the saved input.");
    // Let Stop and navigation events run between separately locked requests.
    await new Promise(resolve => setTimeout(resolve, 0));
  }
}

export function sourceProgress(source) {
  const done = Math.max(0, source.processed_chunks ?? 0);
  const total = Math.max(1, source.total_chunks ?? 1);
  return done >= total ? "Reading complete · answer pending" : `${done.toLocaleString()} of ${total.toLocaleString()} sections read`;
}

export class LongInputView {
  sources = [];
  constructor({ snapshot, onProcess, onResume }) {
    Object.assign(this, { snapshot, onProcess, onResume });
    this.el = h("section", { class: "long-input-panel", "aria-label": "Long input", hidden: true });
    document.getElementById("composer").before(this.el);
  }
  setSources(sources = []) { this.sources = sources; this.render(); }
  updateSource(source) {
    if (!source) return;
    this.sources = [source, ...this.sources.filter(item => item.id !== source.id)];
    this.render();
  }
  render() {
    const snapshot = this.snapshot();
    const plan = longInputPlan(snapshot);
    const pending = this.sources.filter(source => !["complete", "superseded"].includes(source.status) && source.chat_id === snapshot.chatId);
    const active = snapshot.longInput;
    this.el.hidden = !plan.needed && !pending.length && !active;
    if (this.el.hidden) return;
    const nodes = [];
    if (plan.needed && !active) {
      const button = h("button", { class: "context-compact long-input-action", type: "button", text: "Process long input", onclick: () => this.onProcess() });
      button.disabled = !plan.allowed || snapshot.busy || !snapshot.ready;
      button.title = plan.reason || (!snapshot.ready ? "Start the chat server before processing this input." : snapshot.busy ? "Wait for the current operation to finish." : "Review GPU usage before processing.");
      nodes.push(h("div", { class: "long-input-row" }, h("div", { class: "long-input-copy" },
        h("p", { class: "long-input-title", text: "This input is too long for one reply." }),
        h("p", { text: plan.reason || "Qwen can read it in sections. This uses more GPU time; review the warning before starting." })), button));
    }
    if (active) nodes.push(h("p", { class: "long-input-progress", role: "status", "aria-live": "polite", text: active.detail || (active.source ? sourceProgress(active.source) : "Saving the full input…") }));
    const others = pending.filter(source => source.id !== active?.source?.id);
    for (const source of others) {
      const resume = h("button", { class: "context-compact long-input-action", type: "button", text: "Resume long input", onclick: () => this.onResume(source) });
      resume.disabled = snapshot.busy || !snapshot.ready;
      nodes.push(h("div", { class: "long-input-row long-input-saved" },
        h("div", { class: "long-input-copy" }, h("p", { class: "long-input-title", text: "Saved long input" }), h("p", { text: `${source.total_chars.toLocaleString()} characters · ${sourceProgress(source)}` })), resume));
    }
    this.el.replaceChildren(...nodes);
  }
}
