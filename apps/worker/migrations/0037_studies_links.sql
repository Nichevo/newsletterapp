-- Key sentences part 2: the Index under long articles, and studies and source
-- links collected from every summarised article, shared across articles.

-- Index terms ({term, type, count} list) next to the key sentences.
ALTER TABLE key_sentences ADD COLUMN terms TEXT;

-- Studies and links queue: NULL = never looked at; pending | working -> done | none | failed.
ALTER TABLE items ADD COLUMN refs_status TEXT;
ALTER TABLE items ADD COLUMN refs_at INTEGER;
ALTER TABLE items ADD COLUMN refs_attempts INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS items_refs_queue ON items(received_at DESC) WHERE refs_status IN ('pending', 'working');

-- Which job a PC run was: 'key' (key sentences and index) or 'refs' (studies and links).
ALTER TABLE ks_runs ADD COLUMN task TEXT NOT NULL DEFAULT 'key';

CREATE TABLE IF NOT EXISTS studies (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  publisher TEXT,
  year INTEGER,
  doi TEXT,
  url TEXT,
  -- Lower-case title words, for matching the same study across articles.
  title_key TEXT NOT NULL,
  cites INTEGER NOT NULL DEFAULT 0,
  -- 1 when two articles quote it with different numbers.
  differs INTEGER NOT NULL DEFAULT 0,
  first_seen INTEGER NOT NULL,
  last_seen INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS studies_doi ON studies(doi) WHERE doi IS NOT NULL;
CREATE INDEX IF NOT EXISTS studies_url ON studies(url) WHERE url IS NOT NULL;
CREATE INDEX IF NOT EXISTS studies_key ON studies(title_key);
CREATE INDEX IF NOT EXISTS studies_year ON studies(year);
CREATE INDEX IF NOT EXISTS studies_cited ON studies(cites DESC, last_seen DESC);
CREATE INDEX IF NOT EXISTS studies_recent ON studies(last_seen DESC);

CREATE TABLE IF NOT EXISTS study_cites (
  id TEXT PRIMARY KEY,
  study_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  claim TEXT,
  quote TEXT NOT NULL,
  prefix TEXT,
  suffix TEXT,
  text_offset INTEGER,
  -- JSON list of numbers in the citing sentence.
  numbers TEXT,
  -- Another cite of the same study whose numbers disagree with this one.
  differs_from TEXT,
  at INTEGER NOT NULL,
  UNIQUE (study_id, item_id)
);
CREATE INDEX IF NOT EXISTS study_cites_study ON study_cites(study_id, at DESC);
CREATE INDEX IF NOT EXISTS study_cites_item ON study_cites(item_id);

-- Possibly the same study (close titles): asked about with Same / Different.
CREATE TABLE IF NOT EXISTS study_maybe (
  a TEXT NOT NULL,
  b TEXT NOT NULL,
  -- NULL = not answered; 'different' = keep apart (Same merges and drops the row).
  decided TEXT,
  at INTEGER NOT NULL,
  PRIMARY KEY (a, b)
);
CREATE INDEX IF NOT EXISTS study_maybe_b ON study_maybe(b);

CREATE TABLE IF NOT EXISTS links (
  id TEXT PRIMARY KEY,
  url TEXT NOT NULL UNIQUE,
  host TEXT NOT NULL,
  title TEXT,
  cites INTEGER NOT NULL DEFAULT 0,
  first_seen INTEGER NOT NULL,
  last_seen INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS links_cited ON links(cites DESC, last_seen DESC);

CREATE TABLE IF NOT EXISTS link_cites (
  link_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  text TEXT,
  at INTEGER NOT NULL,
  PRIMARY KEY (link_id, item_id)
);
CREATE INDEX IF NOT EXISTS link_cites_item ON link_cites(item_id);
