-- "Interesting": a star separate from Save, meaning "this mattered". A signal, not a to-do.
ALTER TABLE items ADD COLUMN interesting_at INTEGER;
CREATE INDEX items_interesting ON items(interesting_at DESC) WHERE interesting_at IS NOT NULL;
