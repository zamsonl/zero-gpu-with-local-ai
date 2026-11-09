// Anchored popovers: action menus (role="menu", arrow-key navigation) and small panels such as the
// server status details. One is open at a time; Escape, Tab out, a click elsewhere or scrolling the
// page closes it, and focus returns to the button that opened it.

import { h, icon } from "./dom.js";
import { reducedMotion } from "./motion.js";

let current = null;

export function isPopoverOpen() {
  return current !== null;
}

export function closePopover({ restoreFocus = true } = {}) {
  if (!current) return;
  const { el, anchor, cleanup } = current;
  current = null;
  cleanup();
  // Leaves the way it came: shrinking back toward the button that opened it.
  if (reducedMotion()) el.remove();
  else {
    el.classList.add("is-leaving");
    el.setAttribute("inert", "");
    setTimeout(() => el.remove(), 120);
  }
  anchor.setAttribute("aria-expanded", "false");
  if (restoreFocus && anchor.isConnected) anchor.focus({ preventScroll: true });
}

/**
 * Opens `content` in a popover under (or above, when there is no room) `anchor`.
 * @param {HTMLElement} anchor
 * @param {HTMLElement} content
 * @param {{ align?: "start"|"end", className?: string, label?: string, onKeydown?: (e: KeyboardEvent) => void }} options
 */
export function openPopover(anchor, content, { align = "end", className = "", label, onKeydown } = {}) {
  const wasOpenHere = current?.anchor === anchor;
  closePopover({ restoreFocus: false });
  if (wasOpenHere) return null; // a second click on the same button closes it

  const el = h("div", { class: `popover ${className}`.trim(), role: label ? "dialog" : null, "aria-label": label });
  el.append(content);
  document.body.append(el);
  position(el, anchor, align);
  anchor.setAttribute("aria-expanded", "true");

  const onPointerDown = (event) => {
    if (!el.contains(event.target) && !anchor.contains(event.target)) closePopover({ restoreFocus: false });
  };
  const onKey = (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      closePopover();
    } else if (event.key === "Tab") {
      closePopover({ restoreFocus: false });
    } else {
      onKeydown?.(event);
    }
  };
  const onViewportChange = () => closePopover({ restoreFocus: false });
  document.addEventListener("pointerdown", onPointerDown, true);
  el.addEventListener("keydown", onKey);
  window.addEventListener("resize", onViewportChange);
  const scrollers = [...document.querySelectorAll(".conversation, .chat-list")];
  for (const scroller of scrollers) scroller.addEventListener("scroll", onViewportChange, { passive: true });

  current = {
    el,
    anchor,
    cleanup() {
      document.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("resize", onViewportChange);
      for (const scroller of scrollers) scroller.removeEventListener("scroll", onViewportChange);
    },
  };
  return el;
}

/**
 * An action menu. `items`: `{ label, icon, onSelect, danger?, disabled? }`.
 * Opened from the keyboard, focus starts on the first item.
 */
export function openMenu(anchor, items, { align = "end", label = "Options" } = {}) {
  const buttons = items.map((item) =>
    h(
      "button",
      {
        class: `menu-item${item.danger ? " is-danger" : ""}`,
        type: "button",
        role: "menuitem",
        tabindex: "-1",
        disabled: item.disabled,
        onclick: () => {
          closePopover();
          item.onSelect();
        },
      },
      icon(item.icon),
      h("span", { text: item.label }),
    ),
  );
  const menu = h("div", { class: "menu", role: "menu", "aria-label": label }, buttons);
  const el = openPopover(anchor, menu, {
    align,
    className: "popover-menu",
    onKeydown: (event) => moveFocus(event, buttons.filter((b) => !b.disabled)),
  });
  if (el) buttons.find((b) => !b.disabled)?.focus({ preventScroll: true });
  return el;
}

function moveFocus(event, buttons) {
  const index = buttons.indexOf(document.activeElement);
  const targets = {
    ArrowDown: buttons[(index + 1) % buttons.length],
    ArrowUp: buttons[(index - 1 + buttons.length) % buttons.length],
    Home: buttons[0],
    End: buttons[buttons.length - 1],
  };
  const target = targets[event.key];
  if (target) {
    event.preventDefault();
    target.focus();
  }
}

function position(el, anchor, align) {
  const gap = 6;
  const margin = 8;
  const rect = anchor.getBoundingClientRect();
  const { offsetWidth: width, offsetHeight: height } = el;
  const viewportWidth = document.documentElement.clientWidth;
  const viewportHeight = window.innerHeight;

  let left = align === "end" ? rect.right - width : rect.left;
  left = Math.min(Math.max(margin, left), viewportWidth - width - margin);
  let top = rect.bottom + gap;
  if (top + height > viewportHeight - margin && rect.top - gap - height >= margin) top = rect.top - gap - height;

  el.style.left = `${Math.round(left)}px`;
  el.style.top = `${Math.round(top)}px`;
  // Grow out of the button that opened it.
  const originX = Math.min(Math.max(rect.left + rect.width / 2 - left, 0), width);
  el.style.transformOrigin = `${Math.round(originX)}px ${top < rect.top ? "100%" : "0"}`;
}
