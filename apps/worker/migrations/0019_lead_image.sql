-- Comic feeds and the like: show the post's picture in the inbox. The first real
-- image in the post (and its hover text) is picked out when it arrives.
ALTER TABLE items ADD COLUMN lead_image TEXT;
ALTER TABLE items ADD COLUMN lead_image_title TEXT;
ALTER TABLE sources ADD COLUMN show_picture INTEGER NOT NULL DEFAULT 0;
