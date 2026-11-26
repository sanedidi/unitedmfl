-- Match tickets: stadium constructor (venues, layout versions, library),
-- per-match sales with zone prices, orders and tickets, entry scanning
-- with dynamic QR and optional face binding.

-- controllers (nazoratchi) only scan tickets at the gates
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('admin','editor','operator','shop','controller'));

-- ---------- stadium constructor ----------
CREATE TABLE IF NOT EXISTS venues (
    id          BIGSERIAL PRIMARY KEY,
    name        TEXT NOT NULL,
    city        TEXT NOT NULL DEFAULT '',
    archived    BOOLEAN NOT NULL DEFAULT false,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One row per version. At most one draft per venue; published versions are
-- never edited again (matches keep pointing at the version they were sold on).
CREATE TABLE IF NOT EXISTS venue_layouts (
    id            BIGSERIAL PRIMARY KEY,
    venue_id      BIGINT NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
    version       INT    NOT NULL,
    status        TEXT   NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','archived')),
    doc           JSONB  NOT NULL DEFAULT '{}',
    seats         INT    NOT NULL DEFAULT 0,
    note          TEXT   NOT NULL DEFAULT '',
    parent_id     BIGINT REFERENCES venue_layouts(id) ON DELETE SET NULL, -- copied from (another venue or version)
    created_by    BIGINT REFERENCES users(id) ON DELETE SET NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    published_at  TIMESTAMPTZ,
    UNIQUE (venue_id, version)
);
CREATE UNIQUE INDEX IF NOT EXISTS venue_layouts_one_draft ON venue_layouts(venue_id) WHERE status = 'draft';

-- Library: saved stands and sections, reused in any layout.
CREATE TABLE IF NOT EXISTS layout_templates (
    id          BIGSERIAL PRIMARY KEY,
    name        TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    kind        TEXT NOT NULL DEFAULT 'stand' CHECK (kind IN ('stand','section')),
    doc         JSONB NOT NULL,           -- a Stand or a Section of the layout document
    zones       JSONB NOT NULL DEFAULT '[]', -- zones the template refers to
    seats       INT NOT NULL DEFAULT 0,
    version     INT NOT NULL DEFAULT 1,   -- bumped on every save: linked copies offer an update
    visibility  TEXT NOT NULL DEFAULT 'all' CHECK (visibility IN ('private','all')),
    owner_id    BIGINT REFERENCES users(id) ON DELETE SET NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- sales ----------
CREATE TABLE IF NOT EXISTS ticket_sales (
    id               BIGSERIAL PRIMARY KEY,
    match_id         BIGINT NOT NULL UNIQUE REFERENCES matches(id) ON DELETE CASCADE,
    layout_id        BIGINT REFERENCES venue_layouts(id) ON DELETE RESTRICT, -- a published version
    status           TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','open','paused','closed')),
    sale_from        TIMESTAMPTZ,
    sale_to          TIMESTAMPTZ,
    hold_minutes     INT NOT NULL DEFAULT 10,
    max_per_order    INT NOT NULL DEFAULT 10,
    refund_hours     INT NOT NULL DEFAULT 48,
    service_fee      BIGINT NOT NULL DEFAULT 0,
    telegram_delivery BOOLEAN NOT NULL DEFAULT true,
    box_office       BOOLEAN NOT NULL DEFAULT false,
    -- entry security
    dynamic_qr       BOOLEAN NOT NULL DEFAULT true,
    single_scan      BOOLEAN NOT NULL DEFAULT true,
    face_mode        TEXT NOT NULL DEFAULT 'off' CHECK (face_mode IN ('off','vip','all')),
    face_check       TEXT NOT NULL DEFAULT 'manual' CHECK (face_check IN ('auto','manual')),
    face_threshold   INT NOT NULL DEFAULT 90 CHECK (face_threshold BETWEEN 50 AND 99),
    activation_hours INT NOT NULL DEFAULT 2,  -- activate up to N hours before kick-off
    transfer_allowed BOOLEAN NOT NULL DEFAULT true,
    no_face_entry    BOOLEAN NOT NULL DEFAULT true,
    face_retention_days INT NOT NULL DEFAULT 7,
    opened_at        TIMESTAMPTZ,
    opened_by        BIGINT REFERENCES users(id) ON DELETE SET NULL,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Price and options of a zone (ticket kind) for one match.
CREATE TABLE IF NOT EXISTS ticket_zone_prices (
    id         BIGSERIAL PRIMARY KEY,
    sale_id    BIGINT NOT NULL REFERENCES ticket_sales(id) ON DELETE CASCADE,
    zone_key   TEXT NOT NULL,
    title      TEXT NOT NULL DEFAULT '',
    subtitle   TEXT NOT NULL DEFAULT '',
    price      BIGINT NOT NULL DEFAULT 0 CHECK (price >= 0),
    enabled    BOOLEAN NOT NULL DEFAULT true,
    named      BOOLEAN NOT NULL DEFAULT false, -- holder name required (VIP)
    perks      TEXT[] NOT NULL DEFAULT '{}',
    gate       TEXT NOT NULL DEFAULT '',
    sort       INT NOT NULL DEFAULT 0,
    UNIQUE (sale_id, zone_key)
);

CREATE TABLE IF NOT EXISTS ticket_orders (
    id            BIGSERIAL PRIMARY KEY,
    number        TEXT NOT NULL UNIQUE,
    sale_id       BIGINT NOT NULL REFERENCES ticket_sales(id) ON DELETE RESTRICT,
    buyer_name    TEXT NOT NULL,
    phone         TEXT NOT NULL,
    email         TEXT NOT NULL DEFAULT '',
    telegram      BOOLEAN NOT NULL DEFAULT false,
    status        TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','paid','refund_requested','partially_refunded','refunded','cancelled','expired')),
    total         BIGINT NOT NULL DEFAULT 0,
    service_fee   BIGINT NOT NULL DEFAULT 0,
    refunded      BIGINT NOT NULL DEFAULT 0,
    provider      TEXT NOT NULL DEFAULT '' CHECK (provider IN ('','payme','click','uzum','cash','test')),
    provider_txn  TEXT NOT NULL DEFAULT '',
    provider_state JSONB NOT NULL DEFAULT '{}',
    card_mask     TEXT NOT NULL DEFAULT '',
    source        TEXT NOT NULL DEFAULT 'site' CHECK (source IN ('site','box_office')),
    access_token  TEXT NOT NULL UNIQUE,          -- buyer's link to the order (SMS)
    hold_until    TIMESTAMPTZ,
    paid_at       TIMESTAMPTZ,
    cancel_reason TEXT NOT NULL DEFAULT '',
    created_by    BIGINT REFERENCES users(id) ON DELETE SET NULL, -- box office seller
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ticket_orders_sale ON ticket_orders(sale_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ticket_orders_pending ON ticket_orders(hold_until) WHERE status = 'pending';

CREATE TABLE IF NOT EXISTS tickets (
    id            BIGSERIAL PRIMARY KEY,
    order_id      BIGINT NOT NULL REFERENCES ticket_orders(id) ON DELETE CASCADE,
    sale_id       BIGINT NOT NULL REFERENCES ticket_sales(id) ON DELETE RESTRICT,
    number        TEXT NOT NULL UNIQUE,
    zone_key      TEXT NOT NULL,
    seat_id       TEXT,           -- SECTION:ROW:N for numbered zones
    section_key   TEXT NOT NULL DEFAULT '',
    row_label     TEXT NOT NULL DEFAULT '',
    seat_no       INT,
    gate          TEXT NOT NULL DEFAULT '',
    price         BIGINT NOT NULL,
    holder_name   TEXT NOT NULL DEFAULT '',
    status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','active','used','cancelled','refunded')),
    qr_secret     BYTEA NOT NULL,
    holder_token  TEXT NOT NULL UNIQUE,  -- the ticket's own link (sent to a friend)
    transfer_sent_at TIMESTAMPTZ,
    activated_at  TIMESTAMPTZ,           -- face bound (or confirmed without face)
    face_status   TEXT NOT NULL DEFAULT 'none' CHECK (face_status IN ('none','bound','document')),
    used_at       TIMESTAMPTZ,
    used_gate     TEXT NOT NULL DEFAULT '',
    used_by       BIGINT REFERENCES users(id) ON DELETE SET NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS tickets_order ON tickets(order_id);
CREATE INDEX IF NOT EXISTS tickets_sale_zone ON tickets(sale_id, zone_key) WHERE status IN ('pending','active','used');
-- a numbered seat is sold once per match
CREATE UNIQUE INDEX IF NOT EXISTS tickets_seat_once ON tickets(sale_id, seat_id) WHERE seat_id IS NOT NULL AND status IN ('pending','active','used');

-- Face binding. The template and the photo are encrypted; the row is deleted
-- face_retention_days after the match (biometrics stay on our server in Uzbekistan).
CREATE TABLE IF NOT EXISTS ticket_faces (
    ticket_id    BIGINT PRIMARY KEY REFERENCES tickets(id) ON DELETE CASCADE,
    photo_enc    BYTEA NOT NULL,       -- small JPEG shown to the controller
    template_enc BYTEA,                -- embedding from the face service (auto check)
    liveness     JSONB NOT NULL DEFAULT '{}',
    consent_at   TIMESTAMPTZ NOT NULL,
    delete_after TIMESTAMPTZ NOT NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ticket_scans (
    id          BIGSERIAL PRIMARY KEY,
    sale_id     BIGINT REFERENCES ticket_sales(id) ON DELETE CASCADE,
    ticket_id   BIGINT REFERENCES tickets(id) ON DELETE SET NULL,
    gate        TEXT NOT NULL DEFAULT '',
    scanner_id  BIGINT REFERENCES users(id) ON DELETE SET NULL,
    result      TEXT NOT NULL, -- ok, used, stale, invalid, cancelled, wrong_match, not_activated, face_ok, face_mismatch, document, rejected
    score       INT,
    detail      TEXT NOT NULL DEFAULT '',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ticket_scans_sale ON ticket_scans(sale_id, created_at DESC);

CREATE TABLE IF NOT EXISTS ticket_refunds (
    id          BIGSERIAL PRIMARY KEY,
    order_id    BIGINT NOT NULL REFERENCES ticket_orders(id) ON DELETE CASCADE,
    ticket_ids  BIGINT[] NOT NULL,
    amount      BIGINT NOT NULL,
    reason      TEXT NOT NULL DEFAULT '',
    status      TEXT NOT NULL DEFAULT 'done' CHECK (status IN ('requested','done','failed')),
    provider_ref TEXT NOT NULL DEFAULT '',
    created_by  BIGINT REFERENCES users(id) ON DELETE SET NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- raw payment provider calls (Payme / Click), for disputes
CREATE TABLE IF NOT EXISTS ticket_payment_log (
    id         BIGSERIAL PRIMARY KEY,
    provider   TEXT NOT NULL,
    order_id   BIGINT REFERENCES ticket_orders(id) ON DELETE SET NULL,
    method     TEXT NOT NULL DEFAULT '',
    request    JSONB NOT NULL DEFAULT '{}',
    response   JSONB NOT NULL DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
