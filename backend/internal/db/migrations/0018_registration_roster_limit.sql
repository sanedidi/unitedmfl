-- The roster limit now counts players, media people and coaching staff together
-- (8–21 people per team).
ALTER TABLE registration_links ALTER COLUMN max_players SET DEFAULT 21;
UPDATE registration_links SET max_players = 21 WHERE max_players > 21;
