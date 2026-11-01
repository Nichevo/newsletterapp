-- Full-text search over what each item says about itself: subject, sender,
-- preview, AI summary, key points, why it matters and tags. Word-based and
-- ranked (FTS5), kept in step with items by triggers, so a search reads the
-- index instead of scanning the whole inbox.
CREATE VIRTUAL TABLE items_fts USING fts5(
  subject, from_name, snippet, preheader, summary, key_points, why_it_matters, tags,
  content = 'items', content_rowid = 'rowid', tokenize = 'porter unicode61 remove_diacritics 2'
);

CREATE TRIGGER items_fts_insert AFTER INSERT ON items BEGIN
  INSERT INTO items_fts (rowid, subject, from_name, snippet, preheader, summary, key_points, why_it_matters, tags)
  VALUES (new.rowid, new.subject, new.from_name, new.snippet, new.preheader, new.summary, new.key_points, new.why_it_matters, new.tags);
END;

CREATE TRIGGER items_fts_delete AFTER DELETE ON items BEGIN
  INSERT INTO items_fts (items_fts, rowid, subject, from_name, snippet, preheader, summary, key_points, why_it_matters, tags)
  VALUES ('delete', old.rowid, old.subject, old.from_name, old.snippet, old.preheader, old.summary, old.key_points, old.why_it_matters, old.tags);
END;

CREATE TRIGGER items_fts_update AFTER UPDATE OF subject, from_name, snippet, preheader, summary, key_points, why_it_matters, tags ON items BEGIN
  INSERT INTO items_fts (items_fts, rowid, subject, from_name, snippet, preheader, summary, key_points, why_it_matters, tags)
  VALUES ('delete', old.rowid, old.subject, old.from_name, old.snippet, old.preheader, old.summary, old.key_points, old.why_it_matters, old.tags);
  INSERT INTO items_fts (rowid, subject, from_name, snippet, preheader, summary, key_points, why_it_matters, tags)
  VALUES (new.rowid, new.subject, new.from_name, new.snippet, new.preheader, new.summary, new.key_points, new.why_it_matters, new.tags);
END;

-- Index everything already there.
INSERT INTO items_fts (items_fts) VALUES ('rebuild');
