-- Fetches the PC held back or slowed down, by local day and site: skipped (on the
-- Sites the PC leaves alone list), rested (after a bot check), bot checks seen, and
-- waits for the same-site gap, with the limits in force at the time.
CREATE TABLE IF NOT EXISTS pc_holds (
  day TEXT NOT NULL,
  site TEXT NOT NULL,
  skipped INTEGER NOT NULL DEFAULT 0,
  rested INTEGER NOT NULL DEFAULT 0,
  flagged INTEGER NOT NULL DEFAULT 0,
  waited INTEGER NOT NULL DEFAULT 0,
  wait_ms INTEGER NOT NULL DEFAULT 0,
  gap_ms INTEGER NOT NULL DEFAULT 0,
  rest_ms INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, site)
);
