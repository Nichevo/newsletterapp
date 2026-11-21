-- Reddit switched off its RSS feeds from 13 November 2026. Reddit feeds that have
-- answered "gone" three or more times in a row are paused; their posts stay.
UPDATE sources
SET paused_at = CAST(strftime('%s', 'now') AS INTEGER) * 1000,
    last_error = 'Reddit switched off its RSS feeds from 13 November 2026, so the app paused this source. Its posts stay in the app.'
WHERE kind = 'feed'
  AND paused_at IS NULL
  AND error_count >= 3
  AND (feed_url LIKE '%reddit.com/%' OR (feed_url IS NULL AND url LIKE '%reddit.com/%'))
  AND (last_error LIKE '%404%' OR last_error LIKE '%410%' OR last_error LIKE '%no longer returns a feed%');
