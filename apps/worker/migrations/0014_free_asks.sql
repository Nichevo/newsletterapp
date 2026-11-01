-- Questions asked on their own (Add > Ask the AI), not from a highlight: the
-- pasted text lives here, and item_id / highlight_id are '' for these asks.
ALTER TABLE asks ADD COLUMN text TEXT;
