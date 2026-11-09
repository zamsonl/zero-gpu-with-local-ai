// POST /v1/import: idempotent bulk import of chats (existing chat ids are skipped entirely).
//
// D1 limits shape this module: at most 100 bound parameters per statement, and (contract) at most
// 50 statements per batch. Each chat's statements go into a single batch, which D1 runs as one
// transaction, so a failure can never leave half a chat behind for a retry to skip. The per-request
// caps keep one import well under D1's 1000-queries-per-invocation limit.

import { badRequest, tooLarge } from "./http.js";
import { chunk, nowIso } from "./util.js";
import { expectChatId, expectContent, expectIsoDate, expectString, normalizeTitle } from "./validate.js";

/** Imports carry whole histories, so they get a larger body allowance than other JSON requests. */
export const IMPORT_BODY_LIMIT = 4 * 1024 * 1024;
const MAX_CHATS = 100;
const MAX_MESSAGES = 5000;
const MAX_PARAMS = 100;
const MAX_BATCH = 50;
const PARAMS_PER_MESSAGE = 5;
const MESSAGES_PER_INSERT = Math.floor(MAX_PARAMS / PARAMS_PER_MESSAGE);
const MAX_MESSAGES_PER_CHAT = (MAX_BATCH - 1) * MESSAGES_PER_INSERT;

/** Validates and normalises the request body into chats ready to insert. */
export function parseImport(body) {
  if (!Array.isArray(body.chats)) throw badRequest('"chats" must be an array.');
  if (body.chats.length > MAX_CHATS) throw tooLarge(`Import at most ${MAX_CHATS} chats per request.`);
  let total = 0;
  return body.chats.map((chat, i) => {
    const where = `chats[${i}]`;
    if (!isObject(chat)) throw badRequest(`"${where}" must be an object.`);
    if (!Array.isArray(chat.messages)) throw badRequest(`"${where}.messages" must be an array.`);
    if (chat.messages.length > MAX_MESSAGES_PER_CHAT) {
      throw tooLarge(`"${where}" has more than ${MAX_MESSAGES_PER_CHAT} messages.`);
    }
    total += chat.messages.length;
    if (total > MAX_MESSAGES) throw tooLarge(`Import at most ${MAX_MESSAGES} messages per request.`);

    const created_at = chat.created_at == null ? nowIso() : expectIsoDate(chat.created_at, `${where}.created_at`);
    return {
      id: expectChatId(chat.id, `${where}.id`),
      title: chat.title == null ? "" : normalizeTitle(expectString(chat.title, `${where}.title`)),
      created_at,
      updated_at: chat.updated_at == null ? created_at : expectIsoDate(chat.updated_at, `${where}.updated_at`),
      messages: chat.messages.map((m, j) => parseMessage(m, `${where}.messages[${j}]`, created_at)),
    };
  });
}

function parseMessage(message, where, fallbackDate) {
  if (!isObject(message)) throw badRequest(`"${where}" must be an object.`);
  if (message.role !== "user" && message.role !== "assistant") {
    throw badRequest(`"${where}.role" must be "user" or "assistant".`);
  }
  const thinking =
    message.thinking == null ? null : expectContent(message.thinking, `${where}.thinking`, { allowEmpty: true });
  return {
    role: message.role,
    content: expectContent(message.content, `${where}.content`, { allowEmpty: true }),
    thinking: thinking || null,
    created_at: message.created_at == null ? fallbackDate : expectIsoDate(message.created_at, `${where}.created_at`),
  };
}

/** @returns {Promise<{imported: number, skipped: number}>} */
export async function importChats(db, chats) {
  const unique = new Map();
  for (const chat of chats) if (!unique.has(chat.id)) unique.set(chat.id, chat);
  const existing = await existingChatIds(db, [...unique.keys()]);
  const fresh = [...unique.values()].filter((chat) => !existing.has(chat.id));

  let batch = [];
  for (const chat of fresh) {
    const statements = chatStatements(db, chat);
    if (batch.length + statements.length > MAX_BATCH) {
      await db.batch(batch);
      batch = [];
    }
    batch.push(...statements);
  }
  if (batch.length) await db.batch(batch);

  return { imported: fresh.length, skipped: chats.length - fresh.length };
}

async function existingChatIds(db, ids) {
  const found = new Set();
  for (const group of chunk(ids, MAX_PARAMS)) {
    const { results } = await db
      .prepare(`SELECT id FROM chats WHERE id IN (${group.map(() => "?").join(", ")})`)
      .bind(...group)
      .all();
    for (const row of results) found.add(row.id);
  }
  return found;
}

function chatStatements(db, chat) {
  const statements = [
    db
      .prepare("INSERT INTO chats (id, title, created_at, updated_at, message_count) VALUES (?, ?, ?, ?, ?)")
      .bind(chat.id, chat.title, chat.created_at, chat.updated_at, chat.messages.length),
  ];
  // Multi-row inserts keep row order, so message ids stay in conversation order.
  for (const rows of chunk(chat.messages, MESSAGES_PER_INSERT)) {
    statements.push(
      db
        .prepare(
          `INSERT INTO messages (chat_id, role, content, thinking, created_at) VALUES ${rows
            .map(() => "(?, ?, ?, ?, ?)")
            .join(", ")}`,
        )
        .bind(...rows.flatMap((m) => [chat.id, m.role, m.content, m.thinking, m.created_at])),
    );
  }
  return statements;
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
