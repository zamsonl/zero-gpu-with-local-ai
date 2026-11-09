// Theme choice (System, Light, Dark; Light by default), persisted per browser. "System" follows
// prefers-color-scheme.
// The choice is applied as <html data-theme> (boot.js does it before first paint), and it also
// picks the highlight.js stylesheet and the browser's theme-color.

import { h, icon, storage } from "./dom.js";

const KEY = "qwen.theme";
const CHOICES = [
  { value: "system", label: "System", icon: "monitor" },
  { value: "light", label: "Light", icon: "sun" },
  { value: "dark", label: "Dark", icon: "moon" },
];
const THEME_COLORS = { light: "#f8f8f8", dark: "#111111" };
const DEFAULT = "light";
const LIGHT_QUERY = "(prefers-color-scheme: light)";
const DARK_QUERY = "(prefers-color-scheme: dark)";

export function initTheme(container) {
  const saved = storage.get(KEY);
  let choice = CHOICES.some((c) => c.value === saved) ? saved : DEFAULT;

  const buttons = CHOICES.map((c) =>
    h(
      "button",
      {
        class: "theme-option",
        type: "button",
        role: "radio",
        title: `${c.label} theme`,
        "aria-label": `${c.label} theme`,
        dataset: { theme: c.value },
        onclick: () => select(c.value),
      },
      icon(c.icon),
    ),
  );
  container.replaceChildren(...buttons);
  container.addEventListener("keydown", (event) => {
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];
    if (!step) return;
    event.preventDefault();
    const index = CHOICES.findIndex((c) => c.value === choice);
    select(CHOICES[(index + step + CHOICES.length) % CHOICES.length].value);
    buttons.find((b) => b.dataset.theme === choice).focus();
  });

  function select(value) {
    choice = value;
    storage.set(KEY, value === DEFAULT ? null : value);
    apply(value);
    for (const button of buttons) {
      const checked = button.dataset.theme === value;
      button.setAttribute("aria-checked", String(checked));
      button.tabIndex = checked ? 0 : -1;
    }
  }

  select(choice);
}

function apply(choice) {
  const root = document.documentElement;
  // Ease the brightness change instead of flashing between themes.
  root.classList.add("is-theme-changing");
  clearTimeout(apply.timer);
  apply.timer = setTimeout(() => root.classList.remove("is-theme-changing"), 320);
  if (choice === "system") delete root.dataset.theme;
  else root.dataset.theme = choice;

  const forced = choice !== "system";
  document.getElementById("hljs-light").media = forced ? (choice === "light" ? "all" : "not all") : LIGHT_QUERY;
  document.getElementById("hljs-dark").media = forced ? (choice === "dark" ? "all" : "not all") : DARK_QUERY;
  for (const meta of document.querySelectorAll('meta[name="theme-color"]')) {
    const scheme = forced ? choice : meta.media.includes("dark") ? "dark" : "light";
    meta.content = THEME_COLORS[scheme];
  }
}
