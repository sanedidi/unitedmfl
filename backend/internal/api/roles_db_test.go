package api

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"net/http/httptest"
	"os"
	"strconv"
	"testing"
	"time"

	_ "github.com/lib/pq"

	"github.com/sanedidi/unitedmfl/backend/internal/config"
	"github.com/sanedidi/unitedmfl/backend/internal/db"
)

// Runs only with TEST_DATABASE_URL pointing at a throwaway Postgres database.
func TestRolesAndPageAccess(t *testing.T) {
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("TEST_DATABASE_URL not set")
	}
	ctx := context.Background()
	conn, err := sql.Open("postgres", dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	if err := db.Migrate(ctx, conn); err != nil {
		t.Fatal(err)
	}
	sfx := strconv.FormatInt(time.Now().UnixNano()%1e9, 36)
	user := func(name, role string) int64 {
		var id int64
		if err := conn.QueryRow(`INSERT INTO users (name, email, password_hash, role) VALUES ($1, 'role-'||$2||'-'||$3||'@x.uz', 'x', $4) RETURNING id`,
			name, name, sfx, role).Scan(&id); err != nil {
			t.Fatal(err)
		}
		return id
	}
	adminID := user("admin", "admin")
	s := New(conn, &config.Config{UploadDir: t.TempDir(), JWTSecret: []byte("test-secret-test-secret-test-secret!!"), AccessTTL: time.Hour})
	h := s.Routes()
	tok := func(id int64) string { t, _, _ := s.Tokens.Sign(id, "editor", "x"); return t } // role in the token is ignored
	call := func(tk, method, path string, body, out any) int {
		t.Helper()
		var rd *bytes.Reader = bytes.NewReader(nil)
		if body != nil {
			b, _ := json.Marshal(body)
			rd = bytes.NewReader(b)
		}
		req := httptest.NewRequest(method, "/api/v1/admin"+path, rd)
		req.Header.Set("Authorization", "Bearer "+tk)
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		if out != nil {
			_ = json.Unmarshal(rec.Body.Bytes(), out)
		}
		return rec.Code
	}
	admin := tok(adminID)

	// catalog: 27 pages
	var cat struct{ Total int }
	if c := call(admin, "GET", "/permissions", nil, &cat); c != 200 || cat.Total != 27 {
		t.Fatalf("catalog: %d %+v", c, cat)
	}
	// built-in roles were migrated with their access
	var roles []roleDTO
	if c := call(admin, "GET", "/roles", nil, &roles); c != 200 || len(roles) < 5 || roles[0].Slug != "admin" || !roles[0].IsSystem || roles[0].Pages != 27 {
		t.Fatalf("roles: %d %+v", c, roles)
	}
	for _, r := range roles {
		if r.Slug == "editor" && (!contains(r.Permissions, "groups") || !contains(r.Permissions, "instagram") || contains(r.Permissions, "users")) {
			t.Fatalf("editor permissions: %v", r.Permissions)
		}
	}

	// create a role: unknown permission and empty list are rejected
	var e struct {
		Error struct{ Fields map[string]string }
	}
	if c := call(admin, "POST", "/roles", map[string]any{"name": "X", "permissions": []string{"nope"}}, &e); c != 422 || e.Error.Fields["permissions"] == "" {
		t.Fatalf("unknown perm: %d %+v", c, e)
	}
	if c := call(admin, "POST", "/roles", map[string]any{"name": "X", "permissions": []string{}}, nil); c != 422 {
		t.Fatalf("empty perms: %d", c)
	}
	name := "SMM menejer " + sfx
	var smm roleDTO
	// an extra without its page is dropped (applications:delete without applications)
	if c := call(admin, "POST", "/roles", map[string]any{"name": "  " + name + " ", "description": "Kontent",
		"permissions": []string{"news", "banners", "videos", "instagram", "applications:delete"}}, &smm); c != 201 || smm.Pages != 4 || len(smm.Permissions) != 4 || smm.Name != name {
		t.Fatalf("create: %d %+v", c, smm)
	}
	if c := call(admin, "POST", "/roles", map[string]any{"name": name, "permissions": []string{"news"}}, &e); c != 422 || e.Error.Fields["name"] == "" {
		t.Fatalf("duplicate name: %d %+v", c, e)
	}

	// a user with the role sees only its pages
	var uid int64
	var created struct{ ID int64 }
	if c := call(admin, "POST", "/users", map[string]any{"name": "Dilnoza", "email": "smm-" + sfx + "@x.uz", "role": smm.Slug, "password": "password-123"}, &created); c != 201 {
		t.Fatalf("create user: %d", c)
	}
	uid = created.ID
	smmTok := tok(uid)
	var me userDTO
	if c := call(smmTok, "GET", "/me", nil, &me); c != 200 || me.Role != smm.Slug || me.RoleName != name || !contains(me.Permissions, "news") || contains(me.Permissions, "tickets") || !contains(me.Permissions, "uploads") {
		t.Fatalf("me: %d %+v", c, me)
	}
	if c := call(smmTok, "GET", "/news", nil, nil); c != 200 {
		t.Fatalf("news: %d", c)
	}
	for _, p := range []string{"/ticket-sales", "/users", "/dashboard", "/roles", "/audit"} {
		if c := call(smmTok, "GET", p, nil, nil); c != 403 {
			t.Fatalf("%s: %d, want 403", p, c)
		}
	}

	// a change to the role applies at once
	if c := call(admin, "PATCH", fmt.Sprintf("/roles/%d", smm.ID), map[string]any{"permissions": []string{"news", "dashboard"}}, nil); c != 200 {
		t.Fatalf("patch: %d", c)
	}
	if c := call(smmTok, "GET", "/dashboard", nil, nil); c != 200 {
		t.Fatalf("dashboard after patch: %d", c)
	}
	if c := call(smmTok, "GET", "/videos", nil, nil); c != 403 {
		t.Fatalf("videos after patch: %d", c)
	}
	// so does moving the user to another role
	if c := call(admin, "PATCH", fmt.Sprintf("/users/%d", uid), map[string]any{"role": "controller"}, nil); c != 204 {
		t.Fatalf("move user: %d", c)
	}
	if c := call(smmTok, "GET", "/news", nil, nil); c != 403 {
		t.Fatalf("news as controller: %d", c)
	}
	if c := call(admin, "PATCH", fmt.Sprintf("/users/%d", uid), map[string]any{"role": "no-such-role"}, nil); c != 422 {
		t.Fatalf("unknown role: %d", c)
	}
	if c := call(admin, "PATCH", fmt.Sprintf("/users/%d", uid), map[string]any{"role": smm.Slug}, nil); c != 204 {
		t.Fatalf("move back: %d", c)
	}

	// the administrator role is fixed
	if c := call(admin, "PATCH", fmt.Sprintf("/roles/%d", roles[0].ID), map[string]any{"name": "Boss"}, nil); c != 400 {
		t.Fatalf("patch admin role: %d", c)
	}
	if c := call(admin, "DELETE", fmt.Sprintf("/roles/%d", roles[0].ID), nil, nil); c != 400 {
		t.Fatalf("delete admin role: %d", c)
	}

	// a role manager cannot take Rollar va huquqlar away from their own role or delete it
	mgrRole := roleDTO{}
	if c := call(admin, "POST", "/roles", map[string]any{"name": "Kadrlar " + sfx, "permissions": []string{"users", "roles"}}, &mgrRole); c != 201 {
		t.Fatalf("create manager role: %d", c)
	}
	mgr := tok(user("mgr", mgrRole.Slug))
	if c := call(mgr, "PATCH", fmt.Sprintf("/roles/%d", mgrRole.ID), map[string]any{"permissions": []string{"users"}}, nil); c != 400 {
		t.Fatalf("drop own roles page: %d", c)
	}
	if c := call(mgr, "DELETE", fmt.Sprintf("/roles/%d", mgrRole.ID), nil, nil); c != 400 {
		t.Fatalf("delete own role: %d", c)
	}

	// deleting a role in use needs a role to move its users to
	if c := call(admin, "DELETE", fmt.Sprintf("/roles/%d", smm.ID), nil, nil); c != 409 {
		t.Fatalf("delete in use: %d", c)
	}
	if c := call(admin, "DELETE", fmt.Sprintf("/roles/%d?move_to=%d", smm.ID, smm.ID), nil, nil); c != 422 {
		t.Fatalf("move to itself: %d", c)
	}
	var editorID int64
	for _, r := range roles {
		if r.Slug == "editor" {
			editorID = r.ID
		}
	}
	if c := call(admin, "DELETE", fmt.Sprintf("/roles/%d?move_to=%d", smm.ID, editorID), nil, nil); c != 204 {
		t.Fatalf("delete: %d", c)
	}
	var role string
	conn.QueryRow(`SELECT role FROM users WHERE id=$1`, uid).Scan(&role)
	if role != "editor" {
		t.Fatalf("user moved to %q", role)
	}
	if c := call(smmTok, "GET", "/videos", nil, nil); c != 200 {
		t.Fatalf("videos as editor: %d", c)
	}
	var n int
	conn.QueryRow(`SELECT count(*) FROM audit_log WHERE entity='role' AND entity_id=$1`, smm.ID).Scan(&n)
	if n != 3 {
		t.Fatalf("audit entries: %d", n)
	}
	conn.Exec(`DELETE FROM users WHERE role=$1`, mgrRole.Slug)
	conn.Exec(`DELETE FROM roles WHERE id=$1`, mgrRole.ID)
}
