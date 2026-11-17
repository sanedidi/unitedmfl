-- Site visitors for the admin Dashboard («Sayt tashriflari»). The public site
-- (unitedmfl.uz) sends one hit per page view and a heartbeat every minute
-- while a tab is open (POST /api/v1/track). No cookies and no IP addresses are
-- stored: a visitor is an HMAC of an anonymous random id the browser keeps.

-- One row per page view. Kept 90 days (see RunVisitStats), then only the
-- daily totals in site_daily remain.
CREATE TABLE IF NOT EXISTS site_hits (
    id      BIGSERIAL   PRIMARY KEY,
    at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    visitor TEXT        NOT NULL,
    path    TEXT        NOT NULL,
    -- where the visit came from, set on the first page of a visit only:
    -- instagram, telegram, google, yandex, facebook, youtube, tiktok, other, direct
    source  TEXT        NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS site_hits_at ON site_hits (at);

-- Who has the site open right now: a row per visitor, refreshed by every view
-- and heartbeat. «Hozir onlayn» counts rows seen in the last 5 minutes.
CREATE TABLE IF NOT EXISTS site_online (
    visitor TEXT        PRIMARY KEY,
    path    TEXT        NOT NULL,
    seen_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS site_online_seen ON site_online (seen_at);

-- Daily totals (Tashkent days), kept for good after the raw hits expire.
CREATE TABLE IF NOT EXISTS site_daily (
    day        DATE        PRIMARY KEY,
    visitors   INT         NOT NULL,
    views      INT         NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
