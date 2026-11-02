-- Flood guard: 1 = posts past the daily limit are dropped instead of going to Archived.
ALTER TABLE sources ADD COLUMN flood_skip INTEGER NOT NULL DEFAULT 0;
