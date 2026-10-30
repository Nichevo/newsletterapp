-- Phase 3: RSS/Atom/JSON feeds and website watches as sources, the posts
-- already seen from each, and the fetch jobs the PC helper does.

ALTER TABLE sources ADD COLUMN url TEXT;
ALTER TABLE sources ADD COLUMN feed_url TEXT;
-- 'cloud' (the Worker fetches it) or 'pc' (the helper on the PC does).
ALTER TABLE sources ADD COLUMN fetch_via TEXT NOT NULL DEFAULT 'cloud';
-- Open pages in a real browser on the PC, for sites built by JavaScript.
ALTER TABLE sources ADD COLUMN render INTEGER NOT NULL DEFAULT 0;
-- Full article for feed posts: 'auto' (teasers only), 'always', 'never'.
ALTER TABLE sources ADD COLUMN full_text TEXT NOT NULL DEFAULT 'auto';
ALTER TABLE sources ADD COLUMN link_hint TEXT;
ALTER TABLE sources ADD COLUMN check_minutes INTEGER;
ALTER TABLE sources ADD COLUMN etag TEXT;
ALTER TABLE sources ADD COLUMN last_modified TEXT;
ALTER TABLE sources ADD COLUMN last_checked_at INTEGER;
ALTER TABLE sources ADD COLUMN next_check_at INTEGER;
ALTER TABLE sources ADD COLUMN last_ok_at INTEGER;
ALTER TABLE sources ADD COLUMN last_error TEXT;
ALTER TABLE sources ADD COLUMN error_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sources ADD COLUMN paused_at INTEGER;
CREATE INDEX sources_due ON sources(next_check_at) WHERE next_check_at IS NOT NULL;
CREATE INDEX sources_feed_url ON sources(feed_url) WHERE feed_url IS NOT NULL;

-- Posts and article links already seen per source (guid or link), so only new ones become items.
CREATE TABLE source_seen (
  source_id TEXT NOT NULL,
  key TEXT NOT NULL,
  at INTEGER NOT NULL,
  PRIMARY KEY (source_id, key)
) WITHOUT ROWID;

-- Fetches the PC helper does: feeds and pages Cloudflare can't reach, and full articles.
-- pending -> working -> (row deleted when done) | failed
CREATE TABLE fetch_jobs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL, -- 'feed' | 'page' | 'article'
  source_id TEXT,
  item_id TEXT,
  url TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  claimed_at INTEGER,
  error TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX fetch_jobs_status ON fetch_jobs(status, created_at);
CREATE INDEX fetch_jobs_source ON fetch_jobs(source_id, kind, status);
