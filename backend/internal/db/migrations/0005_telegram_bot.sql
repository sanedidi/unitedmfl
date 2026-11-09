-- Telegram Live-pult bot.
-- An administrator writes the operator's phone number on the user card; the bot
-- lets in only Telegram accounts that share exactly that number.

ALTER TABLE users ADD COLUMN IF NOT EXISTS phone TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS users_phone_key ON users (phone) WHERE phone IS NOT NULL;

-- Telegram account ↔ admin user. phone is the number confirmed at link time:
-- if the administrator changes or clears users.phone, the link stops working.
CREATE TABLE IF NOT EXISTS telegram_links (
    tg_user_id BIGINT      PRIMARY KEY,
    user_id    BIGINT      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    phone      TEXT        NOT NULL,
    chat_id    BIGINT      NOT NULL,
    username   TEXT        NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS telegram_links_user_idx ON telegram_links (user_id);
