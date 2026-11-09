// Markdown rendering of a chat for GET /v1/chats/:id/export.

const STATUS_NOTES = {
  stopped: "Reply stopped before it finished.",
  length: "Reply hit the length cap.",
  error: "Reply failed partway through.",
};

export function chatMarkdown(chat, messages) {
  const lines = [
    `# ${chat.title || "Untitled chat"}`,
    "",
    `_Created ${chat.created_at} · updated ${chat.updated_at} · ${messages.length} messages_`,
  ];
  for (const message of messages) {
    lines.push("", "---", "", message.role === "user" ? "## You" : "## Assistant", "");
    if (message.thinking) {
      lines.push("<details>", "<summary>Thinking</summary>", "", message.thinking, "", "</details>", "");
    }
    lines.push(message.content);
    for (const file of message.attachments ?? []) {
      if (typeof file.data === "string") {
        // Pictures are embedded, so the exported file shows them without the chat.
        lines.push("", `![${file.name.replace(/[[\]]/g, "")}](data:${file.type};base64,${file.data})`);
        continue;
      }
      const fence = "`".repeat(Math.max(3, longestBacktickRun(file.text) + 1));
      lines.push("", "<details>", `<summary>Attached: ${file.name}</summary>`, "", fence, file.text, fence, "", "</details>");
    }
    const notes = [STATUS_NOTES[message.status], statsLine(message.stats)].filter(Boolean);
    if (notes.length) lines.push("", `_${notes.join(" · ")}_`);
  }
  return lines.join("\n") + "\n";
}

/** Lowercase ASCII slug of the title for the download name; "chat" when nothing is left. */
export function exportFilename(title) {
  const slug = title
    .normalize("NFKD")
    .replace(/\p{M}/gu, "") // accents split off by NFKD
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/, "");
  return `${slug || "chat"}.md`;
}

/** A fence longer than any backtick run inside the file, so the file can't close it early. */
function longestBacktickRun(text) {
  return Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
}

function statsLine(stats) {
  if (!stats) return "";
  const parts = [];
  if (stats.tokens_per_sec != null) parts.push(`${stats.tokens_per_sec} tok/s`);
  if (stats.eval_count != null) parts.push(`${stats.eval_count} tokens`);
  return parts.join(" · ");
}
