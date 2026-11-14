-- Adverts. items.sponsored = 2 marks an item that is only an advert (the AI said so, or you did),
-- so the lists need no join; the rest sits in its own small table because items is at D1's
-- 100-column limit. A row is only written when there is something to keep.
CREATE TABLE IF NOT EXISTS item_ads (
  item_id TEXT PRIMARY KEY,
  ai_advert INTEGER NOT NULL DEFAULT 0,   -- the AI's last say on the whole item
  tail TEXT,                              -- first words of an ad tacked onto the end of the article (the AI's), NULL = none
  you TEXT,                               -- 'advert' | 'not_advert' | NULL: your say, which the AI never overrides
  tail_wrong INTEGER NOT NULL DEFAULT 0,  -- you said the hidden end wasn't an ad
  moved INTEGER NOT NULL DEFAULT 0,       -- moved out of the Inbox for being an advert (undone with it)
  at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS item_ads_at ON item_ads(at);
-- The Adverts view.
CREATE INDEX IF NOT EXISTS items_adverts ON items(received_at DESC) WHERE sponsored = 2;
