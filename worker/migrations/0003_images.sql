-- Pictures made with Qwen-Image 2.1 on the notebook's GPU. The page queues one; the notebook, in
-- image mode, takes the oldest queued, reports its steps and uploads the result to R2
-- (images/<id>.png and images/<id>.thumb.webp).
CREATE TABLE images (
  id TEXT PRIMARY KEY,                 -- randomId()
  prompt TEXT NOT NULL,
  negative TEXT NOT NULL DEFAULT '',
  aspect TEXT NOT NULL,                -- square | portrait | landscape | tall | wide
  width INTEGER NOT NULL,
  height INTEGER NOT NULL,
  speed TEXT NOT NULL,                 -- fast (turbo LoRA, 8 steps) | quality (25 steps)
  seed INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued','running','done','failed')),
  step INTEGER NOT NULL DEFAULT 0,
  steps INTEGER NOT NULL,
  error TEXT,
  bytes INTEGER,                       -- size of the PNG once done
  has_thumb INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,            -- ISO 8601 UTC
  started_at TEXT,
  updated_at TEXT NOT NULL,
  finished_at TEXT
);
CREATE INDEX images_created ON images(created_at DESC);
CREATE INDEX images_status ON images(status, created_at);
