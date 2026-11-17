-- Videos can be uploaded as files (served from /uploads/videos/) as well as
-- linked (YouTube or any other address).
ALTER TABLE videos ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'link' CHECK (source IN ('link', 'file'));
UPDATE videos SET source = 'file' WHERE url LIKE '%/uploads/videos/%';
