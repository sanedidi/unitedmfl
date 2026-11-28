-- Rollar va huquqlar v2: every page has separate actions — view, create, edit and
-- delete — stored as "page:action" (news:view, news:create, …). A page opened
-- in v1 (bare key "news") meant full access, so it becomes every action of that
-- page. Exceptions keep today's behaviour: Matchlar was split into
-- matches:read / matches:edit, and only applications:delete could delete
-- sent applications.
WITH acts(page, actions) AS (VALUES
    ('dashboard',    ARRAY['view']),
    ('protocols',    ARRAY['view','create','edit']),
    ('live',         ARRAY['view','edit']),
    ('teams',        ARRAY['view','create','edit','delete']),
    ('applications', ARRAY['view','create','edit']),
    ('groups',       ARRAY['view','create','edit','delete']),
    ('players',      ARRAY['view','create','edit','delete']),
    ('standings',    ARRAY['view','edit']),
    ('seasons',      ARRAY['view','create','edit','delete']),
    ('homepage',     ARRAY['view','edit']),
    ('news',         ARRAY['view','create','edit','delete']),
    ('banners',      ARRAY['view','create','edit','delete']),
    ('videos',       ARRAY['view','create','edit','delete']),
    ('partners',     ARRAY['view','create','edit','delete']),
    ('instagram',    ARRAY['view','edit']),
    ('tickets',      ARRAY['view','create','edit']),
    ('stadiums',     ARRAY['view','create','edit','delete']),
    ('scan',         ARRAY['view']),
    ('merch',        ARRAY['view','create','edit','delete']),
    ('requests',     ARRAY['view','edit','delete']),
    ('ai',           ARRAY['view','edit']),
    ('stickers',     ARRAY['view','edit']),
    ('wildberries',  ARRAY['view','edit']),
    ('users',        ARRAY['view','create','edit','delete']),
    ('roles',        ARRAY['view','create','edit','delete']),
    ('audit',        ARRAY['view']),
    -- old split keys of Matchlar
    ('matches:read', ARRAY['view']),
    ('matches:edit', ARRAY['view','create','edit','delete'])
)
INSERT INTO role_permissions (role_id, perm)
SELECT rp.role_id, split_part(a.page, ':', 1) || ':' || x
FROM role_permissions rp
JOIN acts a ON a.page = rp.perm
CROSS JOIN LATERAL unnest(a.actions) AS x
ON CONFLICT DO NOTHING;

-- deleting applications keeps its own key; it needs viewing the page too
INSERT INTO role_permissions (role_id, perm)
SELECT role_id, 'applications:view' FROM role_permissions WHERE perm = 'applications:delete'
ON CONFLICT DO NOTHING;

DELETE FROM role_permissions WHERE perm NOT LIKE '%:%' OR perm = 'matches:read';
