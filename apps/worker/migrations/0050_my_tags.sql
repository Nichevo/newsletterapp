-- Tags you add or take off by hand. items.tags stays the one list everything reads
-- (tag pages, Topics map, stories, search), so an edit rewrites it straight away;
-- these rows are what keeps your say when the AI summarises the item again.
-- tag = lower-cased key, label = as you typed it (or as the AI wrote the one you took off).
CREATE TABLE IF NOT EXISTS tag_edits (
  item_id TEXT NOT NULL,
  tag TEXT NOT NULL,
  label TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('add', 'remove')),
  at INTEGER NOT NULL,
  PRIMARY KEY (item_id, tag)
);
-- Every tag you have added, for Statistics and the export.
CREATE INDEX IF NOT EXISTS tag_edits_at ON tag_edits(action, at DESC);
