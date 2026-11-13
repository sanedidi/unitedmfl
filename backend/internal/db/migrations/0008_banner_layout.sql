-- Hero banner layout: how the title, date and buttons sit over the full-bleed photo.
--   shade  — graphite gradient on the left and bottom (default)
--   panel  — solid graphite panel across the bottom
--   glass  — blurred translucent card
--   split  — slanted graphite plane on the left with a lime edge
--   poster — centred copy on a vignette (finals, special events)
ALTER TABLE banners ADD COLUMN IF NOT EXISTS layout TEXT NOT NULL DEFAULT 'shade'
    CHECK (layout IN ('shade', 'panel', 'glass', 'split', 'poster'));
