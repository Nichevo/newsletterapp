-- Highlights in articles, and questions to the AI about them ("asks").
-- Answers become a note on the article, a new article from the "AI notes"
-- source, or both. Every lookup below goes through an index, so opening an
-- article or the helper's 10-second check reads only a row or two.

CREATE TABLE highlights (
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL,
  quote TEXT NOT NULL,          -- exact highlighted text
  prefix TEXT NOT NULL DEFAULT '', -- ~32 chars before, to find the right copy again
  suffix TEXT NOT NULL DEFAULT '', -- ~32 chars after
  text_offset INTEGER NOT NULL DEFAULT 0, -- rough position in the article's text, the tie-breaker
  context TEXT,                 -- the paragraph around it, for the AI
  color TEXT NOT NULL DEFAULT 'yellow',
  device TEXT,
  created_at INTEGER NOT NULL,
  deleted_at INTEGER
);
CREATE INDEX highlights_item ON highlights(item_id) WHERE deleted_at IS NULL;
CREATE INDEX highlights_created ON highlights(created_at) WHERE deleted_at IS NULL;

-- The prompts on the highlight bar (Define, More info, ...). Versioned like the summary prompts.
CREATE TABLE ask_presets (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  body TEXT NOT NULL,
  output TEXT NOT NULL DEFAULT 'note',   -- note | item | both
  lookups TEXT NOT NULL DEFAULT 'none',  -- none | wiki | web | both
  position INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1,
  built_in INTEGER NOT NULL DEFAULT 0,
  version INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL
);

CREATE TABLE ask_preset_versions (
  preset_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (preset_id, version)
) WITHOUT ROWID;

-- One question about one highlight, and its answer.
-- pending -> working -> done | failed
CREATE TABLE asks (
  id TEXT PRIMARY KEY,
  highlight_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  preset_id TEXT,               -- NULL for "Ask your own"
  label TEXT NOT NULL,
  preset_version INTEGER,
  question TEXT,                -- the typed question for "Ask your own"
  output TEXT NOT NULL,         -- note | item | both
  lookups TEXT NOT NULL DEFAULT 'none',
  prompt TEXT NOT NULL,         -- the finished instructions sent to the model
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  claimed_at INTEGER,
  provider TEXT,
  model TEXT,
  answer TEXT,                  -- light Markdown
  sources TEXT,                 -- JSON [{title, url}] from lookups
  error TEXT,
  rating INTEGER,
  rated_at INTEGER,
  seconds REAL,
  watts INTEGER,
  new_item_id TEXT,             -- the "AI notes" article, when the output includes one
  created_at INTEGER NOT NULL,
  done_at INTEGER,
  deleted_at INTEGER
);
CREATE INDEX asks_item ON asks(item_id, created_at);
CREATE INDEX asks_queue ON asks(created_at) WHERE status IN ('pending', 'working');
-- PC run time for usage limits and cost.
CREATE INDEX asks_done ON asks(done_at) WHERE done_at IS NOT NULL;

-- Inbox markers without an extra query per row, and the AI notes article's way back.
ALTER TABLE items ADD COLUMN highlight_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE items ADD COLUMN note_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE items ADD COLUMN origin_item_id TEXT;
