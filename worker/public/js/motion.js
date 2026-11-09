// Motion helpers: exits that mirror their entrances, and drag-to-dismiss for sheets and the phone
// drawer. A drag tracks the finger 1:1 (with rubber-banding past the open position), and on release
// the gesture's velocity decides: the element is projected forward the way scrolling decelerates,
// and it dismisses if that projected point is past the threshold, otherwise it settles back.

export const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

const EXIT_MS = 160;

/** Closes a <dialog> after its exit animation (the reverse of how it came in). */
export function dismiss(dialog) {
  if (!dialog.open || dialog.classList.contains("is-closing")) return;
  if (reducedMotion()) {
    dialog.close();
    return;
  }
  dialog.classList.add("is-closing");
  setTimeout(() => {
    dialog.classList.remove("is-closing");
    dialog.close();
  }, EXIT_MS);
}

/** Escape and backdrop clicks also leave through the exit animation. */
export function animateDialogDismissal(dialog) {
  dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    dismiss(dialog);
  });
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) dismiss(dialog);
  });
}

/** Where a fling ends: the platform's exponential deceleration (rate per ms). */
export function project(velocityPxPerS, decelerationRate = 0.998) {
  return ((velocityPxPerS / 1000) * decelerationRate) / (1 - decelerationRate);
}

function rubberband(overshoot, dimension, constant = 0.55) {
  return (overshoot * dimension * constant) / (dimension + constant * Math.abs(overshoot));
}

/**
 * Lets the user drag `el` away along `axis` ("x" or "y") in `direction` (1 = right/down,
 * -1 = left/up) to dismiss it. `onDismiss` runs once the element has left; the caller then
 * removes or hides it. Returns a function that detaches the gesture.
 */
export function dragToDismiss(el, { handle = el, axis = "y", direction = 1, threshold = 0.4, onDismiss, enabled = () => true }) {
  let gesture = null;

  const along = (event) => (axis === "x" ? event.clientX : event.clientY);
  const across = (event) => (axis === "x" ? event.clientY : event.clientX);
  const size = () => (axis === "x" ? el.offsetWidth : el.offsetHeight);
  const place = (offset) => {
    el.style.transform = axis === "x" ? `translateX(${offset}px)` : `translateY(${offset}px)`;
  };

  const down = (event) => {
    if (!enabled() || (event.pointerType === "mouse" && event.button !== 0)) return;
    // Text fields keep their own drags (selecting text); links and buttons can start a swipe, and
    // still get their tap when the finger doesn't move.
    if (event.target.closest("input, textarea, select, [contenteditable]")) return;
    gesture = { id: event.pointerId, start: along(event), startAcross: across(event), tracking: false, offset: 0, samples: [] };
  };

  const move = (event) => {
    if (!gesture || event.pointerId !== gesture.id) return;
    const delta = (along(event) - gesture.start) * direction;
    if (!gesture.tracking) {
      const sideways = Math.abs(across(event) - gesture.startAcross);
      if (Math.abs(delta) < 10 && sideways < 10) return; // hysteresis before committing
      if (sideways > Math.abs(delta) || delta < 0) {
        gesture = null; // a scroll or a drag the other way: not ours
        return;
      }
      gesture.tracking = true;
      handle.setPointerCapture(event.pointerId);
      el.style.transition = "none";
      el.classList.add("is-dragging");
    }
    // Follows 1:1 toward dismissal; resists progressively the other way.
    gesture.offset = delta >= 0 ? delta : rubberband(delta, size());
    place(gesture.offset * direction);
    gesture.samples.push({ t: event.timeStamp, offset: gesture.offset });
    if (gesture.samples.length > 6) gesture.samples.shift();
  };

  const up = (event) => {
    if (!gesture || event.pointerId !== gesture.id) return;
    const { tracking, offset, samples } = gesture;
    gesture = null;
    if (!tracking) return;
    el.classList.remove("is-dragging");
    const first = samples[0];
    const last = samples.at(-1);
    const velocity = first && last && last.t > first.t ? ((last.offset - first.offset) / (last.t - first.t)) * 1000 : 0;
    const dismissed = offset + project(Math.max(0, velocity)) > size() * threshold;
    const distance = dismissed ? size() : 0;
    // Continue at the finger's speed: a quick fling gets a short settle, a slow release a gentle one.
    const remaining = Math.abs(distance - offset);
    const ms = Math.round(Math.min(380, Math.max(160, velocity > 0 ? (remaining / velocity) * 1000 * 1.6 : 320)));
    el.style.transition = `transform ${ms}ms cubic-bezier(0.25, 1, 0.35, 1)`;
    place(distance * direction);
    setTimeout(() => {
      // Dismissed: hand over to the closed state first, so clearing the inline offset can't flash.
      if (dismissed) onDismiss();
      requestAnimationFrame(() => {
        el.style.transition = "";
        el.style.transform = "";
      });
    }, ms);
  };

  handle.addEventListener("pointerdown", down);
  handle.addEventListener("pointermove", move);
  handle.addEventListener("pointerup", up);
  handle.addEventListener("pointercancel", up);
  return () => {
    handle.removeEventListener("pointerdown", down);
    handle.removeEventListener("pointermove", move);
    handle.removeEventListener("pointerup", up);
    handle.removeEventListener("pointercancel", up);
  };
}
