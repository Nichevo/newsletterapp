-- items.story_near: for an item matching left out of every story, how close its nearest
-- older item came in meaning when that was within reach of the line (a near miss), for
-- Statistics > Stories. NULL = matched, or nothing close.
ALTER TABLE items ADD COLUMN story_near REAL;
