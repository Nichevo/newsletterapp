-- Morning catch-up: a start-of-day review of what came in since your last visit
-- (Review > Day). The Worker stores the items and their dial levels in `pack`;
-- the PC adds themes and an overview in `written`.
CREATE TABLE IF NOT EXISTS catchups (
  id TEXT PRIMARY KEY,
  built_at INTEGER NOT NULL,
  from_at INTEGER NOT NULL,        -- your last visit: it covers what arrived after it
  to_at INTEGER NOT NULL,
  pack TEXT NOT NULL,              -- JSON: items (with dial levels) and the by-category groups
  written TEXT,                    -- JSON: themes and overview from the PC
  status TEXT NOT NULL DEFAULT 'waiting', -- waiting | working | done | failed
  claimed_at INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  seconds REAL,
  cleared INTEGER NOT NULL DEFAULT 0,        -- items it marked read (themes, Clear all)
  not_interested INTEGER NOT NULL DEFAULT 0, -- items it marked Not interested (Probably skip pile)
  done_at INTEGER,
  replaced INTEGER NOT NULL DEFAULT 0        -- set done by a newer catch-up before you finished it
);
CREATE INDEX IF NOT EXISTS catchups_recent ON catchups(built_at DESC);
