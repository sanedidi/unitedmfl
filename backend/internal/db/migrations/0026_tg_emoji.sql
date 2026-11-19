-- Telegram custom emoji from team logos: a second set kind next to the stickers.
-- Same bot and owner; 100×100 images, up to 200 emoji per set.

ALTER TABLE tg_sticker_settings
    ADD COLUMN IF NOT EXISTS emoji_enabled BOOLEAN NOT NULL DEFAULT false, -- keep the emoji set in step with the teams
    ADD COLUMN IF NOT EXISTS emoji_slug    TEXT    NOT NULL DEFAULT 'unitedmfl_emoji',
    ADD COLUMN IF NOT EXISTS emoji_title   TEXT    NOT NULL DEFAULT 'United MFL — Emoji',
    ADD COLUMN IF NOT EXISTS emoji_outline BOOLEAN NOT NULL DEFAULT true;  -- thin white border (2 px)

ALTER TABLE tg_sticker_sets ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'sticker' CHECK (kind IN ('sticker', 'emoji'));

-- one row per team and kind
ALTER TABLE tg_stickers ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'sticker' CHECK (kind IN ('sticker', 'emoji'));
ALTER TABLE tg_stickers DROP CONSTRAINT IF EXISTS tg_stickers_pkey;
ALTER TABLE tg_stickers ADD PRIMARY KEY (team_id, kind);
