package api

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http/httptest"
	"os"
	"testing"
	"time"

	"github.com/sanedidi/unitedmfl/backend/internal/config"
	"github.com/sanedidi/unitedmfl/backend/internal/db"
)

// A match needs no season (the active one is used) and a team needs no group.
func TestOptionalSeasonAndGroup(t *testing.T) {
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("TEST_DATABASE_URL not set")
	}
	ctx := context.Background()
	conn, err := db.Open(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	if err := db.Migrate(ctx, conn); err != nil {
		t.Fatal(err)
	}
	var uid, active int64
	if err := conn.QueryRow(`INSERT INTO users (name, email, password_hash, role) VALUES ('Admin', 'crud-test-'||floor(random()*1e9)::text||'@x.uz', 'x', 'admin') RETURNING id`).Scan(&uid); err != nil {
		t.Fatal(err)
	}
	if err := conn.QueryRow(`SELECT id FROM seasons ORDER BY is_active DESC, id DESC LIMIT 1`).Scan(&active); err != nil {
		t.Fatal(err)
	}
	s := New(conn, &config.Config{UploadDir: t.TempDir(), JWTSecret: []byte("test-secret-test-secret-test-secret!!"), AccessTTL: time.Hour})
	h := s.Routes()
	tok, _, _ := s.Tokens.Sign(uid, "admin", "Admin")
	call := func(method, path string, body any, out any) int {
		b, _ := json.Marshal(body)
		req := httptest.NewRequest(method, "/api/v1/admin"+path, bytes.NewReader(b))
		req.Header.Set("Authorization", "Bearer "+tok)
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		json.Unmarshal(rec.Body.Bytes(), out)
		if rec.Code >= 300 {
			t.Logf("%s %s → %d %s", method, path, rec.Code, rec.Body.String())
		}
		return rec.Code
	}

	var m struct {
		ID       int64 `json:"id"`
		SeasonID int64 `json:"season_id"`
	}
	if c := call("POST", "/matches", map[string]any{"season_id": nil, "round": "Test", "status": "scheduled"}, &m); c != 201 || m.SeasonID != active {
		t.Fatalf("match without season: %d %+v (active %d)", c, m, active)
	}
	if c := call("PATCH", "/matches/"+idStr(m.ID), map[string]any{"season_id": nil, "round": "Test 2"}, &m); c != 200 || m.SeasonID != active {
		t.Fatalf("patch keeps season: %d %+v", c, m)
	}
	conn.Exec(`DELETE FROM matches WHERE id=$1`, m.ID)

	var team struct {
		ID         int64  `json:"id"`
		GroupLabel string `json:"group_label"`
	}
	slug := "test-" + idStr(time.Now().UnixNano()%1e9)
	if c := call("POST", "/teams", map[string]any{"name": "Test FC " + slug, "slug": slug, "group_label": nil}, &team); c != 201 || team.GroupLabel != "" {
		t.Fatalf("team without group: %d %+v", c, team)
	}
	conn.Exec(`DELETE FROM teams WHERE id=$1`, team.ID)
}
