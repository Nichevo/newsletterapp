-- Stories: items about the same chain of events, joined from the PC helper's embedding
-- neighbours plus shared specific tags. Replaces the old "You've read about this before" list.
--
-- items.story_id    the story the item belongs to (NULL = not part of one)
-- items.news_id     same news from several sources within a couple of days: the id of the
--                   group's first item, so the inbox can show them as one row
-- items.story_at    when matching ran for the item; NULL = waiting (only once it is embedded)
-- items.story_why   why it joined, as JSON {with, sim, tags, kind}, for the story page
-- items.story_split 1 = the reader said "Not part of this story"; it never joins one again
-- items.story_note  the PC's one line on what this item adds to its story
-- items.story_note_status  'pending' | 'working' | 'done' | 'failed' | NULL (no note wanted)
-- items.story_note_at      when the note was claimed or written

CREATE TABLE IF NOT EXISTS stories (
  id TEXT PRIMARY KEY,
  title TEXT,
  summary TEXT,
  tags TEXT,
  first_at INTEGER NOT NULL,
  last_at INTEGER NOT NULL,
  items INTEGER NOT NULL DEFAULT 0,
  sources INTEGER NOT NULL DEFAULT 0,
  followed_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS stories_last ON stories(last_at DESC);
CREATE INDEX IF NOT EXISTS stories_followed ON stories(last_at DESC) WHERE followed_at IS NOT NULL;

ALTER TABLE items ADD COLUMN story_id TEXT;
ALTER TABLE items ADD COLUMN news_id TEXT;
ALTER TABLE items ADD COLUMN story_at INTEGER;
ALTER TABLE items ADD COLUMN story_why TEXT;
ALTER TABLE items ADD COLUMN story_split INTEGER;
ALTER TABLE items ADD COLUMN story_note TEXT;
ALTER TABLE items ADD COLUMN story_note_status TEXT;
ALTER TABLE items ADD COLUMN story_note_at INTEGER;

-- A story's items in order.
CREATE INDEX IF NOT EXISTS items_story ON items(story_id, received_at) WHERE story_id IS NOT NULL;
-- Items waiting to be matched, oldest first (so their older neighbours are matched already).
CREATE INDEX IF NOT EXISTS items_story_queue ON items(received_at) WHERE story_at IS NULL AND embedded_at IS NOT NULL;
-- Story notes waiting for the PC.
CREATE INDEX IF NOT EXISTS items_story_notes ON items(received_at) WHERE story_note_status IN ('pending', 'working');

-- PC time spent writing story notes, for the usage caps and Statistics.
CREATE TABLE IF NOT EXISTS story_runs (
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL,
  story_id TEXT,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  seconds REAL,
  watts REAL,
  ok INTEGER NOT NULL,
  error TEXT,
  at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS story_runs_at ON story_runs(at);
