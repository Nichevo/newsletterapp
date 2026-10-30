-- Thumbs up/down on test-run results, and when each rating was given, so the
-- AI statistics screen can chart ratings per model over time.
ALTER TABLE ai_runs ADD COLUMN rated_at INTEGER;
ALTER TABLE trial_results ADD COLUMN rating INTEGER; -- 1 thumbs up, -1 thumbs down
ALTER TABLE trial_results ADD COLUMN rated_at INTEGER;
UPDATE ai_runs SET rated_at = at WHERE rating IS NOT NULL;
CREATE INDEX ai_runs_rated ON ai_runs(rated_at) WHERE rating IS NOT NULL;
