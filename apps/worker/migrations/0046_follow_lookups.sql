-- Find a way to follow. One row per lookup: what was asked, what the PC
-- understood it to be about (things), and the ways to follow it that the PC
-- found and checked (candidates), both as JSON. The PC works in two stages:
-- 'understand' (who or what is this about?) then 'search'.

CREATE TABLE IF NOT EXISTS follow_lookups (
  id TEXT PRIMARY KEY,
  query TEXT NOT NULL,
  url TEXT,
  -- understand | search
  stage TEXT NOT NULL DEFAULT 'understand',
  -- waiting | working | confirm | done | failed
  status TEXT NOT NULL DEFAULT 'waiting',
  things TEXT NOT NULL DEFAULT '[]',
  candidates TEXT NOT NULL DEFAULT '[]',
  error TEXT,
  searches INTEGER NOT NULL DEFAULT 0,
  model TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  claimed_at INTEGER,
  created_at INTEGER NOT NULL,
  finished_at INTEGER
);
CREATE INDEX IF NOT EXISTS follow_lookups_status ON follow_lookups(status, created_at);
CREATE INDEX IF NOT EXISTS follow_lookups_created ON follow_lookups(created_at DESC);
