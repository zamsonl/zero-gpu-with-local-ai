// Copying text: the async Clipboard API with a textarea/execCommand fallback (older browsers,
// non-secure contexts), and the short "Copied" confirmation on the button that asked for it.

import { icon } from "./dom.js";

const CONFIRM_MS = 1500;

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return copyWithTextarea(text);
  }
}

/**
 * Copies `text` and confirms on `button` for 1.5 s: its icon becomes a check and its label (a
 * `.button-label` child if shown, else the aria-label) reads "Copied".
 */
export async function copyFromButton(button, text) {
  const ok = await copyText(text);
  const label = button.querySelector(".button-label");
  button.dataset.label ??= label?.textContent ?? button.getAttribute("aria-label") ?? "Copy";
  const original = button.dataset.label;
  const confirmation = ok ? "Copied" : "Copy failed";

  clearTimeout(button.copyTimer);
  button.classList.add("is-confirmed");
  button.querySelector("svg")?.replaceWith(icon(ok ? "check" : "alert"));
  if (label) label.textContent = confirmation;
  else button.setAttribute("aria-label", confirmation);
  button.copyTimer = setTimeout(() => {
    button.classList.remove("is-confirmed");
    button.querySelector("svg")?.replaceWith(icon("copy"));
    if (label) label.textContent = original;
    else button.setAttribute("aria-label", original);
  }, CONFIRM_MS);
}

function copyWithTextarea(text) {
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.className = "clipboard-buffer";
  document.body.append(area);
  const selection = document.getSelection();
  const previous = selection.rangeCount ? selection.getRangeAt(0) : null;
  area.select();
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  }
  area.remove();
  if (previous) {
    selection.removeAllRanges();
    selection.addRange(previous);
  }
  return ok;
}
