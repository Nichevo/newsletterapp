-- Phase 1 schema: addresses, senders, sources, items, reading events.
-- Timestamps are Unix milliseconds.

CREATE TABLE addresses (
  id TEXT PRIMARY KEY,
  local_part TEXT NOT NULL UNIQUE,
  label TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  created_in_app INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  blocked_at INTEGER,
  blocked_count INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE senders (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  address_id TEXT,
  name TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  decided_at INTEGER,
  auth_result TEXT NOT NULL DEFAULT 'unknown',
  blocked_count INTEGER NOT NULL DEFAULT 0,
  UNIQUE(email, address_id)
);
CREATE INDEX senders_status ON senders(status, last_seen_at DESC);

CREATE TABLE sources (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL DEFAULT 'newsletter',
  name TEXT NOT NULL,
  sender_email TEXT,
  address_id TEXT,
  folder TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE(sender_email, address_id)
);

CREATE TABLE items (
  id TEXT PRIMARY KEY,
  source_id TEXT,
  sender_id TEXT,
  address_id TEXT,
  kind TEXT NOT NULL DEFAULT 'newsletter',
  status TEXT NOT NULL DEFAULT 'inbox',
  subject TEXT NOT NULL DEFAULT '',
  from_name TEXT,
  from_email TEXT,
  to_address TEXT,
  snippet TEXT,
  received_at INTEGER NOT NULL,
  message_id TEXT,
  raw_key TEXT,
  html_key TEXT,
  text_key TEXT,
  raw_size INTEGER,
  has_html INTEGER NOT NULL DEFAULT 0,
  list_unsubscribe TEXT,
  auth_spf TEXT NOT NULL DEFAULT 'unknown',
  auth_dkim TEXT NOT NULL DEFAULT 'unknown',
  auth_dmarc TEXT NOT NULL DEFAULT 'unknown',
  web_url TEXT,
  read_at INTEGER,
  saved_at INTEGER,
  archived_at INTEGER,
  summary TEXT,
  key_points TEXT,
  tags TEXT,
  score INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX items_status_received ON items(status, received_at DESC);
CREATE INDEX items_saved ON items(saved_at DESC) WHERE saved_at IS NOT NULL;
CREATE INDEX items_sender ON items(sender_id, status);
CREATE INDEX items_source ON items(source_id, received_at DESC);

CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id TEXT NOT NULL,
  type TEXT NOT NULL,
  value INTEGER,
  device TEXT,
  at INTEGER NOT NULL
);
CREATE INDEX events_item ON events(item_id, at);
CREATE INDEX events_at ON events(at);
