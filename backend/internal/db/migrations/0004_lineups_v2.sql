-- Lineups v2: formations, pitch slots, publication status, team staff and
-- formation-change events (see Figma «United MFL — Admin · Lineup Editor»).

ALTER TABLE lineups ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT '';
ALTER TABLE lineups ADD COLUMN IF NOT EXISTS slot SMALLINT;

CREATE TABLE IF NOT EXISTS lineup_meta (
    match_id     BIGINT NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
    side         TEXT   NOT NULL CHECK (side IN ('home','away')),
    formation    TEXT   NOT NULL DEFAULT '',
    status       TEXT   NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published')),
    source       TEXT   NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','protocol','copy')),
    coach        TEXT   NOT NULL DEFAULT '',
    assistant    TEXT   NOT NULL DEFAULT '',
    version      INT    NOT NULL DEFAULT 1,
    published_at TIMESTAMPTZ,
    published_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
    updated_by   BIGINT REFERENCES users(id) ON DELETE SET NULL,
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (match_id, side)
);

-- Lineups that already exist were visible on the site: keep them published.
INSERT INTO lineup_meta (match_id, side, status, source, published_at)
SELECT DISTINCT l.match_id, l.side, 'published',
       CASE WHEN m.protocol_id IS NOT NULL THEN 'protocol' ELSE 'manual' END, now()
FROM lineups l JOIN matches m ON m.id = l.match_id
ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS team_staff (
    id           BIGSERIAL PRIMARY KEY,
    team_id      BIGINT  NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    full_name    TEXT    NOT NULL,
    role         TEXT    NOT NULL DEFAULT 'other' CHECK (role IN ('head_coach','assistant','gk_coach','fitness','doctor','manager','other')),
    photo_url    TEXT    NOT NULL DEFAULT '',
    show_on_site BOOLEAN NOT NULL DEFAULT true,
    ord          INT     NOT NULL DEFAULT 0,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS team_staff_team_idx ON team_staff(team_id, ord);

ALTER TABLE match_events ADD COLUMN IF NOT EXISTS payload JSONB;
ALTER TABLE match_events DROP CONSTRAINT IF EXISTS match_events_type_check;
ALTER TABLE match_events ADD CONSTRAINT match_events_type_check CHECK (type IN
    ('goal','own_goal','penalty_goal','penalty_missed','yellow','second_yellow','red','sub',
     'shootout_scored','shootout_missed','period','note','formation'));
