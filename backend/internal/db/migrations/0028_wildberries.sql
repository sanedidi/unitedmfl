-- Wildberries store (admin: Tizim → Wildberries, Merch → mahsulot).
-- Products and their WB cards are created only in the admin; a background
-- worker sends the card, photos and price to WB and pulls prices and
-- WB-warehouse (FBO) stocks back every 30 minutes.

CREATE TABLE IF NOT EXISTS wb_settings (
    id                INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    token_enc         BYTEA,                           -- API token, AES-GCM (never sent to the browser)
    token_set_at      TIMESTAMPTZ,
    token_expires_at  TIMESTAMPTZ,                     -- from the token itself (JWT exp)
    scopes            TEXT[] NOT NULL DEFAULT '{}',    -- API categories the token answered: content, prices, analytics
    seller_name       TEXT NOT NULL DEFAULT '',
    seller_sid        TEXT NOT NULL DEFAULT '',
    seller_trademark  TEXT NOT NULL DEFAULT '',
    seller_country    TEXT NOT NULL DEFAULT '',
    currency          TEXT NOT NULL DEFAULT '',        -- currencyIsoCode4217 of the price list (UZS for Uzbek sellers)
    link_domain       TEXT NOT NULL DEFAULT 'wildberries.uz',
    auto_push         BOOLEAN NOT NULL DEFAULT true,   -- a saved product goes to WB by itself
    pull_stocks       BOOLEAN NOT NULL DEFAULT true,   -- prices and FBO stocks come back every 30 min
    auto_out_of_stock BOOLEAN NOT NULL DEFAULT true,   -- all sizes at 0 → «Vaqtincha tugagan» on the site
    problem           TEXT NOT NULL DEFAULT '',        -- '', token_invalid, wb_down
    last_error        TEXT NOT NULL DEFAULT '',
    last_sync_at      TIMESTAMPTZ,                     -- last card / photo / price sent
    last_pull_at      TIMESTAMPTZ,                     -- last prices + stocks pull
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO wb_settings (id) VALUES (1) ON CONFLICT DO NOTHING;

ALTER TABLE products
    -- edited in the admin
    ADD COLUMN IF NOT EXISTS wb_enabled        BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS wb_subject_id     INT,
    ADD COLUMN IF NOT EXISTS wb_subject_name   TEXT NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS wb_brand          TEXT NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS wb_vendor_code    TEXT NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS wb_title          TEXT NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS wb_description    TEXT NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS wb_desc_from_site BOOLEAN NOT NULL DEFAULT true,
    ADD COLUMN IF NOT EXISTS wb_chars          JSONB NOT NULL DEFAULT '[]', -- [{id, name, value}] — value: string list or number
    ADD COLUMN IF NOT EXISTS wb_price          BIGINT,                      -- price sent to WB (before discount)
    ADD COLUMN IF NOT EXISTS wb_discount       INT NOT NULL DEFAULT 0 CHECK (wb_discount BETWEEN 0 AND 99),
    ADD COLUMN IF NOT EXISTS wb_show_button    BOOLEAN NOT NULL DEFAULT true,
    ADD COLUMN IF NOT EXISTS pkg_length        INT,                         -- cm, with packaging
    ADD COLUMN IF NOT EXISTS pkg_width         INT,
    ADD COLUMN IF NOT EXISTS pkg_height        INT,
    ADD COLUMN IF NOT EXISTS pkg_weight_g      INT,                         -- grams (sent to WB in kg)
    -- kept by the worker
    ADD COLUMN IF NOT EXISTS wb_nm_id          BIGINT,
    ADD COLUMN IF NOT EXISTS wb_imt_id         BIGINT,
    ADD COLUMN IF NOT EXISTS wb_state          TEXT NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS wb_error          TEXT NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS wb_attempts       INT NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS wb_next_try_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    ADD COLUMN IF NOT EXISTS wb_card_hash      TEXT NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS wb_media_hash     TEXT NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS wb_price_hash     TEXT NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS wb_pending_since  TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS wb_sent_at        TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS wb_cur_price      BIGINT,                      -- pulled from WB
    ADD COLUMN IF NOT EXISTS wb_cur_discount   INT,
    ADD COLUMN IF NOT EXISTS wb_cur_final      BIGINT,                      -- price with the discount
    ADD COLUMN IF NOT EXISTS wb_stock          INT,                         -- all sizes, WB warehouses
    ADD COLUMN IF NOT EXISTS wb_pulled_at      TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS wb_auto_oos       BOOLEAN NOT NULL DEFAULT false; -- «Tugagan» was set by the stock pull

DO $$ BEGIN
    ALTER TABLE products ADD CONSTRAINT products_wb_state_check
        CHECK (wb_state IN ('', 'incomplete', 'queued', 'pending', 'ready', 'error'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE UNIQUE INDEX IF NOT EXISTS products_wb_vendor_code ON products (wb_vendor_code) WHERE wb_vendor_code <> '';
CREATE INDEX IF NOT EXISTS products_wb_due ON products (wb_next_try_at) WHERE wb_state IN ('queued', 'pending');

ALTER TABLE product_variants
    ADD COLUMN IF NOT EXISTS wb_size    TEXT NOT NULL DEFAULT '', -- Russian size (wbSize)
    ADD COLUMN IF NOT EXISTS barcode    TEXT NOT NULL DEFAULT '', -- WB barcode (sku)
    ADD COLUMN IF NOT EXISTS wb_chrt_id BIGINT,                   -- WB size ID
    ADD COLUMN IF NOT EXISTS wb_stock   INT;                      -- WB warehouses

-- what happened with WB, newest first (the admin shows the last entries)
CREATE TABLE IF NOT EXISTS wb_log (
    id         BIGSERIAL PRIMARY KEY,
    at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    level      TEXT NOT NULL DEFAULT 'ok' CHECK (level IN ('ok', 'warn', 'error')),
    product_id BIGINT,
    text       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS wb_log_at ON wb_log (at DESC);
