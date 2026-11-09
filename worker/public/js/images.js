// The Images page: describe a picture, pick its shape and speed, and the notebook makes it with
// Qwen-Image 2.1 on the GPU. Pictures appear at the top of the gallery as soon as they're queued,
// count their steps while they're made, and open full size in a viewer that grows out of the tile.
//
// The chat model and the image model take turns on the GPUs. The strip above the composer says
// which one has them; the first picture switches them over, and "Switch back to chat" returns them.

import { ApiError, api } from "./api.js";
import { copyText } from "./clipboard.js";
import { confirmDialog } from "./dialogs.js";
import { h, icon, isTouch } from "./dom.js";
import { dragToDismiss, reducedMotion } from "./motion.js";
import { closePopover, openPopover } from "./popover.js";
import { toast } from "./toast.js";

export const ASPECTS = [
  { id: "square", label: "Square", w: 1, h: 1 },
  { id: "portrait", label: "Portrait", w: 2, h: 3 },
  { id: "landscape", label: "Landscape", w: 3, h: 2 },
  { id: "tall", label: "Tall", w: 9, h: 16 },
  { id: "wide", label: "Wide", w: 16, h: 9 },
];
const SPEEDS = {
  fast: { label: "Fast", note: "8 steps with the Turbo LoRA. About a quarter of the time." },
  quality: { label: "Quality", note: "25 steps, and follows \"Avoid\". Best detail." },
};
const ACTIVE_POLL_MS = 2_000;
const QUIET_POLL_MS = 15_000;
const PREFS_KEY = "qwen.images.v1";

function loadPrefs() {
  try {
    const saved = JSON.parse(localStorage.getItem(PREFS_KEY) ?? "{}");
    return {
      aspect: ASPECTS.some((a) => a.id === saved.aspect) ? saved.aspect : "square",
      speed: SPEEDS[saved.speed] ? saved.speed : "fast",
      negative: typeof saved.negative === "string" ? saved.negative : "",
    };
  } catch {
    return { aspect: "square", speed: "fast", negative: "" };
  }
}

const isActive = (image) => image.status === "queued" || image.status === "running";

function duration(image) {
  if (!image.started_at || !image.finished_at) return null;
  const s = Math.round((Date.parse(image.finished_at) - Date.parse(image.started_at)) / 1000);
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, "0")} s`;
}

/** A small outline of the shape, so the picker reads at a glance. */
function aspectGlyph({ w, h: height }) {
  const glyph = h("span", { class: "aspect-glyph", "aria-hidden": "true" });
  const scale = 14 / Math.max(w, height);
  glyph.style.width = `${Math.max(6, Math.round(w * scale))}px`;
  glyph.style.height = `${Math.max(6, Math.round(height * scale))}px`;
  return glyph;
}

export class ImagesView {
  /** @param {{ root: HTMLElement, status: import("./server-status.js").ServerStatus, onCountChange: (n: number) => void }} o */
  constructor({ root, status, onCountChange }) {
    this.root = root;
    this.status = status;
    this.onCountChange = onCountChange;
    this.images = [];
    this.hasMore = false;
    this.visible = false;
    this.prefs = loadPrefs();
    this.timer = null;
    this.loading = null;
    this.tiles = new Map();
    this.#build();
    status.addEventListener("change", () => this.visible && this.#renderStrip());
  }

  // ---------------------------------------------------------------- lifecycle

  show() {
    this.visible = true;
    this.root.hidden = false;
    this.#renderStrip();
    this.refresh();
    if (!isTouch()) this.prompt.focus({ preventScroll: true });
  }

  hide() {
    this.visible = false;
    this.root.hidden = true;
    clearTimeout(this.timer);
    this.closeViewer?.();
  }

  async refresh() {
    if (this.loading) return this.loading;
    this.loading = (async () => {
      try {
        const { images, has_more } = await api.images();
        // Keep the older pages already loaded; replace the newest page.
        const oldest = images[images.length - 1]?.created_at;
        const older = oldest ? this.images.filter((i) => i.created_at < oldest) : [];
        this.images = [...images, ...older];
        this.hasMore = older.length ? this.hasMore : has_more;
        this.#renderGallery();
      } catch (err) {
        if (!(err instanceof ApiError && err.status === 0)) console.warn("couldn't load pictures", err);
      } finally {
        this.loading = null;
        this.#schedule();
      }
    })();
    return this.loading;
  }

  #schedule() {
    clearTimeout(this.timer);
    if (!this.visible) return;
    const wait = this.images.some(isActive) ? ACTIVE_POLL_MS : QUIET_POLL_MS;
    this.timer = setTimeout(() => (document.visibilityState === "visible" ? this.refresh() : this.#schedule()), wait);
  }

  // ---------------------------------------------------------------- building the page

  #build() {
    this.gallery = h("div", { class: "gallery", role: "list", "aria-label": "Pictures" });
    this.empty = h(
      "div",
      { class: "gallery-empty" },
      h("p", { class: "empty-kicker" }, h("span", { class: "empty-kicker-dot", "aria-hidden": "true" }), "Qwen-Image 2.1 · on your GPU"),
      h("h2", { class: "gallery-empty-title", text: "Images" }),
      h("p", { class: "gallery-empty-text", text: "Describe a picture below. Full sentences work best: what's in it, where, the light, the kind of shot. Pictures are kept here and on every device you use." }),
    );
    this.more = h("button", { class: "button gallery-more", type: "button", text: "Show older pictures", hidden: true, onclick: () => this.#loadOlder() });
    this.scroller = h("div", { class: "gallery-scroll" }, h("div", { class: "gallery-inner" }, this.empty, this.gallery, this.more));

    this.strip = h("div", { class: "mode-strip", role: "status", "aria-live": "polite" });

    this.prompt = h("textarea", { class: "prompt", id: "image-prompt", rows: "1", placeholder: "Describe a picture", enterkeyhint: "send", maxlength: "2000" });
    this.prompt.addEventListener("input", () => this.#autosize());
    this.prompt.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.shiftKey && !event.isComposing && !isTouch()) {
        event.preventDefault();
        this.form.requestSubmit();
      }
    });

    this.aspectButtons = ASPECTS.map((aspect) =>
      h(
        "button",
        {
          class: "aspect",
          type: "button",
          role: "radio",
          title: aspect.label,
          "aria-label": aspect.label,
          dataset: { aspect: aspect.id },
          onclick: () => this.#setPref("aspect", aspect.id),
        },
        aspectGlyph(aspect),
        h("span", { class: "aspect-label", text: aspect.label }),
      ),
    );
    this.speedButton = h("button", { class: "attach chip-button", type: "button", "aria-haspopup": "menu", onclick: () => this.#openSpeed() });
    this.avoidButton = h("button", { class: "attach chip-button", type: "button", "aria-haspopup": "dialog", onclick: () => this.#openAvoid() });
    this.send = h("button", { class: "send", type: "submit", "aria-label": "Make the picture", title: "Make the picture (Enter)" }, icon("send"));
    this.form = h(
      "form",
      { class: "composer image-composer", autocomplete: "off" },
      h("label", { class: "sr-only", for: "image-prompt", text: "Describe a picture" }),
      this.prompt,
      h(
        "div",
        { class: "composer-bar" },
        h("div", { class: "aspects", role: "radiogroup", "aria-label": "Shape" }, this.aspectButtons),
        this.speedButton,
        this.avoidButton,
        h("span", { class: "composer-spacer" }),
        this.send,
      ),
    );
    this.form.addEventListener("submit", (event) => {
      event.preventDefault();
      this.#create();
    });

    this.root.replaceChildren(this.scroller, h("div", { class: "image-dock" }, this.strip, this.form));
    this.#renderControls();
  }

  #autosize() {
    this.prompt.style.height = "auto";
    this.prompt.style.height = `${Math.min(this.prompt.scrollHeight, 220)}px`;
  }

  #setPref(key, value) {
    this.prefs[key] = value;
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify(this.prefs));
    } catch {
      // private window: fine for this visit
    }
    this.#renderControls();
  }

  #renderControls() {
    for (const button of this.aspectButtons) button.setAttribute("aria-checked", String(button.dataset.aspect === this.prefs.aspect));
    this.speedButton.replaceChildren(icon(this.prefs.speed === "fast" ? "spark" : "think"), h("span", { class: "attach-label", text: SPEEDS[this.prefs.speed].label }), icon("chevron", "icon icon-small"));
    this.speedButton.title = SPEEDS[this.prefs.speed].note;
    const avoiding = this.prefs.negative.trim();
    this.avoidButton.replaceChildren(icon("settings"), h("span", { class: "attach-label", text: "Avoid" }), ...(avoiding ? [h("span", { class: "chip-dot", "aria-hidden": "true" })] : []));
    this.avoidButton.classList.toggle("is-on", Boolean(avoiding));
    this.avoidButton.title = avoiding ? `Avoid: ${avoiding}` : "Things to keep out of the picture";
  }

  #openSpeed() {
    const items = Object.entries(SPEEDS).map(([id, speed]) =>
      h(
        "button",
        {
          class: "menu-item effort-item",
          type: "button",
          role: "menuitemradio",
          "aria-checked": String(this.prefs.speed === id),
          onclick: () => {
            this.#setPref("speed", id);
            closePopover();
          },
        },
        h("span", { class: "effort-check", "aria-hidden": "true" }, icon("check")),
        h("span", { class: "effort-text" }, h("span", { class: "effort-name", text: speed.label }), h("span", { class: "effort-note", text: speed.note })),
      ),
    );
    openPopover(this.speedButton, h("div", { class: "menu", role: "menu", "aria-label": "Speed" }, items), { align: "start", label: "Speed" });
  }

  #openAvoid() {
    const field = h("textarea", { class: "field-input avoid-input", rows: "3", maxlength: "1000", placeholder: "For example: blurry, extra fingers, text, watermark" });
    field.value = this.prefs.negative;
    const save = () => this.#setPref("negative", field.value);
    field.addEventListener("input", save);
    const content = h(
      "div",
      { class: "avoid-panel" },
      h("label", { class: "avoid-title", text: "Avoid" }),
      h("p", { class: "avoid-note", text: "Things to keep out of the picture. Only Quality uses this; Fast ignores it." }),
      field,
      h("button", { class: "button", type: "button", text: "Clear", onclick: () => { field.value = ""; save(); field.focus(); } }),
    );
    openPopover(this.avoidButton, content, { align: "start", label: "Avoid" });
    requestAnimationFrame(() => field.focus());
  }

  // ---------------------------------------------------------------- making pictures

  async #create() {
    const prompt = this.prompt.value.trim();
    if (!prompt) {
      this.prompt.focus();
      return;
    }
    this.send.disabled = true;
    try {
      const { image } = await api.createImage({ prompt, negative: this.prefs.negative, aspect: this.prefs.aspect, speed: this.prefs.speed });
      this.images = [image, ...this.images];
      this.prompt.value = "";
      this.#autosize();
      this.#renderGallery();
      this.scroller.scrollTo({ top: 0, behavior: reducedMotion() ? "auto" : "smooth" });
      this.status.refresh();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : "Couldn't queue the picture. Check your connection.", { tone: "err" });
    } finally {
      this.send.disabled = false;
    }
  }

  async #remove(image, { confirm = true } = {}) {
    if (confirm) {
      const ok = await confirmDialog({
        title: "Delete this picture?",
        message: isActive(image) ? "It's still being made; the GPU stops working on it." : "It's removed from every device.",
        confirmLabel: "Delete",
        danger: true,
      });
      if (!ok) return false;
    }
    try {
      await api.deleteImage(image.id);
      this.images = this.images.filter((i) => i.id !== image.id);
      this.#renderGallery();
      return true;
    } catch (err) {
      toast(`Couldn't delete it: ${err.message}`, { tone: "err" });
      return false;
    }
  }

  #again(image) {
    this.prompt.value = image.prompt;
    this.prefs.negative = image.negative ?? "";
    this.#setPref("aspect", image.aspect);
    this.#setPref("speed", image.speed);
    this.#autosize();
    this.prompt.focus();
  }

  async #loadOlder() {
    const last = this.images[this.images.length - 1];
    if (!last) return;
    this.more.disabled = true;
    try {
      const { images, has_more } = await api.images(last.created_at);
      this.images = [...this.images, ...images.filter((i) => !this.images.some((j) => j.id === i.id))];
      this.hasMore = has_more;
      this.#renderGallery();
    } catch (err) {
      toast(`Couldn't load more: ${err.message}`, { tone: "err" });
    } finally {
      this.more.disabled = false;
    }
  }

  // ---------------------------------------------------------------- the gallery

  #renderGallery() {
    this.empty.hidden = this.images.length > 0;
    this.more.hidden = !this.hasMore;
    const keep = new Set();
    let previous = null;
    for (const image of this.images) {
      keep.add(image.id);
      const key = `${image.status}:${image.step}:${image.has_thumb}`;
      let tile = this.tiles.get(image.id);
      if (!tile || tile.dataset.key !== key) {
        const next = this.#tile(image);
        next.dataset.key = key;
        if (tile) tile.replaceWith(next);
        tile = next;
        this.tiles.set(image.id, tile);
      }
      // Keep DOM order equal to the list order without touching tiles already in place.
      const expected = previous ? previous.nextSibling : this.gallery.firstChild;
      if (expected !== tile) this.gallery.insertBefore(tile, expected);
      previous = tile;
    }
    for (const [id, tile] of this.tiles) {
      if (!keep.has(id)) {
        tile.remove();
        this.tiles.delete(id);
      }
    }
    this.onCountChange(this.images.length);
  }

  #tile(image) {
    const tile = h("figure", { class: "pic", role: "listitem", dataset: { status: image.status } });
    tile.style.aspectRatio = `${image.width} / ${image.height}`;
    if (image.status === "done") {
      const img = h("img", { class: "pic-img", src: api.imageUrl(image.id, "thumb"), alt: image.prompt, loading: "lazy", decoding: "async", draggable: "false" });
      img.addEventListener("load", () => tile.classList.add("is-loaded"), { once: true });
      const open = h("button", { class: "pic-open", type: "button", "aria-label": `Open: ${image.prompt}`, onclick: () => this.#openViewer(image.id) }, img);
      tile.append(open, h("figcaption", { class: "pic-caption", text: image.prompt }));
      return tile;
    }
    if (image.status === "failed") {
      tile.append(
        h(
          "div",
          { class: "pic-state" },
          h("span", { class: "pic-state-icon", "aria-hidden": "true" }, icon("alert")),
          h("p", { class: "pic-state-title", text: "Couldn't make this one" }),
          h("p", { class: "pic-state-text", text: image.error || "Something went wrong on the server." }),
          h(
            "div",
            { class: "pic-actions" },
            h("button", { class: "button", type: "button", text: "Try again", onclick: async () => { this.#again(image); if (await this.#remove(image, { confirm: false })) this.form.requestSubmit(); } }),
            h("button", { class: "button button-quiet", type: "button", text: "Delete", onclick: () => this.#remove(image, { confirm: false }) }),
          ),
        ),
      );
      return tile;
    }
    const running = image.status === "running";
    const fraction = running && image.steps ? Math.min(1, image.step / image.steps) : 0;
    const ring = h("span", { class: "pic-ring", "aria-hidden": "true" });
    ring.style.setProperty("--progress", String(fraction));
    const mode = this.status.status?.mode;
    const waitingNote = mode?.current === "images" && mode.state === "ready" ? "Next in line" : "Waits for the GPUs to switch";
    tile.append(
      h(
        "div",
        { class: "pic-state", "aria-live": "off" },
        ring,
        h("p", { class: "pic-state-title", text: running ? (image.step > 0 ? `Step ${image.step} of ${image.steps}` : "Loading the model") : "Waiting" }),
        h("p", { class: "pic-state-text", text: running ? image.prompt : waitingNote }),
        h("button", { class: "pic-cancel", type: "button", "aria-label": "Cancel this picture", title: "Cancel", onclick: () => this.#remove(image, { confirm: false }) }, icon("close")),
      ),
      h("span", { class: "pic-bar", "aria-hidden": "true" }),
    );
    tile.querySelector(".pic-bar").style.setProperty("--progress", String(fraction));
    return tile;
  }

  // ---------------------------------------------------------------- the GPU strip

  #renderStrip() {
    const status = this.status.status;
    const mode = status?.mode;
    const server = status?.server;
    let tone = "neutral";
    let text = "";
    let action = null;
    let progress = null;
    if (!status || server === "unreachable") {
      text = "Checking the server…";
    } else if (server === "offline" || server === "unregistered") {
      tone = "err";
      text = "The server is off. Start it with the button at the top right, then make pictures.";
    } else if (!status.can_shut_down) {
      tone = "warn";
      text = "Pictures need the updated Kaggle or Colab runtime, which can switch its GPUs between chat and pictures.";
    } else if (mode?.state === "failed" && mode.current !== "images") {
      tone = "err";
      text = `Couldn't switch to pictures: ${mode.detail || "the notebook gave no reason"}.`;
    } else if (mode?.requested === "images" && (mode.current !== "images" || mode.state === "switching")) {
      tone = "info";
      text = mode.detail ? `Switching to pictures: ${mode.detail}` : "Switching to pictures. The chat model steps aside first.";
      progress = mode.percent;
    } else if (mode?.requested === "chat" && mode.current === "images") {
      tone = "info";
      text = mode.detail ? `Switching back to chat: ${mode.detail}` : "Switching back to chat…";
      progress = mode.percent;
    } else if (mode?.current === "images") {
      tone = "ok";
      text = "Pictures have the GPUs. Chat is paused.";
      action = h("button", { class: "button mode-action", type: "button", text: "Switch back to chat", onclick: (e) => this.#switchToChat(e.currentTarget) });
    } else {
      text = "Chat has the GPUs. Your first picture switches them over, which takes a minute or two; chat pauses until you switch back.";
    }
    this.strip.dataset.tone = tone;
    const bar = progress != null ? h("span", { class: "mode-progress", "aria-hidden": "true" }, h("span", { class: "mode-progress-fill" })) : null;
    if (bar) bar.firstChild.style.width = `${Math.max(4, progress)}%`;
    this.strip.replaceChildren(...[h("span", { class: "mode-dot", "aria-hidden": "true" }), h("span", { class: "mode-text", text }), bar, action].filter(Boolean));
    // Waiting tiles say whether they wait for the switch.
    if (this.images.some((i) => i.status === "queued")) {
      for (const image of this.images.filter((i) => i.status === "queued")) this.tiles.get(image.id)?.removeAttribute("data-key");
      this.#renderGallery();
    }
  }

  async #switchToChat(button) {
    button.disabled = true;
    try {
      await api.setMode("chat");
      await this.status.refresh();
    } catch (err) {
      toast(err.message, { tone: "err" });
      button.disabled = false;
    }
  }

  // ---------------------------------------------------------------- the viewer

  #openViewer(id) {
    const done = () => this.images.filter((i) => i.status === "done");
    let index = done().findIndex((i) => i.id === id);
    if (index < 0) return;
    const dialog = h("dialog", { class: "viewer", "aria-label": "Picture" });
    const img = h("img", { class: "viewer-img", alt: "" });
    const stage = h("div", { class: "viewer-stage" }, img);
    const prompt = h("p", { class: "viewer-prompt" });
    const meta = h("p", { class: "viewer-meta" });
    const download = h("a", { class: "button", download: "" }, icon("download"), h("span", { text: "Download" }));
    const copy = h("button", { class: "button", type: "button" }, icon("copy"), h("span", { text: "Copy prompt" }));
    const again = h("button", { class: "button", type: "button" }, icon("regenerate"), h("span", { text: "Use again" }));
    const remove = h("button", { class: "button button-danger", type: "button" }, icon("trash"), h("span", { text: "Delete" }));
    const prev = h("button", { class: "viewer-nav viewer-prev", type: "button", "aria-label": "Previous picture" }, icon("chevron"));
    const next = h("button", { class: "viewer-nav viewer-next", type: "button", "aria-label": "Next picture" }, icon("chevron"));
    const close = h("button", { class: "icon-button viewer-close", type: "button", "aria-label": "Close" }, icon("close"));
    const info = h("div", { class: "viewer-info" }, prompt, meta, h("div", { class: "viewer-actions" }, download, copy, again, remove));
    dialog.append(close, prev, stage, next, info);
    document.body.append(dialog);

    const show = (i) => {
      index = (i + done().length) % done().length;
      const image = done()[index];
      // The preview first (it's cached), then the full picture over it.
      img.src = api.imageUrl(image.id, "thumb");
      const full = new Image();
      full.onload = () => image.id === done()[index]?.id && (img.src = full.src);
      full.src = api.imageUrl(image.id);
      img.alt = image.prompt;
      prompt.textContent = image.prompt;
      const took = duration(image);
      meta.textContent = [`${image.width} × ${image.height}`, SPEEDS[image.speed]?.label, `seed ${image.seed}`, took && `made in ${took}`].filter(Boolean).join(" · ");
      download.href = api.imageUrl(image.id);
      download.download = `qwen-image-${image.id}.png`;
      prev.hidden = next.hidden = done().length < 2;
    };
    const current = () => done()[index];
    const tileRect = () => this.tiles.get(current()?.id)?.getBoundingClientRect();

    const finish = () => {
      dialog.close();
      dialog.remove();
      if (this.closeViewer === leave) this.closeViewer = null;
      this.tiles.get(current()?.id)?.querySelector(".pic-open")?.focus({ preventScroll: true });
    };
    const leave = () => {
      if (dialog.classList.contains("is-closing")) return;
      dialog.classList.add("is-closing");
      const from = img.getBoundingClientRect();
      const to = tileRect();
      if (reducedMotion() || !to || !from.width) {
        dialog.animate({ opacity: [1, 0] }, { duration: 140, easing: "ease-out" }).finished.then(finish, finish);
        return;
      }
      // Back into the tile it came from: the same path in reverse.
      dialog.animate({ backgroundColor: ["var(--viewer-scrim)", "transparent"] }, { duration: 260, easing: "ease-out", fill: "forwards" });
      info.animate({ opacity: [1, 0] }, { duration: 120, fill: "forwards" });
      img.animate({ transform: ["none", flip(from, to)] }, { duration: 300, easing: "cubic-bezier(0.32, 0.72, 0, 1)", fill: "forwards" }).finished.then(finish, finish);
    };

    copy.onclick = async () => {
      await copyText(current().prompt);
      toast("Prompt copied", { tone: "ok" });
    };
    again.onclick = () => {
      this.#again(current());
      leave();
    };
    remove.onclick = async () => {
      const image = current();
      if (!(await this.#remove(image))) return;
      if (!done().length) leave();
      else show(index);
    };
    prev.onclick = () => show(index - 1);
    next.onclick = () => show(index + 1);
    close.onclick = leave;
    dialog.addEventListener("cancel", (event) => {
      event.preventDefault();
      leave();
    });
    dialog.addEventListener("click", (event) => {
      if (event.target === dialog || event.target === stage) leave();
    });
    dialog.addEventListener("keydown", (event) => {
      if (event.key === "ArrowLeft") show(index - 1);
      if (event.key === "ArrowRight") show(index + 1);
    });
    dragToDismiss(stage, { axis: "y", direction: 1, threshold: 0.25, onDismiss: leave, enabled: () => isTouch() });
    this.closeViewer = leave;

    show(index);
    dialog.showModal();
    // Grows out of the tile that was clicked (Apple's rule: things leave the way they came).
    const to = tileRect();
    if (!reducedMotion() && to) {
      requestAnimationFrame(() => {
        const from = img.getBoundingClientRect();
        if (!from.width) return;
        img.animate({ transform: [flip(from, to), "none"] }, { duration: 340, easing: "cubic-bezier(0.32, 0.72, 0, 1)" });
        dialog.animate({ backgroundColor: ["transparent", "var(--viewer-scrim)"] }, { duration: 260, easing: "ease-out" });
        info.animate({ opacity: [0, 1], transform: ["translateY(8px)", "none"] }, { duration: 260, delay: 120, easing: "ease-out", fill: "backwards" });
      });
    }
  }
}

/** The transform that puts a box at `from` over the box at `to`. */
function flip(from, to) {
  const scale = Math.min(to.width / from.width, to.height / from.height);
  const dx = to.left + to.width / 2 - (from.left + from.width / 2);
  const dy = to.top + to.height / 2 - (from.top + from.height / 2);
  return `translate(${dx}px, ${dy}px) scale(${scale})`;
}
