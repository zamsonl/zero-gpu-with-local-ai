// The new-chat title arrives censored and is uncensored in front of you. Every character sits under
// its own rough marker block; the blocks are eaten away in a loose left-to-right scatter, each one
// collapsing into a thin violet strike line before it vanishes while its letter flickers through
// random characters and settles. The subtitle then un-redacts word by word. With reduced motion,
// or if anything goes wrong, the plain text is shown at once.

import { h } from "./dom.js";

const SCRAMBLE = "ABCDEFGHJKLMNPQRSTUVWXYZ#%&$@*?/<>=+";
const LETTER_STEP_MS = 70;
const SCRAMBLE_TICK_MS = 46;
const SETTLE_MS = 700;
const WORD_STEP_MS = 34;

const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const random = (min, max) => min + Math.random() * (max - min);

/** Uncensors `text` into `el` (the title). Resolves when the last letter has settled. */
export async function uncensorTitle(el, text, { delay = 300 } = {}) {
  el.setAttribute("aria-label", text);
  if (reducedMotion()) {
    el.textContent = text;
    return;
  }
  // Censored from the first frame, so the name never shows before its reveal.
  const cells = [...text].map((char) => {
    const glyph = h("span", { class: "uc-glyph", text: char === " " ? " " : char });
    const ink = h("span", { class: "uc-ink" });
    ink.style.clipPath = markerEdge();
    const cell = h("span", { class: "uc-cell", "aria-hidden": "true" }, glyph, ink);
    return { char, cell, glyph, ink };
  });
  el.replaceChildren(...cells.map((c) => c.cell));
  el.classList.add("is-censored");

  // Widths are measured once, so the real font must be in place first.
  await Promise.race([document.fonts?.ready, sleep(900)]);
  if (!el.isConnected) return;
  // Lock each cell to its real letter's width so the scramble never shifts the line.
  for (const c of cells) c.cell.style.width = `${c.cell.getBoundingClientRect().width}px`;

  // A loose left-to-right order: each letter jumps the queue by up to a few places.
  const order = cells
    .map((cell, index) => ({ cell, key: index + random(0, 4.5) }))
    .sort((a, b) => a.key - b.key)
    .map((entry) => entry.cell);

  await sleep(delay);
  order.forEach((cell, n) => setTimeout(() => reveal(cell), n * LETTER_STEP_MS + random(0, 24)));
  await sleep(order.length * LETTER_STEP_MS + SETTLE_MS);

  // Back to one text run so the font's kerning applies again.
  if (el.isConnected) {
    el.classList.remove("is-censored");
    el.textContent = text;
  }
}

/** Un-redacts `text` into `el` word by word, starting after `delay` ms. */
export async function uncensorWords(el, text, { delay = 0 } = {}) {
  if (reducedMotion()) {
    el.textContent = text;
    return;
  }
  const words = text.split(" ").map((word) => {
    const ink = h("span", { class: "uc-ink" });
    ink.style.clipPath = markerEdge();
    return h("span", { class: "uc-word" }, word, ink);
  });
  el.replaceChildren(...words.flatMap((word, i) => (i ? [" ", word] : [word])));
  el.classList.add("is-censored");

  await sleep(delay);
  words.forEach((word, n) => setTimeout(() => word.classList.add("is-lifting"), n * WORD_STEP_MS));
  await sleep(words.length * WORD_STEP_MS + 500);
  if (el.isConnected) {
    el.classList.remove("is-censored");
    el.textContent = text;
  }
}

function reveal({ char, cell, glyph }) {
  if (!cell.isConnected) return;
  cell.classList.add("is-lifting");
  if (char === " ") return;
  let ticks = Math.round(random(3, 7));
  const timer = setInterval(() => {
    if (ticks-- > 0 && cell.isConnected) {
      glyph.textContent = SCRAMBLE[Math.floor(Math.random() * SCRAMBLE.length)];
      return;
    }
    clearInterval(timer);
    glyph.textContent = char;
    cell.classList.add("is-clear");
  }, SCRAMBLE_TICK_MS);
}

/** A slightly uneven top and bottom edge, like a marker stroke rather than a ruled box. */
function markerEdge() {
  const top = () => random(0, 9).toFixed(1);
  const bottom = () => random(91, 100).toFixed(1);
  return `polygon(0% ${top()}%, 50% ${top()}%, 100% ${top()}%, 100% ${bottom()}%, 50% ${bottom()}%, 0% ${bottom()}%)`;
}
