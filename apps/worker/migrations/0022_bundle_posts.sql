-- Feeds that post in bursts (TED Talks adds several at once): each check's new posts
-- can arrive as one inbox item holding all of them.
ALTER TABLE sources ADD COLUMN bundle INTEGER NOT NULL DEFAULT 0;
