// The chat list: New chat, search, chats grouped by day with a row menu (Rename, Export, Delete).
// Below 768 px it is an off-canvas drawer with a backdrop; above, it can be collapsed (remembered).

import { api } from "./api.js";
import { h, icon, iconButton, storage } from "./dom.js";
import { dragToDismiss } from "./motion.js";
import { openMenu } from "./popover.js";
import { GROUP_ORDER, fullDate, groupLabel, shortAge } from "./time.js";

const SEARCH_DEBOUNCE_MS = 200;
const DRAWER_QUERY = window.matchMedia("(max-width: 767px)");

export class Sidebar {
  /** All chats, newest activity first (what the list shows when not searching). */
  #chats = [];
  #activeId = null;
  #generatingId = null;
  /** `{ query, chats, error }` while search results are shown, else null. */
  #search = null;
  #searchTimer = null;
  #searchAbort = null;

  /**
   * @param {object} actions
   * @param {(id: string) => void} actions.onOpen
   * @param {() => void} actions.onNewChat
   * @param {(chat: object) => void} actions.onRename
   * @param {(chat: object) => void} actions.onExport
   * @param {(chat: object) => void} actions.onDelete
   */
  constructor(actions) {
    this.actions = actions;
    this.app = document.getElementById("app");
    this.el = document.getElementById("sidebar");
    this.list = document.getElementById("chat-list");
    this.search = document.getElementById("search");
    this.backdrop = document.getElementById("backdrop");
    this.main = document.getElementById("main");
    this.openButton = document.getElementById("sidebar-open");
    this.closeButton = document.getElementById("sidebar-close");

    this.openButton.append(icon("sidebar"));
    this.closeButton.append(icon("sidebar"));
    document.getElementById("new-chat").prepend(icon("newChat"));
    document.querySelector(".search").prepend(icon("search", "icon search-icon"));

    document.getElementById("new-chat").addEventListener("click", () => actions.onNewChat());
    this.openButton.addEventListener("click", () => this.show());
    this.closeButton.addEventListener("click", () => this.hide());
    this.backdrop.addEventListener("click", () => this.hide());
    this.search.addEventListener("input", () => this.#onSearchInput());
    this.search.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && this.search.value) {
        event.preventDefault();
        event.stopPropagation();
        this.search.value = "";
        this.#onSearchInput();
      }
    });
    DRAWER_QUERY.addEventListener("change", () => this.#syncLayout());
    // On phones the drawer follows a leftward swipe and is flung shut.
    dragToDismiss(this.el, {
      axis: "x",
      direction: -1,
      threshold: 0.45,
      enabled: () => this.isDrawer && this.isDrawerOpen,
      onDismiss: () => this.closeDrawer(),
    });
    setInterval(() => this.#refreshTimes(), 60_000);
    this.#syncLayout();
  }

  get isDrawer() {
    return DRAWER_QUERY.matches;
  }

  get isDrawerOpen() {
    return this.app.classList.contains("drawer-open");
  }

  get chats() {
    return this.#chats;
  }

  setChats(chats) {
    this.#chats = [...chats];
    this.#render();
  }

  /** Adds or updates a chat and keeps the list ordered by last activity. */
  upsert(chat) {
    const others = this.#chats.filter((c) => c.id !== chat.id);
    this.#chats = [chat, ...others].sort((a, b) => b.updated_at.localeCompare(a.updated_at));
    if (this.#search) this.#search.chats = this.#search.chats.map((c) => (c.id === chat.id ? chat : c));
    this.#render();
  }

  remove(id) {
    this.#chats = this.#chats.filter((c) => c.id !== id);
    if (this.#search) this.#search.chats = this.#search.chats.filter((c) => c.id !== id);
    this.#render();
  }

  find(id) {
    return this.#chats.find((c) => c.id === id) ?? null;
  }

  setActive(id) {
    this.#activeId = id;
    for (const row of this.list.querySelectorAll(".chat-row")) {
      const active = row.dataset.id === id;
      row.classList.toggle("is-active", active);
      const link = row.querySelector(".chat-link");
      if (active) link.setAttribute("aria-current", "page");
      else link.removeAttribute("aria-current");
    }
  }

  setGenerating(id) {
    this.#generatingId = id;
    for (const row of this.list.querySelectorAll(".chat-row")) row.classList.toggle("is-generating", row.dataset.id === id);
  }

  focusSearch() {
    if (this.isDrawer) this.show({ focus: false });
    else if (document.documentElement.dataset.sidebar === "collapsed") this.show();
    this.search.focus();
    this.search.select();
  }

  /** Opens the drawer (phones) or expands the collapsed sidebar (desktop). */
  show({ focus = true } = {}) {
    if (!this.isDrawer) {
      this.#setCollapsed(false);
      return;
    }
    this.app.classList.add("drawer-open");
    this.backdrop.hidden = false;
    this.main.inert = true;
    this.openButton.setAttribute("aria-expanded", "true");
    if (focus) (this.list.querySelector(".is-active .chat-link") ?? document.getElementById("new-chat")).focus({ preventScroll: true });
  }

  /** Closes the drawer (phones) or collapses the sidebar (desktop). */
  hide() {
    if (!this.isDrawer) {
      this.#setCollapsed(true);
      this.openButton.focus();
      return;
    }
    this.closeDrawer();
  }

  closeDrawer() {
    if (!this.isDrawerOpen) return;
    const hadFocus = this.el.contains(document.activeElement);
    this.app.classList.remove("drawer-open");
    this.backdrop.hidden = true;
    this.main.inert = false;
    this.openButton.setAttribute("aria-expanded", "false");
    if (hadFocus) this.openButton.focus({ preventScroll: true });
  }

  #setCollapsed(collapsed) {
    const root = document.documentElement;
    if (collapsed) root.dataset.sidebar = "collapsed";
    else delete root.dataset.sidebar;
    storage.set("qwen.sidebar", collapsed ? "collapsed" : null);
    this.#syncLayout();
  }

  #syncLayout() {
    if (!this.isDrawer) this.closeDrawer();
    const collapsed = document.documentElement.dataset.sidebar === "collapsed";
    const expanded = this.isDrawer ? this.isDrawerOpen : !collapsed;
    this.openButton.setAttribute("aria-expanded", String(expanded));
    this.closeButton.setAttribute("aria-label", this.isDrawer ? "Close chats" : "Hide chats");
    this.closeButton.title = this.closeButton.getAttribute("aria-label");
  }

  #onSearchInput() {
    clearTimeout(this.#searchTimer);
    this.#searchAbort?.abort();
    const query = this.search.value.trim();
    if (!query) {
      this.#search = null;
      this.#render();
      return;
    }
    this.#searchTimer = setTimeout(async () => {
      const abort = (this.#searchAbort = new AbortController());
      try {
        this.#search = { query, chats: await api.listChats(query, abort.signal), error: null };
      } catch (err) {
        if (abort.signal.aborted) return;
        this.#search = { query, chats: [], error: `Search failed: ${err.message}` };
      }
      this.#render();
    }, SEARCH_DEBOUNCE_MS);
  }

  #render() {
    const now = new Date();
    if (this.#search) {
      const { query, chats, error } = this.#search;
      this.list.replaceChildren(
        chats.length
          ? this.#group(`Results for “${query}”`, chats, now)
          : h("p", { class: "list-empty", text: error ?? `No chats match “${query}”.` }),
      );
      return;
    }
    if (!this.#chats.length) {
      this.list.replaceChildren(h("p", { class: "list-empty", text: "No chats yet. Your conversations will appear here." }));
      return;
    }
    const groups = new Map(GROUP_ORDER.map((label) => [label, []]));
    for (const chat of this.#chats) groups.get(groupLabel(chat.updated_at, now)).push(chat);
    this.list.replaceChildren(
      ...[...groups].filter(([, chats]) => chats.length).map(([label, chats]) => this.#group(label, chats, now)),
    );
  }

  #group(label, chats, now) {
    return h(
      "section",
      { class: "chat-group" },
      h("h2", { class: "chat-group-label", text: label }),
      h("ul", { class: "chat-group-list", role: "list" }, chats.map((chat) => this.#row(chat, now))),
    );
  }

  #row(chat, now) {
    const title = chat.title || "New chat";
    const active = chat.id === this.#activeId;
    const link = h(
      "a",
      {
        class: "chat-link",
        href: `/c/${chat.id}`,
        "aria-current": active ? "page" : null,
        onclick: (event) => {
          if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
          event.preventDefault();
          this.actions.onOpen(chat.id);
        },
      },
      h("span", { class: "chat-row-title", text: title }),
      h("time", { class: "chat-row-time", datetime: chat.updated_at, title: fullDate(chat.updated_at), text: shortAge(chat.updated_at, now) }),
    );
    const menuButton = iconButton("more", `Options for ${title}`, { className: "icon-button chat-row-menu", title: "Options" });
    menuButton.setAttribute("aria-haspopup", "menu");
    menuButton.setAttribute("aria-expanded", "false");
    menuButton.addEventListener("click", () => this.openChatMenu(menuButton, chat));
    const classes = ["chat-row", active && "is-active", chat.id === this.#generatingId && "is-generating"].filter(Boolean).join(" ");
    return h("li", { class: classes, dataset: { id: chat.id } }, link, menuButton);
  }

  /** The Rename / Export / Delete menu for `chat`, anchored to `anchor` (also used by the header). */
  openChatMenu(anchor, chat, align = "end") {
    openMenu(
      anchor,
      [
        { label: "Rename", icon: "edit", onSelect: () => this.actions.onRename(chat) },
        { label: "Export as Markdown", icon: "download", onSelect: () => this.actions.onExport(chat) },
        { label: "Compact session", icon: "spark", disabled: !this.actions.canCompact?.(chat), onSelect: () => this.actions.onCompact?.(chat) },
        { label: "Delete", icon: "trash", danger: true, onSelect: () => this.actions.onDelete(chat) },
      ],
      { align, label: `Options for ${chat.title || "this chat"}` },
    );
  }

  #refreshTimes() {
    const now = new Date();
    for (const time of this.list.querySelectorAll(".chat-row-time")) time.textContent = shortAge(time.dateTime, now);
  }
}
