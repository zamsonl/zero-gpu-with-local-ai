// Ordinary storage helpers. No embeddings, secondary models or external AI service.
export const LONG_INPUT_COLUMNS = "id, chat_id, user_message_id, client_id, source_key, source_hash, bytes, total_chars, prompt_chars, think, chunk_plan, processed_chunks, total_chunks, notes, status, error, answer_message_id, created_at, updated_at";

export function publicLongInput(row) {
  if (!row) return null;
  const { source_key, chunk_plan, notes, ...source } = row;
  return { ...source, think: JSON.parse(source.think), source_url: `/v1/chats/${row.chat_id}/long-inputs/${row.id}/source` };
}

export async function hydrateLongInputs(db, chatId, messages) {
  const { results } = await db.prepare("SELECT user_message_id, notes, processed_chunks, total_chunks, id FROM long_inputs WHERE chat_id=?1 AND user_message_id IS NOT NULL").bind(chatId).all();
  const sources = new Map(results.map(row => [row.user_message_id, row]));
  return messages.map(message => {
    const source = sources.get(message.id);
    if (!source) return message;
    const coverage = source.processed_chunks === source.total_chunks ? "All source sections have been processed." : `Only ${source.processed_chunks} of ${source.total_chunks} source sections have been processed; the notes are incomplete.`;
    return { ...message, content: `${message.content}\n\n<saved_long_input_notes source_id="${source.id}">\n${coverage}\n${source.notes || "No reading notes have been saved yet."}\n</saved_long_input_notes>` };
  });
}

export async function longInputObjects(db, chatId, fromId = null) {
  const { results } = await db.prepare(`SELECT source_key FROM long_inputs WHERE chat_id=?1${fromId == null ? "" : " AND user_message_id>=?2"}`).bind(...(fromId == null ? [chatId] : [chatId, fromId])).all();
  return results.map(row => row.source_key);
}

export async function deleteLongInputObjects(db, bucket, keys) {
  if (!bucket || !keys.length) return;
  // R2 delete is idempotent. Restrict the namespace even for stored database values.
  const safe = keys.filter(key => typeof key === "string" && /^long-inputs\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+\.txt$/.test(key));
  if (safe.length) {
    try {
      await bucket.delete(safe);
      await db.batch(safe.map(key => db.prepare("DELETE FROM long_input_garbage WHERE source_key=?1").bind(key)));
    } catch (error) {
      // Deletion tombstones continue to reserve these bytes. A later upload retries cleanup.
      console.error("long input R2 cleanup deferred", error?.message);
    }
  }
}

export async function retryLongInputCleanup(db, bucket) {
  if (!bucket) return;
  const { results } = await db.prepare("SELECT source_key FROM long_input_garbage ORDER BY created_at LIMIT 20").all();
  await deleteLongInputObjects(db, bucket, results.map(row => row.source_key));
}
