-- Per-source limits that used to be fixed. NULL keeps the usual value.
-- Reddit feeds: how many top comments the PC adds to each post (usual 8).
ALTER TABLE sources ADD COLUMN reddit_comments INTEGER;
-- Website watches: links dated older than this many days are skipped (usual 30; 0 = never skip).
ALTER TABLE sources ADD COLUMN old_link_days INTEGER;
