// Operational logs from Kaggle or Colab. Updates follow the bottom unless the person scrolls up.

import { ServerLogFeed } from "./server-log-feed.js";
import { copyFromButton } from "./clipboard.js";
import { h, icon } from "./dom.js";
import { animateDialogDismissal, dismiss } from "./motion.js";
import { timeAgo } from "./time.js";

const RUN_STATES = {
  QUEUED: "Waiting for a GPU",
  RUNNING: "Running",
  COMPLETE: "Finished",
  ERROR: "Failed",
  CANCEL_REQUESTED: "Stopping",
  CANCEL_ACKNOWLEDGED: "Stopped",
};

export function openServerLog(host) {
  const close = h("button", { class: "icon-button", type: "button", "aria-label": "Close", title: "Close (Esc)" }, icon("close"));
  const subtitle = h("span", { text: "Loading…" });
  const body = h("pre", { class: "file-dialog-body server-log-body", tabindex: "0", "aria-live": "off" });
  const refresh = h("button", { class: "button", type: "button" }, icon("regenerate"), h("span", { text: "Refresh" }));
  const copy = h("button", { class: "button", type: "button" }, icon("copy"), h("span", { class: "button-label", text: "Copy" }));
  const notebookLabel = h("span", { text: "Open notebook" });
  const notebook = h("a", { class: "button", target: "_blank", rel: "noopener noreferrer", hidden: true }, notebookLabel, icon("external"));
  const hostChoice = h("select", { class: "settings-select server-log-host", "aria-label": "Notebook host" },
    h("option", { value: "", text: "Active server" }),
    h("option", { value: "kaggle", text: "Kaggle" }),
    h("option", { value: "colab", text: "Colab" }),
  );
  hostChoice.value = host || "";
  const dialog = h(
    "dialog",
    { class: "dialog file-dialog server-log-dialog", "aria-labelledby": "server-log-title" },
    h(
      "div",
      { class: "file-dialog-head" },
      icon("monitor"),
      h("div", { class: "file-dialog-title" }, h("strong", { id: "server-log-title", text: "Server log" }), subtitle),
      hostChoice,
      close,
    ),
    body,
    h("div", { class: "file-dialog-foot" }, notebook, h("span", { class: "settings-spacer" }), copy, refresh),
  );

  let text = "";
  let closed = false;
  let feed;
  const render = ({ result, error }) => {
    if (error) {
      subtitle.textContent = `Reconnecting: ${error.message}`;
      return;
    }
    // Follow the end of the log unless the person scrolled up to read something.
    const atBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 40;
      text = result.log || "";
      body.textContent = text || result.message || (result.status ? "Waiting for the notebook's first log update…" : "No notebook log yet. Start a notebook to begin.");
      if (result.truncated) body.prepend(h("span", { class: "server-log-cut", text: "… showing the latest lines; earlier output is in the notebook\n" }));
      const state = RUN_STATES[result.status] ?? null;
      subtitle.textContent = [
        result.host === "colab" ? "Colab" : result.host === "kaggle" ? "Kaggle" : null,
        state,
        result.started_at ? `started ${timeAgo(result.started_at)}` : null,
        result.updated_at ? `last update ${timeAgo(result.updated_at)}` : null,
        result.failure ? result.failure : null,
      ]
        .filter(Boolean)
        .join(" · ") || "Waiting for notebook logs";
      if (result.url) {
        notebook.href = result.url;
        notebookLabel.textContent = `Open on ${result.host === "colab" ? "Colab" : "Kaggle"}`;
        notebook.hidden = false;
      }
      if (atBottom) body.scrollTop = body.scrollHeight;
  };

  function follow(nextHost) {
    feed?.stop();
    text = "";
    body.textContent = "Waiting for the notebook's log…";
    subtitle.textContent = "Connecting…";
    notebook.hidden = true;
    feed = new ServerLogFeed(nextHost || undefined, render);
    return feed.start();
  }
  hostChoice.addEventListener("change", () => follow(hostChoice.value));

  refresh.addEventListener("click", async () => {
    refresh.disabled = true;
    await feed.refresh();
    if (!closed) refresh.disabled = false;
  });
  copy.addEventListener("click", () => copyFromButton(copy, text));
  close.addEventListener("click", () => dismiss(dialog));
  animateDialogDismissal(dialog);
  dialog.addEventListener("close", () => {
    closed = true;
    feed.stop();
    dialog.remove();
  });
  document.body.append(dialog);
  dialog.showModal();
  close.focus();
  follow(host);
}
