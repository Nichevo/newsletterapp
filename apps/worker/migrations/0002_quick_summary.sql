-- Phase 2, part 1: quick summaries worked out by rules (no AI), categories,
-- per-source AI switches and app settings.

ALTER TABLE items ADD COLUMN preheader TEXT;
ALTER TABLE items ADD COLUMN word_count INTEGER;
-- Rules-based category from a keyword rule. NULL means "use the source's category".
ALTER TABLE items ADD COLUMN category TEXT;
ALTER TABLE items ADD COLUMN sponsored INTEGER NOT NULL DEFAULT 0;

ALTER TABLE sources ADD COLUMN category TEXT;
ALTER TABLE sources ADD COLUMN ai_mode TEXT NOT NULL DEFAULT 'default';

-- Key/value app settings; values are JSON.
CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
