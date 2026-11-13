-- Instagram feed for the /media page (Instagram API with Instagram Login).
-- One connected account; posts are synced by the API and their images are
-- copied into /uploads, so the site never hotlinks expiring Instagram CDN URLs.

CREATE TABLE IF NOT EXISTS instagram_account (
    id               SMALLINT    PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    access_token     TEXT        NOT NULL DEFAULT '',
    ig_user_id       TEXT        NOT NULL DEFAULT '',
    username         TEXT        NOT NULL DEFAULT '',
    token_expires_at TIMESTAMPTZ,
    token_set_at     TIMESTAMPTZ,
    last_sync_at     TIMESTAMPTZ,
    last_error       TEXT        NOT NULL DEFAULT '',
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS instagram_posts (
    id         TEXT        PRIMARY KEY,           -- Instagram media id
    caption    TEXT        NOT NULL DEFAULT '',
    media_type TEXT        NOT NULL,              -- IMAGE | VIDEO | CAROUSEL_ALBUM
    is_reel    BOOLEAN     NOT NULL DEFAULT false,
    image_url  TEXT        NOT NULL,              -- local /uploads/images/ig-<id>.<ext>
    permalink  TEXT        NOT NULL,
    posted_at  TIMESTAMPTZ NOT NULL,
    is_hidden  BOOLEAN     NOT NULL DEFAULT false,
    synced_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS instagram_posts_posted_at ON instagram_posts (posted_at DESC);
