-- Local AI usage limits and running cost: measured GPU draw per run, and a
-- timestamp on test-run results so their time counts towards usage too.

ALTER TABLE ai_runs ADD COLUMN watts REAL;
ALTER TABLE trial_results ADD COLUMN at INTEGER;
ALTER TABLE trial_results ADD COLUMN watts REAL;
CREATE INDEX trial_results_at ON trial_results(at);
