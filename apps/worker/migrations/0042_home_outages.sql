-- Home outage checks for System status: power, mobile and internet outages near
-- the home area set in Settings > System status (the area itself lives in settings, not here).
INSERT OR IGNORE INTO status_services (id, name, kind, feed_url, page_url, enabled, only_words, sort, created_at) VALUES
  ('vector', 'Power (Vector)', 'vector', 'https://help.vector.co.nz/config.js', 'https://help.vector.co.nz/map', 1, NULL, 5, 0),
  ('onenz', 'Mobile (One NZ network)', 'onenz', 'https://one.nz/getconfigvalues/outage-config.json', 'https://one.nz/help/network-status/', 1, NULL, 6, 0),
  ('chorus', 'Internet (Chorus network)', 'chorus', 'https://www.chorus.co.nz/config.json', 'https://www.chorus.co.nz/optimise/internet-outages-map', 1, '["Fibre"]', 7, 0);
