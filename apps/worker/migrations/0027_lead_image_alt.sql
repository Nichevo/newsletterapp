-- A post's picture keeps its alt text as well as its hover text (shown under the picture in the inbox).
ALTER TABLE items ADD COLUMN lead_image_alt TEXT;
