-- Instagram feed: which Graph API the stored token belongs to.
--   instagram — Instagram User token (IGAA…), graph.instagram.com, refreshed every ~60 days
--   facebook  — Facebook Login for Business / system-user token (EAA…), graph.facebook.com
ALTER TABLE instagram_account ADD COLUMN IF NOT EXISTS api TEXT NOT NULL DEFAULT 'instagram'
    CHECK (api IN ('instagram', 'facebook'));
