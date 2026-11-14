-- AI service storage. API keys are encrypted with AES-GCM (AI_MASTER_KEY);
-- only a masked form ever leaves the service.
CREATE TABLE IF NOT EXISTS ai_providers (
    provider     TEXT PRIMARY KEY CHECK (provider IN ('openai', 'gemini')),
    api_key_enc  BYTEA       NOT NULL,
    key_mask     TEXT        NOT NULL DEFAULT '',
    org_id       TEXT        NOT NULL DEFAULT '',
    base_url     TEXT        NOT NULL DEFAULT '',
    status       TEXT        NOT NULL DEFAULT 'unknown',
    checked_at   TIMESTAMPTZ,
    latency_ms   INT         NOT NULL DEFAULT 0,
    image_models TEXT[]      NOT NULL DEFAULT '{}',
    text_models  TEXT[]      NOT NULL DEFAULT '{}',
    last_error   TEXT        NOT NULL DEFAULT '',
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ai_settings (
    id         INT PRIMARY KEY CHECK (id = 1),
    data       JSONB       NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
