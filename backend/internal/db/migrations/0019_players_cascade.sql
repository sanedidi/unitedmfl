-- Deleting a team now deletes its players (and media people) too, the same
-- way its coaching staff is deleted. Match events and lineups keep the row
-- with player_id set to NULL.
ALTER TABLE players DROP CONSTRAINT IF EXISTS players_team_id_fkey;
ALTER TABLE players ADD CONSTRAINT players_team_id_fkey
    FOREIGN KEY (team_id) REFERENCES teams(id) ON DELETE CASCADE;
