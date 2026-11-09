-- Chat history, the registered Colab target and the generation lock.

CREATE TABLE chats (
  id TEXT PRIMARY KEY,                 -- client- or server-generated, [A-Za-z0-9_-]{1,64}
  title TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,            -- ISO 8601 UTC
  updated_at TEXT NOT NULL,            -- bumped by new messages, NOT by rename
  message_count INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX chats_updated ON chats(updated_at DESC);

CREATE TABLE messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('user','assistant')),
  content TEXT NOT NULL,
  thinking TEXT,                       -- assistant reasoning, shown in UI, never sent back as context
  status TEXT NOT NULL DEFAULT 'complete'
    CHECK (status IN ('complete','stopped','length','error')),
  stats TEXT,                          -- JSON: eval_count, tokens_per_sec, prompt_eval_count, total_ms, done_reason
  created_at TEXT NOT NULL
);
CREATE INDEX messages_chat ON messages(chat_id, id);

CREATE TABLE state (k TEXT PRIMARY KEY, v TEXT NOT NULL, updated_at TEXT NOT NULL);
-- k='target'   v=JSON {"target":"https://...","at":"ISO"}
-- k='gen_lock' v=JSON {"owner":"<uuid>","chat_id":"...","since":"ISO","heartbeat":"ISO"}
