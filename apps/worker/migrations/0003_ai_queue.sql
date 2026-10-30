-- Phase 2, part 2: the AI job queue the PC helper pulls from, prompts,
-- models, and a record of every summary run for the statistics screen.

-- pending -> working -> done | failed; NULL = never queued (e.g. screening).
ALTER TABLE items ADD COLUMN ai_status TEXT;
ALTER TABLE items ADD COLUMN ai_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE items ADD COLUMN ai_claimed_at INTEGER;
ALTER TABLE items ADD COLUMN ai_error TEXT;
ALTER TABLE items ADD COLUMN ai_category TEXT;
ALTER TABLE items ADD COLUMN why_it_matters TEXT;
ALTER TABLE items ADD COLUMN thin_content INTEGER NOT NULL DEFAULT 0;
ALTER TABLE items ADD COLUMN ai_run_id TEXT;
CREATE INDEX items_ai_queue ON items(ai_status, received_at DESC);

-- Everything already in the inbox joins the queue.
UPDATE items SET ai_status = 'pending' WHERE status = 'inbox';

-- One row per attempt to summarise an item: the value history.
CREATE TABLE ai_runs (
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL,
  source_id TEXT,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  prompt_id TEXT,
  prompt_version INTEGER,
  seconds REAL,
  ok INTEGER NOT NULL,
  error TEXT,
  rating INTEGER, -- 1 thumbs up, -1 thumbs down
  at INTEGER NOT NULL
);
CREATE INDEX ai_runs_at ON ai_runs(at);
CREATE INDEX ai_runs_item ON ai_runs(item_id, at);

-- Summary prompts. scope: 'default' | 'category' | 'source'; the most specific match wins.
CREATE TABLE prompts (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  scope_value TEXT,
  version INTEGER NOT NULL,
  body TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(scope, scope_value)
);

CREATE TABLE prompt_versions (
  prompt_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (prompt_id, version)
);

-- Models the helper can see on the PC, in the reader's preferred order.
CREATE TABLE models (
  provider TEXT NOT NULL,
  name TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  position INTEGER NOT NULL DEFAULT 0,
  installed INTEGER NOT NULL DEFAULT 1,
  size_bytes INTEGER,
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  PRIMARY KEY (provider, name)
);

-- Test mode: run a prompt on recent items with several models, side by side.
CREATE TABLE trials (
  id TEXT PRIMARY KEY,
  prompt_body TEXT NOT NULL,
  models TEXT NOT NULL, -- JSON [{provider, name}]
  item_ids TEXT NOT NULL, -- JSON [id]
  status TEXT NOT NULL DEFAULT 'pending', -- pending | running | done
  created_at INTEGER NOT NULL,
  finished_at INTEGER
);

CREATE TABLE trial_results (
  trial_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  output TEXT, -- JSON AiOutput
  error TEXT,
  seconds REAL,
  PRIMARY KEY (trial_id, item_id, provider, model)
);
