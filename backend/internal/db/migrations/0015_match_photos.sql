-- Match photo reports: every upload is converted to WebP (large + thumbnail).
ALTER TABLE matches ADD COLUMN IF NOT EXISTS photographer TEXT NOT NULL DEFAULT '';

CREATE TABLE IF NOT EXISTS match_photos (
    id             BIGSERIAL PRIMARY KEY,
    match_id       BIGINT NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
    url            TEXT   NOT NULL,
    thumb_url      TEXT   NOT NULL,
    width          INT    NOT NULL DEFAULT 0,
    height         INT    NOT NULL DEFAULT 0,
    bytes          BIGINT NOT NULL DEFAULT 0,
    original_bytes BIGINT NOT NULL DEFAULT 0,
    caption        TEXT   NOT NULL DEFAULT '',
    ord            INT    NOT NULL DEFAULT 0,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS match_photos_match_idx ON match_photos(match_id, ord, id);
