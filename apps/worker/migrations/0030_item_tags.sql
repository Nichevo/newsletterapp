-- Tags as rows, so a tag's page, the numbers on tag chips and the Topics map read only
-- the rows they need instead of every item's tags JSON. item_tags holds one row per item
-- and tag (tag = lower-cased key, label = as the AI wrote it); tag_counts keeps a running
-- count per tag. Triggers keep both in step with items.tags, which only the AI writes.

CREATE TABLE IF NOT EXISTS item_tags (
  tag TEXT NOT NULL,
  item_id TEXT NOT NULL,
  received_at INTEGER NOT NULL,
  label TEXT NOT NULL,
  PRIMARY KEY (tag, item_id)
);
-- A tag's items, newest first.
CREATE INDEX IF NOT EXISTS item_tags_tag_time ON item_tags(tag, received_at DESC);
-- Tags seen together (by item), and clearing an item's tags.
CREATE INDEX IF NOT EXISTS item_tags_item ON item_tags(item_id, tag, label);
-- The Topics map: every tag row in a period, without touching the table.
CREATE INDEX IF NOT EXISTS item_tags_time ON item_tags(received_at, item_id, tag, label);

CREATE TABLE IF NOT EXISTS tag_counts (
  tag TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  n INTEGER NOT NULL DEFAULT 0
);

-- Backfill from the tags already written.
INSERT OR IGNORE INTO item_tags (tag, item_id, received_at, label)
SELECT lower(trim(j.value)), items.id, items.received_at, trim(j.value)
FROM items, json_each(items.tags) AS j
WHERE items.tags IS NOT NULL AND json_valid(items.tags) AND j.type = 'text' AND trim(j.value) != '';

INSERT OR REPLACE INTO tag_counts (tag, label, n)
SELECT tag, MAX(label), COUNT(*) FROM item_tags GROUP BY tag;

CREATE TRIGGER IF NOT EXISTS tag_counts_add AFTER INSERT ON item_tags BEGIN
  INSERT INTO tag_counts (tag, label, n) VALUES (new.tag, new.label, 1)
  ON CONFLICT(tag) DO UPDATE SET n = n + 1;
END;

CREATE TRIGGER IF NOT EXISTS tag_counts_remove AFTER DELETE ON item_tags BEGIN
  UPDATE tag_counts SET n = MAX(n - 1, 0) WHERE tag = old.tag;
END;

CREATE TRIGGER IF NOT EXISTS item_tags_on_insert AFTER INSERT ON items WHEN new.tags IS NOT NULL BEGIN
  INSERT OR IGNORE INTO item_tags (tag, item_id, received_at, label)
  SELECT lower(trim(value)), new.id, new.received_at, trim(value)
  FROM json_each(CASE WHEN json_valid(new.tags) THEN new.tags ELSE '[]' END)
  WHERE type = 'text' AND trim(value) != '';
END;

CREATE TRIGGER IF NOT EXISTS item_tags_on_update AFTER UPDATE OF tags ON items WHEN old.tags IS NOT new.tags BEGIN
  DELETE FROM item_tags WHERE item_id = new.id;
  INSERT OR IGNORE INTO item_tags (tag, item_id, received_at, label)
  SELECT lower(trim(value)), new.id, new.received_at, trim(value)
  FROM json_each(CASE WHEN json_valid(new.tags) THEN new.tags ELSE '[]' END)
  WHERE type = 'text' AND trim(value) != '';
END;
