-- Team self-registration: the admin opens a registration link, a team
-- representative fills an application on the separate registration site, the
-- admin reviews it and approval creates the team, its players and staff.

CREATE TABLE IF NOT EXISTS registration_links (
    id               BIGSERIAL PRIMARY KEY,
    code             TEXT    NOT NULL UNIQUE,
    title            TEXT    NOT NULL,
    season_id        BIGINT  REFERENCES seasons(id) ON DELETE SET NULL,
    stage_id         BIGINT  REFERENCES stages(id) ON DELETE SET NULL,
    kind             TEXT    NOT NULL DEFAULT 'multi' CHECK (kind IN ('multi', 'single')),
    -- closed unless the admin opens it
    is_active        BOOLEAN NOT NULL DEFAULT false,
    -- shown on the root page of the registration site
    is_default       BOOLEAN NOT NULL DEFAULT false,
    opens_at         TIMESTAMPTZ,
    closes_at        TIMESTAMPTZ,
    max_teams        INT     CHECK (max_teams IS NULL OR max_teams > 0),
    min_players      INT     NOT NULL DEFAULT 8  CHECK (min_players BETWEEN 1 AND 60),
    max_players      INT     NOT NULL DEFAULT 20 CHECK (max_players BETWEEN 1 AND 60),
    min_age          INT     CHECK (min_age IS NULL OR min_age BETWEEN 5 AND 60),
    require_logo     BOOLEAN NOT NULL DEFAULT true,
    require_photo    BOOLEAN NOT NULL DEFAULT false,
    require_medical  BOOLEAN NOT NULL DEFAULT false,
    require_phone    BOOLEAN NOT NULL DEFAULT true,
    check_duplicates BOOLEAN NOT NULL DEFAULT true,
    heading          TEXT    NOT NULL DEFAULT '',
    description      TEXT    NOT NULL DEFAULT '',
    rules_url        TEXT    NOT NULL DEFAULT '',
    created_by       BIGINT  REFERENCES users(id) ON DELETE SET NULL,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS registration_links_one_default ON registration_links ((true)) WHERE is_default;

CREATE TABLE IF NOT EXISTS team_applications (
    id                BIGSERIAL PRIMARY KEY,
    link_id           BIGINT REFERENCES registration_links(id) ON DELETE SET NULL,
    -- secret part of the representative's URL (/a/{token})
    token             TEXT   NOT NULL UNIQUE,
    status            TEXT   NOT NULL DEFAULT 'draft'
        CHECK (status IN ('draft', 'submitted', 'review', 'changes', 'approved', 'rejected')),
    team              JSONB  NOT NULL DEFAULT '{}',
    rep               JSONB  NOT NULL DEFAULT '{}',
    players           JSONB  NOT NULL DEFAULT '[]',
    staff             JSONB  NOT NULL DEFAULT '[]',
    consents          JSONB  NOT NULL DEFAULT '{}',
    rep_phone         TEXT   NOT NULL DEFAULT '',
    phone_verified_at TIMESTAMPTZ,
    comments          JSONB  NOT NULL DEFAULT '[]',
    changes_deadline  TIMESTAMPTZ,
    reject_reason     TEXT   NOT NULL DEFAULT '',
    internal_note     TEXT   NOT NULL DEFAULT '',
    team_id           BIGINT REFERENCES teams(id) ON DELETE SET NULL,
    ip                TEXT   NOT NULL DEFAULT '',
    submitted_at      TIMESTAMPTZ,
    decided_at        TIMESTAMPTZ,
    decided_by        BIGINT REFERENCES users(id) ON DELETE SET NULL,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS team_applications_status_idx ON team_applications (status, updated_at DESC);
CREATE INDEX IF NOT EXISTS team_applications_link_idx ON team_applications (link_id);
CREATE INDEX IF NOT EXISTS team_applications_phone_idx ON team_applications (rep_phone) WHERE rep_phone <> '';

CREATE TABLE IF NOT EXISTS application_events (
    id             BIGSERIAL PRIMARY KEY,
    application_id BIGINT NOT NULL REFERENCES team_applications(id) ON DELETE CASCADE,
    kind           TEXT   NOT NULL,
    note           TEXT   NOT NULL DEFAULT '',
    user_id        BIGINT REFERENCES users(id) ON DELETE SET NULL,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS application_events_app_idx ON application_events (application_id, id);

-- one pending SMS code per application
CREATE TABLE IF NOT EXISTS registration_otps (
    application_id BIGINT PRIMARY KEY REFERENCES team_applications(id) ON DELETE CASCADE,
    phone          TEXT   NOT NULL,
    code_hash      TEXT   NOT NULL,
    expires_at     TIMESTAMPTZ NOT NULL,
    attempts       INT    NOT NULL DEFAULT 0,
    sends          INT    NOT NULL DEFAULT 1,
    sent_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Roster fields from the league's TARKIB.xlsx template.
ALTER TABLE players
    ADD COLUMN IF NOT EXISTS birth_date  DATE,
    ADD COLUMN IF NOT EXISTS jersey_name TEXT    NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS kit_size    TEXT    NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS workplace   TEXT    NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS is_media    BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS medical_url TEXT    NOT NULL DEFAULT '';
ALTER TABLE team_staff
    ADD COLUMN IF NOT EXISTS birth_date DATE,
    ADD COLUMN IF NOT EXISTS kit_size   TEXT NOT NULL DEFAULT '';
