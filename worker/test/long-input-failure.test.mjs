import assert from "node:assert/strict";
import { test } from "node:test";
import { createLongInput } from "../src/long-input.js";

// Exercise the actual preparation handler with a database that loses its batch
// acknowledgement after committing. R2 is tracked independently of the database.
function fixture({ commitBeforeFailure }) {
  const chat = { id: "owned-ack-fixture", title: "", created_at: "2026-10-30T00:00:00Z", updated_at: "2026-10-30T00:00:00Z", message_count: 0 };
  const objects = new Map(), messages = [];
  const calls = { puts: 0, deletes: 0, lockAcquires: 0, creationBatches: 0 };
  let source = null;
  const db = {
    prepare(sql) {
      return {
        sql, values: [],
        bind(...values) { this.values = values; return this; },
        async first() {
          if (sql.includes("FROM chats WHERE id")) return { ...chat };
          if (sql.includes("FROM long_inputs WHERE chat_id=?1 AND client_id=?2")) {
            return source && source.chat_id === this.values[0] && source.client_id === this.values[1] ? { ...source } : null;
          }
          throw new Error(`Unexpected first: ${sql}`);
        },
        async all() {
          if (sql.includes("FROM long_input_garbage")) return { results: [] };
          if (sql.includes("FROM messages WHERE chat_id")) return { results: messages.map(message => ({ ...message })) };
          throw new Error(`Unexpected all: ${sql}`);
        },
        async run() {
          if (sql.includes("INSERT INTO state")) { calls.lockAcquires++; return { meta: { changes: 1 } }; }
          if (sql.includes("DELETE FROM state")) return { meta: { changes: 1 } };
          if (sql.includes("INSERT INTO long_inputs")) {
            const [id, chat_id, client_id, source_key, source_hash, bytes, total_chars, prompt_chars, think, chunk_plan, total_chunks, at] = this.values;
            source = { id, chat_id, client_id, source_key, source_hash, bytes, total_chars, prompt_chars, think, chunk_plan, total_chunks,
              user_message_id: null, processed_chunks: 0, notes: "", status: "ready", error: null, answer_message_id: null, created_at: at, updated_at: at };
            return { meta: { changes: 1 } };
          }
          if (sql.includes("DELETE FROM long_inputs") && sql.includes("user_message_id IS NULL")) {
            const changes = source && source.user_message_id == null ? 1 : 0;
            if (changes) source = null;
            return { meta: { changes } };
          }
          throw new Error(`Unexpected run: ${sql}`);
        },
      };
    },
    async batch(statements) {
      if (statements[0].sql.includes("INSERT INTO messages")) {
        calls.creationBatches++;
        if (commitBeforeFailure) {
          const [chat_id, content, created_at] = statements[0].values;
          messages.push({ id: 71, chat_id, role: "user", content, created_at, thinking: null, status: "complete", stats: null, attachments: null });
          source.user_message_id = 71;
          chat.message_count = 1;
          chat.title = statements[2].values[1];
        }
        throw new Error(commitBeforeFailure ? "Lost creation acknowledgement after commit" : "Creation transaction rolled back");
      }
      assert(statements.every(statement => statement.sql.includes("DELETE FROM long_input_garbage")));
      return statements.map(() => ({ meta: { changes: 1 }, results: [] }));
    },
  };
  const env = { DB: db, IMAGES: {
    async put(key, value) { calls.puts++; objects.set(key, value); },
    async delete(keys) { calls.deletes++; for (const key of Array.isArray(keys) ? keys : [keys]) objects.delete(key); },
  } };
  const body = { content: "Important exact task code ACK_841. Preserve the complete original.", attachments: [], think: false, consent: true, client_id: "owned-stable-ack-request" };
  const prepare = () => createLongInput({ env, params: { id: chat.id }, request: new Request(`https://fixture.invalid/v1/chats/${chat.id}/long-inputs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) });
  return { calls, objects, messages, prepare, source: () => source };
}

test("lost creation acknowledgement preserves linked original and retry returns the same message without another upload", async () => {
  const f = fixture({ commitBeforeFailure: true });
  await assert.rejects(f.prepare(), /Lost creation acknowledgement after commit/);
  assert.equal(f.messages.length, 1);
  assert.equal(f.source().user_message_id, f.messages[0].id);
  assert.equal(f.objects.get(f.source().source_key), "Important exact task code ACK_841. Preserve the complete original.");
  assert.equal(f.calls.deletes, 0, "A linked original must survive an ambiguous database result");
  const result = await (await f.prepare()).json();
  assert.equal(result.source.id, f.source().id);
  assert.equal(result.user_message.id, f.messages[0].id);
  assert.equal(f.calls.puts, 1);
  assert.equal(f.calls.creationBatches, 1);
  assert.equal(f.calls.lockAcquires, 1, "An idempotent retry returns saved data before acquiring another operation");
});

test("confirmed rollback removes the unlinked reservation and its orphaned original", async () => {
  const f = fixture({ commitBeforeFailure: false });
  await assert.rejects(f.prepare(), /Creation transaction rolled back/);
  assert.equal(f.source(), null);
  assert.equal(f.objects.size, 0);
  assert.equal(f.messages.length, 0);
  assert.equal(f.calls.puts, 1);
  assert.equal(f.calls.deletes, 1);
});
