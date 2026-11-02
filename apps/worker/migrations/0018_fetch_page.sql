-- "Fetch full page" from the reader: a fetch the reader asked for replaces the saved copy whatever its length.
ALTER TABLE fetch_jobs ADD COLUMN force INTEGER NOT NULL DEFAULT 0;
-- Bumped whenever an item's saved copy is replaced, so the app asks for the new one instead of a cached copy.
ALTER TABLE items ADD COLUMN body_v INTEGER NOT NULL DEFAULT 0;
