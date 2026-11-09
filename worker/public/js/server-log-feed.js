// Poll while a log is visible. Stop and host changes discard in-flight responses; hidden tabs
// pause requests. A failed poll preserves the last log and retries automatically.
import { api } from "./api.js";
import { h } from "./dom.js";
import { timeAgo } from "./time.js";

export class ServerLogFeed {
  #active = false;
  #timer = null;
  #controller = null;
  #inflight = null;
  #visibility = () => {
    clearTimeout(this.#timer);
    if (document.visibilityState === "hidden") this.#controller?.abort();
    else this.refresh();
  };

  constructor(host, onChange) { this.host = host; this.onChange = onChange; this.result = null; }

  start() {
    if (this.#active) return;
    this.#active = true;
    document.addEventListener("visibilitychange", this.#visibility);
    return this.refresh();
  }

  stop() {
    this.#active = false;
    clearTimeout(this.#timer);
    this.#controller?.abort();
    document.removeEventListener("visibilitychange", this.#visibility);
  }

  refresh() {
    if (!this.#active || document.visibilityState === "hidden") return Promise.resolve();
    if (this.#inflight) return this.#inflight;
    clearTimeout(this.#timer);
    this.#inflight = this.#load().finally(() => {
      this.#inflight = null;
      if (this.#active && document.visibilityState !== "hidden") this.#timer = setTimeout(() => this.refresh(), 5000);
    });
    return this.#inflight;
  }

  async #load() {
    const controller = new AbortController();
    this.#controller = controller;
    const timeout = setTimeout(() => controller.abort(), 20000);
    try {
      const result = await api.serverLog(this.host, controller.signal);
      if (!this.#active || controller.signal.aborted) return;
      this.result = result;
      this.onChange({ result, error: null });
    } catch (error) {
      if (this.#active && document.visibilityState !== "hidden") this.onChange({ result: this.result, error });
    } finally {
      clearTimeout(timeout);
      if (this.#controller === controller) this.#controller = null;
    }
  }
}

/** The most recent operational messages, expanded by default during startup. */
export function createStartupLog(host, { notBefore = null } = {}) {
  const meta = h("span", { class: "startup-log-meta", text: "Connecting…", "aria-live": "polite" });
  const body = h("pre", { class: "startup-log-body", tabindex: "0", "aria-live": "off", text: "Waiting for the notebook's first log update…" });
  const element = h("details", { class: "startup-log", open: true }, h("summary", {}, "Live startup log", meta), body);
  const feed = new ServerLogFeed(host, ({ result, error }) => {
    if (error) { meta.textContent = "Reconnecting…"; return; }
    if (notBefore && result.started_at && Date.parse(result.started_at) < notBefore - 5000) {
      body.textContent = "Waiting for the new notebook session to send logs…";
      meta.textContent = "Waiting";
      return;
    }
    const follow = body.scrollHeight - body.scrollTop - body.clientHeight < 40;
    const text = result.log?.trim();
    const next = text ? text.split("\n").slice(-8).join("\n") : result.message || "Waiting for the notebook's first log update…";
    if (body.textContent !== next) body.textContent = next;
    meta.textContent = result.updated_at
      ? `${result.source === "kaggle" ? "Fetched" : "Updated"} ${timeAgo(result.updated_at)}`
      : "Waiting";
    if (follow) body.scrollTop = body.scrollHeight;
  });
  feed.start();
  return { element, stop: () => feed.stop() };
}
