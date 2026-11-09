// What the server status looks like on the page: the header pill (with a details panel), the Start
// button (it asks where: Kaggle, started from here, or Colab, opened in a new tab) or, once a server
// runs, the button that opens its notebook, and the banner above the composer that walks through
// starting it.

import { h, icon, isTouch } from "./dom.js";
import { closePopover, openPopover } from "./popover.js";
import { BOOT_STEPS, STAGES, activeBoot, describe } from "./server-status.js";
import { openServerLog } from "./server-log.js";
import { createStartupLog } from "./server-log-feed.js";
import { clock, timeAgo } from "./time.js";

// The host picked last on this device, offered first next time.
const LAST_HOST_KEY = "qwen.start-host";
const BANNER_DISMISSAL_KEY = "qwen.server-banner.dismissal";

function bannerDismissal() {
  try {
    const saved = JSON.parse(sessionStorage.getItem(BANNER_DISMISSAL_KEY) || "null");
    return saved?.version === 1 && saved.hidden === true
      ? { hidden: true, failureKey: typeof saved.failureKey === "string" ? saved.failureKey : null }
      : { hidden: false, failureKey: null };
  } catch {
    return { hidden: false, failureKey: null };
  }
}

function rememberBannerDismissal(hidden, failureKey = null) {
  try {
    if (hidden) sessionStorage.setItem(BANNER_DISMISSAL_KEY, JSON.stringify({ version: 1, hidden: true, failureKey }));
    else sessionStorage.removeItem(BANNER_DISMISSAL_KEY);
  } catch {
    // Storage may be blocked; the current view still respects the choice.
  }
}

function startupFailureKey(boot) {
  return boot?.stage === "failed" ? JSON.stringify([boot.host || "", boot.at || "", boot.detail || ""]) : null;
}

function lastHost() {
  try {
    return localStorage.getItem(LAST_HOST_KEY);
  } catch {
    return null;
  }
}

function rememberHost(host) {
  try {
    localStorage.setItem(LAST_HOST_KEY, host);
  } catch {
    // private window: it just isn't remembered
  }
}

const STAGE_LABELS = { offline: "Server offline", loading: "Loading the model", ready: "Ready" };
// These phases cover both cache reuse and download fallback. The active description below
// says "Downloading" only when the notebook actually reports a download.
const BOOT_SHORT = { queued: "Queued", installing: "Runtime", downloading: "Model files", loading: "Loading", connecting: "Connecting" };
const BOOT_ORDER = ["queued", "installing", "downloading", "loading", "connecting"];

/** How to start each host's notebook, in the words of its own interface. */
const HOSTS = {
  kaggle: {
    name: "Kaggle",
    start: () => "Open the notebook, click Edit, then Save Version → Save & Run All. It keeps running in the background for up to 12 hours, even with the tab closed. This page connects when the model is ready; startup progress appears here.",
  },
  colab: {
    name: "Colab",
    start: () => `Open the notebook and press ${isTouch() ? "Runtime → Run all" : "Ctrl+F9 (Runtime → Run all)"}. Keep the tab open. This page connects when the model is ready.`,
  },
};

export class StatusView {
  /** @param {import("./server-status.js").ServerStatus} status */
  constructor(status) {
    this.status = status;
    this.pill = document.getElementById("status-pill");
    this.label = document.getElementById("status-label");
    this.detail = document.getElementById("status-detail");
    this.colabLink = document.getElementById("colab-link");
    this.banner = document.getElementById("banner");
    this.urls = { colab: "https://colab.research.google.com/", kaggle: null };
    this.modelLabel = "Heretic Qwen";
    /** Set by the app: stops the reply another device is generating. */
    this.onStop = null;
    /** Set by the app: asks the running notebook to shut down. */
    this.onShutDown = null;
    /** Set by the app: starts the server on Kaggle. Resolves when the request is done. */
    this.onStart = null;
    this.starting = false;
    this.startupLog = null;
    this.startupLogKey = null;
    const dismissal = bannerDismissal();
    this.bannerDismissed = dismissal.hidden;
    this.dismissedFailureKey = dismissal.failureKey;
    /** Set by the app: closes Session when the user asks to show the startup card. */
    this.onShowBanner = null;
    this.bannerRestore = h("button", {
      class: "button server-status-restore", type: "button", text: "Show startup status", hidden: true,
      "aria-controls": "banner",
      onclick: () => { this.onShowBanner?.(); this.showBanner({ focus: true }); },
    });
    document.getElementById("server")?.append(this.bannerRestore);

    this.colabLink.prepend(icon("power", "icon start-icon"));
    this.colabLink.append(icon("external", "icon colab-icon"));
    this.colabLink.addEventListener("click", (event) => {
      // With no server running, the header button asks where to start one.
      if (this.colabLink.dataset.mode === "start") {
        event.preventDefault();
        this.#start(this.colabLink);
      } else {
        this.#revealForLaunch();
        this.status.restartWait();
      }
    });
    this.pill.addEventListener("click", () => this.#openPanel());
    status.addEventListener("change", () => this.render());
    setInterval(() => this.#tickBanner(), 1000);
  }

  /** Hide only startup guidance; chats, drafts and the Session controls stay intact. */
  dismissBanner() {
    const conversation = document.getElementById("conversation");
    const readingTop = conversation?.scrollTop;
    this.bannerDismissed = true;
    this.dismissedFailureKey = startupFailureKey(activeBoot(this.status.status));
    rememberBannerDismissal(true, this.dismissedFailureKey);
    this.render();
    if (conversation && Number.isFinite(readingTop)) conversation.scrollTop = readingTop;
    document.getElementById("session-toggle")?.focus({ preventScroll: true });
  }

  showBanner({ focus = false } = {}) {
    this.bannerDismissed = false;
    this.dismissedFailureKey = null;
    rememberBannerDismissal(false);
    this.render();
    if (focus) this.banner.querySelector(".banner-dismiss")?.focus({ preventScroll: true });
  }

  #revealForLaunch() {
    this.onShowBanner?.();
    this.showBanner();
  }

  #bannerHeading(title) {
    return h("div", { class: "banner-heading" },
      h("h2", { class: "banner-title", id: "banner-title", text: title }),
      h("button", {
        class: "banner-dismiss", type: "button", title: "Hide server status", "aria-label": "Hide server status",
        "aria-controls": "banner", onclick: () => this.dismissBanner(),
      }, icon("close")),
    );
  }

  /** Kaggle is preferred when its notebook URL is configured; Colab stays available as a fallback. */
  setLaunchUrls(urls) {
    this.#applyUrls(urls);
    // The label depends on the server too (Start, Starting…, Open): render works it out. Before
    // the first status there is nothing else to go on.
    if (this.status.status) this.render();
    else this.colabLink.querySelector(".colab-label").textContent = `Open ${HOSTS[this.#primaryHost()].name}`;
  }

  #applyUrls({ colab, kaggle }) {
    this.urls = { colab: colab || this.urls.colab, kaggle: kaggle || null };
    this.colabLink.href = this.#launchUrl(this.#primaryHost());
  }

  #primaryHost() {
    return this.urls.kaggle ? "kaggle" : "colab";
  }

  #launchUrl(host) {
    return host === "kaggle" ? this.urls.kaggle : this.urls.colab;
  }

  /** The server can be started from this page (Kaggle's API token is set up). */
  #canStart() {
    return Boolean(this.status.status?.can_start);
  }

  /** Asks where to start the server, in a small panel under `anchor`. */
  #start(anchor) {
    if (this.starting) return;
    const last = lastHost();
    const canKaggle = this.#canStart();
    const option = (host, title, meta, note, { disabled = false, onPick }) =>
      h(
        "button",
        { class: "host-option", type: "button", role: "menuitem", disabled: disabled || null, dataset: { host }, onclick: onPick },
        h("span", { class: "host-option-mark", "aria-hidden": "true" }, icon(host === "kaggle" ? "power" : "external")),
        h(
          "span",
          { class: "host-option-text" },
          h("span", { class: "host-option-title" }, title, last === host && !disabled ? h("span", { class: "host-option-badge", text: "Last used" }) : null),
          h("span", { class: "host-option-meta", text: meta }),
          h("span", { class: "host-option-note", text: note }),
        ),
      );
    const kaggle = option(
      "kaggle",
      "Kaggle",
      this.status.status?.host === "kaggle" && ["ready", "idle", "images"].includes(this.status.status?.server)
        ? `2 × T4 · ${this.status.status.num_ctx.toLocaleString()}-token window · pictures too`
        : "2 × T4 · context selected to fit the GPUs · pictures too",
      canKaggle
        ? "Starts from here and runs in the background for up to 12 hours, even with this page closed. Check Kaggle for your remaining GPU quota."
        : "Needs your Kaggle API token saved on the server.",
      { disabled: !canKaggle, onPick: () => this.#startKaggle() },
    );
    const colab = option(
      "colab",
      "Colab",
      this.status.status?.host === "colab" && ["ready", "idle", "images"].includes(this.status.status?.server)
        ? `Colab GPU · ${this.status.status.num_ctx.toLocaleString()}-token window · pictures too`
        : "Qwen 9B Q6_K · up to 32K context · pictures too",
      "Use the updated notebook for the smaller Qwen 9B model on a single GPU, with vision and Images mode. It measures context fit from 32K down to 8K while keeping Q6_K precision. Press Run all and keep Colab connected.",
      { onPick: () => this.#openColab() },
    );
    // The one used last comes first.
    const options = last === "colab" ? [colab, kaggle] : [kaggle, colab];
    const panel = h("div", { class: "host-chooser", role: "menu", "aria-label": "Start the server on" },
      h("p", { class: "host-chooser-title", text: "Start the server on" }), options,
      h("a", { class: "colab-notebook-download", role: "menuitem", href: "/notebooks/heretic-qwen-colab.ipynb", download: "heretic-qwen-colab.ipynb", text: "Download updated Colab notebook", onclick: () => closePopover({ restoreFocus: false }) }),
      h("p", { class: "host-option-note colab-notebook-help", text: "In Colab, choose File → Upload notebook once. Upload the updated download to replace an older chat-only notebook; it sends live startup and Images logs here." }),
    );
    openPopover(anchor, panel, { align: "end", className: "popover-panel host-popover", label: "Start the server", onKeydown: (event) => {
      const choices = [...panel.querySelectorAll('[role="menuitem"]:not([disabled])')];
      const index = choices.indexOf(document.activeElement);
      const target = { ArrowDown: choices[(index + 1) % choices.length], ArrowUp: choices[(index - 1 + choices.length) % choices.length], Home: choices[0], End: choices.at(-1) }[event.key];
      if (target) { event.preventDefault(); target.focus(); }
    } });
    requestAnimationFrame(() => panel.querySelector(".host-option:not([disabled])")?.focus());
  }

  #openColab() {
    closePopover({ restoreFocus: false });
    rememberHost("colab");
    this.#revealForLaunch();
    window.open(this.urls.colab, "_blank", "noopener");
    this.colabOpenedAt = Date.now();
    this.status.restartWait();
    this.render();
  }

  async #startKaggle() {
    if (this.starting || !this.onStart) return;
    rememberHost("kaggle");
    closePopover({ restoreFocus: false });
    this.#revealForLaunch();
    this.starting = true;
    this.render();
    try {
      await this.onStart();
    } finally {
      this.starting = false;
      this.render();
    }
  }

  #startButton(label = "Start server", { className = "" } = {}) {
    const button = h(
      "button",
      { class: `button button-primary ${className}`.trim(), type: "button", disabled: this.starting || null },
      icon("power"),
      h("span", { text: this.starting ? "Starting…" : label }),
    );
    button.addEventListener("click", () => this.#start(button));
    return button;
  }

  /** A quiet link that opens the selected notebook's log right here. */
  #logLink(text = "Show the full log", host) {
    return h("button", { class: "banner-alt", type: "button", text, onclick: () => openServerLog(host) });
  }

  #liveLog(host, notBefore = null) {
    const key = `${host}:${notBefore || ""}`;
    if (this.startupLogKey !== key) {
      this.#stopLog();
      this.startupLog = createStartupLog(host, { notBefore });
      this.startupLogKey = key;
    }
    return this.startupLog.element;
  }

  #stopLog() {
    this.startupLog?.stop();
    this.startupLog = null;
    this.startupLogKey = null;
  }

  #launchButton(host, { className = "" } = {}) {
    return h(
      "a",
      { class: `button button-primary ${className}`.trim(), href: this.#launchUrl(host), target: "_blank", rel: "noopener noreferrer", onclick: () => { this.#revealForLaunch(); this.status.restartWait(); } },
      h("span", { text: `Open ${HOSTS[host].name}` }),
      icon("external"),
    );
  }

  render() {
    const { status } = this.status;
    // The Kaggle link is set in Settings; every status carries the current one.
    if (status && "kaggle_url" in status && ((status.kaggle_url || null) !== this.urls.kaggle || (status.colab_url && status.colab_url !== this.urls.colab))) {
      this.#applyUrls({ colab: status.colab_url, kaggle: status.kaggle_url });
    }
    const info = describe(status, this.status.busyElsewhere);
    // When nothing else needs saying, the cell names the machine the model runs on.
    const machine = info.tone === "ok" ? { kaggle: "Kaggle 2×T4", colab: "Colab GPU" }[status.host] : null;
    const detail = info.detail || machine || "";
    this.pill.dataset.tone = info.tone;
    this.label.textContent = info.label;
    this.detail.textContent = detail;
    this.detail.hidden = !detail;
    this.pill.setAttribute("aria-label", `Server: ${info.label}${info.detail ? `, ${info.detail}` : ""}. Show details`);
    const down = ["offline", "unregistered"].includes(status?.server);
    const boot = activeBoot(status);
    const booting = boot && boot.stage !== "failed";
    const startMode = down && !booting;
    this.colabLink.dataset.mode = startMode ? "start" : "open";
    this.colabLink.querySelector(".colab-label").textContent =
      this.starting || booting ? "Starting…" : startMode ? "Start" : `Open ${HOSTS[this.#primaryHost()].name}`;
    this.colabLink.classList.toggle("is-urgent", down && !booting);
    this.colabLink.setAttribute("aria-disabled", this.starting ? "true" : "false");
    this.#renderBanner();
  }

  #renderBanner() {
    const server = this.status.status?.server;
    const wait = this.status.wait;
    const boot = activeBoot(this.status.status);
    const show = Boolean(boot) || server === "offline" || server === "unregistered" || (wait && server === "idle");
    const failureKey = startupFailureKey(boot);
    // A new real startup failure must surface, even if an older offline notice
    // was hidden. Dismissing that same failure survives polls and tab refreshes.
    if (this.bannerDismissed && failureKey && failureKey !== this.dismissedFailureKey) {
      this.bannerDismissed = false;
      this.dismissedFailureKey = null;
      rememberBannerDismissal(false);
    }
    const hidden = !show || this.bannerDismissed;
    this.banner.hidden = hidden;
    this.bannerRestore.hidden = !show || !this.bannerDismissed;
    if (hidden) {
      this.#stopLog();
      this.banner.replaceChildren();
      return;
    }
    if (boot) {
      this.#renderBoot(boot);
      return;
    }
    const stage = wait?.stage ?? "offline";
    // Colab was opened from here a moment ago: say what to do in that tab while this page waits.
    const colabWaiting = this.colabOpenedAt && Date.now() - this.colabOpenedAt < 15 * 60_000;
    if (!colabWaiting) this.#stopLog();
    const title =
      stage === "loading" ? "The server is up. Loading the model…" : colabWaiting ? "Waiting for the Colab notebook" : "The model server isn't running";
    const text =
      stage === "loading"
        ? "The notebook is starting the model. This page switches to Ready by itself."
        : colabWaiting
          ? HOSTS.colab.start()
          : "Start it on Kaggle or use the updated Colab notebook for chat, vision and pictures. Kaggle runs in the background; Colab needs enough GPU memory and its notebook kept connected. This page connects when Qwen is ready.";
    const open = h(
      "div",
      { class: "banner-actions" },
      this.#startButton(colabWaiting ? "Start somewhere else" : "Start server", { className: "banner-action" }),
      colabWaiting ? h("a", { class: "banner-alt", href: this.urls.colab, target: "_blank", rel: "noopener noreferrer", text: "Open Colab again" }) : null,
      colabWaiting ? this.#logLink("Show the full log", "colab") : null,
    );
    const steps = h(
      "ol",
      { class: "steps", "aria-label": "Progress" },
      STAGES.map((name) => {
        const index = STAGES.indexOf(name);
        const current = STAGES.indexOf(stage);
        const state = index < current ? "done" : index === current ? "current" : "todo";
        return h("li", { class: "step", dataset: { state }, "aria-current": state === "current" ? "step" : null }, h("span", { class: "step-dot", "aria-hidden": "true" }), STAGE_LABELS[name]);
      }),
    );
    this.banner.replaceChildren(
      h("div", { class: "banner-icon", "aria-hidden": "true" }, icon(stage === "loading" ? "think" : "alert")),
      h(
        "div",
        { class: "banner-body" },
        this.#bannerHeading(title),
        h("p", { class: "banner-text", text }),
        h("div", { class: "banner-meta" }, steps, h("span", { class: "banner-timer", "aria-live": "off" })),
        colabWaiting ? this.#liveLog("colab", this.colabOpenedAt) : null,
      ),
      stage === "loading" ? null : open,
    );
    this.#tickBanner();
  }

  /** A notebook is starting (or failed to): what it's doing, how far along, and what's next. */
  #renderBoot(boot) {
    const host = HOSTS[boot.host] ? boot.host : this.#primaryHost();
    const failed = boot.stage === "failed";
    const order = BOOT_ORDER;
    const current = order.indexOf(boot.stage);
    const steps = h(
      "ol",
      { class: "steps", "aria-label": "Progress" },
      order.map((name, index) => {
        const state = failed ? "todo" : index < current ? "done" : index === current ? "current" : "todo";
        return h("li", { class: "step", dataset: { state }, "aria-current": state === "current" ? "step" : null }, h("span", { class: "step-dot", "aria-hidden": "true" }), BOOT_SHORT[name]);
      }),
    );
    let bar = null;
    if (!failed && boot.percent != null) {
      const fill = h("span");
      // Set through the CSSOM: the page's CSP doesn't allow style attributes.
      fill.style.setProperty("--progress", `${boot.percent}%`);
      bar = h("div", { class: "boot-bar", role: "progressbar", "aria-valuemin": "0", "aria-valuemax": "100", "aria-valuenow": String(boot.percent), "aria-label": BOOT_STEPS[boot.stage] }, fill);
    }
    const title = failed ? `The ${HOSTS[host].name} notebook stopped` : `Starting on ${HOSTS[host].name}…`;
    const canStart = this.#canStart() && host === "kaggle";
    const heading = boot.stage === "installing" && boot.detail ? boot.detail : BOOT_STEPS[boot.stage];
    const step = `${heading}${boot.percent != null ? `: ${boot.percent}%` : ""}.`;
    const text = failed
      ? `${boot.detail || "It hit a problem while starting."} ${canStart ? "Its log is on Kaggle. Try again, or start it from Colab." : "Open the notebook to see its log, then run it again."}`
      : [step, boot.detail && boot.detail !== heading ? boot.detail : null].filter(Boolean).join(" ");
    let actions = null;
    if (failed) {
      actions = canStart
        ? h("div", { class: "banner-actions" }, this.#startButton("Try again", { className: "banner-action" }), this.#logLink("See the log", host))
        : h("div", { class: "banner-actions" }, this.#launchButton(host, { className: "banner-action" }), this.#logLink("See the log", host));
    } else {
      actions = h("div", { class: "banner-actions" }, this.#logLink("Show the full log", host));
    }
    this.banner.replaceChildren(
      h("div", { class: "banner-icon", "aria-hidden": "true" }, icon(failed ? "alert" : "think")),
      h(
        "div",
        { class: "banner-body" },
        this.#bannerHeading(title),
        h("p", { class: "banner-text", text }),
        !failed && host === "kaggle" ? h("p", { class: "banner-text", text: "Saved runtime and model files are reused when available. GPU loading can still take several minutes." }) : null,
        bar,
        h("div", { class: "banner-meta" }, steps, h("span", { class: "banner-timer", "aria-live": "off" })),
        this.#liveLog(host, host === "colab" ? this.colabOpenedAt || null : null),
      ),
      actions,
    );
    this.#tickBanner();
  }

  #tickBanner() {
    const timer = this.banner.querySelector(".banner-timer");
    if (!timer) return;
    const wait = this.status.wait;
    timer.textContent = wait ? `Waiting ${clock(Date.now() - wait.startedAt)}` : "";
  }

  #openPanel() {
    const { status } = this.status;
    const info = describe(status, this.status.busyElsewhere);
    const rows = [];
    rows.push(["Model", status?.quant ? `${this.modelLabel} · ${status.quant}` : this.modelLabel]);
    if (["ready", "idle", "images"].includes(status?.server) && status?.num_ctx) rows.push(["Context window", `${status.num_ctx.toLocaleString()} tokens${status.loaded_ctx && status.loaded_ctx !== status.num_ctx ? ` (loaded at ${status.loaded_ctx.toLocaleString()})` : ""}`]);
    if (status?.target_registered_at) rows.push(["Server", `${HOSTS[status.host]?.name ?? "Colab"}, connected ${timeAgo(status.target_registered_at)}`]);
    if (status?.target_registered_at) rows.push(["Pictures", status.vision ? "Can see pictures you attach" : "Text and PDFs only"]);
    if (status?.busy) rows.push([status.busy.operation === "compact" ? "Compacting since" : "Generating since", timeAgo(status.busy.since)]);

    const refresh = h("button", { class: "button", type: "button", text: "Check again" });
    const stop = this.status.busyElsewhere && this.onStop
      ? h("button", { class: "button button-danger", type: "button", text: status.busy?.operation === "compact" ? "Stop compaction" : "Stop the reply" })
      : null;
    const canShutDown = status?.can_shut_down && ["ready", "idle"].includes(status.server) && this.onShutDown;
    const shutDown = canShutDown
      ? h("button", { class: "button button-danger", type: "button", disabled: status.shutting_down || null }, icon("power"), h("span", { text: status.shutting_down ? "Shutting down…" : "Shut down" }))
      : null;
    shutDown?.addEventListener("click", () => {
      closePopover();
      this.onShutDown();
    });
    stop?.addEventListener("click", async () => {
      stop.disabled = true;
      stop.textContent = "Stopping…";
      await this.onStop();
      closePopover();
    });
    const log = h("button", { class: "button", type: "button" }, icon("monitor"), h("span", { text: "Server log" }));
    const colabNotebook = h("a", { class: "button", href: "/notebooks/heretic-qwen-colab.ipynb", download: "heretic-qwen-colab.ipynb", "aria-label": "Download updated Colab notebook" }, h("span", { text: "Colab notebook" }), icon("external"));
    log?.addEventListener("click", () => {
      closePopover({ restoreFocus: false });
      openServerLog(activeBoot(status)?.host || status?.host || lastHost() || this.#primaryHost());
    });
    const panel = h(
      "div",
      { class: "status-panel" },
      h("div", { class: "status-panel-head", dataset: { tone: info.tone } }, h("span", { class: "status-dot", "aria-hidden": "true" }), h("strong", { text: info.label })),
      h("p", { class: "status-panel-text", text: info.summary }),
      rows.length ? h("dl", { class: "status-facts" }, rows.flatMap(([k, v]) => [h("dt", { text: k }), h("dd", { text: v })])) : null,
      h(
        "div",
        { class: "status-panel-actions" },
        stop,
        shutDown,
        log,
        colabNotebook,
        refresh,
        canShutDown
          ? null
          : ["offline", "unregistered"].includes(status?.server) && !activeBoot(status)
            ? this.#startButton()
            : this.#launchButton(this.#primaryHost()),
      ),
    );
    refresh.addEventListener("click", async () => {
      refresh.disabled = true;
      refresh.textContent = "Checking…";
      await this.status.refresh();
      refresh.disabled = false;
      refresh.textContent = "Check again";
      closePopover({ restoreFocus: false });
      this.#openPanel();
    });
    const el = openPopover(this.pill, panel, { align: "end", className: "popover-panel", label: "Server status" });
    el?.querySelector("button")?.focus({ preventScroll: true });
  }
}
