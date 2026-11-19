-- Telegram stickers from team logos (admin: Tizim → Telegram stikerlar).
-- The bot owns the sticker set on behalf of one Telegram account (owner_id);
-- every team with a logo gets one sticker, kept in step with the logo.

CREATE TABLE IF NOT EXISTS tg_sticker_settings (
    id             INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    token_enc      BYTEA,                         -- bot token, AES-GCM (never sent to the browser)
    bot_id         BIGINT NOT NULL DEFAULT 0,
    bot_username   TEXT NOT NULL DEFAULT '',
    token_set_at   TIMESTAMPTZ,                   -- owner candidates are /start messages after this
    owner_id       BIGINT NOT NULL DEFAULT 0,     -- Telegram user the sets belong to
    owner_username TEXT NOT NULL DEFAULT '',
    owner_name     TEXT NOT NULL DEFAULT '',
    set_slug       TEXT NOT NULL DEFAULT 'unitedmfl',
    set_title      TEXT NOT NULL DEFAULT 'United MFL — Jamoalar',
    outline        BOOLEAN NOT NULL DEFAULT true, -- white border around the logo
    auto_update    BOOLEAN NOT NULL DEFAULT true, -- a changed logo replaces the sticker by itself
    enabled        BOOLEAN NOT NULL DEFAULT false,-- the first set has been created
    problem        TEXT NOT NULL DEFAULT '',      -- '', token_invalid, owner_blocked, telegram_down
    last_error     TEXT NOT NULL DEFAULT '',
    last_sync_at   TIMESTAMPTZ,
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO tg_sticker_settings (id) VALUES (1) ON CONFLICT DO NOTHING;

-- sticker sets in use; a set holds up to 120 stickers, then the next one opens
CREATE TABLE IF NOT EXISTS tg_sticker_sets (
    name       TEXT PRIMARY KEY,                  -- <slug>[N]_by_<bot>
    ord        INT NOT NULL,
    title      TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- one row per team sticker; no foreign key: the row outlives a deleted team
-- until its sticker is removed from Telegram
CREATE TABLE IF NOT EXISTS tg_stickers (
    team_id        BIGINT PRIMARY KEY,
    set_name       TEXT NOT NULL DEFAULT '',
    file_id        TEXT NOT NULL DEFAULT '',
    file_unique_id TEXT NOT NULL DEFAULT '',
    image          TEXT NOT NULL DEFAULT '',     -- the sent PNG under /uploads/images/stickers/
    source         TEXT NOT NULL DEFAULT '',     -- crest_url and look the sticker was built from
    state          TEXT NOT NULL DEFAULT 'queued' CHECK (state IN ('queued', 'ready', 'error', 'removing')),
    attempts       INT NOT NULL DEFAULT 0,
    next_try_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_error     TEXT NOT NULL DEFAULT '',
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS tg_stickers_due ON tg_stickers (next_try_at) WHERE state IN ('queued', 'removing');

-- who sent /start to which bot: the admin picks the set owner from this list
CREATE TABLE IF NOT EXISTS tg_bot_starts (
    bot_id     BIGINT NOT NULL,
    tg_user_id BIGINT NOT NULL,
    username   TEXT NOT NULL DEFAULT '',
    name       TEXT NOT NULL DEFAULT '',
    at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (bot_id, tg_user_id)
);
