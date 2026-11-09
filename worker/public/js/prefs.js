// Per-device preferences (this browser only): reading size, line width, whether reasoning stays
// open, and which key sends. Applied as CSS variables and data attributes on <html>; boot.js
// applies the stored ones before first paint.

import { storage } from "./dom.js";

const KEY = "qwen.prefs";

export const TEXT_SIZES = [
  { value: "xsmall", label: "Extra small", px: 12, codePx: 11 },
  { value: "small", label: "Small", px: 13, codePx: 11.5 },
  { value: "medium", label: "Medium", px: 14, codePx: 12 },
  { value: "big", label: "Big", px: 15, codePx: 13 },
];

export const WIDTHS = [
  { value: "comfortable", label: "Comfortable", px: 880 },
  { value: "wide", label: "Wide", px: 1120 },
];

const DEFAULTS = { textSize: "medium", width: "wide", readingVersion: 2, reasoningOpen: false, sendKey: "enter" };

let current = load();

function load() {
  try {
    const saved = JSON.parse(storage.get(KEY) ?? "{}") || {};
    const current = { ...DEFAULTS, ...saved };
    // Apply the requested new defaults once; later explicit selections persist.
    if (saved.readingVersion !== 2) Object.assign(current, { textSize: "medium", width: "wide" });
    if (!TEXT_SIZES.some(size => size.value === current.textSize)) current.textSize = DEFAULTS.textSize;
    if (!WIDTHS.some(width => width.value === current.width)) current.width = DEFAULTS.width;
    current.readingVersion = 2;
    return current;
  } catch {
    return { ...DEFAULTS };
  }
}

export const prefs = {
  get: () => current,

  set(patch) {
    current = { ...current, ...patch };
    storage.set(KEY, JSON.stringify(current));
    apply();
  },
};

export function apply() {
  const root = document.documentElement;
  const size = TEXT_SIZES.find((s) => s.value === current.textSize) ?? TEXT_SIZES[2];
  const width = WIDTHS.find((w) => w.value === current.width) ?? WIDTHS[1];
  root.style.setProperty("--reading-size", `${size.px}px`);
  root.style.setProperty("--code-size", `${size.codePx}px`);
  root.style.setProperty("--measure", `${width.px}px`);
}
