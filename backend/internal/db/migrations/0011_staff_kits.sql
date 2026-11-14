-- The coaching staff is dressed in the team kit too (same flow as players).
ALTER TABLE team_staff
    ADD COLUMN kit_photo_url    TEXT NOT NULL DEFAULT '',
    ADD COLUMN kit_approved_url TEXT NOT NULL DEFAULT '',
    ADD COLUMN kit_status       TEXT NOT NULL DEFAULT ''
        CHECK (kit_status IN ('', 'queued', 'running', 'review', 'approved', 'rejected', 'error', 'skipped', 'multi', 'cancelled')),
    ADD COLUMN kit_error        TEXT NOT NULL DEFAULT '',
    ADD COLUMN kit_hint         TEXT NOT NULL DEFAULT '',
    ADD COLUMN kit_analysis     JSONB,
    ADD COLUMN kit_model        TEXT NOT NULL DEFAULT '',
    ADD COLUMN kit_updated_at   TIMESTAMPTZ;

CREATE INDEX team_staff_kit_queue ON team_staff (kit_updated_at, id) WHERE kit_status = 'queued';
