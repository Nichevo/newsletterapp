-- System status: service status pages read into incidents with their updates.
CREATE TABLE IF NOT EXISTS status_services (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,              -- statuspage | google | m365 | azure | aws | apple
  feed_url TEXT NOT NULL,
  page_url TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  only_words TEXT,                 -- JSON array: only incidents naming one of these count
  custom INTEGER NOT NULL DEFAULT 0,
  sort INTEGER NOT NULL DEFAULT 100,
  checked_at INTEGER,
  next_check_at INTEGER,
  error TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS status_incidents (
  id TEXT PRIMARY KEY,
  service_id TEXT NOT NULL,
  ext_key TEXT NOT NULL,           -- the incident's id on the status page
  grp TEXT,                        -- pages posting each update apart: what joins updates (AWS service+region, Microsoft impact line)
  title TEXT NOT NULL,
  state TEXT NOT NULL,             -- open | resolved
  level TEXT NOT NULL,             -- minor | major
  components TEXT,                 -- JSON array of affected parts
  url TEXT,
  next_update TEXT,
  latest TEXT,
  started_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  resolved_at INTEGER,
  fp TEXT,                         -- fingerprint of what the page last said, to skip unchanged ones
  updates INTEGER NOT NULL DEFAULT 0,
  viewed_at INTEGER,
  UNIQUE (service_id, ext_key)
);
CREATE INDEX IF NOT EXISTS status_incidents_open ON status_incidents(state, service_id);
CREATE INDEX IF NOT EXISTS status_incidents_recent ON status_incidents(service_id, updated_at);
CREATE INDEX IF NOT EXISTS status_incidents_resolved ON status_incidents(resolved_at);

CREATE TABLE IF NOT EXISTS status_updates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  incident_id TEXT NOT NULL,
  ukey TEXT NOT NULL,
  at INTEGER NOT NULL,
  label TEXT,
  body TEXT NOT NULL,
  UNIQUE (incident_id, ukey)
);

-- The built-in list. Words limit busy pages to the parts this app and its owner use.
INSERT OR IGNORE INTO status_services (id, name, kind, feed_url, page_url, enabled, only_words, sort, created_at) VALUES
  ('apple', 'Apple', 'apple', 'https://www.apple.com/support/systemstatus/data/system_status_en_US.js', 'https://www.apple.com/support/systemstatus/', 1, NULL, 10, 0),
  ('google', 'Google Workspace', 'google', 'https://www.google.com/appsstatus/dashboard/en/feed.atom', 'https://www.google.com/appsstatus/dashboard/', 1, NULL, 20, 0),
  ('cloudflare', 'Cloudflare', 'statuspage', 'https://www.cloudflarestatus.com/history.atom', 'https://www.cloudflarestatus.com/', 1, '["Workers","D1","R2","Email Routing","Access","Zero Trust","DNS","Pages","Dashboard","API"]', 30, 0),
  ('dropbox', 'Dropbox', 'statuspage', 'https://status.dropbox.com/history.rss', 'https://status.dropbox.com/', 1, NULL, 40, 0),
  ('m365', 'Microsoft 365', 'm365', 'https://status.cloud.microsoft/api/feed/mac', 'https://status.cloud.microsoft/', 1, NULL, 50, 0),
  ('azure', 'Azure', 'azure', 'https://rssfeed.azure.status.microsoft/en-us/status/feed/', 'https://azure.status.microsoft/en-us/status', 1, NULL, 60, 0),
  ('aws', 'Amazon Web Services', 'aws', 'https://status.aws.amazon.com/rss/all.rss', 'https://health.aws.amazon.com/health/status', 1, '["us-east-1","ap-southeast-2","ap-southeast-6","global"]', 70, 0),
  ('github', 'GitHub', 'statuspage', 'https://www.githubstatus.com/history.rss', 'https://www.githubstatus.com/', 1, '["Actions","Git Operations","Pull Requests","API Requests"]', 80, 0),
  ('claude', 'Claude', 'statuspage', 'https://status.claude.com/history.rss', 'https://status.claude.com/', 1, NULL, 90, 0),
  ('reddit', 'Reddit', 'statuspage', 'https://www.redditstatus.com/history.rss', 'https://www.redditstatus.com/', 1, NULL, 100, 0),
  ('gcloud', 'Google Cloud', 'google', 'https://status.cloud.google.com/en/feed.atom', 'https://status.cloud.google.com/', 0, NULL, 110, 0);
