-- Per-team roster limit: an admin may let one application have more (or fewer)
-- people than its registration link allows. NULL — the link's limit applies.
ALTER TABLE team_applications
    ADD COLUMN IF NOT EXISTS max_players INT CHECK (max_players BETWEEN 1 AND 70);
