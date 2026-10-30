-- Is the PC keeping up? A snapshot of the AI queue every 15 minutes, how long
-- each item waited before its summary, and a per-source cut-off so switching
-- AI on summarises new items only (or a chosen number of days back).

-- When the item (last) joined the AI queue; NULL = when it arrived (created_at).
ALTER TABLE items ADD COLUMN ai_queued_at INTEGER;

-- Seconds between joining the queue and the summary being written.
ALTER TABLE ai_runs ADD COLUMN wait_seconds REAL;
UPDATE ai_runs SET wait_seconds = MAX(0, (at - (SELECT created_at FROM items WHERE items.id = ai_runs.item_id)) / 1000.0)
WHERE ok = 1 AND NOT EXISTS (SELECT 1 FROM ai_runs r2 WHERE r2.item_id = ai_runs.item_id AND r2.ok = 1 AND r2.at < ai_runs.at);

-- Items that arrived (or were published) before this go to the AI no more; NULL = no cut-off.
ALTER TABLE sources ADD COLUMN ai_since INTEGER;

CREATE TABLE ai_backlog (
  at INTEGER PRIMARY KEY,
  waiting INTEGER NOT NULL,
  working INTEGER NOT NULL,
  -- when the longest-waiting item joined the queue
  oldest_at INTEGER
);
