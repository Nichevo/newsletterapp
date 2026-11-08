-- Links that are files, not web pages (Add > Just one page), and deleting pages added on their own.
--
-- items.file_type   the file's type when the link was a file (e.g. 'application/pdf'); NULL for web pages
-- items.file_key    R2 key of the app's own copy of that file (PDFs and pictures up to 8 MB); NULL = link only
-- items.deleted_at  when a saved page was deleted (status 'dropped'). Undo clears it; about ten minutes
--                   later the hourly tidy-up removes its stored copy, tags and story link and sets it to 0.

ALTER TABLE items ADD COLUMN file_type TEXT;
ALTER TABLE items ADD COLUMN file_key TEXT;
ALTER TABLE items ADD COLUMN deleted_at INTEGER;

-- Deleted pages still to tidy up (a handful at most, so the hourly check reads almost nothing).
CREATE INDEX IF NOT EXISTS items_deleted ON items(deleted_at) WHERE deleted_at > 0;
