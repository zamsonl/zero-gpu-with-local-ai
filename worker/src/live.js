// The reply being generated, mirrored to D1 so other devices can follow it live.
//
// One `state` row (k='gen_live') holds the reply so far: written at most every FLUSH_MS while the
// reply streams, deleted when it ends (after the final message is saved). Any device viewing the
// chat polls GET /v1/chats/:id/live and renders what is there.

const KEY = "gen_live";
export const FLUSH_MS = 800;
const PROGRESS_FIELDS = ["operation", "phase", "chunk", "chunks", "finish_reason", "transport_state", "transport_detail", "transport_attempt", "attempt"];

export class LiveReply {
  #db;
  #snapshot;
  #timer = null;
  #writing = null;
  #lastFlush = 0;
  #closed = false;

  /** `content`/`thinking`: what a continued reply already had, so followers see it whole. */
  constructor(db, { owner, chatId, userMessageId, assistantMessageId = null, content = "", thinking = "" }) {
    this.#db = db;
    const now = new Date().toISOString();
    this.#snapshot = {
      owner,
      chat_id: chatId,
      user_message_id: userMessageId,
      content,
      thinking,
      state: "waiting",
      detail: "",
      since: now,
      updated_at: now,
    };
    if (Number.isSafeInteger(assistantMessageId) && assistantMessageId > 0) this.#snapshot.assistant_message_id = assistantMessageId;
    this.#schedule(0);
  }

  /** Mirrors the owner's complete status envelope, or records newly produced text. */
  update({ content = "", thinking = "", state, detail, assistantMessageId, ...progress } = {}) {
    if (this.#closed) return;
    const s = this.#snapshot;
    if (Number.isSafeInteger(assistantMessageId) && assistantMessageId > 0) s.assistant_message_id = assistantMessageId;
    s.content += content;
    s.thinking += thinking;
    if (content || thinking) {
      // New output proves that the old saving/extracting/transport step ended.
      // Retain the operation for context, but never show its stale phase/detail.
      s.state = s.phase = content ? "answering" : "thinking";
      s.detail = "";
      for (const field of PROGRESS_FIELDS) if (field !== "operation" && field !== "phase") delete s[field];
    } else {
      if (state) {
        s.state = state;
        s.detail = detail ?? "";
        // A status event is a new complete envelope, including explicit null
        // resets. Metadata-only updates must not erase an in-flight status.
        for (const field of PROGRESS_FIELDS) delete s[field];
      } else if (detail !== undefined) s.detail = detail ?? "";
      for (const field of PROGRESS_FIELDS) if (progress[field] !== undefined) s[field] = progress[field];
    }
    this.#schedule(Math.max(0, FLUSH_MS - (Date.now() - this.#lastFlush)));
  }

  /** Removes the row. Call after the final message is saved. Never throws. */
  async finish() {
    this.#closed = true;
    clearTimeout(this.#timer);
    this.#timer = null;
    try {
      await this.#writing;
      await this.#db
        .prepare("DELETE FROM state WHERE k = ?1 AND json_extract(v, '$.owner') = ?2")
        .bind(KEY, this.#snapshot.owner)
        .run();
    } catch (err) {
      console.error("clearing the live reply failed:", err);
    }
  }

  #schedule(delay) {
    if (this.#timer || this.#closed) return;
    this.#timer = setTimeout(() => {
      this.#timer = null;
      this.#flush();
    }, delay);
  }

  #flush() {
    if (this.#closed || this.#writing) {
      if (!this.#closed) this.#schedule(FLUSH_MS);
      return;
    }
    const s = this.#snapshot;
    s.updated_at = new Date().toISOString();
    this.#lastFlush = Date.now();
    this.#writing = this.#db
      .prepare(
        `INSERT INTO state (k, v, updated_at) VALUES (?1, ?2, ?3)
         ON CONFLICT (k) DO UPDATE SET v = excluded.v, updated_at = excluded.updated_at`,
      )
      .bind(KEY, JSON.stringify(s), s.updated_at)
      .run()
      .catch((err) => console.error("writing the live reply failed:", err))
      .finally(() => (this.#writing = null));
  }
}

/** The reply being generated in `chatId`, or null. A row not refreshed for a minute is ignored. */
export async function readLiveReply(db, chatId) {
  const row = await db.prepare("SELECT v FROM state WHERE k = ?1").bind(KEY).first();
  if (!row) return null;
  const live = JSON.parse(row.v);
  if (live.chat_id !== chatId || Date.parse(live.updated_at) < Date.now() - 60_000) return null;
  const { owner, ...visible } = live;
  return visible;
}
