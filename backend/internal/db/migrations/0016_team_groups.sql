-- Groups become their own entity instead of a fixed A–H letter on the team.
-- teams.group_label / group_is_provisional stay as a mirror of the group
-- (kept in sync by triggers) so standings and the site keep working as is.
CREATE TABLE IF NOT EXISTS team_groups (
    id         BIGSERIAL PRIMARY KEY,
    season_id  BIGINT REFERENCES seasons(id) ON DELETE SET NULL,
    name       TEXT    NOT NULL,
    code       TEXT    NOT NULL,
    ord        INT     NOT NULL DEFAULT 0,
    confirmed  BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT team_groups_code_len CHECK (char_length(code) BETWEEN 1 AND 4),
    CONSTRAINT team_groups_name_len CHECK (char_length(name) BETWEEN 1 AND 40)
);
CREATE UNIQUE INDEX IF NOT EXISTS team_groups_code_key ON team_groups (coalesce(season_id, 0), lower(code));

ALTER TABLE teams ADD COLUMN IF NOT EXISTS group_id  BIGINT REFERENCES team_groups(id) ON DELETE SET NULL;
ALTER TABLE teams ADD COLUMN IF NOT EXISTS group_ord INT NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS teams_group_idx ON teams (group_id);

-- team → mirror columns
CREATE OR REPLACE FUNCTION teams_group_mirror() RETURNS trigger AS $$
BEGIN
    IF NEW.group_id IS NULL THEN
        NEW.group_label := '';
        NEW.group_is_provisional := false;
        NEW.group_ord := 0;
    ELSE
        SELECT g.code, NOT g.confirmed INTO NEW.group_label, NEW.group_is_provisional FROM team_groups g WHERE g.id = NEW.group_id;
        -- joined a group → goes to the end of its list
        IF TG_OP = 'INSERT' OR OLD.group_id IS DISTINCT FROM NEW.group_id THEN
            SELECT coalesce(max(group_ord), 0) + 1 INTO NEW.group_ord FROM teams WHERE group_id = NEW.group_id AND id <> NEW.id;
        END IF;
    END IF;
    RETURN NEW;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS teams_group_mirror ON teams;
CREATE TRIGGER teams_group_mirror BEFORE INSERT OR UPDATE OF group_id ON teams
    FOR EACH ROW EXECUTE FUNCTION teams_group_mirror();

-- group renamed / confirmed → its teams
CREATE OR REPLACE FUNCTION team_groups_propagate() RETURNS trigger AS $$
BEGIN
    UPDATE teams SET group_label = NEW.code, group_is_provisional = NOT NEW.confirmed WHERE group_id = NEW.id;
    RETURN NEW;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS team_groups_propagate ON team_groups;
CREATE TRIGGER team_groups_propagate AFTER UPDATE OF code, confirmed ON team_groups
    FOR EACH ROW EXECUTE FUNCTION team_groups_propagate();

-- existing letters → groups «Guruh X» in the active season
INSERT INTO team_groups (season_id, name, code, ord, confirmed)
SELECT (SELECT id FROM seasons ORDER BY is_active DESC, id DESC LIMIT 1),
       'Guruh ' || upper(group_label), upper(group_label),
       row_number() OVER (ORDER BY upper(group_label)),
       NOT bool_or(group_is_provisional)
FROM teams WHERE group_label <> '' AND group_id IS NULL
GROUP BY upper(group_label)
ON CONFLICT DO NOTHING;
UPDATE teams t SET group_id = g.id
FROM team_groups g
WHERE t.group_id IS NULL AND t.group_label <> '' AND upper(t.group_label) = g.code;
