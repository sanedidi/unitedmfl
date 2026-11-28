-- Roles editable in the admin panel (Rollar va huquqlar): an administrator creates
-- roles and ticks which admin pages each role may open.
CREATE SEQUENCE IF NOT EXISTS roles_custom_seq;

CREATE TABLE roles (
    id          BIGSERIAL   PRIMARY KEY,
    -- stable key stored in users.role and in access tokens; custom roles get custom_N
    slug        TEXT        NOT NULL UNIQUE DEFAULT ('custom_' || nextval('roles_custom_seq')),
    name        TEXT        NOT NULL CHECK (btrim(name) <> ''),
    description TEXT        NOT NULL DEFAULT '',
    -- the administrator role: every page, cannot be changed or deleted
    is_system   BOOLEAN     NOT NULL DEFAULT false,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX roles_name_key ON roles (lower(btrim(name)));

CREATE TABLE role_permissions (
    role_id BIGINT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
    perm    TEXT   NOT NULL,
    PRIMARY KEY (role_id, perm)
);

-- the roles that were fixed in code until now, with the same access; pages that
-- used to share one permission (Guruhlar and O‘yinchilar with Jamoalar, Instagram
-- with Videolar) are now separate, so editors keep them explicitly
INSERT INTO roles (slug, name, description, is_system) VALUES
    ('admin',      'Administrator',   'Barcha bo‘limlar',                          true),
    ('editor',     'Muharrir',        'Kontent, jamoalar va arizalar',             false),
    ('operator',   'Match operatori', 'Matchlar, Live-pult va protokollar',        false),
    ('shop',       'Do‘kon menejeri', 'Merch, chiptalar va murojaatlar',           false),
    ('controller', 'Nazoratchi',      'Stadion kirishida chiptalarni skanerlaydi', false);

INSERT INTO role_permissions (role_id, perm)
SELECT r.id, p.perm FROM roles r
JOIN (VALUES
    ('editor', 'dashboard'), ('editor', 'matches:read'), ('editor', 'teams'), ('editor', 'groups'),
    ('editor', 'players'), ('editor', 'applications'), ('editor', 'homepage'), ('editor', 'news'),
    ('editor', 'banners'), ('editor', 'videos'), ('editor', 'partners'), ('editor', 'instagram'),
    ('editor', 'requests'),
    ('operator', 'dashboard'), ('operator', 'matches:read'), ('operator', 'matches:edit'),
    ('operator', 'live'), ('operator', 'protocols'),
    ('shop', 'dashboard'), ('shop', 'merch'), ('shop', 'requests'), ('shop', 'tickets'), ('shop', 'scan'),
    ('controller', 'scan')
) AS p(slug, perm) ON p.slug = r.slug;

-- users.role now points at a role row instead of a fixed list
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_fkey FOREIGN KEY (role) REFERENCES roles(slug) ON UPDATE CASCADE;
