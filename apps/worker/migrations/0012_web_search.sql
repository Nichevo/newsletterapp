-- Web search (Brave, through the PC helper) and Wikipedia lookups.

-- Lookups that were wanted for a highlight question but couldn't be made.
ALTER TABLE asks ADD COLUMN lookup_note TEXT;

-- Summaries written with web search results: context the issue assumes,
-- and other coverage of the same story (JSON [{title, url}]).
ALTER TABLE items ADD COLUMN background TEXT;
ALTER TABLE items ADD COLUMN coverage TEXT;
