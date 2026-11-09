// Real session details for the approved workspace. This view never starts inference.
import { api } from "./api.js";
import { h, icon } from "./dom.js";
import { contextReady } from "./context-ui.js";
import { downloadBlob } from "./download.js";
import { viewFile } from "./file-viewer.js";
import { formatChars } from "./files.js";
import { isPopoverOpen } from "./popover.js";
import { toast } from "./toast.js";

export function sessionContext(snapshot, server, busyElsewhere = false) {
  const context = snapshot.context;
  const ready = contextReady(server);
  const images = snapshot.images || server?.mode?.current === "images" || server?.mode?.requested === "images";
  const used = ready && context ? context.estimated_input_tokens : null;
  const budget = ready && context ? context.input_budget_tokens : null;
  return {
    used, budget,
    fraction: budget > 0 ? Math.max(0, Math.min(1, used / budget)) : 0,
    canCompact: Boolean(snapshot.chatId && ready && context?.can_compact && !snapshot.busy && !busyElsewhere && !images),
    caption: !ready ? "Capacity is confirmed when the model connects."
      : !context ? "Estimating the next input…"
      : context.over_budget ? "This input needs the long-input processing option."
      : context.would_omit_history ? "Earlier messages will be preserved through automatic compaction."
      : `${Math.max(0, budget - used).toLocaleString()} estimated input tokens free`,
  };
}

/** Keep repeated uploads distinct; they belong to separate messages. */
export function conversationFiles({ chatId, messages = [], attachments = [], sources = [] }) {
  const result = messages.flatMap(message => (message.attachments ?? []).map((file, index) => ({
    key: `message-${message.id}-${index}`, name: file.name, file,
    detail: file.data ? "Saved picture" : file.type === "application/pdf" ? "Saved PDF text" : "Saved document",
  })));
  result.push(...attachments.map((file, index) => ({ key: `draft-${index}`, name: file.name, file, draft: true, detail: file.reading ? "Reading attachment…" : "Unsent attachment" })));
  result.push(...sources.filter(source => source.chat_id === chatId).map(source => ({
    key: `source-${source.id}`, name: "Saved long input", source,
    detail: `${formatChars(source.total_chars)} · ${source.processed_chunks}/${source.total_chunks} sections read`,
  })));
  return result;
}

export function memoryNotes(summary = "") {
  const notes = [];
  for (const match of summary.matchAll(/^- \[([a-z_]+)\] (.+)$/gm)) {
    try { const text = JSON.parse(match[2]); if (typeof text === "string") notes.push({ kind: match[1], text }); } catch { /* Legacy notes remain visible in the full review. */ }
  }
  return notes;
}

export class SessionRail {
  #chatId = null;
  #memoryKey = null;
  #memoryAbort = null;
  #memoryLoading = false;
  #memoryError = "";
  #memory = null;
  #open = false;
  #inert = [];
  #panels = null;
  #filesSnapshot = null;

  constructor({ status, snapshot, onCompact, onBeforeOpen = () => {} }) {
    Object.assign(this, { status, snapshot, onCompact, onBeforeOpen });
    this.el = document.getElementById("session-rail");
    this.content = document.getElementById("session-content");
    this.toggle = document.getElementById("session-toggle");
    this.closeButton = document.getElementById("session-close");
    this.backdrop = document.getElementById("session-backdrop");
    this.toggle?.setAttribute("aria-expanded", "false");
    this.toggle?.addEventListener("click", () => this.#open ? this.close() : this.open());
    this.closeButton?.addEventListener("click", () => this.close());
    this.backdrop?.addEventListener("click", () => this.close());
    document.getElementById("nav-documents")?.addEventListener("click", () => { this.onBeforeOpen(); this.openDocuments(); });
    document.addEventListener("keydown", event => this.#key(event));
    status.addEventListener("change", () => this.refresh());
    this.refresh();
  }

  open() {
    if (!this.el || this.#open) return;
    this.onBeforeOpen();
    this.#open = true;
    this.el.classList.add("is-open");
    this.el.setAttribute("role", "dialog");
    this.el.setAttribute("aria-modal", "true");
    this.toggle?.setAttribute("aria-expanded", "true");
    if (this.backdrop) this.backdrop.hidden = false;
    document.body.classList.add("session-open");
    // The aside is inside main: inert only its siblings, never its ancestor.
    const background = [...(this.el.parentElement?.children ?? []), document.getElementById("sidebar")]
      .filter(element => element && element !== this.el && element !== this.backdrop);
    this.#inert = background.map(element => [element, element.inert]);
    for (const [element] of this.#inert) element.inert = true;
    this.closeButton?.focus({ preventScroll: true });
  }

  close({ restoreFocus = true } = {}) {
    if (!this.#open) return;
    this.#open = false;
    this.el.classList.remove("is-open");
    this.el.removeAttribute("role");
    this.el.removeAttribute("aria-modal");
    this.toggle?.setAttribute("aria-expanded", "false");
    if (this.backdrop) this.backdrop.hidden = true;
    document.body.classList.remove("session-open");
    for (const [element, before] of this.#inert) element.inert = before;
    this.#inert = [];
    if (restoreFocus && this.toggle?.isConnected) this.toggle.focus({ preventScroll: true });
  }

  #key(event) {
    if (!this.#open || event.defaultPrevented) return;
    if ((event.ctrlKey || event.metaKey) && ["k", "o", ","].includes(event.key.toLowerCase())) this.close({ restoreFocus: false });
    if (event.key === "Escape" && !isPopoverOpen() && !document.querySelector("dialog[open]")) {
      event.preventDefault(); this.close(); return;
    }
    // Anchored status menus live in a body portal and own their keyboard input.
    if (event.key !== "Tab" || isPopoverOpen() || !this.el.contains(event.target)) return;
    const controls = [...this.el.querySelectorAll('button:not([disabled]), a[href], summary, [tabindex="0"]')]
      .filter(element => !element.hidden && element.getClientRects().length);
    const first = controls[0], last = controls.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  }

  refresh({ forceMemory = false } = {}) {
    if (!this.content) return;
    const snapshot = this.snapshot();
    if (snapshot.chatId !== this.#chatId) {
      this.#memoryAbort?.abort(); this.#memory = null; this.#memoryError = ""; this.#memoryKey = null;
      if (this.#chatId !== null) this.close({ restoreFocus: false });
      this.#chatId = snapshot.chatId;
      if (this.el) this.el.scrollTop = 0;
    }
    const key = snapshot.chatId ? JSON.stringify([snapshot.chatId, snapshot.context?.summary_through_message_id, snapshot.context?.summarized_message_count]) : null;
    if (key && (forceMemory || key !== this.#memoryKey)) this.#loadMemory(key);
    if (!key) { this.#memoryLoading = false; this.#memoryKey = null; }
    this.#render(snapshot);
  }

  async #loadMemory(key) {
    this.#memoryKey = key;
    this.#memoryAbort?.abort();
    const abort = this.#memoryAbort = new AbortController(), chatId = this.#chatId;
    this.#memoryLoading = true; this.#memoryError = "";
    try {
      const { memory } = await api.memory(chatId, abort.signal);
      if (abort.signal.aborted || this.#chatId !== chatId || this.#memoryKey !== key) return;
      this.#memory = memory;
    } catch (error) {
      if (abort.signal.aborted || this.#chatId !== chatId || this.#memoryKey !== key) return;
      this.#memoryError = error.message || "Stored memory could not be loaded.";
    } finally {
      if (!abort.signal.aborted && this.#chatId === chatId && this.#memoryKey === key) {
        this.#memoryLoading = false; this.#render(this.snapshot());
      }
    }
  }

  #render(snapshot) {
    const server = this.status.status;
    const active = contextReady(server);
    const context = sessionContext(snapshot, server, this.status.busyElsewhere);
    const row = (label, text) => h("div", {}, h("dt", { text: label }), h("dd", { text }));
    const button = (text, action, props = {}) => h("button", { class: "text-button", type: "button", text, onclick: action, ...props });
    const section = (title, action, ...nodes) => h("section", { class: "session-section" }, h("div", { class: "section-heading" }, h("h2", { text: title }), action), ...nodes);
    // Action nodes survive counter/status updates, preserving focus and clicks.
    if (!this.#panels) {
      const model = h("div"), contextBody = h("div"), memory = h("div"), files = h("div");
      const compact = button("Compact", () => { this.close({ restoreFocus: false }); this.onCompact(); }, { title: "Compact earlier messages; the full chat stays saved.", "aria-label": "Compact session from session details" });
      const review = button("Review", () => this.#memoryError ? this.refresh({ forceMemory: true }) : this.openMemory());
      const documents = button("View", () => this.openDocuments(), { "aria-label": "View documents in this conversation" });
      this.#panels = { model, contextBody, memory, files, compact, review, documents };
      this.content.replaceChildren(section("Model", null, model), section("Context", compact, contextBody), section("Saved memory", review, memory), section("In this conversation", documents, files));
    }
    const panels = this.#panels;
    panels.model.replaceChildren(
      h("div", { class: "session-model" }, h("strong", { text: snapshot.modelLabel || "Heretic Qwen" }), h("small", { text: `${server?.model_size || "27B"} Qwen${active && server.quant ? ` · ${server.quant}` : ""}` })),
      h("dl", { class: "session-details" }, row("Host", active ? server.host === "kaggle" ? "Kaggle" : "Colab" : "Not connected"), row("Total context", active ? `${server.num_ctx.toLocaleString()} tokens` : "Pending connection"), row("Vision", active ? server.vision ? "On · attach pictures" : "Text and documents" : "Pending connection")));
    panels.compact.textContent = snapshot.compacting ? "Compacting…" : "Compact";
    panels.compact.disabled = !context.canCompact;
    // CSP rejects style attributes; CSSOM writes keep the visible ratio exact.
    const contextFill = h("span");
    contextFill.style.width = `${context.fraction * 100}%`;
    panels.contextBody.replaceChildren(
      h("div", { class: "session-context-number" }, h("span", { text: context.used == null ? "—" : `≈${context.used.toLocaleString()}` }), h("small", { text: context.budget == null ? " input tokens" : ` / ${context.budget.toLocaleString()} input` })),
      h("div", { class: "session-context-track", "aria-hidden": "true" }, contextFill),
      h("p", { class: "session-context-caption", text: context.caption }),
      h("p", { class: "rail-description", text: "Input and replies share this window. The full chat stays saved." }));
    const notes = memoryNotes(this.#memory?.summary);
    panels.review.textContent = this.#memoryError ? "Retry" : "Review";
    panels.review.disabled = !snapshot.chatId || this.#memoryLoading || (!this.#memory && !this.#memoryError);
    const memoryState = this.#memoryError || (this.#memoryLoading ? "Loading stored memory…" : this.#memory ? `${this.#memory.covered_count.toLocaleString()} earlier messages summarized` : "No earlier messages compacted yet.");
    const preview = notes.slice(-3).map(note => h("li", {}, h("span", { text: `${note.kind.replaceAll("_", " ")}: ` }), h("span", { text: note.text })));
    panels.memory.replaceChildren(
      h("p", { class: "session-memory-count", text: memoryState }),
      ...(preview.length ? [h("ul", { class: "session-memory-preview" }, preview)] : []),
      h("p", { class: "rail-description", text: this.#memory ? "Review notes for missing details. Originals stay saved." : "Important facts and corrections carry into later replies." }));
    const files = conversationFiles(snapshot);
    panels.documents.disabled = !files.length;
    const previousFiles = this.#filesSnapshot;
    const sameFiles = previousFiles?.chatId === snapshot.chatId && previousFiles.files.length === files.length
      && files.every((item, index) => {
        const previous = previousFiles.files[index];
        return item.key === previous.key && item.name === previous.name && item.detail === previous.detail
          && item.file === previous.file && item.source === previous.source;
      });
    if (!sameFiles) {
      this.#filesSnapshot = { chatId: snapshot.chatId, files };
      panels.files.replaceChildren(
        files.length ? h("div", { class: "session-file-list" }, files.slice(0, 3).map(item => this.#fileButton(item))) : h("p", { class: "session-empty", text: "No documents attached. Add files beside the message box." }),
        ...(files.length > 3 ? [h("p", { class: "session-context-caption", text: `${files.length.toLocaleString()} documents and pictures` })] : []));
    }
  }

  #fileButton(item) {
    return h("button", { class: "session-file", type: "button", disabled: Boolean(item.file?.reading), title: item.source ? "Download the full saved original" : `View ${item.name}`, onclick: () => this.#openFile(item) },
      icon(item.file?.data ? "image" : "file"), h("span", { class: "session-file-label" }, h("strong", { text: item.name }), h("small", { text: item.detail })));
  }

  async #openFile(item) {
    this.close({ restoreFocus: false });
    if (!item.source) { viewFile(item.file); return; }
    try {
      const { blob, filename } = await api.longInputSource(item.source.chat_id, item.source.id);
      downloadBlob(blob, filename);
    } catch (error) { toast(`Couldn't download the full input: ${error.message}`, { tone: "err" }); }
  }

  openDocuments() {
    this.close({ restoreFocus: false });
    const files = conversationFiles(this.snapshot());
    this.#dialog("Documents in this chat", files.length
      ? h("div", { class: "session-document-list" }, files.map(item => this.#fileButton(item)))
      : h("p", { class: "session-empty", text: "No documents are attached to this chat. Use Attach beside the message box to add text, code, PDFs or pictures." }));
  }

  openMemory() {
    if (!this.#memory) return;
    this.close({ restoreFocus: false });
    this.#dialog("Saved session memory", h("div", {},
      h("p", { class: "rail-description", text: `${this.#memory.covered_count.toLocaleString()} earlier messages summarized. Original messages remain in the chat. Later explicit corrections supersede earlier statements.` }),
      h("pre", { class: "session-memory-text", tabindex: "0", text: this.#memory.summary })));
  }

  #dialog(title, body) {
    const previous = document.activeElement;
    const close = h("button", { class: "icon-button", type: "button", "aria-label": `Close ${title.toLowerCase()}` }, icon("close"));
    const dialog = h("dialog", { class: "dialog session-memory-dialog", "aria-label": title },
      h("div", { class: "session-memory-head" }, h("h2", { text: title }), close), h("div", { class: "session-memory-body" }, body));
    close.addEventListener("click", () => dialog.close());
    dialog.addEventListener("close", () => { dialog.remove(); if (!document.querySelector("dialog[open]") && previous?.isConnected) previous.focus({ preventScroll: true }); });
    document.body.append(dialog); dialog.showModal(); close.focus();
  }
}
