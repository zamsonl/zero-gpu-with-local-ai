// Chat CRUD, search, export and import handlers under /v1.

import { HttpError, badRequest, json, notFound, readJsonObject } from "./http.js";
import { IMPORT_BODY_LIMIT, importChats, parseImport } from "./import.js";
import { chatMarkdown, exportFilename } from "./export.js";
import { readActiveLock } from "./lock.js";
import * as store from "./store.js";
import { nowIso, randomId } from "./util.js";
import { expectChatId, expectString, normalizeTitle } from "./validate.js";

const MAX_QUERY_CHARS = 200;

export async function listChats({ env, url }) {
  const query = (url.searchParams.get("q") ?? "").trim();
  if (query.length > MAX_QUERY_CHARS) throw badRequest(`"q" is longer than ${MAX_QUERY_CHARS} characters.`);
  return json({ chats: await store.listChats(env.DB, query) });
}

/** Creating an id that already exists returns that chat with 200, so a retried create is harmless. */
export async function createChat({ env, request }) {
  const body = await readJsonObject(request);
  const id = body.id == null ? randomId() : expectChatId(body.id);
  const title = body.title == null ? "" : normalizeTitle(expectString(body.title, "title"));
  const created = await store.insertChat(env.DB, { id, title, now: nowIso() });
  if (created) return json({ chat: created }, 201);
  return json({ chat: await store.getChat(env.DB, id) });
}

export async function getChat({ env, params }) {
  const chat = await requireChat(env.DB, params.id);
  return json({ chat, messages: await store.listMessages(env.DB, chat.id) });
}

export async function renameChat({ env, request, params }) {
  const body = await readJsonObject(request);
  const title = normalizeTitle(expectString(body.title, "title"));
  if (!title) throw badRequest('"title" must not be empty.');
  const chat = await store.renameChat(env.DB, params.id, title);
  if (!chat) throw notFound("No chat with this id.");
  return json({ chat });
}

export async function deleteChat({ env, params }) {
  const busy = await readActiveLock(env.DB);
  if (busy?.chat_id === params.id) {
    throw new HttpError(409, "busy", "A reply is being generated in this chat. Stop it first.", { busy });
  }
  if (!(await store.deleteChat(env.DB, params.id, env.IMAGES))) throw notFound("No chat with this id.");
  return json({ ok: true });
}

export async function exportChat({ env, params }) {
  const chat = await requireChat(env.DB, params.id);
  // Markdown assembly is buffered. Refuse a large aggregate before loading R2 originals
  // or message bodies into memory; each full source still has its own download endpoint.
  const payload = await env.DB.prepare(`SELECT
    (SELECT COALESCE(SUM(length(CAST(content AS BLOB))+COALESCE(length(CAST(thinking AS BLOB)),0)+COALESCE(length(CAST(attachments AS BLOB)),0)),0) FROM messages WHERE chat_id=?1)
    +(SELECT COALESCE(SUM(bytes),0) FROM long_inputs WHERE chat_id=?1) AS bytes`).bind(chat.id).first();
  if (payload.bytes > 16 * 1024 * 1024) throw new HttpError(413, "export_size", "This chat is too large for a combined export. Download its full inputs individually from their source links.");
  const messages = await store.listMessages(env.DB, chat.id);
  // Exports include full originals, rather than only a link that depends on this deployment.
  const { results: sources } = await env.DB.prepare("SELECT user_message_id,source_key,id FROM long_inputs WHERE chat_id=?1 AND user_message_id IS NOT NULL").bind(chat.id).all();
  for (const source of sources) {
    const message = messages.find(item => item.id === source.user_message_id);
    if (!message) continue;
    const object = env.IMAGES ? await env.IMAGES.get(source.source_key) : null;
    message.attachments.push({ name: `full-input-${source.id}.txt`, type: "text/plain", text: object ? await object.text() : "The original source is unavailable from storage." });
  }
  return new Response(chatMarkdown(chat, messages), {
    headers: {
      "content-type": "text/markdown; charset=utf-8",
      "content-disposition": `attachment; filename="${exportFilename(chat.title)}"`,
      "cache-control": "no-store",
    },
  });
}

export async function importChatsHandler({ env, request }) {
  const chats = parseImport(await readJsonObject(request, IMPORT_BODY_LIMIT));
  return json(await importChats(env.DB, chats));
}

export async function requireChat(db, id) {
  const chat = await store.getChat(db, id);
  if (!chat) throw notFound("No chat with this id.");
  return chat;
}
