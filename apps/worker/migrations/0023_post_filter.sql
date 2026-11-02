-- Per-source post filter (keep/skip words, skip pre-releases, major/minor releases only)
-- and a flood guard: at most daily_cap new posts a day reach the inbox; the rest go to
-- Archived and the source page says how many were set aside.
ALTER TABLE sources ADD COLUMN post_filter TEXT;
ALTER TABLE sources ADD COLUMN daily_cap INTEGER;
ALTER TABLE sources ADD COLUMN flood_at INTEGER;
ALTER TABLE sources ADD COLUMN flood_count INTEGER NOT NULL DEFAULT 0;
