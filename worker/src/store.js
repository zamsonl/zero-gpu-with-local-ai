// D1 access for chats and messages, and the mapping from rows to API objects.
import { hydrateLongInputs, longInputObjects, deleteLongInputObjects } from "./long-input-store.js";

const CHAT_COLUMNS = "id, title, created_at, updated_at, message_count";
const MESSAGE_COLUMNS = "id, chat_id, role, content, thinking, status, stats, attachments, created_at";
const LIST_LIMIT = 500;
const COUNT_MESSAGES = "(SELECT COUNT(*) FROM messages WHERE chat_id = ?1)";

export function toMessage(row) {
  return {
    ...row,
    thinking: row.thinking ?? null,
    stats: row.stats ? JSON.parse(row.stats) : null,
    attachments: row.attachments ? JSON.parse(row.attachments) : [],
  };
}

export function getChat(db, id) {
  return db.prepare(`SELECT ${CHAT_COLUMNS} FROM chats WHERE id = ?1`).bind(id).first();
}

/** Most recently updated first; `query` matches the title or any message, case-insensitively. */
export async function listChats(db, query) {
  if (!query) {
    const { results } = await db
      .prepare(`SELECT ${CHAT_COLUMNS} FROM chats ORDER BY updated_at DESC, id LIMIT ${LIST_LIMIT}`)
      .all();
    return results;
  }
  // instr() rather than LIKE: D1 caps LIKE patterns at 50 bytes, and nothing needs escaping.
  // SQLite's lower() folds ASCII only, so the query is folded the same way to line up.
  const needle = query.replace(/[A-Z]/g, (c) => c.toLowerCase());
  const { results } = await db
    .prepare(
      `SELECT ${CHAT_COLUMNS} FROM chats c
       WHERE instr(lower(c.title), ?1) > 0
          OR EXISTS (SELECT 1 FROM messages m WHERE m.chat_id = c.id AND instr(lower(m.content), ?1) > 0)
       ORDER BY c.updated_at DESC, c.id LIMIT ${LIST_LIMIT}`,
    )
    .bind(needle)
    .all();
  return results;
}

/** Creates the chat, or returns null when the id is taken. */
export function insertChat(db, { id, title, now }) {
  return db
    .prepare(
      `INSERT INTO chats (id, title, created_at, updated_at, message_count) VALUES (?1, ?2, ?3, ?3, 0)
       ON CONFLICT (id) DO NOTHING RETURNING ${CHAT_COLUMNS}`,
    )
    .bind(id, title, now)
    .first();
}

/** Renames without touching updated_at. Returns the chat, or null if it does not exist. */
export function renameChat(db, id, title) {
  return db
    .prepare(`UPDATE chats SET title = ?2 WHERE id = ?1 RETURNING ${CHAT_COLUMNS}`)
    .bind(id, title)
    .first();
}

/** Deletes the chat and its messages. Returns false if the chat did not exist. */
export async function deleteChat(db, id, bucket = null) {
  const keys = await longInputObjects(db, id);
  const results = await db.batch([
    db.prepare("DELETE FROM chat_context WHERE chat_id = ?1").bind(id),
    db.prepare("DELETE FROM messages WHERE chat_id = ?1").bind(id),
    db.prepare("DELETE FROM chats WHERE id = ?1").bind(id),
  ]);
  await deleteLongInputObjects(db, bucket, keys);
  return results.at(-1).meta.changes > 0;
}

export async function listMessages(db, chatId) {
  const { results } = await db
    .prepare(`SELECT ${MESSAGE_COLUMNS} FROM messages WHERE chat_id = ?1 ORDER BY id`)
    .bind(chatId)
    .all();
  return results.map(toMessage);
}

/** id, role, content and attachments of every message, oldest first: the turn endpoint's context. */
export async function listTranscript(db, chatId) {
  const { results } = await db
    .prepare("SELECT id, role, content, attachments FROM messages WHERE chat_id = ?1 ORDER BY id")
    .bind(chatId)
    .all();
  return hydrateLongInputs(db, chatId, results.map((r) => ({ ...r, attachments: r.attachments ? JSON.parse(r.attachments) : [] })));
}

/**
 * One transaction: drop messages from `replaceFrom` on (if given), append the user message, give
 * the chat `autoTitle` if it has no title yet, and bump its updated_at and message_count.
 */
export async function saveUserMessage(db, { chatId, replaceFrom, content, attachments = [], autoTitle, now, bucket = null }) {
  const keys = replaceFrom != null ? await longInputObjects(db, chatId, replaceFrom) : [];
  const statements = [];
  if (replaceFrom != null) {
    statements.push(db.prepare("DELETE FROM chat_context WHERE chat_id = ?1 AND through_id >= ?2").bind(chatId, replaceFrom));
    statements.push(db.prepare("DELETE FROM messages WHERE chat_id = ?1 AND id >= ?2").bind(chatId, replaceFrom));
  }
  statements.push(
    db
      .prepare(
        `INSERT INTO messages (chat_id, role, content, attachments, created_at) VALUES (?1, 'user', ?2, ?3, ?4)
         RETURNING ${MESSAGE_COLUMNS}`,
      )
      .bind(chatId, content, attachments.length ? JSON.stringify(attachments) : null, now),
    db
      .prepare(
        `UPDATE chats SET title = CASE WHEN title = '' THEN ?2 ELSE title END,
                          updated_at = ?3, message_count = ${COUNT_MESSAGES}
         WHERE id = ?1 RETURNING ${CHAT_COLUMNS}`,
      )
      .bind(chatId, autoTitle, now),
  );
  const results = await db.batch(statements);
  await deleteLongInputObjects(db, bucket, keys);
  const [message, chat] = results.slice(-2).map((r) => r.results[0]);
  return { message: toMessage(message), chat };
}

/** The last message of the chat (with thinking and status), or null when it has none. */
export async function lastMessage(db, chatId) {
  const row = await db
    .prepare(`SELECT ${MESSAGE_COLUMNS} FROM messages WHERE chat_id = ?1 ORDER BY id DESC LIMIT 1`)
    .bind(chatId)
    .first();
  return row ? toMessage(row) : null;
}

/**
 * Rewrites an assistant message that was continued (its text so far plus what was added) and
 * bumps the chat. Returns null when the message or chat no longer exists.
 */
export async function updateAssistantMessage(db, chatId, id, { content, thinking, status, stats, now }) {
  const results = await db.batch([
    db.prepare("DELETE FROM chat_context WHERE chat_id = ?1 AND through_id >= ?2").bind(chatId, id),
    db
      .prepare(
        `UPDATE messages SET content = ?3, thinking = ?4, status = ?5, stats = ?6
         WHERE id = ?2 AND chat_id = ?1 AND role = 'assistant' RETURNING ${MESSAGE_COLUMNS}`,
      )
      .bind(chatId, id, content, thinking || null, status, stats ? JSON.stringify(stats) : null),
    db.prepare(`UPDATE chats SET updated_at = ?2 WHERE id = ?1 RETURNING ${CHAT_COLUMNS}`).bind(chatId, now),
  ]);
  const [updated, chat] = results.slice(-2);
  const message = updated.results[0];
  return message && chat.results[0] ? { message: toMessage(message), chat: chat.results[0] } : null;
}

/**
 * Appends an assistant message and bumps the chat. Returns null when the chat no longer exists
 * (deleted while the reply was generating).
 */
export async function saveAssistantMessage(db, chatId, { content, thinking, status, stats, now }) {
  const [inserted, updated] = await db.batch([
    db
      .prepare(
        `INSERT INTO messages (chat_id, role, content, thinking, status, stats, created_at)
         SELECT ?1, 'assistant', ?2, ?3, ?4, ?5, ?6 WHERE EXISTS (SELECT 1 FROM chats WHERE id = ?1)
         RETURNING ${MESSAGE_COLUMNS}`,
      )
      .bind(chatId, content, thinking || null, status, stats ? JSON.stringify(stats) : null, now),
    db
      .prepare(
        `UPDATE chats SET updated_at = ?2, message_count = ${COUNT_MESSAGES}
         WHERE id = ?1 RETURNING ${CHAT_COLUMNS}`,
      )
      .bind(chatId, now),
  ]);
  const message = inserted.results[0];
  const chat = updated.results[0];
  return message && chat ? { message: toMessage(message), chat } : null;
}
