// The Settings dialog. "Model" and "Server" settings are saved on the server and apply on every
// device (custom instructions, creativity, reply length, conversation memory; the Kaggle notebook
// link and when an idle server shuts down); "This device" settings are kept in this browser (text
// size, line width, reasoning, which key sends).

import { api } from "./api.js";
import { h } from "./dom.js";
import { animateDialogDismissal, dismiss, dragToDismiss } from "./motion.js";
import { TEXT_SIZES, WIDTHS, prefs } from "./prefs.js";
import { toast } from "./toast.js";

const REPLY_LENGTHS = [
  { value: "", label: "Recommended (longer with Think on)" },
  { value: "1024", label: "Short (about 750 words)" },
  { value: "4096", label: "Medium (about 3,000 words)" },
  { value: "8192", label: "Long (about 6,000 words)" },
  { value: "16384", label: "Very long (about 12,000 words)" },
];

const MEMORY = [
  { value: "", label: "Automatic: use the available input space" },
  { value: "16000", label: "Short: the last few messages" },
  { value: "60000", label: "Medium: up to 60,000 characters" },
  { value: "150000", label: "Long: up to 150,000 characters" },
];

const IDLE = [
  { value: "", label: "After 45 minutes (recommended)" },
  { value: "15", label: "After 15 minutes" },
  { value: "30", label: "After 30 minutes" },
  { value: "60", label: "After 1 hour" },
  { value: "120", label: "After 2 hours" },
  { value: "0", label: "Never: run until the 12-hour limit" },
];

let nextId = 0;
const uid = (name) => `settings-${name}-${++nextId}`;

/** Opens the dialog; resolves when it closes. */
export function openSettings() {
  return new Promise((resolve) => {
    const dialog = h("dialog", { class: "dialog settings-dialog", "aria-labelledby": "settings-title" });
    const form = h("form", { class: "settings-form", method: "dialog", novalidate: true });
    const error = h("p", { class: "settings-error", role: "alert", hidden: true });
    const model = modelSection();
    const server = serverSection();
    const device = deviceSection();
    const cancel = h("button", { class: "button", type: "button", text: "Cancel" });
    const save = h("button", { class: "button button-primary", type: "submit", text: "Save", disabled: true });
    const reset = h("button", { class: "button settings-reset", type: "button", text: "Reset model settings", disabled: true });

    form.append(
      h("header", { class: "settings-head" }, h("span", { class: "sheet-grabber", "aria-hidden": "true" }), h("h2", { class: "dialog-title", id: "settings-title", text: "Settings" })),
      h("div", { class: "settings-body" }, model.el, server.el, device.el),
      error,
      h("footer", { class: "settings-foot" }, reset, h("span", { class: "settings-spacer" }), cancel, save),
    );
    dialog.append(form);
    document.body.append(dialog);
    dialog.showModal();

    let defaults = null;
    api
      .settings()
      .then((body) => {
        defaults = body.defaults;
        model.fill(body.settings, body.limits);
        server.fill(body.settings);
        save.disabled = false;
        reset.disabled = false;
      })
      .catch((err) => {
        model.unavailable(err.message);
        server.unavailable();
        save.disabled = false; // device settings can still be saved
      });

    cancel.addEventListener("click", () => dismiss(dialog));
    animateDialogDismissal(dialog);
    // On phones Settings is a bottom sheet: drag its header down to put it away.
    dragToDismiss(dialog, {
      handle: form.querySelector(".settings-head"),
      axis: "y",
      direction: 1,
      enabled: () => window.matchMedia("(max-width: 640px)").matches,
      onDismiss: () => dialog.close(),
    });
    dialog.addEventListener("close", () => {
      dialog.remove();
      resolve();
    });
    reset.addEventListener("click", () => {
      if (defaults) {
        model.fill(defaults);
        server.fill(defaults);
      }
    });

    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      error.hidden = true;
      save.disabled = true;
      save.textContent = "Saving…";
      try {
        prefs.set(device.read());
        if (model.loaded) await api.saveSettings({ ...model.read(), ...server.read() });
        toast("Settings saved", { tone: "ok" });
        dismiss(dialog);
      } catch (err) {
        error.textContent = `Couldn't save the settings: ${err.message}`;
        error.hidden = false;
        save.disabled = false;
        save.textContent = "Save";
      }
    });
  });
}

function modelSection() {
  const promptId = uid("prompt");
  const prompt = h("textarea", {
    class: "settings-textarea",
    id: promptId,
    rows: "5",
    maxlength: "8000",
    placeholder: "For example: Answer in short paragraphs. I use Windows and Python 3.12. Show code before explaining it.",
  });
  const promptCount = h("span", { class: "settings-count", "aria-live": "polite" });
  const syncCount = () => (promptCount.textContent = `${prompt.value.length.toLocaleString()} / 8,000`);
  prompt.addEventListener("input", syncCount);

  const recommendedId = uid("temp-auto");
  const recommended = h("input", { type: "checkbox", id: recommendedId, checked: true });
  const tempId = uid("temp");
  const temperature = h("input", { type: "range", id: tempId, min: "0", max: "2", step: "0.05", value: "0.7", disabled: true });
  const tempValue = h("output", { class: "settings-value", for: tempId });
  const describeTemp = () => {
    const t = Number(temperature.value);
    const feel = t < 0.4 ? "precise" : t < 0.9 ? "balanced" : t < 1.3 ? "creative" : "very loose";
    tempValue.textContent = recommended.checked ? "Recommended" : `${t.toFixed(2)} (${feel})`;
  };
  recommended.addEventListener("change", () => {
    temperature.disabled = recommended.checked;
    describeTemp();
  });
  temperature.addEventListener("input", describeTemp);

  const lengthId = uid("length");
  const length = select(lengthId, REPLY_LENGTHS);
  const memoryId = uid("memory");
  const memory = select(memoryId, MEMORY);

  const fields = h(
    "div",
    { class: "settings-fields" },
    field(promptId, "Custom instructions", "Sent with every message, in every chat.", h("div", { class: "settings-stack" }, prompt, promptCount)),
    field(
      tempId,
      "Creativity",
      "Lower is more focused and predictable; higher is more varied.",
      h("div", { class: "settings-stack" }, h("label", { class: "settings-check", for: recommendedId }, recommended, "Use the recommended setting"), h("div", { class: "settings-range" }, temperature, tempValue)),
    ),
    field(lengthId, "Reply length", "The longest a single reply can get before it is cut off.", length),
    field(memoryId, "Conversation memory", "Limits the history sent with each message, capped by the available input space. This does not enlarge the model's context window.", memory),
  );
  const status = h("p", { class: "settings-note", text: "Loading…" });
  const el = section("Model", "Saved on the server. Applies on every device.", status, fields);
  fields.hidden = true;

  return {
    el,
    loaded: false,
    fill(values, limits) {
      prompt.value = values.system_prompt ?? "";
      if (limits?.system_prompt) prompt.maxLength = limits.system_prompt.maxChars;
      syncCount();
      recommended.checked = values.temperature === null;
      temperature.disabled = recommended.checked;
      if (values.temperature !== null) temperature.value = String(values.temperature);
      describeTemp();
      setSelect(length, values.max_reply_tokens === null ? "" : String(values.max_reply_tokens), (v) => `Custom (${Number(v).toLocaleString()} tokens)`);
      setSelect(memory, values.history_chars == null ? "" : String(values.history_chars), (v) => `Custom (${Number(v).toLocaleString()} characters)`);
      status.hidden = true;
      fields.hidden = false;
      this.loaded = true;
    },
    unavailable(message) {
      status.textContent = `Couldn't load the model settings: ${message}`;
      status.classList.add("is-error");
    },
    read() {
      return {
        system_prompt: prompt.value.trim(),
        temperature: recommended.checked ? null : Number(temperature.value),
        max_reply_tokens: length.value ? Number(length.value) : null,
        history_chars: memory.value ? Number(memory.value) : null,
      };
    },
  };
}

function serverSection() {
  const linkId = uid("kaggle");
  const link = h("input", {
    class: "settings-input",
    id: linkId,
    type: "url",
    inputmode: "url",
    autocomplete: "off",
    spellcheck: "false",
    placeholder: "https://www.kaggle.com/code/your-name/heretic-qwen-server",
  });
  const idleId = uid("idle");
  const idle = select(idleId, IDLE);
  const fields = h(
    "div",
    { class: "settings-fields" },
    field(linkId, "Kaggle notebook", "Filled in the first time you press Start. To use a notebook of your own, paste its link instead.", link),
    field(idleId, "Shut down when idle", "The notebook stops its model server after this much inactivity. In Colab, also disconnect the runtime to release its GPU allocation.", idle),
  );
  fields.hidden = true;
  const el = section("Server", "Saved on the server. Applies on every device.", fields);
  return {
    el,
    fill(values) {
      link.value = values.kaggle_url ?? "";
      setSelect(idle, values.idle_minutes == null ? "" : String(values.idle_minutes), (v) => `After ${v} minutes`);
      fields.hidden = false;
    },
    unavailable() {
      el.hidden = true;
    },
    read() {
      return { kaggle_url: link.value.trim(), idle_minutes: idle.value === "" ? null : Number(idle.value) };
    },
  };
}

function deviceSection() {
  const current = prefs.get();
  const size = radioGroup("text-size", TEXT_SIZES, current.textSize);
  const width = radioGroup("width", WIDTHS, current.width);
  const send = radioGroup(
    "send",
    [
      { value: "enter", label: "Enter sends, Shift+Enter adds a line" },
      { value: "ctrl-enter", label: "Ctrl+Enter sends, Enter adds a line" },
    ],
    current.sendKey,
    { stacked: true },
  );
  const reasoningId = uid("reasoning");
  const reasoning = h("input", { type: "checkbox", id: reasoningId, checked: current.reasoningOpen });

  // Text size and width preview live; Cancel puts them back.
  const before = { textSize: current.textSize, width: current.width };
  let saved = false;
  const preview = () => prefs.set({ textSize: size.value(), width: width.value() });
  size.el.addEventListener("change", preview);
  width.el.addEventListener("change", preview);

  const el = section(
    "This device",
    "Kept in this browser only.",
    h(
      "div",
      { class: "settings-fields" },
      fieldset("Text size", size.el),
      fieldset("Line width", width.el),
      fieldset("Sending", send.el),
      h("div", { class: "settings-field" }, h("label", { class: "settings-check", for: reasoningId }, reasoning, "Keep the model's reasoning open under each reply")),
    ),
  );
  // Restore the previewed size and width if the dialog closes without saving.
  queueMicrotask(() =>
    el.closest("dialog")?.addEventListener("close", () => {
      if (!saved) prefs.set(before);
    }),
  );

  return {
    el,
    read() {
      saved = true;
      return { textSize: size.value(), width: width.value(), sendKey: send.value(), reasoningOpen: reasoning.checked };
    },
  };
}

function section(title, note, ...children) {
  return h("section", { class: "settings-section" }, h("h3", { class: "settings-section-title", text: title }), h("p", { class: "settings-note", text: note }), ...children);
}

function field(id, label, hint, control) {
  return h("div", { class: "settings-field" }, h("label", { class: "settings-label", for: id, text: label }), h("p", { class: "settings-hint", text: hint }), control);
}

function fieldset(legend, control) {
  return h("fieldset", { class: "settings-field settings-fieldset" }, h("legend", { class: "settings-label", text: legend }), control);
}

function select(id, options) {
  return h("select", { class: "settings-select", id }, options.map((o) => h("option", { value: o.value, text: o.label })));
}

/** Selects `value`, adding a "Custom" option for a value the presets don't cover. */
function setSelect(el, value, customLabel) {
  if (![...el.options].some((o) => o.value === value)) el.append(h("option", { value, text: customLabel(value) }));
  el.value = value;
}

function radioGroup(name, options, current, { stacked = false } = {}) {
  const groupName = uid(name);
  const inputs = options.map((o) => h("input", { type: "radio", name: groupName, value: o.value, checked: o.value === current }));
  const el = h(
    "div",
    { class: `settings-choices${stacked ? " is-stacked" : ""}` },
    options.map((o, i) => h("label", { class: "settings-choice" }, inputs[i], h("span", { text: o.label }))),
  );
  if (!inputs.some((i) => i.checked)) inputs[0].checked = true;
  return { el, value: () => inputs.find((i) => i.checked)?.value ?? options[0].value };
}
