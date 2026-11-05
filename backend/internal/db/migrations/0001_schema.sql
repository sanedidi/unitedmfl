-- United MFL — base schema

CREATE TABLE IF NOT EXISTS users (
    id            BIGSERIAL PRIMARY KEY,
    name          TEXT        NOT NULL,
    email         TEXT        NOT NULL UNIQUE,
    password_hash TEXT        NOT NULL,
    role          TEXT        NOT NULL CHECK (role IN ('admin','editor','operator','shop')),
    status        TEXT        NOT NULL DEFAULT 'active' CHECK (status IN ('active','blocked')),
    last_login_at TIMESTAMPTZ,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS refresh_tokens (
    id         BIGSERIAL PRIMARY KEY,
    user_id    BIGINT      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash TEXT        NOT NULL UNIQUE,
    expires_at TIMESTAMPTZ NOT NULL,
    revoked_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS seasons (
    id         BIGSERIAL PRIMARY KEY,
    name       TEXT        NOT NULL,
    slug       TEXT        NOT NULL UNIQUE,
    is_active  BOOLEAN     NOT NULL DEFAULT false,
    teams_planned   INT,
    matches_planned INT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS stages (
    id         BIGSERIAL PRIMARY KEY,
    season_id  BIGINT NOT NULL REFERENCES seasons(id) ON DELETE CASCADE,
    name       TEXT   NOT NULL,
    kind       TEXT   NOT NULL CHECK (kind IN ('group','round_of_16','quarter','semi','final','other')),
    ord        INT    NOT NULL DEFAULT 0,
    status     TEXT   NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled','active','finished')),
    note       TEXT   NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS teams (
    id                    BIGSERIAL PRIMARY KEY,
    slug                  TEXT    NOT NULL UNIQUE,
    name                  TEXT    NOT NULL,
    short_name            TEXT    NOT NULL DEFAULT '',
    group_label           TEXT    NOT NULL DEFAULT '',
    group_is_provisional  BOOLEAN NOT NULL DEFAULT true,
    crest_url             TEXT    NOT NULL DEFAULT '',
    colors                TEXT[]  NOT NULL DEFAULT '{}',
    leader                TEXT    NOT NULL DEFAULT '',
    instagram             TEXT    NOT NULL DEFAULT '',
    telegram              TEXT    NOT NULL DEFAULT '',
    is_active             BOOLEAN NOT NULL DEFAULT true,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS players (
    id         BIGSERIAL PRIMARY KEY,
    team_id    BIGINT REFERENCES teams(id) ON DELETE SET NULL,
    full_name  TEXT   NOT NULL,
    number     INT,
    position   TEXT   NOT NULL DEFAULT '' CHECK (position IN ('','GK','DF','MF','FW')),
    photo_url  TEXT   NOT NULL DEFAULT '',
    instagram  TEXT   NOT NULL DEFAULT '',
    is_active  BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS players_team_idx ON players(team_id);

CREATE TABLE IF NOT EXISTS matches (
    id             BIGSERIAL PRIMARY KEY,
    season_id      BIGINT NOT NULL REFERENCES seasons(id) ON DELETE CASCADE,
    stage_id       BIGINT REFERENCES stages(id) ON DELETE SET NULL,
    round          TEXT   NOT NULL DEFAULT '',
    home_team_id   BIGINT REFERENCES teams(id) ON DELETE SET NULL,
    away_team_id   BIGINT REFERENCES teams(id) ON DELETE SET NULL,
    kickoff_at     TIMESTAMPTZ,
    venue          TEXT   NOT NULL DEFAULT '',
    ticket_url     TEXT   NOT NULL DEFAULT '',
    status         TEXT   NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled','live','halftime','finished','postponed','cancelled')),
    period         TEXT   NOT NULL DEFAULT '' CHECK (period IN ('','1H','HT','2H','ET','PEN','FT')),
    clock_started_at TIMESTAMPTZ,
    clock_offset_sec INT  NOT NULL DEFAULT 0,
    home_score     INT,
    away_score     INT,
    home_ht        INT,
    away_ht        INT,
    home_et        INT,
    away_et        INT,
    home_pen       INT,
    away_pen       INT,
    attendance     INT,
    added_time_1h  INT,
    added_time_2h  INT,
    banner_url     TEXT   NOT NULL DEFAULT '',
    video_url      TEXT   NOT NULL DEFAULT '',
    notes          TEXT   NOT NULL DEFAULT '',
    published      BOOLEAN NOT NULL DEFAULT true,
    show_in_hero   BOOLEAN NOT NULL DEFAULT false,
    protocol_id    BIGINT,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS matches_kickoff_idx ON matches(kickoff_at);
CREATE INDEX IF NOT EXISTS matches_stage_idx ON matches(stage_id);

CREATE TABLE IF NOT EXISTS match_events (
    id                 BIGSERIAL PRIMARY KEY,
    match_id           BIGINT NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
    team_id            BIGINT REFERENCES teams(id) ON DELETE SET NULL,
    side               TEXT   NOT NULL CHECK (side IN ('home','away')),
    type               TEXT   NOT NULL CHECK (type IN ('goal','own_goal','penalty_goal','penalty_missed','yellow','second_yellow','red','sub','shootout_scored','shootout_missed','period','note')),
    minute             INT    NOT NULL DEFAULT 0,
    extra_minute       INT    NOT NULL DEFAULT 0,
    player_id          BIGINT REFERENCES players(id) ON DELETE SET NULL,
    player_name        TEXT   NOT NULL DEFAULT '',
    related_player_id  BIGINT REFERENCES players(id) ON DELETE SET NULL,
    related_player_name TEXT  NOT NULL DEFAULT '',
    note               TEXT   NOT NULL DEFAULT '',
    source             TEXT   NOT NULL DEFAULT 'manual' CHECK (source IN ('live','protocol','manual')),
    created_by         BIGINT REFERENCES users(id) ON DELETE SET NULL,
    idempotency_key    TEXT,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS match_events_match_idx ON match_events(match_id, minute, extra_minute);
CREATE UNIQUE INDEX IF NOT EXISTS match_events_idem_idx ON match_events(match_id, idempotency_key) WHERE idempotency_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS lineups (
    id          BIGSERIAL PRIMARY KEY,
    match_id    BIGINT NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
    side        TEXT   NOT NULL CHECK (side IN ('home','away')),
    team_id     BIGINT REFERENCES teams(id) ON DELETE SET NULL,
    player_id   BIGINT REFERENCES players(id) ON DELETE SET NULL,
    player_name TEXT   NOT NULL,
    number      INT,
    position    TEXT   NOT NULL DEFAULT '',
    is_starter  BOOLEAN NOT NULL DEFAULT true,
    is_captain  BOOLEAN NOT NULL DEFAULT false
);
CREATE INDEX IF NOT EXISTS lineups_match_idx ON lineups(match_id);

CREATE TABLE IF NOT EXISTS match_officials (
    id       BIGSERIAL PRIMARY KEY,
    match_id BIGINT NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
    side     TEXT   NOT NULL DEFAULT '' CHECK (side IN ('','home','away')),
    role     TEXT   NOT NULL,
    name     TEXT   NOT NULL
);

CREATE TABLE IF NOT EXISTS standing_adjustments (
    id         BIGSERIAL PRIMARY KEY,
    season_id  BIGINT NOT NULL REFERENCES seasons(id) ON DELETE CASCADE,
    team_id    BIGINT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    points     INT    NOT NULL,
    reason     TEXT   NOT NULL,
    created_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS news (
    id              BIGSERIAL PRIMARY KEY,
    slug            TEXT   NOT NULL UNIQUE,
    title           TEXT   NOT NULL,
    category        TEXT   NOT NULL DEFAULT '',
    excerpt         TEXT   NOT NULL DEFAULT '',
    body            TEXT   NOT NULL DEFAULT '',
    cover_url       TEXT   NOT NULL DEFAULT '',
    status          TEXT   NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','scheduled')),
    published_at    TIMESTAMPTZ,
    match_id        BIGINT REFERENCES matches(id) ON DELETE SET NULL,
    tags            TEXT[] NOT NULL DEFAULT '{}',
    seo_description TEXT   NOT NULL DEFAULT '',
    on_home         BOOLEAN NOT NULL DEFAULT false,
    views           BIGINT NOT NULL DEFAULT 0,
    author_id       BIGINT REFERENCES users(id) ON DELETE SET NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS news_pub_idx ON news(status, published_at DESC);

CREATE TABLE IF NOT EXISTS banners (
    id             BIGSERIAL PRIMARY KEY,
    title          TEXT   NOT NULL,
    badge          TEXT   NOT NULL DEFAULT '',
    badge_type     TEXT   NOT NULL DEFAULT 'accent',
    event_date     DATE,
    event_time     TEXT   NOT NULL DEFAULT '',
    venue          TEXT   NOT NULL DEFAULT '',
    cta_label      TEXT   NOT NULL DEFAULT '',
    cta_url        TEXT   NOT NULL DEFAULT '',
    image_desktop  TEXT   NOT NULL DEFAULT '',
    image_mobile   TEXT   NOT NULL DEFAULT '',
    show_from      TIMESTAMPTZ,
    show_until     TIMESTAMPTZ,
    is_active      BOOLEAN NOT NULL DEFAULT true,
    status         TEXT   NOT NULL DEFAULT 'published' CHECK (status IN ('draft','published')),
    ord            INT    NOT NULL DEFAULT 0,
    note           TEXT   NOT NULL DEFAULT '',
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS videos (
    id            BIGSERIAL PRIMARY KEY,
    title         TEXT   NOT NULL,
    url           TEXT   NOT NULL,
    youtube_id    TEXT   NOT NULL DEFAULT '',
    kind          TEXT   NOT NULL DEFAULT 'highlight',
    match_id      BIGINT REFERENCES matches(id) ON DELETE SET NULL,
    duration_sec  INT,
    thumbnail_url TEXT   NOT NULL DEFAULT '',
    status        TEXT   NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published')),
    published_at  TIMESTAMPTZ,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS products (
    id          BIGSERIAL PRIMARY KEY,
    slug        TEXT   NOT NULL UNIQUE,
    name        TEXT   NOT NULL,
    category    TEXT   NOT NULL DEFAULT '',
    price_uzs   BIGINT NOT NULL CHECK (price_uzs >= 0),
    sale_price_uzs BIGINT,
    description TEXT   NOT NULL DEFAULT '',
    images      TEXT[] NOT NULL DEFAULT '{}',
    external_url TEXT  NOT NULL DEFAULT '',
    visible     BOOLEAN NOT NULL DEFAULT true,
    featured    BOOLEAN NOT NULL DEFAULT false,
    status      TEXT   NOT NULL DEFAULT 'active' CHECK (status IN ('active','in_review','out_of_stock','hidden')),
    ord         INT    NOT NULL DEFAULT 0,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS product_variants (
    id         BIGSERIAL PRIMARY KEY,
    product_id BIGINT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    size       TEXT   NOT NULL,
    sku        TEXT   NOT NULL DEFAULT '',
    stock      INT,
    available  BOOLEAN NOT NULL DEFAULT true
);

CREATE TABLE IF NOT EXISTS contact_requests (
    id            BIGSERIAL PRIMARY KEY,
    name          TEXT   NOT NULL,
    phone         TEXT   NOT NULL,
    topic         TEXT   NOT NULL DEFAULT 'other',
    message       TEXT   NOT NULL DEFAULT '',
    source        TEXT   NOT NULL DEFAULT 'site',
    status        TEXT   NOT NULL DEFAULT 'new' CHECK (status IN ('new','in_progress','closed')),
    assignee_id   BIGINT REFERENCES users(id) ON DELETE SET NULL,
    internal_note TEXT   NOT NULL DEFAULT '',
    ip            TEXT   NOT NULL DEFAULT '',
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS protocols (
    id           BIGSERIAL PRIMARY KEY,
    file_name    TEXT   NOT NULL,
    file_path    TEXT   NOT NULL,
    mime         TEXT   NOT NULL,
    size_bytes   BIGINT NOT NULL,
    pages        INT    NOT NULL DEFAULT 0,
    status       TEXT   NOT NULL DEFAULT 'uploaded' CHECK (status IN ('uploaded','processing','review','applied','failed','rejected')),
    progress     INT    NOT NULL DEFAULT 0,
    method       TEXT   NOT NULL DEFAULT '' CHECK (method IN ('','pdf_text','ocr')),
    match_id     BIGINT REFERENCES matches(id) ON DELETE SET NULL,
    extracted    JSONB,
    issues       JSONB  NOT NULL DEFAULT '[]',
    error        TEXT   NOT NULL DEFAULT '',
    publish_pdf  BOOLEAN NOT NULL DEFAULT false,
    uploaded_by  BIGINT REFERENCES users(id) ON DELETE SET NULL,
    applied_by   BIGINT REFERENCES users(id) ON DELETE SET NULL,
    applied_at   TIMESTAMPTZ,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS audit_log (
    id         BIGSERIAL PRIMARY KEY,
    user_id    BIGINT REFERENCES users(id) ON DELETE SET NULL,
    action     TEXT   NOT NULL,
    entity     TEXT   NOT NULL,
    entity_id  BIGINT,
    data       JSONB  NOT NULL DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS audit_created_idx ON audit_log(created_at DESC);
