-- Originals stay in R2; D1 stores a resumable reading cursor and Qwen's bounded notes.
CREATE TABLE long_inputs (
  id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  user_message_id INTEGER REFERENCES messages(id) ON DELETE CASCADE,
  client_id TEXT NOT NULL,
  source_key TEXT NOT NULL UNIQUE,
  source_hash TEXT NOT NULL,
  bytes INTEGER NOT NULL CHECK(bytes > 0),
  total_chars INTEGER NOT NULL CHECK(total_chars > 0),
  prompt_chars INTEGER NOT NULL DEFAULT 0,
  think TEXT NOT NULL DEFAULT '"medium"',
  chunk_plan TEXT NOT NULL,
  processed_chunks INTEGER NOT NULL DEFAULT 0,
  total_chunks INTEGER NOT NULL DEFAULT 0,
  notes TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'ready',
  error TEXT,
  answer_message_id INTEGER REFERENCES messages(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(chat_id, client_id)
);
CREATE INDEX long_inputs_chat ON long_inputs(chat_id, created_at DESC);
CREATE INDEX long_inputs_message ON long_inputs(user_message_id);

-- Keep charged bytes reserved if an R2 cleanup fails after a chat/message deletion.
CREATE TABLE long_input_garbage (source_key TEXT PRIMARY KEY, bytes INTEGER NOT NULL, created_at TEXT NOT NULL);
CREATE TRIGGER long_inputs_cleanup BEFORE DELETE ON long_inputs BEGIN
  INSERT OR IGNORE INTO long_input_garbage(source_key,bytes,created_at) VALUES(old.source_key,old.bytes,old.updated_at);
END;
