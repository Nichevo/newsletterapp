-- Feed suggestions. The PC counts the outside sites each item you read, save or
-- star links to (item_links; items.links_at marks an item as counted), the
-- reader records the links you actually tap (link_clicks), and once a week the
-- PC checks the most-linked sites you don't follow for a feed and scores their
-- posts against your stars. One row per site in suggestions.

ALTER TABLE items ADD COLUMN links_at INTEGER;

CREATE TABLE IF NOT EXISTS item_links (
  item_id TEXT NOT NULL,
  site TEXT NOT NULL,
  n INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (item_id, site)
);
CREATE INDEX IF NOT EXISTS item_links_site ON item_links(site, item_id);

CREATE TABLE IF NOT EXISTS link_clicks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id TEXT NOT NULL,
  site TEXT NOT NULL,
  at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS link_clicks_at ON link_clicks(at, site);

CREATE TABLE IF NOT EXISTS suggestions (
  site TEXT PRIMARY KEY,
  -- new | followed | dismissed | nofeed
  status TEXT NOT NULL DEFAULT 'new',
  title TEXT,
  feed_url TEXT,
  site_url TEXT,
  description TEXT,
  samples TEXT,
  posts_per_week REAL,
  last_post_at INTEGER,
  -- JSON SuggestionWhy without the learnt part, and the source ids that link to it.
  why TEXT,
  via TEXT,
  tags TEXT,
  link_score REAL NOT NULL DEFAULT 0,
  fit REAL,
  source_id TEXT,
  -- Followed but kept out of the learning ("Keep, don't learn from it").
  ignored INTEGER NOT NULL DEFAULT 0,
  -- A followed site hardly opened after three weeks has taught the list a soft no once.
  soft_no_at INTEGER,
  checked_at INTEGER,
  created_at INTEGER NOT NULL,
  decided_at INTEGER
);
CREATE INDEX IF NOT EXISTS suggestions_status ON suggestions(status, link_score DESC);
