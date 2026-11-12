-- Weekly and monthly reviews (they replace the daily digest; old digests stay in their table).
CREATE TABLE IF NOT EXISTS reviews (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,              -- 'week' | 'month'
  period TEXT NOT NULL,            -- week: local date it was built (YYYY-MM-DD); month: YYYY-MM covered
  from_at INTEGER NOT NULL,
  to_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  pack TEXT NOT NULL,              -- JSON ReviewPack: the facts, gathered by the Worker
  written TEXT,                    -- JSON ReviewWritten: what the PC wrote and found
  status TEXT NOT NULL DEFAULT 'waiting', -- waiting | working | done | failed
  claimed_at INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  more_wanted INTEGER NOT NULL DEFAULT 0, -- Find more: extra searches asked for
  seconds REAL,                    -- PC time spent writing it, in all
  read_at INTEGER,
  inbox_item_id TEXT,
  UNIQUE (kind, period)
);
CREATE INDEX IF NOT EXISTS reviews_recent ON reviews(created_at DESC);
CREATE INDEX IF NOT EXISTS reviews_queue ON reviews(created_at) WHERE status IN ('waiting', 'working');

-- Reviews count items by arrival time across months.
CREATE INDEX IF NOT EXISTS items_received ON items(received_at);
