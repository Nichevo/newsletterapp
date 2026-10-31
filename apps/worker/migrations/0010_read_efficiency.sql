-- Small indexes so the PC helper's once-a-minute check-in reads only the AI
-- queue, not the whole inbox (D1's free plan allows 5 million rows read a day).

-- Queued items by kind, and by source for sources switched on by hand.
CREATE INDEX IF NOT EXISTS items_ai_queue_kind ON items(kind, received_at)
  WHERE status = 'inbox' AND ai_status IN ('pending', 'working');
CREATE INDEX IF NOT EXISTS items_ai_queue_source ON items(source_id, received_at)
  WHERE status = 'inbox' AND ai_status IN ('pending', 'working');
CREATE INDEX IF NOT EXISTS sources_ai_mode ON sources(ai_mode);

-- Thumbs per model on Settings > AI.
CREATE INDEX IF NOT EXISTS ai_runs_model_rating ON ai_runs(provider, model, rating) WHERE rating IS NOT NULL;
