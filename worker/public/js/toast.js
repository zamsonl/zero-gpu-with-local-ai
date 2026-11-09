// Brief confirmations ("Connected", "Chat deleted") at the bottom of the page.

import { h } from "./dom.js";

const SHOW_MS = 2600;

export function toast(message, { tone = "neutral" } = {}) {
  const region = document.getElementById("toasts");
  const el = h("div", { class: "toast", dataset: { tone } }, h("span", { class: "toast-dot", "aria-hidden": "true" }), message);
  region.append(el);
  setTimeout(() => {
    el.classList.add("is-leaving");
    el.addEventListener("animationend", () => el.remove(), { once: true });
    // Reduced motion skips the animation; make sure it still goes.
    setTimeout(() => el.remove(), 400);
  }, SHOW_MS);
}
