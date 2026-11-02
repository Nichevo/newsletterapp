-- Hold new posts until they are this many hours old (Reddit: let votes and comments build up). 0 = straight away.
ALTER TABLE sources ADD COLUMN wait_hours INTEGER NOT NULL DEFAULT 0;
-- Reddit sources added so far: wait 6 hours.
UPDATE sources SET wait_hours = 6 WHERE kind = 'feed' AND feed_url LIKE '%reddit.com/%';
