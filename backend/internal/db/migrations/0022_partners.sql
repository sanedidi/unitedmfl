-- Sponsors and partners («Kontent» → «Hamkorlar»). Until now they were typed
-- into the homepage builder's Partners block; now the admin adds them with a
-- logo and an optional promo video, orders them and hides them here, and the
-- Partners block and the /hamkorlar page read this table.
CREATE TABLE IF NOT EXISTS partners (
    id                 BIGSERIAL   PRIMARY KEY,
    name               TEXT        NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 80),
    url                TEXT        NOT NULL DEFAULT '',
    kind               TEXT        NOT NULL DEFAULT 'official' CHECK (kind IN ('main', 'official', 'media')),
    description        TEXT        NOT NULL DEFAULT '',
    logo_url           TEXT        NOT NULL DEFAULT '',
    logo_name          TEXT        NOT NULL DEFAULT '',
    logo_size          INT,
    video_url          TEXT        NOT NULL DEFAULT '',
    video_name         TEXT        NOT NULL DEFAULT '',
    video_size         BIGINT,
    video_duration_sec INT,
    -- «Saytda nima ko‘rinadi»: false keeps the uploaded video but the site shows the logo only
    show_video         BOOLEAN     NOT NULL DEFAULT true,
    is_active          BOOLEAN     NOT NULL DEFAULT true,
    ord                INT         NOT NULL DEFAULT 0,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS partners_ord ON partners (ord, id);

-- «Bosh sahifadagi blok» card of the Hamkorlar page.
CREATE TABLE IF NOT EXISTS partner_settings (
    id         SMALLINT    PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    title      TEXT        NOT NULL DEFAULT 'Final homiylari',
    show_cta   BOOLEAN     NOT NULL DEFAULT true,  -- «+ Sizning brendingiz» card
    show_block BOOLEAN     NOT NULL DEFAULT true,  -- the homepage Partners block
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Carry over what the live homepage shows today: the Partners block of the
-- newest published version, or the built-in layout's names when nothing has
-- been published yet.
WITH cfg AS (
    SELECT config FROM homepage_versions WHERE publish_at <= now() ORDER BY publish_at DESC, version DESC LIMIT 1
), blk AS (
    SELECT b FROM cfg, jsonb_array_elements(cfg.config -> 'rows') r, jsonb_array_elements(r -> 'blocks') b
    WHERE b ->> 'type' = 'partners' LIMIT 1
)
INSERT INTO partner_settings (id, title, show_cta)
SELECT 1,
       coalesce((SELECT nullif(btrim(b ->> 'title'), '') FROM blk), 'Final homiylari'),
       coalesce((SELECT (b -> 'props' ->> 'cta')::boolean FROM blk), true)
ON CONFLICT (id) DO NOTHING;

WITH cfg AS (
    SELECT config FROM homepage_versions WHERE publish_at <= now() ORDER BY publish_at DESC, version DESC LIMIT 1
), blk AS (
    SELECT b FROM cfg, jsonb_array_elements(cfg.config -> 'rows') r, jsonb_array_elements(r -> 'blocks') b
    WHERE b ->> 'type' = 'partners' LIMIT 1
), items AS (
    SELECT it, n FROM blk, jsonb_array_elements(coalesce(blk.b -> 'props' -> 'items', '[]')) WITH ORDINALITY AS t(it, n)
    WHERE jsonb_typeof(it) = 'object'
), src AS (
    SELECT left(coalesce(nullif(btrim(it ->> 'name'), ''), 'Hamkor'), 80) AS name,
           coalesce(btrim(it ->> 'url'), '') AS url, coalesce(btrim(it ->> 'logo'), '') AS logo_url,
           'official' AS kind, n::int AS ord
    FROM items WHERE coalesce(btrim(it ->> 'name'), '') <> '' OR coalesce(btrim(it ->> 'logo'), '') <> ''
    UNION ALL
    SELECT * FROM (VALUES ('realme', '', '', 'main', 1), ('Click', '', '', 'official', 2), ('Wildberries', '', '', 'official', 3)) d(name, url, logo_url, kind, ord)
    WHERE NOT EXISTS (SELECT 1 FROM cfg)
)
INSERT INTO partners (name, url, logo_url, kind, ord)
SELECT name, url, logo_url, kind, ord FROM src
WHERE NOT EXISTS (SELECT 1 FROM partners);
