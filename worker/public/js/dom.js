// Small DOM helpers shared by the views.

import { ICONS } from "./icons.js";

const SVG_NS = "http://www.w3.org/2000/svg";

/**
 * Creates an element. Props: `class`, `text` (textContent), `on<event>` listeners, `dataset`,
 * booleans (true sets an empty attribute, false/null skips it) and plain attributes.
 */
export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value == null || value === false) continue;
    if (key === "class") el.className = value;
    else if (key === "text") el.textContent = value;
    else if (key === "dataset") Object.assign(el.dataset, value);
    else if (key.startsWith("on") && typeof value === "function") el.addEventListener(key.slice(2), value);
    else el.setAttribute(key, value === true ? "" : String(value));
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const child of children) {
    if (child == null || child === false) continue;
    if (Array.isArray(child)) append(el, child);
    else el.append(child);
  }
}

/** An inline SVG icon from icons.js; decorative unless the caller labels its button. */
export function icon(name, className = "icon") {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("class", className);
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  svg.innerHTML = ICONS[name];
  return svg;
}

/** Puts an icon in front of whatever the element already contains. */
export function prependIcon(el, name) {
  el.prepend(icon(name));
  return el;
}

/** A button with an icon and an accessible name; `label` is shown only when `showLabel`. */
export function iconButton(name, label, { className = "icon-button", showLabel = false, onclick, title } = {}) {
  const button = h("button", { class: className, type: "button", title: title ?? label, onclick }, icon(name));
  if (showLabel) button.append(h("span", { class: "button-label", text: label }));
  else button.setAttribute("aria-label", label);
  return button;
}

export function clear(el) {
  el.replaceChildren();
  return el;
}

/** Whether the primary input is touch (Enter adds a newline there, actions are always visible). */
export const isTouch = () => window.matchMedia("(hover: none) and (pointer: coarse)").matches;

export const isMac = () => /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

/** "Ctrl+K" or "⌘K" for a `mod+k` style key description. */
export function shortcutLabel(keys) {
  const mac = isMac();
  const names = { mod: mac ? "⌘" : "Ctrl", shift: mac ? "⇧" : "Shift", alt: mac ? "⌥" : "Alt" };
  const parts = keys.split("+").map((k) => names[k] ?? k.toUpperCase());
  return mac ? parts.join("") : parts.join("+");
}

/** Wraps localStorage: storage can be blocked or full, and the app must keep working without it. */
export const storage = {
  get(key) {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key, value) {
    try {
      if (value == null) localStorage.removeItem(key);
      else localStorage.setItem(key, value);
    } catch {
      // not persisted; the in-memory state still applies for this visit
    }
  },
};

/** Announces a short message to screen readers through the page's polite live region. */
export function announce(message) {
  const region = document.getElementById("announcer");
  region.textContent = "";
  // A separate task, so repeating the same text is still announced.
  setTimeout(() => (region.textContent = message), 30);
}
