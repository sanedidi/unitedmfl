-- Media reja: the Instagram plan of every group, counted back from the group's
-- final match. Team managers get the tasks from the Telegram bot and send the
-- post links back; moderators approve them in the admin or in the bot.

-- the person who posts for the team; the bot recognises them by this phone
ALTER TABLE teams ADD COLUMN IF NOT EXISTS manager_name  TEXT NOT NULL DEFAULT '';
ALTER TABLE teams ADD COLUMN IF NOT EXISTS manager_phone TEXT NOT NULL DEFAULT '';

-- one row: reminder times (Asia/Tashkent) and checks
CREATE TABLE IF NOT EXISTS media_settings (
    id             INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    evening_on     BOOLEAN NOT NULL DEFAULT true,
    evening_time   TIME    NOT NULL DEFAULT '20:00',
    morning_on     BOOLEAN NOT NULL DEFAULT true,
    morning_time   TIME    NOT NULL DEFAULT '09:00',
    deadline_time  TIME    NOT NULL DEFAULT '23:59',
    overdue_on     BOOLEAN NOT NULL DEFAULT true,
    overdue_time   TIME    NOT NULL DEFAULT '10:00',
    escalate_time  TIME    NOT NULL DEFAULT '12:00',
    report_on      BOOLEAN NOT NULL DEFAULT true,
    report_time    TIME    NOT NULL DEFAULT '23:00',
    auto_check     BOOLEAN NOT NULL DEFAULT true,
    require_review BOOLEAN NOT NULL DEFAULT true,
    last_report_on DATE,
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO media_settings (id) VALUES (1) ON CONFLICT DO NOTHING;

-- the template: one row per task of a team. offsets[n] is the day of the
-- n-th team of the group relative to the final (0 = final day, -10 = ten days before)
CREATE TABLE IF NOT EXISTS media_template_items (
    id            BIGSERIAL PRIMARY KEY,
    ord           INT     NOT NULL DEFAULT 0,
    title         TEXT    NOT NULL,
    short         TEXT    NOT NULL DEFAULT '',
    description   TEXT    NOT NULL DEFAULT '',
    stage         INT     NOT NULL DEFAULT 1 CHECK (stage BETWEEN 1 AND 9),
    with_bloggers BOOLEAN NOT NULL DEFAULT false,
    sponsor       TEXT    NOT NULL DEFAULT '',
    rival         INT     NOT NULL DEFAULT 0 CHECK (rival BETWEEN 0 AND 9), -- a reply to the n-th rival of the group
    offsets       INT[]   NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT media_template_title_len CHECK (char_length(title) BETWEEN 1 AND 80),
    CONSTRAINT media_template_offsets CHECK (cardinality(offsets) BETWEEN 1 AND 9)
);

INSERT INTO media_template_items (ord, title, short, description, stage, with_bloggers, sponsor, rival, offsets)
SELECT * FROM (VALUES
    (1, 'Chaqiruv — guruhga', 'Chaqiruv', 'Guruhdagi raqiblarga video-chaqiruv. Blogerlar ishtirokida, ikkala raqib jamoa akkauntini belgilang.', 1, true, '', 0, ARRAY[-10,-9,-8]),
    (2, 'Homiy post', 'Homiy', 'Click homiy posti — brief bo‘yicha, Click logotipi va belgisi bilan.', 1, true, 'CLICK', 0, ARRAY[-9,-8,-7]),
    (3, 'Javob — 1-raqibga', 'Javob', 'Guruhdagi birinchi raqib chaqiruviga javob.', 2, false, '', 1, ARRAY[-7,-6,-5]),
    (4, 'Javob — 2-raqibga', 'Javob', 'Guruhdagi ikkinchi raqib chaqiruviga javob.', 2, false, '', 2, ARRAY[-6,-5,-4]),
    (5, 'Oflayn tomoshaga taklif', 'Oflayn', 'Muxlislarni o‘yinni stadionda tomosha qilishga chaqiring, chipta havolasini qo‘shing.', 2, false, '', 0, ARRAY[-4,-3,-2]),
    (6, 'Homiy post', 'Homiy', 'RWB homiy posti — brief bo‘yicha, RWB logotipi va belgisi bilan.', 3, true, 'RWB', 0, ARRAY[-3,-2,-1]),
    (7, 'TVda tomoshaga taklif', 'TV', 'Final kuni muxlislarni o‘yinni TVda tomosha qilishga chaqiring.', 3, true, '', 0, ARRAY[0,0,0])
) AS v(ord, title, short, description, stage, with_bloggers, sponsor, rival, offsets)
WHERE NOT EXISTS (SELECT 1 FROM media_template_items);

-- a group's plan; team_ids is the order of the teams (1-, 2-, 3-jamoa)
CREATE TABLE IF NOT EXISTS media_plans (
    id               BIGSERIAL PRIMARY KEY,
    group_id         BIGINT NOT NULL UNIQUE REFERENCES team_groups(id) ON DELETE CASCADE,
    final_match_id   BIGINT REFERENCES matches(id) ON DELETE SET NULL,
    final_date       DATE   NOT NULL,
    team_ids         BIGINT[] NOT NULL DEFAULT '{}',
    pending_ignored  DATE,  -- the admin kept the plan when the final moved to this date
    pending_notified DATE,  -- moderators were told in the bot that the final moved to this date
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS media_tasks (
    id              BIGSERIAL PRIMARY KEY,
    plan_id         BIGINT  NOT NULL REFERENCES media_plans(id) ON DELETE CASCADE,
    team_id         BIGINT  NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    item_id         BIGINT  REFERENCES media_template_items(id) ON DELETE SET NULL,
    ord             INT     NOT NULL DEFAULT 0,
    title           TEXT    NOT NULL,
    short           TEXT    NOT NULL DEFAULT '',
    description     TEXT    NOT NULL DEFAULT '',
    stage           INT     NOT NULL DEFAULT 1,
    with_bloggers   BOOLEAN NOT NULL DEFAULT false,
    sponsor         TEXT    NOT NULL DEFAULT '',
    target_team_id  BIGINT  REFERENCES teams(id) ON DELETE SET NULL,
    day_offset      INT     NOT NULL,
    due_date        DATE    NOT NULL,
    locked          BOOLEAN NOT NULL DEFAULT false, -- the date was set by hand: moving the final leaves it
    status          TEXT    NOT NULL DEFAULT 'todo' CHECK (status IN ('todo','review','done','returned')),
    link            TEXT    NOT NULL DEFAULT '',
    checks          JSONB   NOT NULL DEFAULT '{}',
    submitted_at    TIMESTAMPTZ,
    submitted_by    TEXT    NOT NULL DEFAULT '',
    reviewed_at     TIMESTAMPTZ,
    reviewed_by     BIGINT  REFERENCES users(id) ON DELETE SET NULL,
    comment         TEXT    NOT NULL DEFAULT '', -- moderator → manager
    note            TEXT    NOT NULL DEFAULT '', -- manager → admin (late, cannot)
    evening_sent_at TIMESTAMPTZ,
    morning_sent_at TIMESTAMPTZ,
    overdue_sent_at TIMESTAMPTZ,
    escalated_at    TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS media_tasks_item_key ON media_tasks (plan_id, team_id, item_id);
CREATE INDEX IF NOT EXISTS media_tasks_due_idx ON media_tasks (due_date);
CREATE INDEX IF NOT EXISTS media_tasks_status_idx ON media_tasks (status);

CREATE TABLE IF NOT EXISTS media_task_events (
    id      BIGSERIAL PRIMARY KEY,
    plan_id BIGINT NOT NULL REFERENCES media_plans(id) ON DELETE CASCADE,
    task_id BIGINT REFERENCES media_tasks(id) ON DELETE CASCADE,
    at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    kind    TEXT NOT NULL,
    actor   TEXT NOT NULL DEFAULT '',
    text    TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS media_task_events_plan_idx ON media_task_events (plan_id, at DESC);
CREATE INDEX IF NOT EXISTS media_task_events_task_idx ON media_task_events (task_id, at DESC);

-- Telegram account ↔ team manager. phone is the number confirmed at link time:
-- when the admin changes teams.manager_phone the link stops working.
-- One person may manage several teams.
CREATE TABLE IF NOT EXISTS media_manager_links (
    tg_user_id BIGINT NOT NULL,
    team_id    BIGINT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    phone      TEXT   NOT NULL,
    chat_id    BIGINT NOT NULL,
    username   TEXT   NOT NULL DEFAULT '',
    name       TEXT   NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (tg_user_id, team_id)
);
CREATE INDEX IF NOT EXISTS media_manager_links_team_idx ON media_manager_links (team_id);

-- messages the API asks the bot to deliver (approve/return from the web admin,
-- a reminder button, a moved final)
CREATE TABLE IF NOT EXISTS media_outbox (
    id            BIGSERIAL PRIMARY KEY,
    team_id       BIGINT REFERENCES teams(id) ON DELETE CASCADE, -- to the team's manager
    to_moderators BOOLEAN NOT NULL DEFAULT false,
    text          TEXT    NOT NULL,
    buttons       JSONB   NOT NULL DEFAULT '[]',
    attempts      INT     NOT NULL DEFAULT 0,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    sent_at       TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS media_outbox_unsent_idx ON media_outbox (id) WHERE sent_at IS NULL;
