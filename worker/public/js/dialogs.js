// Modal dialogs on the native <dialog> element (focus trap, Escape and top layer come for free).
// Each helper resolves when the dialog closes and removes it from the page.

import { h } from "./dom.js";
import { animateDialogDismissal, dismiss } from "./motion.js";

let nextId = 0;

/**
 * `onConfirm` returns the dialog's result, or undefined to keep it open (invalid input).
 * Cancel, Escape and a click on the backdrop resolve to null.
 */
function showDialog({ title, body, confirm, initialFocus, onConfirm }) {
  return new Promise((resolve) => {
    const titleId = `dialog-title-${++nextId}`;
    const cancel = h("button", { class: "button", type: "button", text: "Cancel" });
    const form = h(
      "form",
      { method: "dialog", class: "dialog-form" },
      h("h2", { class: "dialog-title", id: titleId, text: title }),
      body,
      h("div", { class: "dialog-actions" }, cancel, confirm),
    );
    const dialog = h("dialog", { class: "dialog", "aria-labelledby": titleId }, form);
    let result = null;

    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const value = onConfirm();
      if (value === undefined) return; // invalid input: stay open
      result = value;
      dismiss(dialog);
    });
    cancel.addEventListener("click", () => dismiss(dialog));
    animateDialogDismissal(dialog);
    dialog.addEventListener("close", () => {
      dialog.remove();
      resolve(result);
    });

    document.body.append(dialog);
    dialog.showModal();
    initialFocus.focus();
  });
}

/** Resolves to true when confirmed. */
export async function confirmDialog({ title, message, confirmLabel, danger = false }) {
  const confirm = h("button", {
    class: danger ? "button button-danger" : "button button-primary",
    type: "submit",
    text: confirmLabel,
  });
  const result = await showDialog({
    title,
    body: h("p", { class: "dialog-text", text: message }),
    confirm,
    initialFocus: confirm,
    onConfirm: () => true,
  });
  return result === true;
}

/** Resolves to the entered text (trimmed), or null when cancelled. Blank input keeps it open. */
export function promptDialog({ title, label, value = "", confirmLabel, maxLength, type = "text", hint }) {
  const input = h("input", {
    class: "text-field",
    type,
    value,
    maxlength: maxLength,
    required: true,
    autocomplete: "off",
    spellcheck: type === "text" ? "true" : "false",
  });
  const promise = showDialog({
    title,
    body: h(
      "label",
      { class: "field" },
      h("span", { class: "field-label", text: label }),
      input,
      hint ? h("span", { class: "field-hint", text: hint }) : null,
    ),
    confirm: h("button", { class: "button button-primary", type: "submit", text: confirmLabel }),
    initialFocus: input,
    onConfirm: () => input.value.trim() || undefined,
  });
  input.select();
  return promise;
}
