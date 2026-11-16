-- Homepage layout builder. The admin edits one shared draft; publishing
-- copies it into a numbered version. The live homepage is the newest version
-- whose publish_at has passed, so a version can also be scheduled ahead.
CREATE TABLE IF NOT EXISTS homepage_draft (
    id           SMALLINT    PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    config       JSONB       NOT NULL,
    base_version INT,
    updated_by   BIGINT      REFERENCES users(id) ON DELETE SET NULL,
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS homepage_versions (
    id         BIGSERIAL   PRIMARY KEY,
    version    INT         NOT NULL UNIQUE,
    config     JSONB       NOT NULL,
    summary    TEXT        NOT NULL DEFAULT '',
    changes    JSONB       NOT NULL DEFAULT '[]',
    created_by BIGINT      REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    publish_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS homepage_versions_publish_at ON homepage_versions (publish_at DESC, version DESC);
