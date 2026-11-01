-- When each feed usually posts, learnt from its posts (JSON, see FeedRhythm), so checks can follow it.
ALTER TABLE sources ADD COLUMN rhythm TEXT;
