package auth

import (
	"context"
	"database/sql"
	"log/slog"
	"sync"
	"time"
)

// rolesTTL bounds how long another process (or a missed Invalidate) may serve
// stale permissions; changes made through the admin API apply at once.
const rolesTTL = 30 * time.Second

// Roles answers permission questions from the roles and role_permissions tables.
// The whole table is small, so it is cached in memory and reloaded after a change
// (Invalidate) or when the cache is older than rolesTTL.
type Roles struct {
	db *sql.DB

	mu     sync.RWMutex
	perms  map[string]map[string]bool // role slug → permissions
	loaded time.Time
}

func NewRoles(db *sql.DB) *Roles { return &Roles{db: db} }

// Invalidate drops the cache; the next question reloads it.
func (r *Roles) Invalidate() {
	r.mu.Lock()
	r.perms = nil
	r.mu.Unlock()
}

func (r *Roles) snapshot(ctx context.Context) map[string]map[string]bool {
	r.mu.RLock()
	m, at := r.perms, r.loaded
	r.mu.RUnlock()
	if m != nil && time.Since(at) < rolesTTL {
		return m
	}
	fresh, err := r.load(ctx)
	if err != nil {
		slog.Warn("roles: load failed", "err", err)
		if m != nil {
			return m // keep serving the last good copy
		}
		return map[string]map[string]bool{}
	}
	r.mu.Lock()
	r.perms, r.loaded = fresh, time.Now()
	r.mu.Unlock()
	return fresh
}

func (r *Roles) load(ctx context.Context) (map[string]map[string]bool, error) {
	rows, err := r.db.QueryContext(ctx, `SELECT r.slug, coalesce(p.perm, '') FROM roles r LEFT JOIN role_permissions p ON p.role_id = r.id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]map[string]bool{}
	for rows.Next() {
		var slug, perm string
		if err := rows.Scan(&slug, &perm); err != nil {
			return nil, err
		}
		if out[slug] == nil {
			out[slug] = map[string]bool{}
		}
		if perm != "" {
			out[slug][perm] = true
		}
	}
	return out, rows.Err()
}

// Can reports whether role has permission perm ("news:create"; a bare page key
// means view). Administrators can do everything.
func (r *Roles) Can(ctx context.Context, role, perm string) bool {
	if role == RoleAdmin {
		return true
	}
	set := r.snapshot(ctx)[role]
	if perm == PermUploads {
		return uploadsAllowed(set)
	}
	return set[Normalize(perm)]
}

// Permissions returns the permission list of a role (used by the admin UI).
func (r *Roles) Permissions(ctx context.Context, role string) []string {
	if role == RoleAdmin {
		return append(AllPermissions(), PermUploads)
	}
	set := r.snapshot(ctx)[role]
	out := []string{}
	for _, p := range AllPermissions() {
		if set[p] {
			out = append(out, p)
		}
	}
	if uploadsAllowed(set) {
		out = append(out, PermUploads)
	}
	return out
}

// uploadsAllowed: image uploads come with any right to create or edit something.
func uploadsAllowed(set map[string]bool) bool {
	for p := range set {
		if _, a := SplitKey(p); a == ActCreate || a == ActEdit {
			return true
		}
	}
	return false
}
