-- The PC helper's once-a-minute "anything to embed?" check walked every item
-- still waiting for an AI summary first (items_embed_queue holds all of them,
-- including older ones outside the inbox whose summary never comes), about 500
-- rows a check. This index leaves those out, so the check reads only items it
-- can actually hand over.
CREATE INDEX IF NOT EXISTS items_embed_ready ON items(received_at)
  WHERE embedded_at IS NULL AND (ai_status IS NULL OR ai_status NOT IN ('pending', 'working'));
DROP INDEX IF EXISTS items_embed_queue;
