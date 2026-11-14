-- History of AI image generations started from the admin (banner page).
-- The pictures themselves live in /uploads/images; keys and settings live in the AI service.
CREATE TABLE IF NOT EXISTS ai_generations (
    id              BIGSERIAL PRIMARY KEY,
    user_id         BIGINT REFERENCES users(id) ON DELETE SET NULL,
    user_name       TEXT        NOT NULL DEFAULT '',
    target          TEXT        NOT NULL DEFAULT 'banner',
    target_id       BIGINT,
    layout          TEXT        NOT NULL DEFAULT '',
    prompt_original TEXT        NOT NULL DEFAULT '',
    prompt          TEXT        NOT NULL,
    formats         TEXT[]      NOT NULL DEFAULT '{}',
    assets          JSONB       NOT NULL DEFAULT '[]',
    status          TEXT        NOT NULL DEFAULT 'running'
        CHECK (status IN ('running', 'done', 'applied', 'saved', 'error', 'cancelled')),
    error           TEXT        NOT NULL DEFAULT '',
    provider        TEXT        NOT NULL DEFAULT '',
    model           TEXT        NOT NULL DEFAULT '',
    duration_ms     INT         NOT NULL DEFAULT 0,
    variants        JSONB       NOT NULL DEFAULT '[]',
    applied_variant INT,
    warnings        JSONB       NOT NULL DEFAULT '[]',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ai_generations_created_idx ON ai_generations (created_at DESC);
