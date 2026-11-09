// Date helpers for the chat list, the status panel and live timers. All in the viewer's time zone.

const DAY_MS = 86_400_000;

function startOfDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

/** "Today", "Yesterday", "Previous 7 days" or "Older", by calendar day. */
export function groupLabel(iso, now = new Date()) {
  const days = Math.round((startOfDay(now) - startOfDay(new Date(iso))) / DAY_MS);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days <= 7) return "Previous 7 days";
  return "Older";
}

export const GROUP_ORDER = ["Today", "Yesterday", "Previous 7 days", "Older"];

/** Compact age for list rows: "now", "4 min", "3 h", "Mon", "12 Mar", "12 Mar 2025". */
export function shortAge(iso, now = new Date()) {
  const date = new Date(iso);
  const seconds = Math.max(0, (now - date) / 1000);
  if (seconds < 60) return "now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min`;
  if (seconds < 86_400 && startOfDay(now) === startOfDay(date)) return `${Math.floor(seconds / 3600)} h`;
  const days = Math.round((startOfDay(now) - startOfDay(date)) / DAY_MS);
  if (days === 1) return "Yesterday";
  if (days < 7) return date.toLocaleDateString(undefined, { weekday: "short" });
  const sameYear = date.getFullYear() === now.getFullYear();
  return date.toLocaleDateString(undefined, { day: "numeric", month: "short", year: sameYear ? undefined : "numeric" });
}

/** "just now", "5 minutes ago", "3 hours ago", "2 days ago". */
export function timeAgo(iso, now = Date.now()) {
  const seconds = Math.max(0, (now - Date.parse(iso)) / 1000);
  if (seconds < 45) return "just now";
  const units = [
    ["day", 86_400],
    ["hour", 3600],
    ["minute", 60],
  ];
  for (const [unit, size] of units) {
    const count = Math.round(seconds / size);
    if (seconds >= size * 0.75 && count >= 1) return `${count} ${unit}${count === 1 ? "" : "s"} ago`;
  }
  return "just now";
}

/** "0:42", "4:05", "1:02:03" for a live waiting timer. */
export function clock(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

export function fullDate(iso) {
  return new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}
