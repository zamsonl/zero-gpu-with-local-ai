// Keeps /v1/status fresh and turns it into what the page shows.
//
// Polling: every 15 s while the model is ready, every 5 s otherwise (offline, loading, busy), and
// right away when the window regains focus. A hidden tab skips its polls and catches up when shown.
//
// A "wait" starts when the server is seen offline and lasts until it is ready again. It drives the
// banner's elapsed time and its stages (offline → server up, loading the model → ready); the
// "Connected" toast fires when a wait ends.

import { api } from "./api.js";

const READY_POLL_MS = 15_000;
const WAITING_POLL_MS = 5_000;
const REQUEST_TIMEOUT_MS = 15_000;

/** Stages of a wait, in order. */
export const STAGES = ["offline", "loading", "ready"];

export class ServerStatus extends EventTarget {
  /** The last /v1/status body, or `{ server: "unreachable" }` when the relay itself can't be reached. */
  status = null;
  /** `{ startedAt, stage }` while waiting for the server to come up, else null. */
  wait = null;
  /** Set by the app while this page generates, so its own lock doesn't read as another device. */
  ownGeneration = null;

  #timer = null;
  #inflight = null;

  start() {
    window.addEventListener("focus", () => this.refresh());
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") this.refresh();
    });
    return this.refresh();
  }

  /** Fetches the status now (joining a fetch already in flight) and schedules the next poll. */
  refresh() {
    this.#inflight ??= this.#fetch().finally(() => {
      this.#inflight = null;
      this.#schedule();
    });
    return this.#inflight;
  }

  /** Restarts the wait's clock, e.g. when the user has just opened the notebook to start it. */
  restartWait() {
    if (!this.wait) return;
    this.wait.startedAt = Date.now();
    this.#emit();
  }

  /** The device holding the generation lock, unless that is this page. */
  get busyElsewhere() {
    const busy = this.status?.busy;
    if (!busy) return null;
    const own = this.ownGeneration;
    if (own && own.chatId === busy.chat_id && (own.active || Date.now() - own.endedAt < 10_000)) return null;
    return busy;
  }

  async #fetch() {
    let next;
    try {
      next = await api.status(AbortSignal.timeout(REQUEST_TIMEOUT_MS));
    } catch (err) {
      next = { server: "unreachable", error: err };
    }
    const connected = this.#track(next.server);
    this.status = next;
    this.#emit();
    if (connected) this.dispatchEvent(new Event("connected"));
  }

  /** Advances the wait for a new server state; true when this observation ends a wait. */
  #track(server) {
    // A notebook reconnecting its tunnel is waited for too: "Connected" says when it is back.
    if (server === "offline" || server === "unregistered" || server === "reconnecting") {
      this.wait ??= { startedAt: Date.now(), stage: "offline" };
      this.wait.stage = "offline";
    } else if (server === "idle" && this.wait) {
      this.wait.stage = "loading";
    } else if (server === "ready" && this.wait) {
      this.wait = null;
      return true;
    }
    return false;
  }

  #schedule() {
    clearTimeout(this.#timer);
    // A switch between chat and pictures reports its progress, so follow it closely.
    const mode = this.status?.mode;
    const switching = mode && (mode.requested !== mode.current || mode.state === "switching");
    const settled = this.status?.server === "ready" && !this.status.busy && !switching;
    this.#timer = setTimeout(() => {
      if (document.visibilityState === "visible") this.refresh();
      else this.#schedule();
    }, settled ? READY_POLL_MS : WAITING_POLL_MS);
  }

  #emit() {
    this.dispatchEvent(new Event("change"));
  }
}

/** What a starting notebook is doing, as the page says it. */
export const BOOT_STEPS = {
  queued: "Waiting for Kaggle to assign two GPUs",
  installing: "Preparing the runtime",
  downloading: "Downloading the model",
  loading: "Loading the model onto the GPUs",
  connecting: "Connecting to this page",
  failed: "The notebook stopped with a problem",
};

/** A notebook start-up worth showing: reported recently and the server isn't serving yet. */
export function activeBoot(status) {
  const boot = status?.boot;
  if (!boot || status.server === "ready" || status.server === "reconnecting") return null;
  return boot;
}

const KAGGLE_RUN_STATES = { COMPLETE: "the run finished", ERROR: "the run failed", CANCEL_REQUESTED: "the run was cancelled", CANCEL_ACKNOWLEDGED: "the run was cancelled", CANCELED: "the run was cancelled", CANCELLED: "the run was cancelled" };

/** "45 minutes", "1 hour", "3 h 20 min". */
function duration(minutes) {
  if (minutes < 60) return `${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} h ${rest} min` : `${hours} ${hours === 1 ? "hour" : "hours"}`;
}

/**
 * Why the last server stopped (status.last_stop), in plain words: `{ title, short }` — a sentence
 * for the banner and the status panel, and a few words for the status pill — or null when the
 * reason isn't known.
 */
export function describeStop(stop) {
  if (!stop?.reason) return null;
  const detail = typeof stop.detail === "string" && stop.detail.trim() ? stop.detail.trim().replace(/[.\s]+$/, "") : "";
  const ran = Number.isFinite(stop.uptime_s) && stop.uptime_s >= 60 ? ` It had run for ${duration(Math.round(stop.uptime_s / 60))}.` : "";
  switch (stop.reason) {
    case "idle": {
      const minutes = Number.isInteger(stop.idle_minutes) ? stop.idle_minutes : Number(/(\d+)\s*minutes?/.exec(detail)?.[1]);
      return { title: Number.isFinite(minutes) && minutes > 0 ? `The server shut down after ${duration(minutes)} unused.` : "The server shut down after a while unused.", short: "shut down when idle" };
    }
    case "requested":
      return { title: "The website asked it to stop.", short: "stopped from this site" };
    case "replaced":
      return { title: "Another server took over from it.", short: "replaced" };
    case "runtime_limit":
      return { title: `Kaggle's 12-hour limit was reached.${ran}`, short: "12-hour limit" };
    case "tunnel_failed":
      return { title: `The notebook lost its tunnel and could not reconnect.${ran}`, short: "tunnel lost" };
    case "crashed":
      return { title: `The notebook crashed${detail ? `: ${detail}` : ""}.`, short: "crashed" };
    case "terminated":
      return { title: `${detail || "The notebook was stopped"}.`, short: "stopped" };
    case "kaggle_ended": {
      const what = KAGGLE_RUN_STATES[stop.status] ?? (stop.status ? `status ${String(stop.status).toLowerCase()}` : "");
      const words = [what, detail].filter(Boolean).join(": ");
      return { title: `Kaggle stopped the notebook${words ? `: ${words}` : ""}.`, short: "stopped by Kaggle" };
    }
    case "start_failed":
      return { title: `It stopped while starting${detail ? `: ${detail}` : ""}.`, short: "failed to start" };
  }
  return null;
}

/**
 * What the status pill says: `tone` (ok, warn, err, info, neutral), a short `label`, an optional
 * longer `detail` shown where there is room, and the `summary` used in the status panel.
 */
export function describe(status, busyElsewhere) {
  const boot = activeBoot(status);
  if (boot && boot.stage !== "failed") {
    const progress = boot.percent != null ? `${boot.percent}%` : "";
    return {
      tone: "info",
      label: "Starting",
      detail: [BOOT_STEPS[boot.stage]?.toLowerCase(), progress].filter(Boolean).join(" "),
      summary: `The ${boot.host === "kaggle" ? "Kaggle" : "Colab"} notebook is starting: ${BOOT_STEPS[boot.stage]?.toLowerCase() ?? boot.stage}${progress ? ` (${progress})` : ""}. This page connects by itself when it's done.`,
    };
  }
  if (status?.shutting_down && ["ready", "idle"].includes(status.server)) {
    return { tone: "warn", label: "Shutting down", detail: "", summary: "The notebook was asked to shut down and stops within a minute." };
  }
  switch (status?.server) {
    case undefined:
      return { tone: "neutral", label: "Checking", detail: "", summary: "Checking the server…" };
    case "unreachable":
      return {
        tone: "err",
        label: "No connection",
        detail: "",
        summary: "This page can't reach the relay. Check your internet connection; it retries every 5 seconds.",
      };
    case "reconnecting":
      return {
        tone: "warn",
        label: "Reconnecting",
        detail: "to the notebook",
        summary: "Reconnecting to the notebook… It is still running (it checked in moments ago), but its tunnel isn't answering. It replaces the tunnel by itself; don't start another one.",
      };
    case "unregistered":
    case "offline": {
      const stop = describeStop(status.last_stop);
      return {
        tone: "err",
        label: "Offline",
        detail: stop?.short ?? "",
        summary: stop
          ? `${stop.title} Start it again when you need it.`
          : status.server === "unregistered"
            ? "No model server has connected yet. Start the Kaggle or Colab notebook."
            : "The notebook isn't running, or its tunnel dropped. Start it again.",
      };
    }
  }
  const mode = status.mode;
  if (mode?.state === "switching") {
    const to = mode.current === "images" ? "pictures" : "chat";
    return {
      tone: "info",
      label: "Switching",
      detail: `to ${to}`,
      summary: `The GPUs are switching to ${to}${mode.detail ? `: ${mode.detail.toLowerCase()}` : ""}. This takes a minute or two.`,
    };
  }
  if (status.server === "images") {
    return {
      tone: "info",
      label: "Making pictures",
      detail: "",
      summary: "Pictures have the GPUs, so chat is paused. Switch back from the Images page or above the message box.",
    };
  }
  if (busyElsewhere) {
    return {
      tone: "info",
      label: "Busy on another device",
      detail: "",
      summary: busyElsewhere.operation === "compact" ? "Another device is compacting earlier messages. Your full chat stays saved." : "Another device is generating a reply. You can send when it finishes.",
    };
  }
  if (status.server === "idle") {
    return {
      tone: "warn",
      label: "Model not loaded",
      detail: "first reply loads the model",
      summary: "The server is running but the model isn't in GPU memory. The next request loads it.",
    };
  }
  return { tone: "ok", label: "Ready", detail: "", summary: "The model is loaded and ready for requests." };
}
