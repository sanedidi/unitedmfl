-- Friendly matches belong to no season: season_id becomes optional.
ALTER TABLE matches ALTER COLUMN season_id DROP NOT NULL;
