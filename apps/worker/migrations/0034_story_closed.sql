-- stories.closed_at: the reader closed the story; matching adds no new articles to it
-- (adding one by hand with "Same story" still works). NULL = open.
ALTER TABLE stories ADD COLUMN closed_at INTEGER;
