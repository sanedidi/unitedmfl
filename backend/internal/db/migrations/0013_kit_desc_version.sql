-- Descriptions written before number detection (v2) may contain the sample's
-- digits and miss kit_has_number; the API re-describes those kits once.
ALTER TABLE teams ADD COLUMN kit_desc_version INT NOT NULL DEFAULT 0;
