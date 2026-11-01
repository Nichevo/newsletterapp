-- How many of its latest posts a feed or website brings in on its first check
-- (chosen when adding it or switching how it's followed). NULL = the old default of 5.
ALTER TABLE sources ADD COLUMN start_count INTEGER;
