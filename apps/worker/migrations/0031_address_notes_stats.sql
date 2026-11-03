-- Newsletter addresses: a short note per address, and stored arrival counts so the
-- Add page can show totals, last arrival and a month-by-month count without reading
-- every item. A trigger on items keeps the numbers in step with each email stored.
-- Months are calendar months in UTC, counted by when the email arrived (created_at).

ALTER TABLE addresses ADD COLUMN note TEXT;
ALTER TABLE addresses ADD COLUMN item_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE addresses ADD COLUMN last_item_at INTEGER;

CREATE TABLE IF NOT EXISTS address_months (
  address_id TEXT NOT NULL,
  month TEXT NOT NULL, -- 'YYYY-MM'
  n INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (address_id, month)
);

-- Backfill from the emails already stored.
INSERT OR REPLACE INTO address_months (address_id, month, n)
SELECT address_id, strftime('%Y-%m', created_at / 1000, 'unixepoch'), COUNT(*)
FROM items WHERE address_id IS NOT NULL
GROUP BY 1, 2;

UPDATE addresses SET
  item_count = COALESCE((SELECT SUM(n) FROM address_months WHERE address_months.address_id = addresses.id), 0),
  last_item_at = (SELECT MAX(created_at) FROM items WHERE items.address_id = addresses.id);

CREATE TRIGGER IF NOT EXISTS address_stats_on_item AFTER INSERT ON items WHEN new.address_id IS NOT NULL BEGIN
  UPDATE addresses SET item_count = item_count + 1, last_item_at = MAX(COALESCE(last_item_at, 0), new.created_at)
  WHERE id = new.address_id;
  INSERT INTO address_months (address_id, month, n)
  VALUES (new.address_id, strftime('%Y-%m', new.created_at / 1000, 'unixepoch'), 1)
  ON CONFLICT(address_id, month) DO UPDATE SET n = n + 1;
END;
