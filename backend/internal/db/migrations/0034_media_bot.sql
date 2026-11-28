-- Media reja moves to its own Telegram bot («United MFL Media Control»):
-- moderators link to that bot here, apart from the Live-pult's telegram_links.
CREATE TABLE IF NOT EXISTS media_moderator_links (
    tg_user_id BIGINT      PRIMARY KEY,
    user_id    BIGINT      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    phone      TEXT        NOT NULL,
    chat_id    BIGINT      NOT NULL,
    username   TEXT        NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS media_moderator_links_user_idx ON media_moderator_links (user_id);

-- links and queued messages made through the shared bot before the split
DELETE FROM media_manager_links;
UPDATE media_outbox SET sent_at = now() WHERE sent_at IS NULL;
