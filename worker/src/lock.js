// The generation lock: one D1 `state` row (k='gen_lock') so only one reply runs on the GPU at a time.
// A holder heartbeats while it generates; a lock whose heartbeat is older than LOCK_STALE_MS was
// left behind by a dead invocation and may be taken over.
//
// Any device can ask the holder to stop (POST /v1/stop): that stamps `stop` on the row, and the
// holder, which re-reads its row every STOP_POLL_MS, aborts its reply when it sees the stamp or
// finds the row gone or taken over.

const KEY = "gen_lock";
// Heartbeats every 5 s; six missed in a row (30 s) mean the holder died without releasing.
export const LOCK_STALE_MS = 30_000;
export const LOCK_HEARTBEAT_MS = 5_000;
export const STOP_POLL_MS = 1_000;

export class GenerationLock {
  #db;
  #owner;
  #timer = null;
  #stopTimer = null;

  constructor(db, owner) {
    this.#db = db;
    this.#owner = owner;
  }

  get id() { return this.#owner; }

  /**
   * Atomically takes the lock for `chatId`.
   * @returns {Promise<{lock: GenerationLock} | {busy: {chat_id: string, since: string}}>}
   */
  static async acquire(db, chatId, { operation = null } = {}) {
    // A failed take-over followed by a vanished row means the holder released in between: try again.
    for (let attempt = 0; attempt < 3; attempt++) {
      const owner = crypto.randomUUID();
      const now = Date.now();
      const iso = new Date(now).toISOString();
      const value = JSON.stringify({ owner, chat_id: chatId, since: iso, heartbeat: iso, ...(operation ? { operation } : {}) });
      const { meta } = await db
        .prepare(
          `INSERT INTO state (k, v, updated_at) VALUES (?1, ?2, ?3)
           ON CONFLICT (k) DO UPDATE SET v = excluded.v, updated_at = excluded.updated_at
           WHERE json_extract(state.v, '$.heartbeat') < ?4`,
        )
        .bind(KEY, value, iso, new Date(now - LOCK_STALE_MS).toISOString())
        .run();
      if (meta.changes === 1) return { lock: new GenerationLock(db, owner) };

      const holder = await readLockRow(db);
      if (holder) return { busy: busyInfo(holder) };
    }
    throw new Error("could not acquire the generation lock");
  }

  startHeartbeat() {
    this.#timer ??= setInterval(() => {
      this.#db
        .prepare(
          `UPDATE state SET v = json_set(v, '$.heartbeat', ?2), updated_at = ?2
           WHERE k = ?1 AND json_extract(v, '$.owner') = ?3`,
        )
        .bind(KEY, new Date().toISOString(), this.#owner)
        .run()
        .catch((err) => console.error("lock heartbeat failed:", err));
    }, LOCK_HEARTBEAT_MS);
  }

  /** Calls `onStop` once when a stop is requested for this lock (or it is no longer ours). */
  watchForStop(onStop, pollMs = STOP_POLL_MS) {
    if (this.#stopTimer) return;
    let checking = false;
    this.#stopTimer = setInterval(async () => {
      if (checking) return;
      checking = true;
      try {
        const holder = await readLockRow(this.#db);
        if (!holder || holder.owner !== this.#owner || holder.stop) {
          clearInterval(this.#stopTimer);
          onStop();
        }
      } catch (err) {
        console.error("stop check failed:", err);
      } finally {
        checking = false;
      }
    }, pollMs);
  }

  /** Stops the heartbeat and deletes the row if this lock still owns it. Never throws. */
  async release() {
    clearInterval(this.#timer);
    clearInterval(this.#stopTimer);
    this.#timer = null;
    this.#stopTimer = null;
    try {
      await this.#db
        .prepare("DELETE FROM state WHERE k = ?1 AND json_extract(v, '$.owner') = ?2")
        .bind(KEY, this.#owner)
        .run();
    } catch (err) {
      // The lock goes stale on its own after LOCK_STALE_MS without heartbeats.
      console.error("lock release failed:", err);
    }
  }
}

/**
 * Asks whoever is generating to stop. A stale lock (its holder is dead) is cleared on the spot.
 * @returns {Promise<{stopped: boolean, busy: {chat_id: string, since: string} | null}>}
 */
export async function requestStop(db, { generationId = null, chatId = null } = {}) {
  const holder = await readLockRow(db);
  if (!holder) return { stopped: false, busy: null };
  const busy = busyInfo(holder);
  if (generationId && holder.owner !== generationId || chatId && holder.chat_id !== chatId) return { stopped: false, busy };
  if (Date.parse(holder.heartbeat) < Date.now() - LOCK_STALE_MS) {
    await db
      .prepare("DELETE FROM state WHERE k = ?1 AND json_extract(v, '$.owner') = ?2")
      .bind(KEY, holder.owner)
      .run();
    return { stopped: true, busy };
  }
  const { meta } = await db
    .prepare(
      `UPDATE state SET v = json_set(v, '$.stop', ?2), updated_at = ?2
       WHERE k = ?1 AND json_extract(v, '$.owner') = ?3`,
    )
    .bind(KEY, new Date().toISOString(), holder.owner)
    .run();
  return { stopped: meta.changes === 1, busy };
}

/** The live (non-stale) holder, or null. */
export async function readActiveLock(db) {
  const holder = await readLockRow(db);
  if (!holder || Date.parse(holder.heartbeat) < Date.now() - LOCK_STALE_MS) return null;
  return busyInfo(holder);
}

function busyInfo(holder) {
  return { chat_id: holder.chat_id, since: holder.since, ...(holder.operation ? { operation: holder.operation } : {}) };
}

async function readLockRow(db) {
  const row = await db.prepare("SELECT v FROM state WHERE k = ?1").bind(KEY).first();
  return row ? JSON.parse(row.v) : null;
}
