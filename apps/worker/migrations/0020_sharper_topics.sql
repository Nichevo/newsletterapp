-- Sharper topics: prompts that still carry the original topics line get the new one, as a new version.
-- Topics are what "You've read about this before" matches on, so broad ones ("AI") linked everything.

INSERT INTO prompt_versions (prompt_id, version, body, created_at)
SELECT id, version + 1, replace(body, '  "topics": ["up to 3 specific names or subjects, e.g. Nvidia, interest rates"],', '  "topics": ["up to 3 specific named things the issue is about (companies, products, people, places, laws, events) in their usual short name, e.g. Nvidia, Federal Reserve, EU AI Act; never broad subjects such as AI, technology or markets"],'), CAST(strftime('%s','now') AS INTEGER) * 1000
FROM prompts WHERE instr(body, '  "topics": ["up to 3 specific names or subjects, e.g. Nvidia, interest rates"],') > 0;

UPDATE prompts SET version = version + 1, body = replace(body, '  "topics": ["up to 3 specific names or subjects, e.g. Nvidia, interest rates"],', '  "topics": ["up to 3 specific named things the issue is about (companies, products, people, places, laws, events) in their usual short name, e.g. Nvidia, Federal Reserve, EU AI Act; never broad subjects such as AI, technology or markets"],'), updated_at = CAST(strftime('%s','now') AS INTEGER) * 1000
WHERE instr(body, '  "topics": ["up to 3 specific names or subjects, e.g. Nvidia, interest rates"],') > 0;
