// The message box: per-chat drafts, a manually resizable textarea, Enter (or Ctrl+Enter) to send,
// the Think toggle, attached files (button, paste or drop) and a counter for long text. On touch
// devices Enter adds a line.

import { h, icon, isTouch, storage } from "./dom.js";
import {
  FileRejected,
  MAX_FILES,
  MAX_PICTURES,
  MAX_TOTAL_CHARS,
  formatChars,
  isPictureAttachment,
  pictureUrl,
  readFile,
} from "./files.js";
import { closePopover, openPopover } from "./popover.js";
import { prefs } from "./prefs.js";

/**
 * Whether a keydown in a message box should send it: Enter (or Ctrl/Cmd+Enter, per this device's
 * setting). On touch keyboards Enter always adds a line and the Send button sends.
 */
export function isSendKey(event) {
  if (event.key !== "Enter" || event.isComposing || event.shiftKey || event.altKey) return false;
  const mod = event.ctrlKey || event.metaKey;
  if (prefs.get().sendKey === "ctrl-enter") return mod;
  return !mod && !isTouch();
}

const THINK_KEY = "qwen.think";
const CHAT_THINK_KEY = THINK_KEY + ".chat:";

/**
 * How much the model reasons before it answers, remembered per chat on this device. `think` is what the API takes: false,
 * the template's "low" or "medium" effort, or true for its default (xhigh), which is thorough but can
 * deliberate for minutes on a hard question.
 */
export const EFFORTS = [
  { id: "off", think: false, label: "Off", short: "Off", hint: "Answers straight away. Fastest." },
  { id: "low", think: "low", label: "Quick", short: "Quick", hint: "A brief think first. Fast." },
  { id: "medium", think: "medium", label: "Balanced", short: "Think", hint: "Thinks as much as the question needs." },
  { id: "deep", think: true, label: "Deep", short: "Deep", hint: "Checks its work and weighs alternatives. Slowest; for hard problems." },
];
const DEFAULT_EFFORT = "medium";
const MAX_CHARS = 100_000;
const COUNTER_FROM = 2_000;
const HEIGHT_KEY = 'qwen.composer.height';
const MIN_HEIGHT = 64;
const MAX_HEIGHT_RATIO = 0.55;

let nextFileId = 0;

export class Composer {
  #generating = false;
  #stopping = false;
  #blocked = null;
  #contextOverBudget = false;
  #preparing = false;
  /**
   * Attached files: documents `{ id, name, type, text }`, pictures `{ id, name, type, data }`, or
   * `{ id, name, reading: true }` while being read.
   */
  #files = [];
  // Draft contents and File objects stay in this tab, never in shared browser storage.
  #draftKey = 'new';
  #drafts = new Map([['new', { text: '', files: this.#files, revision: 0 }]]);
  #efforts = new Map();
  #defaultEffort = DEFAULT_EFFORT;
  #height = MIN_HEIGHT;
  #preferredHeight = MIN_HEIGHT;

  /**
   * @param {object} actions
   * @param {(text: string, files: ({name: string, type: string, text: string} | {name: string, type: string, data: string})[]) => void} actions.onSend
   * @param {() => void} actions.onStop
   * @param {(message: string) => void} actions.onError
   * @param {() => boolean} [actions.canSeePictures] whether the model server running now takes pictures
   */
  constructor(actions) {
    this.actions = actions;
    this.form = document.getElementById("composer");
    this.input = document.getElementById("prompt");
    // Long input is an explicit alternate action; preserve the full paste for that choice.
    this.input.removeAttribute("maxlength");
    this.input.setAttribute('rows', '2');
    this.send = document.getElementById("send");
    this.thinkButton = document.getElementById("think");
    this.counter = document.getElementById("counter");
    this.hint = document.getElementById("composer-hint");
    this.tray = document.getElementById("attachments");
    this.picker = document.getElementById("file-picker");
    this.attachButton = document.getElementById("attach");

    this.thinkButton.prepend(icon("spark"));
    this.attachButton.prepend(icon("attach"));
    this.keys = document.getElementById("keys");
    // Keep the old device preference as the default for new or previously unconfigured chats.
    this.#defaultEffort = this.#validEffort(storage.get(THINK_KEY)) ?? DEFAULT_EFFORT;
    this.effort = this.#defaultEffort;
    this.#efforts.set(this.#draftKey, this.effort);
    this.#syncThink();
    this.#syncSend();

    this.thinkButton.setAttribute("aria-haspopup", "menu");
    this.thinkButton.addEventListener("click", () => this.#openEffortMenu());
    this.attachButton.addEventListener("click", () => this.picker.click());
    this.picker.addEventListener("change", () => {
      this.addFiles([...this.picker.files]);
      this.picker.value = "";
    });
    this.input.addEventListener("paste", (event) => {
      const files = [...(event.clipboardData?.files ?? [])];
      if (files.length) {
        event.preventDefault();
        this.addFiles(files);
      }
    });
    this.input.addEventListener("input", () => this.#onInput());
    this.input.addEventListener("keydown", (event) => {
      if (isSendKey(event)) {
        event.preventDefault();
        this.form.requestSubmit();
      }
    });
    this.form.addEventListener("submit", (event) => {
      event.preventDefault();
      if (this.#generating) this.actions.onStop();
      else this.#submit();
    });
    this.#setUpResize();
  }

  get value() {
    return this.input.value;
  }

  /** Ready and pending files for the context preview; picture data stays in this browser. */
  get attachments() {
    return this.#files;
  }

  set value(text) {
    this.input.value = text;
    this.#onInput();
  }

  focus() {
    if (!isTouch()) this.input.focus({ preventScroll: true });
  }

  get draftKey() { return this.#draftKey; }

  captureDraft() {
    this.#saveDraft(false);
    const draft = this.#drafts.get(this.#draftKey);
    return { key: this.#draftKey, revision: draft.revision, text: draft.text, files: [...draft.files] };
  }

  switchDraft(chatId) {
    this.#saveDraft(false);
    this.#draftKey = chatId == null ? 'new' : 'chat:' + chatId;
    if (!this.#drafts.has(this.#draftKey)) this.#drafts.set(this.#draftKey, { text: '', files: [], revision: 0 });
    this.effort = this.#efforts.get(this.#draftKey)
      ?? (chatId == null ? null : this.#validEffort(storage.get(CHAT_THINK_KEY + chatId)))
      ?? this.#defaultEffort;
    this.#efforts.set(this.#draftKey, this.effort);
    // Pin inherited choices too: changing the new-chat default must not change an existing chat.
    if (chatId != null) storage.set(CHAT_THINK_KEY + chatId, this.effort);
    this.#syncThink();
    this.#showDraft();
  }

  /** A newly saved chat takes ownership of its former new-chat draft, including newer edits. */
  adoptDraft(chatId) {
    this.#saveDraft(false);
    const draft = this.#drafts.get(this.#draftKey);
    this.#drafts.delete(this.#draftKey);
    this.#efforts.delete(this.#draftKey);
    this.#draftKey = 'chat:' + chatId;
    this.#drafts.set(this.#draftKey, draft);
    this.#efforts.set(this.#draftKey, this.effort);
    storage.set(CHAT_THINK_KEY + chatId, this.effort);
    return this.#draftKey;
  }

  forgetDraft(chatId) {
    this.#drafts.delete('chat:' + chatId);
    this.#efforts.delete('chat:' + chatId);
    storage.set(CHAT_THINK_KEY + chatId, null);
  }

  /** Compare-and-clear only the submitted version, even if another chat is now visible. */
  clearDraft(snapshot = this.captureDraft()) {
    const draft = this.#drafts.get(snapshot.key);
    if (!draft || draft.revision !== snapshot.revision) return null;
    draft.text = ''; draft.files = []; draft.revision++;
    if (snapshot.key === this.#draftKey) this.#showDraft();
    return { key: snapshot.key, revision: draft.revision };
  }

  restoreDraft(snapshot, cleared) {
    const draft = cleared && this.#drafts.get(cleared.key);
    if (!draft || draft.revision !== cleared.revision) return;
    draft.text = snapshot.text; draft.files = [...snapshot.files]; draft.revision++;
    if (cleared.key === this.#draftKey) this.#showDraft();
  }

  #saveDraft(changed = true) {
    let draft = this.#drafts.get(this.#draftKey);
    if (!draft) this.#drafts.set(this.#draftKey, draft = { text: '', files: [], revision: 0 });
    draft.text = this.input.value; draft.files = this.#files;
    if (changed) draft.revision++;
  }

  #showDraft() {
    const draft = this.#drafts.get(this.#draftKey);
    this.input.value = draft.text; this.#files = draft.files;
    this.#onInput(false); this.#renderTray(false);
  }

  setContext(context) {
    this.#contextOverBudget = Boolean(context?.over_budget);
    this.#syncSend();
  }

  setPreparing(preparing) {
    this.#preparing = preparing;
    this.#syncSend();
  }

  /** Reads and attaches `files`; refusals are reported through `onError`. */
  async addFiles(files) {
    const draft = this.#drafts.get(this.#draftKey);
    const room = MAX_FILES - this.#files.length;
    if (files.length > room) this.actions.onError(`Up to ${MAX_FILES} files can be attached to one message.`);
    const pending = files.slice(0, Math.max(0, room)).map((file) => ({ id: ++nextFileId, name: file.name, reading: true, file }));
    this.#files.push(...pending);
    this.#renderTray();
    await Promise.all(
      pending.map(async (entry) => {
        try {
          const read = await readFile(entry.file, { pictures: Boolean(this.actions.canSeePictures?.()) });
          if (!draft.files.includes(entry)) return;
          if (isPictureAttachment(read) && draft.files.filter((f) => f !== entry && isPictureAttachment(f)).length >= MAX_PICTURES) {
            throw new FileRejected(`Up to ${MAX_PICTURES} pictures can be attached to one message.`);
          }
          Object.assign(entry, read, { reading: false, file: null });
        } catch (err) {
          draft.files = draft.files.filter((f) => f !== entry);
          this.actions.onError(err instanceof FileRejected ? err.message : `${entry.name} couldn't be read.`);
        }
        draft.revision++;
        if (this.#drafts.get(this.#draftKey) === draft) { this.#files = draft.files; this.#renderTray(false); }
      }),
    );
  }

  /** Puts text and files back after a send that the server never accepted. */
  restore(text, files = [], expected = this.captureDraft()) {
    const draft = this.#drafts.get(expected.key);
    if (!draft || draft.revision !== expected.revision) return;
    if (draft.text || draft.files.length) return;
    draft.text = text;
    draft.files = files.map((f) => ({ id: ++nextFileId, ...f, reading: false }));
    draft.revision++;
    if (expected.key === this.#draftKey) this.#showDraft();
  }

  /** Switches the button between Send and Stop. */
  setGenerating(generating) {
    this.#generating = generating;
    this.#syncSend();
  }

  /** While a Stop is on its way: the Stop button waits, so a second press doesn't drop the reply. */
  setStopping(stopping) {
    this.#stopping = stopping;
    this.#syncSend();
  }

  /**
   * Blocks sending with a reason (another device is generating), or unblocks with null. `action`
   * (`{ label, busyLabel, onClick }`) adds a button to the notice, e.g. to stop that reply.
   */
  setBlocked(reason, action = null) {
    this.#blocked = reason;
    this.hint.hidden = !reason;
    this.hint.replaceChildren();
    if (reason) {
      this.hint.append(h("span", { text: reason }));
      if (action) {
        const button = h("button", { class: "hint-action", type: "button", text: action.label });
        button.addEventListener("click", async () => {
          button.disabled = true;
          button.textContent = action.busyLabel ?? action.label;
          await action.onClick();
        });
        this.hint.append(button);
      }
    }
    this.#syncSend();
  }

  #submit() {
    const text = this.input.value.trim();
    const files = this.#files;
    if ((!text && !files.length) || this.#blocked || this.#preparing || this.#contextOverBudget || text.length > MAX_CHARS) return;
    if (files.some((f) => f.reading)) return;
    if (this.#totalChars() > MAX_TOTAL_CHARS) return;
    const snapshot = this.captureDraft();
    this.actions.onSend(
      text,
      files.map(({ name, type, text: body, data }) => (isPictureAttachment({ data }) ? { name, type, data } : { name, type, text: body })),
      snapshot,
    );
  }

  #totalChars() {
    return this.#files.reduce((sum, f) => sum + (f.text?.length ?? 0), 0);
  }

  #renderTray(changed = true) {
    if (changed) this.#saveDraft();
    this.tray.hidden = !this.#files.length;
    this.tray.replaceChildren(
      ...this.#files.map((file) => {
        const remove = h("button", { class: "chip-remove", type: "button", "aria-label": `Remove ${file.name}`, title: "Remove" }, icon("close"));
        remove.addEventListener("click", () => {
          this.#files = this.#files.filter((f) => f !== file);
          this.#renderTray();
          this.input.focus({ preventScroll: true });
        });
        const picture = isPictureAttachment(file);
        return h(
          "span",
          { class: `file-chip${file.reading ? " is-reading" : ""}${picture ? " is-picture" : ""}` },
          picture ? h("img", { class: "file-chip-thumb", src: pictureUrl(file), alt: "", decoding: "async" }) : icon("file"),
          h("span", { class: "file-chip-name", text: file.name, title: file.name }),
          h("span", { class: "file-chip-meta", text: file.reading ? "Reading…" : picture ? `${file.width}×${file.height}` : formatChars(file.text.length) }),
          remove,
        );
      }),
    );
    const total = this.#totalChars();
    if (total > MAX_TOTAL_CHARS) {
      this.tray.append(h("span", { class: "tray-note", text: `${formatChars(total)} attached. Use Process long input to read these documents in sections.` }));
    } else if (this.actions.inputBudget?.() && total > this.actions.inputBudget() * 3 * 0.8) {
      this.tray.append(h("span", { class: "tray-note", text: `${formatChars(total)} attached. Check the context estimate; large files may need to be shortened.` }));
    }
    this.#syncSend();
    this.actions.onChange?.();
  }

  #onInput(changed = true) {
    if (changed) this.#saveDraft();
    const length = this.input.value.length;
    this.counter.hidden = length < COUNTER_FROM;
    this.counter.textContent = length > MAX_CHARS ? `${length.toLocaleString()} characters · long input` : `${length.toLocaleString()} / ${MAX_CHARS.toLocaleString()}`;
    this.counter.classList.toggle("is-over", length > MAX_CHARS);
    this.#syncSend();
    this.actions.onChange?.();
  }

  #maxHeight() { return Math.max(MIN_HEIGHT, Math.min(640, Math.round((window.visualViewport?.height ?? window.innerHeight) * MAX_HEIGHT_RATIO))); }

  #size(height, persist = true) {
    this.#height = Math.max(MIN_HEIGHT, Math.min(this.#maxHeight(), height));
    this.input.style.height = this.#height + 'px';
    this.input.style.maxHeight = this.#maxHeight() + 'px';
    this.resizeHandle.setAttribute('aria-valuemin', MIN_HEIGHT);
    this.resizeHandle.setAttribute('aria-valuemax', this.#maxHeight());
    this.resizeHandle.setAttribute('aria-valuenow', this.#height);
    this.resizeHandle.setAttribute('aria-valuetext', Math.round(this.#height) + ' pixels');
    if (persist) { this.#preferredHeight = this.#height; storage.set(HEIGHT_KEY, String(this.#height)); }
  }

  #setUpResize() {
    const handle = this.resizeHandle = h('div', { class: 'composer-resize', role: 'separator', tabindex: '0', 'aria-label': 'Resize message box', 'aria-orientation': 'horizontal', 'aria-controls': 'prompt', title: 'Drag up to enlarge · Arrow keys resize · Home resets' });
    this.input.before(handle);
    this.#preferredHeight = Number(storage.get(HEIGHT_KEY)) || MIN_HEIGHT;
    this.#size(this.#preferredHeight, false);
    handle.addEventListener('keydown', event => {
      const next = { ArrowUp: this.#height + 24, ArrowDown: this.#height - 24, Home: MIN_HEIGHT, End: this.#maxHeight() }[event.key];
      if (next == null) return;
      event.preventDefault(); this.#size(next);
    });
    let drag = null;
    handle.addEventListener('pointerdown', event => {
      if (event.button !== 0) return;
      event.preventDefault(); drag = { y: event.clientY, height: this.#height, id: event.pointerId };
      handle.setPointerCapture?.(event.pointerId);
    });
    handle.addEventListener('pointermove', event => { if (drag) this.#size(drag.height + drag.y - event.clientY); });
    const end = event => { if (drag) handle.releasePointerCapture?.(event.pointerId); drag = null; };
    handle.addEventListener('pointerup', end); handle.addEventListener('pointercancel', end);
    handle.addEventListener('lostpointercapture', () => { drag = null; });
    // Native textarea resizing remains available as a fallback. Typing never writes height.
    const rememberNative = () => { const height = this.input.getBoundingClientRect().height; if (Math.abs(height - this.#height) > 1) this.#size(height); };
    this.input.addEventListener('pointerup', rememberNative);
    window.addEventListener?.('pointerup', () => { if (!drag) rememberNative(); });
    const fitViewport = () => this.#size(this.#preferredHeight, false);
    window.visualViewport?.addEventListener('resize', fitViewport);
    window.addEventListener?.('resize', fitViewport);
  }

  /** What the API takes for the chosen effort: false, "low", "medium" or true. */
  get think() {
    return EFFORTS.find((e) => e.id === this.effort).think;
  }

  #validEffort(value) { return EFFORTS.some((effort) => effort.id === value) ? value : null; }

  #syncThink() {
    const effort = EFFORTS.find((e) => e.id === this.effort);
    this.thinkButton.setAttribute("aria-pressed", String(effort.think !== false));
    this.thinkButton.dataset.effort = effort.id;
    this.thinkButton.querySelector(".think-label").textContent = effort.short;
    this.thinkButton.title = `Thinking: ${effort.label}. ${effort.hint} Click to change.`;
    this.actions.onChange?.();
  }

  /** The effort picker: a small menu of radio items, each with what it trades. */
  #openEffortMenu() {
    if (this.#generating || this.#preparing) return;
    const items = EFFORTS.map((effort) => {
      const checked = effort.id === this.effort;
      const item = h(
        "button",
        { class: "effort-item", type: "button", role: "menuitemradio", "aria-checked": String(checked), tabindex: "-1", dataset: { effort: effort.id } },
        h("span", { class: "effort-check", "aria-hidden": "true" }, checked ? icon("check") : null),
        h("span", { class: "effort-text" }, h("span", { class: "effort-label", text: effort.label }), h("span", { class: "effort-hint", text: effort.hint })),
      );
      item.addEventListener("click", () => {
        if (this.#generating || this.#preparing) return;
        this.effort = effort.id;
        this.#efforts.set(this.#draftKey, effort.id);
        if (this.#draftKey === 'new') {
          this.#defaultEffort = effort.id;
          storage.set(THINK_KEY, effort.id === DEFAULT_EFFORT ? null : effort.id);
        } else {
          storage.set(CHAT_THINK_KEY + this.#draftKey.slice(5), effort.id);
        }
        this.#syncThink();
        closePopover();
        this.focus();
      });
      return item;
    });
    const menu = h(
      "div",
      { class: "effort-menu", role: "menu", "aria-label": "Thinking" },
      h("p", { class: "effort-title", text: "Thinking before it answers" }),
      items,
    );
    const el = openPopover(this.thinkButton, menu, {
      align: "start",
      className: "popover-menu popover-effort",
      onKeydown: (event) => {
        const index = items.indexOf(document.activeElement);
        const next = { ArrowDown: index + 1, ArrowUp: index - 1, Home: 0, End: items.length - 1 }[event.key];
        if (next == null) return;
        event.preventDefault();
        items[(next + items.length) % items.length].focus();
      },
    });
    if (el) (items.find((i) => i.getAttribute("aria-checked") === "true") ?? items[0]).focus({ preventScroll: true });
  }

  /** The send keys, spelled out next to the button where there's a keyboard. */
  #syncKeys() {
    if (!this.keys) return;
    this.keys.textContent = prefs.get().sendKey === "ctrl-enter" ? "Ctrl ↵ send · ↵ new line" : "↵ send · ⇧↵ new line";
    this.keys.hidden = isTouch() || this.#generating || Boolean(this.#blocked) || !this.counter.hidden || this.#files.length > 0;
  }

  #syncSend() {
    this.#syncKeys();
    this.thinkButton.disabled = this.#generating || this.#preparing;
    const text = this.input.value.trim();
    const hasFiles = this.#files.length > 0;
    const blockedByFiles = this.#files.some((f) => f.reading) || this.#totalChars() > MAX_TOTAL_CHARS;
    this.send.replaceChildren(icon(this.#generating ? "stop" : "send"));
    this.send.classList.toggle("is-stop", this.#generating);
    this.send.classList.toggle("is-stopping", this.#generating && this.#stopping);
    this.send.setAttribute("aria-label", this.#generating ? (this.#stopping ? "Stopping" : "Stop") : "Send");
    this.send.title = this.#generating ? (this.#stopping ? "Stopping…" : "Stop (Esc)") : "Send";
    this.send.disabled = this.#generating
      ? this.#stopping
      : (!text && !hasFiles) || Boolean(this.#blocked) || this.#preparing || this.#contextOverBudget || text.length > MAX_CHARS || blockedByFiles;
  }
}
