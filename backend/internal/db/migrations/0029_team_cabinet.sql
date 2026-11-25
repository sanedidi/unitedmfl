-- Team cabinet: a team signs in at ariza.<domain>/jamoa/<login> with the login
-- and password the league gives it, edits its info, roster, staff and kit as a
-- draft and sends the draft for review. Nothing reaches the site until an
-- admin approves it (all items or a part of them).

CREATE TABLE IF NOT EXISTS team_accounts (
    team_id         BIGINT      PRIMARY KEY REFERENCES teams(id) ON DELETE CASCADE,
    login           TEXT        NOT NULL UNIQUE CHECK (login ~ '^[a-z0-9][a-z0-9-]{2,39}$'),
    password_hash   TEXT        NOT NULL,
    enabled         BOOLEAN     NOT NULL DEFAULT true,
    failed_attempts INT         NOT NULL DEFAULT 0,
    locked_until    TIMESTAMPTZ,
    password_set_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_login_at   TIMESTAMPTZ,
    last_login_ua   TEXT        NOT NULL DEFAULT '',
    created_by      BIGINT      REFERENCES users(id) ON DELETE SET NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Signed-in devices. The token itself is never stored, only its SHA-256.
CREATE TABLE IF NOT EXISTS team_sessions (
    id           BIGSERIAL   PRIMARY KEY,
    team_id      BIGINT      NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    token_hash   TEXT        NOT NULL UNIQUE,
    user_agent   TEXT        NOT NULL DEFAULT '',
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at   TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS team_sessions_team_idx ON team_sessions (team_id, expires_at);

-- One request per round: draft → submitted → approved | partial | rejected,
-- or back to the team (changes) and submitted again. draft is the desired
-- state of the team; items are the changes computed when it was sent, each
-- with the admin's decision.
CREATE TABLE IF NOT EXISTS team_change_requests (
    id            BIGSERIAL   PRIMARY KEY,
    team_id       BIGINT      NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    status        TEXT        NOT NULL DEFAULT 'draft'
                  CHECK (status IN ('draft', 'submitted', 'changes', 'approved', 'partial', 'rejected', 'withdrawn')),
    draft         JSONB       NOT NULL DEFAULT '{}',
    items         JSONB       NOT NULL DEFAULT '[]',
    comment       TEXT        NOT NULL DEFAULT '',
    internal_note TEXT        NOT NULL DEFAULT '',
    submitted_by  TEXT        NOT NULL DEFAULT '',
    submitted_at  TIMESTAMPTZ,
    decided_at    TIMESTAMPTZ,
    decided_by    BIGINT      REFERENCES users(id) ON DELETE SET NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS team_change_requests_open ON team_change_requests (team_id)
    WHERE status IN ('draft', 'submitted', 'changes');
CREATE INDEX IF NOT EXISTS team_change_requests_list ON team_change_requests (status, submitted_at DESC);

-- History shown in the admin (cabinet created, password reset, sign-ins, requests).
CREATE TABLE IF NOT EXISTS team_cabinet_events (
    id         BIGSERIAL   PRIMARY KEY,
    team_id    BIGINT      NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    request_id BIGINT      REFERENCES team_change_requests(id) ON DELETE CASCADE,
    kind       TEXT        NOT NULL,
    note       TEXT        NOT NULL DEFAULT '',
    user_id    BIGINT      REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS team_cabinet_events_team_idx ON team_cabinet_events (team_id, created_at DESC);
