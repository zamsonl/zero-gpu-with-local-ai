-- A replaceable memory checkpoint; original messages remain the transcript.
CREATE TABLE chat_context (
  chat_id TEXT PRIMARY KEY REFERENCES chats(id) ON DELETE CASCADE,
  summary TEXT NOT NULL,
  through_id INTEGER NOT NULL,
  covered_count INTEGER NOT NULL,
  source_digest TEXT NOT NULL,
  model TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
