-- Does the team kit show a player number on the front? Then every player needs
-- a number and the AI draws that player's own number on the photo.
ALTER TABLE teams
    ADD COLUMN kit_has_number   BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN kit_number_style TEXT    NOT NULL DEFAULT '';
