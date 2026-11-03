-- Inbox and unread badge counts read only this index (no table rows).
CREATE INDEX IF NOT EXISTS items_inbox_read ON items(status, read_at);
