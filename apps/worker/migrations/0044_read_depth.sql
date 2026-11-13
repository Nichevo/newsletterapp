-- How far you went with each item, for "How you read this source". Its own small
-- table, one row per item you spent time on: the items table is at D1's limit of
-- 100 columns in one result (the reader's SELECT items.* plus its joins), so
-- nothing more can go on items itself. "Not interested" is items.read_via =
-- 'not_interested', so it needs no column either.
CREATE TABLE IF NOT EXISTS item_reads (
  item_id TEXT PRIMARY KEY,
  glance_secs INTEGER,    -- seconds its inbox row sat at the reading line
  summary_secs INTEGER,   -- reader seconds with the AI summary in view (NULL = visited before this was split)
  article_secs INTEGER,   -- reader seconds in the article itself
  read_secs INTEGER,      -- all active reader seconds (summary, article and the rest)
  scroll_pct INTEGER,     -- furthest scroll in the reader
  live_opened INTEGER     -- 1 once Live page / Web version / the file was opened
) WITHOUT ROWID;

-- What the events already say about earlier visits (one pass over those event types).
INSERT OR IGNORE INTO item_reads (item_id, read_secs, scroll_pct, live_opened)
SELECT item_id,
  SUM(CASE WHEN type = 'read_time' THEN value END),
  MAX(CASE WHEN type = 'finish' THEN value END),
  MAX(CASE WHEN type = 'open_original' THEN 1 END)
FROM events WHERE type IN ('read_time', 'finish', 'open_original')
GROUP BY item_id;
