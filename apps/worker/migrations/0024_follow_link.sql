-- Aggregator feeds (Techmeme): fetch the outside article a post links to, kept under the post's own summary.
ALTER TABLE sources ADD COLUMN follow_link INTEGER NOT NULL DEFAULT 0;
