-- Security alerts: breaches from Have I Been Pwned's alert emails, the addresses
-- each one hit, what happened to it over time, and the mail sent to the alerts
-- address. Kept as history (nothing is tidied away except old mail).

CREATE TABLE IF NOT EXISTS security_breaches (
  name TEXT PRIMARY KEY,           -- HIBP's breach name
  info TEXT NOT NULL,              -- JSON BreachInfo from HIBP's public breach list
  origin TEXT NOT NULL,            -- alert | past | site
  level TEXT NOT NULL,             -- high | medium | low | watch
  state TEXT NOT NULL,             -- open | handled
  first_seen_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  handled_at INTEGER,
  viewed_at INTEGER,
  todo_done TEXT,                  -- JSON array of to-do step keys ticked
  site_sources TEXT,               -- JSON [{id,name}] for a site you get mail from
  info_checked_at INTEGER          -- last time HIBP's details were read (NULL = still to read)
);
CREATE INDEX IF NOT EXISTS security_breaches_state ON security_breaches(state, updated_at);
CREATE INDEX IF NOT EXISTS security_breaches_info ON security_breaches(info_checked_at);

CREATE TABLE IF NOT EXISTS security_hits (
  breach_name TEXT NOT NULL,
  address TEXT NOT NULL,           -- the address, '@domain' for a domain-wide alert, '' when unnamed
  person TEXT,
  via TEXT NOT NULL,               -- alert | domain | past
  count INTEGER,
  seen_at INTEGER NOT NULL,
  PRIMARY KEY (breach_name, address)
);

CREATE TABLE IF NOT EXISTS security_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  breach_name TEXT NOT NULL,
  at INTEGER NOT NULL,
  kind TEXT NOT NULL,              -- announced | alert | past | changed | handled | reopened
  text TEXT NOT NULL,
  mail_id TEXT
);
CREATE INDEX IF NOT EXISTS security_events_breach ON security_events(breach_name, at);

CREATE TABLE IF NOT EXISTS security_mail (
  id TEXT PRIMARY KEY,
  received_at INTEGER NOT NULL,
  from_email TEXT NOT NULL,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,              -- plain text, cut at 20,000 characters
  genuine INTEGER NOT NULL DEFAULT 0,
  from_hibp INTEGER NOT NULL DEFAULT 0,
  breaches TEXT                    -- JSON array of breach names it was read as
);
CREATE INDEX IF NOT EXISTS security_mail_received ON security_mail(received_at);
