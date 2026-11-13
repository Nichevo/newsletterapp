-- Learning from "Not interested". The PC helper reads these items (once a minute it
-- only checks their count and newest time), so both lookups use small partial indexes
-- rather than walking the inbox (D1 free plan: 5 million rows read a day).
CREATE INDEX IF NOT EXISTS items_not_interested ON items(read_at DESC) WHERE read_via = 'not_interested';
-- items.likely = -1: "Probably not for you" (close to what you marked Not interested, not to your stars).
CREATE INDEX IF NOT EXISTS items_unlikely ON items(received_at DESC) WHERE likely = -1;
