-- The app's own log: warnings and errors from the PC helper (sent with its
-- heartbeat) and from Cloudflare's feed checks, kept 14 days, behind the
-- "Your app" problems on the System status page.
CREATE TABLE IF NOT EXISTS app_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  level TEXT NOT NULL,
  origin TEXT NOT NULL,
  area TEXT NOT NULL,
  site TEXT,
  source_id TEXT,
  message TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS app_log_at ON app_log(at DESC);
CREATE INDEX IF NOT EXISTS app_log_source ON app_log(source_id, at DESC);
CREATE INDEX IF NOT EXISTS app_log_site ON app_log(site, at DESC);

-- Jobs the PC put back on purpose (Reddit asked it to slow down) wait until this time.
ALTER TABLE fetch_jobs ADD COLUMN not_before INTEGER;

-- Reddit turns Cloudflare away (403/429 most of the time, so feeds went quiet without
-- ever failing three times in a row): every Reddit feed is fetched by the PC now,
-- at the pace Reddit asks for. Checked again straight away.
UPDATE sources SET fetch_via = 'pc', error_count = 0, next_check_at = 0
  WHERE kind = 'feed' AND (feed_url LIKE '%reddit.com/%' OR (feed_url IS NULL AND url LIKE '%reddit.com/%'));
