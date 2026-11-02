-- Embeddings worked out on the PC helper (the vectors stay on the PC).
-- embedded_at: when the helper last embedded the item; NULL = waiting.
-- neighbours: the nearest older items as JSON [[id, similarity], ...], for related reading.
-- likely: 1 when the item is close to what was marked Interesting.
ALTER TABLE items ADD COLUMN embedded_at INTEGER;
ALTER TABLE items ADD COLUMN neighbours TEXT;
ALTER TABLE items ADD COLUMN likely INTEGER;

CREATE INDEX items_embed_queue ON items(received_at) WHERE embedded_at IS NULL;
CREATE INDEX items_likely ON items(received_at DESC) WHERE likely = 1;
