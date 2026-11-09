// Prospective request context, with explicit estimates and preserved-history compaction.
import { api } from "./api.js";
import { h } from "./dom.js";
import { isPictureAttachment } from "./files.js";
import { tokensShort } from "./telemetry.js";
import { NORMAL_PROMPT_CHARS, NORMAL_DOCUMENT_CHARS } from "./long-input-ui.js";

export const contextReady = (status) => ["ready", "idle", "images"].includes(status?.server) && Number.isInteger(status?.num_ctx);

/** A request preview contains document text, never picture data. */
export function previewBody({ draft = "", attachments = [], think }) {
  const files = attachments.filter((file) => !file.reading);
  return {
    content: draft,
    think,
    attachments: files.filter((file) => !isPictureAttachment(file)).map(({ name, type, text }) => ({ name, type, text })),
    pictures_count: files.filter(isPictureAttachment).length,
  };
}

export class ContextView {
  context = null;
  #timer;
  #abort;
  #key;
  #chatId;
  #error = null;
  #progress = "";
  #longDraft = false;

  constructor({ status, snapshot, onCompact, onContext }) {
    Object.assign(this, { status, snapshot, onContext });
    this.el = h("section", { class: "context-panel", "aria-label": "Conversation context" });
    this.details = h("details", { class: "context-details" });
    this.value = h("span", { class: "context-value", text: "Context capacity pending" });
    this.track = h("span", { class: "context-track", "aria-hidden": "true" }, this.fill = h("span", { class: "context-fill" }));
    this.toggle = h("summary", { class: "context-toggle", title: "Context, memory and Compact session", "aria-label": "Context and session memory" }, this.value, this.track);
    this.details.append(this.toggle);
    this.explanation = h("div", { class: "context-explanation" });
    this.content = h("div", { class: "context-content" });
    this.explanation.append(this.content);
    this.details.append(this.explanation);
    this.note = h("p", { class: "context-note", hidden: true });
    this.compact = h("button", { class: "context-compact", type: "button", text: "Compact session", disabled: true });
    this.compact.addEventListener("click", () => onCompact());
    this.explanation.append(h("div", { class: "context-actions" }, this.compact));
    this.el.append(h("div", { class: "context-row" }, this.details), this.note);
    this.details.addEventListener("toggle", () => this.positionDetails());
    this.details.addEventListener("keydown", (event) => {
      if (event.key !== "Escape" || !this.details.open) return;
      event.preventDefault();
      this.details.open = false;
      this.toggle.focus();
    });
    document.addEventListener("pointerdown", (event) => {
      if (this.details.open && !this.el.contains(event.target)) this.details.open = false;
    });
    window.addEventListener("resize", () => this.positionDetails());
    document.getElementById("composer").before(this.el);
    status.addEventListener("change", () => this.refresh());
    window.addEventListener("focus", () => this.refresh({ force: true }));
    this.render();
  }

  /** Debounce draft edits; the server's planner is also used by send and continue. */
  refresh({ immediate = false, force = false } = {}) {
    const snapshot = this.snapshot();
    const body = previewBody(snapshot);
    const server = this.status.status;
    const key = JSON.stringify([snapshot.chatId, body, snapshot.messages.length, snapshot.messages.at(-1)?.id,
      server?.server, server?.num_ctx, server?.loaded_ctx, server?.busy?.since, server?.busy?.operation]);
    if (snapshot.chatId !== this.#chatId) {
      this.context = null;
      this.#error = null;
      this.#chatId = snapshot.chatId;
      this.onContext(null);
    }
    this.render();
    if (!force && key === this.#key) return;
    this.#key = key;
    clearTimeout(this.#timer);
    this.#abort?.abort();
    // Oversized drafts use their own upload/reading flow. Do not repeatedly send megabytes
    // to the ordinary preview endpoint, whose input deliberately keeps the normal limits.
    this.#longDraft = body.content.length > NORMAL_PROMPT_CHARS || body.attachments.reduce((sum, file) => sum + file.text.length, 0) > NORMAL_DOCUMENT_CHARS;
    if (this.#longDraft) {
      this.context = null;
      this.#error = null;
      this.onContext(null);
      this.render();
      return;
    }
    const abort = this.#abort = new AbortController();
    const load = async () => {
      try {
        const { context } = await api.context(snapshot.chatId, body, abort.signal);
        if (abort.signal.aborted) return;
        this.context = context;
        this.#error = null;
        this.onContext(context);
      } catch (error) {
        if (abort.signal.aborted) return;
        this.#error = error.message;
        this.context = null;
        this.onContext(null);
        this.#key = null; // a later edit/status update may retry
      }
      if (!abort.signal.aborted) this.render();
    };
    if (immediate) load();
    else this.#timer = setTimeout(load, 800);
  }

  setProgress(detail = "") {
    this.#progress = detail;
    this.render();
  }

  positionDetails() {
    if (!this.details.open) return;
    const room = this.el.getBoundingClientRect().top - 20;
    this.explanation.classList.toggle("is-sheet", room < 160);
    this.explanation.style.setProperty("--context-room", `${Math.max(120, Math.min(440, room))}px`);
  }

  render() {
    const snapshot = this.snapshot();
    const context = this.context;
    const server = this.status.status;
    const active = contextReady(server);
    const busy = snapshot.busy || snapshot.compacting || Boolean(this.status.busyElsewhere);
    const pictures = server?.mode?.current === "images" || server?.mode?.requested === "images";
    const used = context?.estimated_input_tokens ?? 0;
    const budget = context?.input_budget_tokens ?? 0;
    const share = budget > 0 ? used / budget : 0;
    const high = active && (share >= 0.8 || context?.would_omit_history || context?.over_budget);
    this.el.classList.toggle("is-high", Boolean(high));
    this.el.classList.toggle("is-over", Boolean(active && context?.over_budget));
    this.el.classList.toggle("is-compacting", Boolean(snapshot.compacting));
    this.value.textContent = !active ? "Context capacity pending" : this.#longDraft ? "Long input · see processing option below" : context
      ? `Context · ≈${tokensShort(used)} / ${tokensShort(budget)} input`
      : this.#error ? "Context estimate unavailable" : "Estimating context…";
    this.fill.style.width = `${Math.min(100, Math.max(0, share * 100))}%`;
    this.track.hidden = !active || !context;
    this.compact.hidden = !snapshot.chatId;
    this.compact.disabled = !context?.can_compact || !active || busy || pictures;
    this.compact.textContent = snapshot.compacting ? "Compacting…" : "Compact session";
    this.compact.title = busy ? "Wait for the current operation to finish, or stop it."
      : !active ? "Start the chat server to compact earlier messages."
      : pictures ? "Switch back to chat to compact earlier messages."
      : !context?.can_compact ? "More completed messages are needed before compaction."
      : "Summarizes earlier messages to make room. Your full chat stays saved.";
    const notes = [];
    if (snapshot.compacting) notes.push(this.#progress || "Summarizing earlier messages…");
    else if (active && context?.over_budget) notes.push("This message exceeds the available input space. Choose Process long input below, or shorten the prompt and files.");
    else if (active && context?.would_omit_history) notes.push(context.can_compact
      ? "Earlier messages will be summarized automatically before sending."
      : `${context.omitted_message_count.toLocaleString()} earlier messages do not fit. Review context and memory before sending.`);
    else if (high && context?.can_compact) notes.push("Context is getting full. Compact earlier messages to make room.");
    else if (context?.summarized_message_count) notes.push(`${context.summarized_message_count.toLocaleString()} earlier messages summarized. Full chat saved.`);
    if (active && server.loaded_ctx && server.loaded_ctx !== server.num_ctx) notes.push(`Loaded window: ${tokensShort(server.loaded_ctx)}; next request is configured for ${tokensShort(server.num_ctx)}.`);
    this.note.textContent = notes.join(" ");
    this.note.hidden = !notes.length;
    const rows = [];
    if (context && active) {
      rows.push(this.#row("Total context window", context.capacity_tokens));
      rows.push(this.#row("Available for input", context.input_budget_tokens));
      rows.push(this.#row("Estimated input", used));
      rows.push(this.#row("Reserved for the reply", context.reserved_reply_tokens));
      rows.push(this.#row("Instructions and overhead", (context.overhead_tokens ?? 0) + (context.system_tokens ?? 0)));
      rows.push(h("div", { class: "context-detail-row" }, h("span", { text: "Full messages in input" }), h("b", { text: (context.included_message_count ?? 0).toLocaleString() })));
      if (context.summarized_message_count) rows.push(h("div", { class: "context-detail-row" }, h("span", { text: "Earlier messages summarized" }), h("b", { text: context.summarized_message_count.toLocaleString() })));
      if (context.omitted_message_count) rows.push(h("div", { class: "context-detail-row" }, h("span", { text: "Messages left out" }), h("b", { text: context.omitted_message_count.toLocaleString() })));
      if (context.last_measured) rows.push(this.#row("Last prompt, measured", context.last_measured.prompt_tokens));
    }
    this.content.replaceChildren(...[
      ...rows,
      h("p", { text: !active ? "The active capacity is confirmed when the model server connects."
        : "Input is an estimate, including this draft and attachments. Tokenization, especially pictures, can vary." }),
      context?.last_measured?.capacity_tokens ? h("p", { text: `The last measured prompt used a ${context.last_measured.capacity_tokens.toLocaleString()}-token window.` }) : null,
      h("p", { text: "Compact session saves important facts, constraints, corrections and unfinished tasks from earlier text, and keeps recent messages in full. Your original chat stays saved; summaries can still miss details. Describe important image details in text before compacting." }),
      this.#error ? h("p", { class: "is-error", text: this.#error }) : null,
    ].filter(Boolean));
    this.positionDetails();
  }

  #row(label, value) {
    return h("div", { class: "context-detail-row" }, h("span", { text: label }), h("b", { text: `${Math.max(0, value ?? 0).toLocaleString()} tokens` }));
  }
}
