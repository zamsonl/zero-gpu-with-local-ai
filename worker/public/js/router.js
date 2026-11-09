// URL routing with the History API: "/" is a new chat, "/c/<chatId>" an existing one, "/images" the
// pictures.

const CHAT_PATH = /^\/c\/([A-Za-z0-9_-]{1,64})\/?$/;
export const IMAGES_PATH = "/images";

export const chatPath = (id) => `/c/${id}`;

/** True on the pictures page. */
export const isImagesRoute = () => /^\/images\/?$/.test(location.pathname);

/** The chat id in the current URL, or null for a new chat. Unknown paths are rewritten to "/". */
export function currentChatId() {
  const match = CHAT_PATH.exec(location.pathname);
  if (match) return match[1];
  if (location.pathname !== "/" && !isImagesRoute()) history.replaceState(null, "", "/");
  return null;
}

/** Calls `onChange(chatId)` on back/forward and on every navigate(). */
export function onRouteChange(onChange) {
  window.addEventListener("popstate", () => onChange(currentChatId()));
  document.addEventListener("app:navigate", () => onChange(currentChatId()));
}

/** Changes the URL. `silent` updates it without loading anything (the page already shows it). */
export function navigate(path, { replace = false, silent = false } = {}) {
  if (path !== location.pathname) history[replace ? "replaceState" : "pushState"](null, "", path);
  if (!silent) document.dispatchEvent(new Event("app:navigate"));
}
