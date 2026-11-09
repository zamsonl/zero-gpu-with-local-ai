// The instrument readouts. The header shows the estimated next input and reply speeds
// (a sparkline of the recent ones). In the sidebar: the model badge, Kaggle GPU hours used this
// week and when an idle server will shut itself down. On the start screen: the same facts as tiles.
// Fed by the server status and the open chat's messages.

import { h } from "./dom.js";

const GPU_WEEK_HOURS = 30;
const SPARK_POINTS = 16;
const EFFORT_NAMES = { true: "Deep", medium: "Balanced", low: "Quick", false: "Off" };

/** "8.2K" for token counts. */
export function tokensShort(n) {
  if (n < 1000) return String(n);
  return `${(n / 1024).toFixed(n < 10_240 ? 1 : 0).replace(/\.0$/, "")}K`;
}

/** What the saved `think` value of a reply was called in the picker. */
export function effortName(think) {
  return EFFORT_NAMES[String(think)] ?? null;
}

export class Telemetry {
  #status;
  #messages = [];
  #context = null;

  /** @param {import("./server-status.js").ServerStatus} status */
  constructor(status) {
    this.#status = status;
    this.memory = document.getElementById("gauge-memory");
    this.speed = document.getElementById("gauge-speed");
    this.badge = document.getElementById("brand-badge");
    this.meters = document.getElementById("meters");
    status.addEventListener("change", () => this.render());
    // The idle countdown moves between status polls.
    setInterval(() => this.#renderMeters(), 15_000);
  }

  /** The open chat's messages; their stats hold the token counts and speeds. */
  setChat(messages) {
    this.#messages = messages ?? [];
    this.render();
  }

  setContext(context) {
    this.#context = context;
    this.render();
  }

  render() {
    this.#renderGauges();
    this.#renderBadge();
    this.#renderMeters();
    this.#renderTiles();
  }

  #replies() {
    return this.#messages.filter((m) => m.role === "assistant" && m.stats);
  }

  #renderGauges() {
    const status = this.#status.status;
    const context = this.#context;
    const limit = context?.input_budget_tokens;
    const active = ["ready", "idle", "images"].includes(status?.server);
    if (context && limit && active) {
      const used = context.estimated_input_tokens;
      const share = Math.min(1, used / limit);
      this.memory.querySelector(".gauge-fill").style.setProperty("--fill", `${Math.max(2, share * 100).toFixed(1)}%`);
      this.memory.querySelector(".gauge-name").textContent = "Input";
      this.memory.querySelector(".gauge-value").replaceChildren(h("b", { text: `≈${tokensShort(used)}` }), ` / ${tokensShort(limit)}`);
      this.memory.classList.toggle("is-high", share >= 0.8 || context.would_omit_history);
      this.memory.title = `Estimated next input: ${used.toLocaleString()} / ${limit.toLocaleString()} tokens. Total window: ${context.capacity_tokens.toLocaleString()}; reply reserve: ${context.reserved_reply_tokens.toLocaleString()}. Open context details by the message box.`;
      this.memory.hidden = false;
    } else {
      this.memory.hidden = true;
    }

    const speeds = this.#replies()
      .map((m) => m.stats.tokens_per_sec)
      .filter((v) => typeof v === "number" && v > 0)
      .slice(-SPARK_POINTS);
    if (speeds.length) {
      this.speed.querySelector("polyline").setAttribute("points", sparkline(speeds));
      this.speed.querySelector(".gauge-value").replaceChildren(h("b", { text: speeds.at(-1).toFixed(1) }), " tok/s");
      this.speed.hidden = false;
    } else {
      this.speed.hidden = true;
    }
  }

  #renderBadge() {
    const quant = this.#status.status?.quant;
    const size = this.#status.status?.model_size || "27B";
    this.badge.textContent = quant ? `${size} · ${quant}` : size;
    this.badge.title = quant ? `The server runs the ${size} model at ${quant}` : `The ${size} model`;
    this.badge.hidden = !this.#status.status;
  }

  #renderMeters() {
    const status = this.#status.status;
    const rows = [];
    if (typeof status?.gpu_hours_week === "number") {
      const hours = status.gpu_hours_week;
      const tracked = meter("Tracked serving time", `${hours.toFixed(1)} h`, hours / GPU_WEEK_HOURS, hours > GPU_WEEK_HOURS * 0.85 ? "warn" : "accent");
      tracked.title = "This week's Kaggle serving sessions recorded by this app. Manual runs and probes are excluded; check Kaggle for remaining quota.";
      rows.push(tracked);
    }
    if (status?.idle_shutdown_at && status.server === "ready") {
      const left = Math.max(0, Date.parse(status.idle_shutdown_at) - Date.now());
      const minutes = Math.ceil(left / 60_000);
      const total = (status.idle_minutes || 45) * 60_000;
      rows.push(meter("Shuts down when idle", minutes <= 1 ? "in under a minute" : `in ${minutes} min`, left / total, "amber"));
    }
    this.meters.replaceChildren(...rows);
    this.meters.hidden = rows.length === 0;
  }

  /** The start screen's tiles, when it is showing. */
  #renderTiles() {
    const tiles = document.querySelector(".empty-tiles");
    if (!tiles) return;
    const status = this.#status.status;
    const host = status?.host === "kaggle" ? "Kaggle 2×T4" : status?.host === "colab" ? "Colab GPU" : "No server";
    const up = status?.server === "ready" || status?.server === "idle";
    const pictures = status?.server === "images";
    const set = (name, value, note) => {
      const tile = tiles.querySelector(`[data-tile="${name}"]`);
      tile.querySelector(".tile-value").textContent = value;
      tile.querySelector(".tile-note").textContent = note;
    };
    if (pictures) set("server", host, "Making pictures; chat is paused");
    else set("server", up ? host : status?.boot && status.boot.stage !== "failed" ? "Starting" : "Offline", up ? "Ready to answer" : status?.can_start ? "Start it from the banner below" : "Start the notebook");
    const active = up || pictures;
    set("memory", active && status?.num_ctx ? `${status.num_ctx.toLocaleString()} tokens` : "—", active ? "Total window, shared by input and replies" : "Confirmed when the server connects");
    set("pictures", active ? (status?.vision ? "On" : "Off") : "—", active && status?.vision ? "Attach a picture to ask about it" : active ? "Text, code and PDFs" : "Vision is checked when chat starts");
    set(
      "gpu",
      typeof status?.gpu_hours_week === "number" ? `${status.gpu_hours_week.toFixed(1)} h tracked` : "—",
      typeof status?.gpu_hours_week === "number" ? "Serving sessions only; check Kaggle for quota" : "Kaggle isn't set up",
    );
  }
}

function meter(name, value, share, tone) {
  const fill = h("span", { class: "meter-fill" });
  fill.style.setProperty("--fill", `${Math.max(0, Math.min(1, share)) * 100}%`);
  return h(
    "div",
    { class: "meter", dataset: { tone } },
    h("div", { class: "meter-row" }, h("span", { class: "meter-name", text: name }), h("span", { class: "meter-value", text: value })),
    h("span", { class: "meter-track", "aria-hidden": "true" }, fill),
  );
}

/** Points for a 48×16 polyline through `values`, scaled to their own range. */
function sparkline(values) {
  if (values.length === 1) values = [values[0], values[0]];
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  return values.map((v, i) => `${((i / (values.length - 1)) * 47 + 0.5).toFixed(1)},${(14 - ((v - min) / span) * 12).toFixed(1)}`).join(" ");
}
