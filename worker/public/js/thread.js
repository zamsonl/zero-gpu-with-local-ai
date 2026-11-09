// The message list: your messages and the model's replies, each beside its avatar. A reply has a
// reasoning trace (collapsible, its steps one per paragraph, headed by how long and how much it
// thought), the Markdown answer, a live status line before the first token, status badges, the
// reply's readings (speed, tokens, time to first token) and the per-message actions.

import { copyFromButton } from "./clipboard.js";
import { isSendKey } from "./composer.js";
import { h, icon, iconButton } from "./dom.js";
import { MarkdownView } from "./markdown.js";
import { prefs } from "./prefs.js";
import { viewFile } from "./file-viewer.js";
import { formatChars, isPictureAttachment, pictureUrl } from "./files.js";
import { effortName, tokensShort } from "./telemetry.js";
import { clock } from "./time.js";
import { uncensorTitle } from "./uncensor.js";
import { formatProgressStatus } from "./progress-status.js";

const STATUS_BADGES = {
  stopped: { label: "Stopped", tone: "neutral", hint: "You stopped this reply." },
  length: { label: "Cut off", tone: "warn", hint: "The reply hit the length limit. Continue picks it up where it stopped." },
  error: { label: "Failed", tone: "err", hint: "Something went wrong while this reply was written." },
};

/** Reply statuses that can be continued from where they stopped. */
const CONTINUABLE = ["length", "stopped", "error"];
// Keep every trace window bounded, including saved replies. The complete source
// remains in #thinking; readers can page through it while new tokens arrive.
const LIVE_REASONING_CHARS = 24_000;
const REASONING_STEPS = 200;
const REASONING_BOTTOM_SLOP = 32;

/**
 * @typedef {object} ThreadActions
 * @property {(message: object) => void} onRegenerate
 * @property {(message: object, text: string) => void} onEdit
 */

export class Thread {
  /** @param {HTMLElement} el @param {ThreadActions} actions */
  constructor(el, actions) {
    this.el = el;
    this.actions = actions;
  }

  /** Shows the empty state for a new chat: the name, unredacted once, and the server at a glance. */
  showEmpty({ label, numCtx, active = false, modelSize = "27B" }) {
    const title = h("h2", { class: "empty-title" });
    const subtitle = h("p", { class: "empty-text" });
    const blurb = emptyBlurb(numCtx, active, modelSize);
    uncensorTitle(title, label).catch(() => {
      title.classList.remove("is-censored");
      title.textContent = label;
    });
    subtitle.textContent = blurb;
    subtitle.dataset.contextText = blurb;
    this.el.replaceChildren(
      h(
        "div",
        { class: "empty" },
        title,
        subtitle,
      ),
    );
  }

  /** Refresh capacity without replaying the welcome animation on every status poll. */
  refreshEmpty({ numCtx, active = false, modelSize = "27B" }) {
    const subtitle = this.el.querySelector(".empty-text");
    if (!subtitle) return;
    const text = emptyBlurb(numCtx, active, modelSize);
    if (subtitle.dataset.contextText === text) return;
    subtitle.dataset.contextText = text;
    subtitle.textContent = text;
  }

  /** Renders a saved conversation. */
  render(messages) {
    this.el.replaceChildren();
    const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant");
    for (const message of messages) {
      if (message.role === "user") this.el.append(this.#userMessage(message));
      else this.el.append(new AssistantView(this, message, { isLast: message === lastAssistant }).el);
    }
  }

  /** Appends a user bubble for text that is being sent (it gets its id when the server confirms). */
  appendPendingUser(text, attachments = []) {
    const message = { id: null, role: "user", content: text, attachments, pending: true };
    const el = this.#userMessage(message);
    this.el.append(el);
    return { message, el };
  }

  /** Appends a live assistant reply and returns its view. */
  appendLiveAssistant() {
    for (const action of this.el.querySelectorAll(".msg-regenerate")) action.hidden = true;
    const view = new AssistantView(this, null, { isLast: true });
    this.el.append(view.el);
    view.startLive();
    return view;
  }

  /** A durable recovery draft and its live mirror represent the same reply. */
  hideFollowedAssistant(view, messageId) {
    if (!Number.isSafeInteger(messageId) || messageId < 1) return null;
    const saved = this.el.querySelector(`.msg-assistant[data-message-id="${messageId}"]`);
    if (!saved || saved === view.el) return null;
    const wasHidden = saved.hidden;
    saved.hidden = true;
    saved.before(view.el);
    return () => { saved.hidden = wasHidden; };
  }

  /** Removes every message from the one rendered for `messageId` onwards (regenerate, edit). */
  truncateFrom(messageId) {
    const start = this.el.querySelector(`[data-message-id="${messageId}"]`);
    if (!start) return;
    let node = start;
    while (node) {
      const next = node.nextElementSibling;
      node.remove();
      node = next;
    }
  }

  #userMessage(message) {
    const files = message.attachments ?? [];
    const bubble = message.content ? h("div", { class: "bubble", text: message.content }) : null;
    const chips = files.length
      ? h(
          "div",
          { class: "msg-files" },
          files.map((file) =>
            h(
              "button",
              { class: `file-chip is-sent${isPictureAttachment(file) ? " is-picture" : ""}`, type: "button", title: `View ${file.name}`, onclick: () => viewFile(file) },
              isPictureAttachment(file) ? h("img", { class: "file-chip-thumb", src: pictureUrl(file), alt: "", decoding: "async" }) : icon("file"),
              h("span", { class: "file-chip-name", text: file.name }),
              h("span", { class: "file-chip-meta", text: isPictureAttachment(file) ? "Picture" : formatChars(file.text?.length ?? file.size ?? 0) }),
            ),
          ),
        )
      : null;
    const copy = iconButton("copy", "Copy message", { className: "icon-button msg-action" });
    copy.addEventListener("click", () => copyFromButton(copy, message.content));
    copy.hidden = !message.content;
    const edit = iconButton("edit", "Edit and resend", { className: "icon-button msg-action" });
    edit.addEventListener("click", () => this.#startEdit(el, message));
    const actions = h("div", { class: "msg-actions" }, copy, edit);
    const el = h(
      "article",
      { class: "msg msg-user", "aria-label": "You", dataset: message.id ? { messageId: message.id } : {} },
      h("span", { class: "msg-avatar", "aria-hidden": "true" }, icon("user")),
      h("div", { class: "msg-main" }, bubble, chips, actions),
    );
    if (message.pending) edit.hidden = true;
    message.el = el;
    return el;
  }

  #startEdit(el, message) {
    if (!message.id || this.el.querySelector(".msg-editor")) return;
    const area = h("textarea", { class: "edit-area", rows: "3", "aria-label": "Edit message" });
    area.value = message.content;
    const cancel = h("button", { class: "button", type: "button", text: "Cancel" });
    const save = h("button", { class: "button button-primary", type: "submit", text: "Send" });
    const editor = h(
      "form",
      { class: "msg-editor" },
      area,
      h("div", { class: "msg-editor-bar" }, h("span", { class: "msg-editor-hint", text: "Replies after this message will be replaced." }), cancel, save),
    );
    const restore = () => {
      editor.replaceWith(...saved);
      el.classList.remove("is-editing");
    };
    const saved = [...el.children];
    el.classList.add("is-editing");
    el.replaceChildren(editor);
    const grow = () => {
      area.style.height = "auto";
      area.style.height = `${Math.min(area.scrollHeight, 360)}px`;
    };
    area.addEventListener("input", grow);
    area.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        restore();
      } else if (isSendKey(event)) {
        event.preventDefault();
        editor.requestSubmit();
      }
    });
    cancel.addEventListener("click", restore);
    editor.addEventListener("submit", (event) => {
      event.preventDefault();
      const text = area.value.trim();
      if (!text) return;
      restore();
      this.actions.onEdit(message, text);
    });
    grow();
    area.focus();
    area.setSelectionRange(area.value.length, area.value.length);
  }
}

function emptyBlurb(numCtx, active, modelSize = "27B") {
  return active && numCtx
    ? `A ${modelSize} Qwen model on your cloud GPU, with ${numCtx.toLocaleString()} tokens of total context shared by messages and replies.`
    : `A ${modelSize} Qwen model on your cloud GPU. The active context capacity appears when the server connects.`;
}

/** One assistant reply, either saved (`message`) or being streamed (startLive → … → finish). */
export class AssistantView {
  #thread;
  #message;
  #markdown;
  #content = "";
  #thinking = "";
  #frame = 0;
  #liveTimer = 0;
  #liveStarted = 0;
  #liveState = null;
  #thinkingStarted = 0;
  #contentStarted = false;
  #contentDirty = false;
  #thinkingDirty = false;
  #thinkingFollow = true;
  #thinkingManualPage = false;
  #thinkingInteracted = false;
  #thinkingStart = 0;
  #thinkingEnd = 0;
  #thinkingPaint = false;
  #thinkingScroll = null;

  constructor(thread, message, { isLast = false } = {}) {
    this.#thread = thread;
    this.#message = message;
    this.body = h("div", { class: "md" });
    this.#markdown = new MarkdownView(this.body);
    this.thinkingEl = null;
    this.liveEl = null;
    this.footer = h("div", { class: "msg-foot" });
    this.main = h("div", { class: "msg-main" }, this.body, this.footer);
    this.el = h(
      "article",
      { class: "msg msg-assistant", "aria-label": "Reply" },
      h("span", { class: "msg-avatar", "aria-hidden": "true", text: "HQ" }),
      this.main,
    );
    if (message) {
      this.el.dataset.messageId = message.id;
      if (message.thinking) this.#setThinking(message.thinking, { open: prefs.get().reasoningOpen, label: reasonedFor(message.stats), meta: traceMeta(message.stats) });
      this.#content = message.content;
      this.#contentStarted = Boolean(message.content);
      this.#markdown.render(message.content, { final: true });
      this.#renderFooter(message, isLast);
    }
  }

  get content() {
    return this.#content;
  }

  get thinking() {
    return this.#thinking;
  }

  startLive() {
    this.el.classList.add("is-live");
    this.#liveStarted = Date.now();
    this.liveEl = h("div", { class: "live-status", role: "status" }, h("span", { class: "spinner", "aria-hidden": "true" }), h("span", { class: "live-text" }));
    this.main.prepend(this.liveEl);
    this.#liveState = { state: "waiting", detail: "" };
    this.#tickLive();
    this.#liveTimer = setInterval(() => this.#tickLive(), 1000);
  }

  /**
   * Puts a saved reply that stopped early back into live mode, so it can be continued in place:
   * its reasoning reopens if it was cut off mid-thought, and the status line sits under its text.
   */
  resume({ thinking = true } = {}) {
    this.el.classList.add("is-live");
    this.#liveStarted = Date.now();
    if (thinking && this.thinkingEl && !this.#contentStarted) {
      this.thinkingEl.classList.add("is-live");
      this.thinkingEl.open = true;
      this.thinkingLabel.textContent = "Thinking…";
      this.#thinkingStarted = Date.now();
      if (!this.#thinkingInteracted) {
        this.#thinkingFollow = true;
        this.#thinkingManualPage = false;
        this.#thinkingDirty = true;
        this.#schedule();
      }
    }
    this.liveEl = h("div", { class: "live-status", role: "status" }, h("span", { class: "spinner", "aria-hidden": "true" }), h("span", { class: "live-text" }));
    this.body.after(this.liveEl);
    this.#liveState = { state: "continuing", detail: "" };
    this.#tickLive();
    this.#liveTimer = setInterval(() => this.#tickLive(), 1000);
  }

  /** A `status` event from the server (before the first token). */
  setStatus(status) {
    const { state } = status;
    this.#liveState = { ...status };
    if (this.thinkingEl && !this.#contentStarted && state !== 'thinking') {
      this.thinkingLabel.textContent = formatProgressStatus({...status,transport_state:null});
      this.thinkingEl.classList.remove('is-live');
    }
    if (!this.liveEl && this.el.classList.contains("is-live") && state) {
      this.liveEl = h("div", { class: "live-status", role: "status" }, h("span", { class: "spinner", "aria-hidden": "true" }), h("span", { class: "live-text" }));
      this.body.after(this.liveEl);
      this.#liveTimer = setInterval(() => this.#tickLive(), 1000);
    }
    this.#tickLive();
  }

  /**
   * Catches up with a snapshot of a reply another device is generating (`GET /live`): appends
   * whatever is new since the last snapshot, or the status line while nothing has been written.
   */
  sync(snapshot) {
    const { thinking = "", content = "", state, phase } = snapshot;
    if (thinking.startsWith(this.#thinking) && thinking.length > this.#thinking.length) {
      this.appendThinking(thinking.slice(this.#thinking.length));
    }
    if (content.startsWith(this.#content) && content.length > this.#content.length) {
      this.appendContent(content.slice(this.#content.length));
    }
    // A joining follower receives older text and the current workflow together.
    // Restore the current phase after appending that text, which ends old spinners.
    if (state) {
      if (["thinking", "answering"].includes(state) && (!phase || phase === state)) {
        this.#liveState = { ...snapshot };
        this.#endLive();
        if (state === 'thinking' && this.thinkingEl && !this.#contentStarted) {
          this.thinkingLabel.textContent = 'Thinking…';
          this.thinkingEl.classList.add('is-live');
        }
      } else this.setStatus(snapshot);
    }
  }

  appendThinking(text) {
    this.#endLive();
    if (!this.#thinkingStarted) this.#thinkingStarted = Date.now();
    this.#thinking += text;
    if (!this.thinkingEl) this.#setThinking(this.#thinking, { open: true, label: "Thinking…", live: true });
    if (!this.#contentStarted) {
      this.thinkingLabel.textContent = 'Thinking…';
      this.thinkingEl.classList.add('is-live');
    }
    this.#thinkingDirty = true;
    this.#schedule();
  }

  appendContent(text) {
    this.#endLive();
    if (!this.#contentStarted) {
      this.#contentStarted = true;
      if (this.thinkingEl) this.#closeThinking();
    }
    this.#content += text;
    this.#contentDirty = true;
    this.#schedule();
  }

  /** The reply ended: `message` is what the server saved (or null when nothing was saved). */
  finish(message, { isLast = true, errorText = null } = {}) {
    this.#endLive();
    cancelAnimationFrame(this.#frame);
    this.#frame = 0;
    this.el.classList.remove("is-live");
    if (this.thinkingEl && !this.#contentStarted) this.#closeThinking();
    this.#flush(true);
    if (message) {
      this.#message = message;
      this.el.dataset.messageId = message.id;
      if (!this.#thinking && message.thinking) this.#setThinking(message.thinking, { open: prefs.get().reasoningOpen, label: reasonedFor(message.stats), meta: traceMeta(message.stats) });
      else if (this.thinkingEl && message.stats) {
        // The server measured the reasoning; its numbers replace the page's own estimate.
        if (message.stats.thinking_ms) this.thinkingLabel.textContent = reasonedFor(message.stats);
        this.thinkingMeta.textContent = traceMeta(message.stats);
      }
      this.#renderFooter(message, isLast, errorText);
    } else {
      this.#renderFooter({ status: "error", content: this.#content, stats: null }, isLast, errorText);
    }
  }

  /** Marks a reply the user stopped before the server confirmed what it saved. */
  markStopped() {
    this.finish({ id: this.el.dataset.messageId || null, role: "assistant", content: this.#content, thinking: this.#thinking, status: "stopped", stats: null }, { isLast: true });
    if (!this.#content && !this.#thinking) this.el.remove();
  }

  #schedule() {
    if (this.#frame) return;
    this.#frame = requestAnimationFrame(() => {
      this.#frame = 0;
      this.#flush(false);
      this.el.dispatchEvent(new Event("grew", { bubbles: true }));
    });
  }

  #flush(final) {
    if (this.thinkingBody && (this.#thinkingDirty || final)) {
      // A reader who scrolled away keeps the exact same nodes and offsets.
      // Only the small navigation status changes until they choose another page.
      if (this.#thinkingFollow || this.#thinkingPaint) this.#paintThinking();
      this.#thinkingNavigation();
      this.#thinkingDirty = false;
    }
    if (this.#contentDirty || final) {
      this.#markdown.render(this.#content, { final });
      this.#contentDirty = false;
    }
  }

  #paintThinking() {
    if (this.#thinkingFollow) {
      this.#thinkingEnd = this.#thinking.length;
      this.#thinkingStart = Math.max(0, this.#thinkingEnd - LIVE_REASONING_CHARS);
      // Do not put half of a surrogate pair at a page boundary.
      if (isLowSurrogate(this.#thinking.charCodeAt(this.#thinkingStart))) this.#thinkingStart--;
    }
    const top = this.thinkingBody.scrollTop;
    renderSteps(this.thinkingBody, this.#thinking.slice(this.#thinkingStart, this.#thinkingEnd));
    this.thinkingBody.dataset.traceStart = this.#thinkingStart;
    this.thinkingBody.dataset.traceEnd = this.#thinkingEnd;
    if (this.#thinkingFollow || this.#thinkingScroll === "end") this.thinkingBody.scrollTop = this.thinkingBody.scrollHeight;
    else if (this.#thinkingScroll === "start") this.thinkingBody.scrollTop = 0;
    else this.thinkingBody.scrollTop = top;
    this.#thinkingScroll = null;
    this.#thinkingPaint = false;
  }

  #thinkingNavigation() {
    const total = this.#thinking.length;
    const paged = this.#thinkingStart > 0 || this.#thinkingEnd < total;
    const navigating = paged || (!this.#thinkingFollow && this.#thinkingInteracted);
    this.thinkingControls.hidden = !navigating;
    this.thinkingWindowNote.hidden = !navigating;
    this.thinkingFirst.disabled = this.thinkingPrevious.disabled = this.#thinkingStart === 0;
    this.thinkingNext.disabled = this.#thinkingEnd >= total;
    this.thinkingLatest.hidden = this.#thinkingFollow;
    const range = `${(this.#thinkingStart + 1).toLocaleString()}–${this.#thinkingEnd.toLocaleString()} of ${total.toLocaleString()} characters`;
    const behind = total - this.#thinkingEnd;
    const state = this.#thinkingFollow ? "Following latest reasoning" : behind ? `${behind.toLocaleString()} new characters after this view` : "Reading paused";
    this.thinkingWindowNote.textContent = `${state} · ${range}. The complete trace stays available through these controls.`;
  }

  #readThinking(start, end, scroll = "start") {
    this.#thinkingFollow = false;
    this.#thinkingManualPage = true;
    this.#thinkingInteracted = true;
    this.#thinkingStart = Math.max(0, start);
    this.#thinkingEnd = Math.min(this.#thinking.length, end);
    if (isLowSurrogate(this.#thinking.charCodeAt(this.#thinkingStart))) this.#thinkingStart--;
    if (isHighSurrogate(this.#thinking.charCodeAt(this.#thinkingEnd - 1)) && isLowSurrogate(this.#thinking.charCodeAt(this.#thinkingEnd))) this.#thinkingEnd--;
    this.#thinkingPaint = this.#thinkingDirty = true;
    this.#thinkingScroll = scroll;
    this.#schedule();
  }

  #latestThinking() {
    this.#thinkingFollow = true;
    this.#thinkingManualPage = false;
    this.#thinkingInteracted = true;
    this.#thinkingDirty = true;
    this.#schedule();
  }

  #setThinking(text, { open, label, meta = "", live = false }) {
    this.#thinking = text;
    this.thinkingLabel = h("span", { class: "thinking-label", text: label });
    this.thinkingMeta = h("span", { class: "thinking-meta", text: meta });
    this.thinkingWindowNote = h("p", { class: "thinking-window-note", hidden: true });
    const nav = (text, label) => h("button", { class: "thinking-nav", type: "button", text, "aria-label": label, title: label });
    this.thinkingFirst = nav("Beginning", "Read reasoning from the beginning");
    this.thinkingPrevious = nav("Earlier", "Read the previous reasoning section");
    this.thinkingNext = nav("Later", "Read the next reasoning section");
    this.thinkingLatest = nav("Jump to latest", "Jump to latest reasoning and follow new text");
    this.thinkingControls = h("div", { class: "thinking-controls", role: "group", "aria-label": "Reasoning navigation", hidden: true }, this.thinkingFirst, this.thinkingPrevious, this.thinkingNext, this.thinkingLatest);
    this.thinkingBody = h("div", { class: "thinking-body", tabindex: "0", "aria-label": "Reasoning text" });
    this.thinkingFirst.addEventListener("click", () => this.#readThinking(0, LIVE_REASONING_CHARS));
    this.thinkingPrevious.addEventListener("click", () => this.#readThinking(this.#thinkingStart - LIVE_REASONING_CHARS, this.#thinkingStart));
    this.thinkingNext.addEventListener("click", () => this.#readThinking(this.#thinkingEnd, this.#thinkingEnd + LIVE_REASONING_CHARS));
    this.thinkingLatest.addEventListener("click", () => this.#latestThinking());
    this.thinkingBody.addEventListener("scroll", () => {
      const bottom = this.thinkingBody.scrollHeight - this.thinkingBody.clientHeight - this.thinkingBody.scrollTop <= REASONING_BOTTOM_SLOP;
      if (!bottom && this.#thinkingFollow) {
        this.#thinkingFollow = false;
        this.#thinkingInteracted = true;
        this.#thinkingNavigation();
      } else if (bottom && !this.#thinkingFollow && !this.#thinkingManualPage) this.#latestThinking();
    }, { passive: true });
    this.#thinkingFollow = live;
    this.#thinkingManualPage = !live;
    this.#thinkingStart = 0;
    this.#thinkingEnd = live ? 0 : Math.min(text.length, LIVE_REASONING_CHARS);
    if (isHighSurrogate(text.charCodeAt(this.#thinkingEnd - 1)) && isLowSurrogate(text.charCodeAt(this.#thinkingEnd))) this.#thinkingEnd--;
    if (!live) {
      this.#thinkingScroll = "start";
      this.#paintThinking();
      this.#thinkingNavigation();
    }
    this.#thinkingDirty = live;
    // A disclosure: the label says how long it reasoned, the meta how much and at what effort; the
    // chevron turns when it opens.
    this.thinkingEl = h(
      "details",
      { class: `thinking${live ? " is-live" : ""}` },
      h("summary", { class: "thinking-summary" }, icon("spark"), this.thinkingLabel, this.thinkingMeta, icon("chevron", "icon thinking-chevron")),
      this.thinkingControls,
      this.thinkingWindowNote,
      this.thinkingBody,
    );
    this.thinkingEl.open = open;
    this.body.before(this.thinkingEl);
  }

  #closeThinking() {
    const seconds = this.#thinkingStarted ? Math.max(1, Math.round((Date.now() - this.#thinkingStarted) / 1000)) : 0;
    this.thinkingEl.classList.remove("is-live");
    this.#thinkingDirty = true;
    if (this.#thinkingFollow) this.thinkingEl.open = prefs.get().reasoningOpen;
    this.thinkingLabel.textContent = seconds ? `Reasoned for ${seconds} s` : "Reasoning";
  }

  #tickLive() {
    if (!this.liveEl) return;
    const elapsed = clock(Date.now() - this.#liveStarted);
    const text = formatProgressStatus(this.#liveState);
    this.liveEl.querySelector(".live-text").textContent = `${text} ${elapsed}`;
  }

  #endLive() {
    clearInterval(this.#liveTimer);
    this.#liveTimer = 0;
    this.liveEl?.remove();
    this.liveEl = null;
  }

  #renderFooter(message, isLast, errorText = null) {
    const parts = [];
    const badge = STATUS_BADGES[message.status];
    if (badge) {
      parts.push(h("span", { class: "badge", dataset: { tone: badge.tone }, title: errorText ?? badge.hint, text: badge.label }));
      if (errorText) parts.push(h("span", { class: "msg-error", text: errorText }));
    }
    const stats = message.stats;
    if (stats?.tokens_per_sec) {
      const readings = [`${stats.eval_count.toLocaleString()} tokens`];
      if (stats.first_token_ms != null) readings.push(`first token ${(stats.first_token_ms / 1000).toFixed(1)} s`);
      parts.push(
        h(
          "span",
          { class: "msg-stats" },
          h("span", { class: "stat-speed", text: `${stats.tokens_per_sec.toFixed(1)} tok/s` }),
          ...readings.map((text) => h("span", { text })),
        ),
      );
    }
    const copy = iconButton("copy", "Copy reply", { className: "icon-button msg-action" });
    copy.addEventListener("click", () => copyFromButton(copy, this.#content));
    const regenerate = iconButton("regenerate", "Regenerate", { className: "icon-button msg-action msg-regenerate" });
    regenerate.addEventListener("click", () => this.#thread.actions.onRegenerate(this.#message ?? message));
    regenerate.hidden = !isLast;
    const actions = h("div", { class: "msg-actions" }, this.#content ? copy : null, regenerate);
    // A last reply that stopped early can be picked up where it left off instead of started over.
    const continuable = isLast && message.id && CONTINUABLE.includes(message.status) && (this.#content || this.#thinking);
    const resume = continuable
      ? h("button", { class: "button msg-continue", type: "button", title: "Pick up where this reply stopped" }, icon("resume"), h("span", { text: "Continue" }))
      : null;
    resume?.addEventListener("click", () => this.#thread.actions.onContinue(this.#message ?? message, this));
    const finishAnswer = continuable && this.#thinking
      ? h("button", { class: "button msg-continue", type: "button", title: "Finish without replaying the long reasoning trace. Your saved reasoning stays intact." }, icon("resume"), h("span", { text: "Answer now" }))
      : null;
    finishAnswer?.addEventListener("click", () => this.#thread.actions.onContinue(this.#message ?? message, this, false));
    // Readings first, so they line up under every reply; the actions follow (hidden until hover
    // except on the last reply).
    this.footer.replaceChildren(...parts, actions, resume ?? [], finishAnswer ?? []);
  }
}

/** "Reasoned for 14 s", from the server's measurement, or plain "Reasoning" without one. */
function reasonedFor(stats) {
  const ms = stats?.thinking_ms;
  if (!ms) return "Reasoning";
  return ms < 60_000 ? `Reasoned for ${Math.max(1, Math.round(ms / 1000))} s` : `Reasoned for ${clock(ms)}`;
}

/** "186 tokens · Balanced": how much the model reasoned and at which effort. */
function traceMeta(stats) {
  const parts = [];
  if (stats?.thinking_tokens) parts.push(`${tokensShort(stats.thinking_tokens)} tokens`);
  const effort = stats && "think" in stats ? effortName(stats.think) : null;
  if (effort) parts.push(effort);
  return parts.join(" · ");
}

/**
 * Lays the reasoning out as steps, one per paragraph, changing only what changed (it streams in a
 * frame at a time). Returns whether anything changed.
 */
function renderSteps(container, text) {
  let parts = text.split(/\n{2,}/).filter((part, i, all) => part.trim() || i === all.length - 1);
  if (parts.length > REASONING_STEPS) {
    const size = Math.ceil(parts.length / REASONING_STEPS), grouped = [];
    for (let i = 0; i < parts.length; i += size) grouped.push(parts.slice(i, i + size).join("\n\n"));
    parts = grouped;
  }
  const nodes = container.children;
  let changed = false;
  parts.forEach((part, i) => {
    if (!nodes[i]) {
      container.append(h("p", { class: "trace-step", text: part }));
      changed = true;
    } else if (nodes[i].textContent !== part) {
      nodes[i].textContent = part;
      changed = true;
    }
  });
  while (nodes.length > parts.length) {
    nodes[nodes.length - 1].remove();
    changed = true;
  }
  return changed;
}

function isHighSurrogate(code) { return code >= 0xd800 && code <= 0xdbff; }
function isLowSurrogate(code) { return code >= 0xdc00 && code <= 0xdfff; }
