-- Team kit photo; players dressed in it by the AI service (originals are kept).
ALTER TABLE teams
    ADD COLUMN kit_url         TEXT NOT NULL DEFAULT '',
    ADD COLUMN kit_description TEXT NOT NULL DEFAULT '';

-- photo_url stays the original upload. kit_photo_url is the latest AI result;
-- kit_approved_url is what the site shows instead of the original once approved.
ALTER TABLE players
    ADD COLUMN kit_photo_url    TEXT NOT NULL DEFAULT '',
    ADD COLUMN kit_approved_url TEXT NOT NULL DEFAULT '',
    ADD COLUMN kit_status       TEXT NOT NULL DEFAULT ''
        CHECK (kit_status IN ('', 'queued', 'running', 'review', 'approved', 'rejected', 'error', 'skipped', 'multi', 'cancelled')),
    ADD COLUMN kit_error        TEXT NOT NULL DEFAULT '',
    ADD COLUMN kit_hint         TEXT NOT NULL DEFAULT '',
    ADD COLUMN kit_analysis     JSONB,
    ADD COLUMN kit_model        TEXT NOT NULL DEFAULT '',
    ADD COLUMN kit_updated_at   TIMESTAMPTZ;

CREATE INDEX players_kit_queue ON players (kit_updated_at, id) WHERE kit_status = 'queued';
