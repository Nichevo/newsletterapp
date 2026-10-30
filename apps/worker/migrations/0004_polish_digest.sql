-- One-tap unsubscribe, per-source bulk actions, scores and the daily digest.
ALTER TABLE items ADD COLUMN list_unsubscribe_post TEXT;
ALTER TABLE sources ADD COLUMN unsubscribed_at INTEGER;

CREATE INDEX items_score ON items(status, score DESC, received_at DESC);

CREATE TABLE digests (
  id TEXT PRIMARY KEY,
  day TEXT NOT NULL UNIQUE, -- YYYY-MM-DD in the reader's time zone
  created_at INTEGER NOT NULL,
  from_at INTEGER NOT NULL,
  to_at INTEGER NOT NULL,
  body TEXT NOT NULL -- JSON Digest
);
