-- Key sentences: the PC marks the sentences that carry a long article, by kind
-- (main point, evidence, example, caveat, takeaway), and the reader colours
-- them. One row per article in key_sentences, kept apart from highlights.

-- NULL = never looked at; pending | working -> done | none (skipped) | failed.
ALTER TABLE items ADD COLUMN ks_status TEXT;
ALTER TABLE items ADD COLUMN ks_at INTEGER;
ALTER TABLE items ADD COLUMN ks_attempts INTEGER NOT NULL DEFAULT 0;
-- 1 when asked for by hand in the reader: goes first and skips the length check.
ALTER TABLE items ADD COLUMN ks_manual INTEGER NOT NULL DEFAULT 0;
-- The queue the PC claims from: only waiting rows are in this index.
CREATE INDEX IF NOT EXISTS items_ks_queue ON items(ks_manual DESC, received_at DESC) WHERE ks_status IN ('pending', 'working');
-- The inbox "Key sentences" filter.
CREATE INDEX IF NOT EXISTS items_ks_done ON items(received_at DESC) WHERE ks_status = 'done';

-- Per source: NULL = Auto (by length), 'always', 'never'.
ALTER TABLE sources ADD COLUMN key_sentences TEXT;

CREATE TABLE IF NOT EXISTS key_sentences (
  item_id TEXT PRIMARY KEY,
  provider TEXT,
  model TEXT,
  prompt_version INTEGER,
  -- JSON list of {kind, quote, prefix, suffix, textOffset, fix?, was?}
  marks TEXT NOT NULL,
  sentences INTEGER,
  words INTEGER,
  -- Why it was skipped or failed, for the reader.
  note TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- One row per PC run, for usage limits, running cost and statistics.
CREATE TABLE IF NOT EXISTS ks_runs (
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  prompt_version INTEGER,
  seconds REAL,
  watts INTEGER,
  ok INTEGER NOT NULL,
  -- short | roundup | empty when checked and skipped
  skipped TEXT,
  marks INTEGER,
  manual INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ks_runs_at ON ks_runs(at);
