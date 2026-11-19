-- Catch-up themes kept apart from the catch-up's JSON, so an article can show the
-- theme it was grouped under (the reader's theme chip) and themes that come back
-- on several mornings can be offered once as a lasting tag. Categories used as a
-- fallback are not stored: the article already shows its category.
CREATE TABLE IF NOT EXISTS catchup_themes (
  catchup_id TEXT NOT NULL,
  theme_id TEXT NOT NULL,
  name TEXT NOT NULL,
  key TEXT NOT NULL,               -- name lower-cased: how mornings are matched
  built_at INTEGER NOT NULL,
  items INTEGER NOT NULL,
  PRIMARY KEY (catchup_id, theme_id)
);
CREATE INDEX IF NOT EXISTS catchup_themes_recent ON catchup_themes(built_at DESC, key);
CREATE INDEX IF NOT EXISTS catchup_themes_key ON catchup_themes(key, built_at DESC);

-- The latest theme each article was grouped under.
CREATE TABLE IF NOT EXISTS catchup_item_themes (
  item_id TEXT PRIMARY KEY,
  catchup_id TEXT NOT NULL,
  theme_id TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS catchup_item_themes_theme ON catchup_item_themes(catchup_id, theme_id);

-- Your answer to "make this theme a tag?": asked once per theme name.
CREATE TABLE IF NOT EXISTS theme_tag_choices (
  key TEXT PRIMARY KEY,
  choice TEXT NOT NULL CHECK (choice IN ('tag', 'no')),
  tag TEXT,
  at INTEGER NOT NULL
);
