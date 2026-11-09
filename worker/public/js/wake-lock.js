// Keeps the screen on while a reply is generating (phones would otherwise sleep mid-reply). The
// browser drops the lock whenever the page is hidden, so it is requested again on return.

export class ScreenWakeLock {
  #sentinel = null;
  #wanted = false;

  constructor() {
    document.addEventListener("visibilitychange", () => {
      if (this.#wanted && document.visibilityState === "visible") this.#request();
    });
  }

  acquire() {
    this.#wanted = true;
    return this.#request();
  }

  release() {
    this.#wanted = false;
    const sentinel = this.#sentinel;
    this.#sentinel = null;
    sentinel?.release().catch(() => {});
  }

  async #request() {
    if (!("wakeLock" in navigator) || document.visibilityState !== "visible" || this.#sentinel) return;
    try {
      const sentinel = await navigator.wakeLock.request("screen");
      if (!this.#wanted) {
        sentinel.release().catch(() => {});
        return;
      }
      this.#sentinel = sentinel;
      sentinel.addEventListener("release", () => {
        if (this.#sentinel === sentinel) this.#sentinel = null;
      });
    } catch {
      // Refused (battery saver, unsupported context): generating works the same without it.
    }
  }
}
