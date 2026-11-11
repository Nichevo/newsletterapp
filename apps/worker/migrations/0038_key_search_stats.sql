-- Key sentences part 3: search over key sentences and Index names, and daily
-- counts of how the reader's key-sentence tools are used.

-- One row per key sentence (kind = main, evidence...) and per Index name
-- (kind = term:person, term:place...), kept in step by the Worker. Row ids are
-- the item's rowid * 1024 + the mark's position (Index names from 512), so an
-- article's rows are replaced with a rowid range instead of a scan.
CREATE VIRTUAL TABLE IF NOT EXISTS ks_fts USING fts5(
  item_id UNINDEXED, kind UNINDEXED, quote,
  tokenize = 'porter unicode61 remove_diacritics 2'
);

INSERT INTO ks_fts (rowid, item_id, kind, quote)
  SELECT items.rowid * 1024 + j.key, k.item_id, json_extract(j.value, '$.kind'), json_extract(j.value, '$.quote')
  FROM key_sentences k JOIN items ON items.id = k.item_id AND items.ks_status = 'done', json_each(k.marks) j
  WHERE COALESCE(json_extract(j.value, '$.fix'), '') != 'removed' AND j.key < 512;
INSERT INTO ks_fts (rowid, item_id, kind, quote)
  SELECT items.rowid * 1024 + 512 + j.key, k.item_id, 'term:' || json_extract(j.value, '$.type'), json_extract(j.value, '$.term')
  FROM key_sentences k JOIN items ON items.id = k.item_id AND items.ks_status = 'done', json_each(COALESCE(k.terms, '[]')) j
  WHERE j.key < 512;

-- Counters per day ({"open": 3, "skim": 1, ...}), one small row a day.
CREATE TABLE IF NOT EXISTS ks_daily (
  day TEXT PRIMARY KEY,
  counts TEXT NOT NULL DEFAULT '{}'
);
