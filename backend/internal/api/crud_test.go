package api

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http/httptest"
	"net/url"
	"os"
	"testing"
	"time"

	"github.com/sanedidi/unitedmfl/backend/internal/config"
	"github.com/sanedidi/unitedmfl/backend/internal/db"
)

// A match needs no season (a friendly) and a team needs no group.
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
		ID       int64  `json:"id"`
		SeasonID *int64 `json:"season_id"`
	}
	// no season = friendly match
	if c := call("POST", "/matches", map[string]any{"season_id": nil, "round": "O‘rtoqlik o‘yini", "status": "finished", "home_score": 4, "away_score": 7, "published": true}, &m); c != 201 || m.SeasonID != nil {
		t.Fatalf("friendly match: %d %+v", c, m)
	}
	var list struct {
		Items []struct {
			ID int64 `json:"id"`
		} `json:"items"`
	}
	call("GET", "/matches?status=finished", nil, &list)
	found := false
	for _, it := range list.Items {
		found = found || it.ID == m.ID
	}
	if !found {
		t.Fatalf("friendly match missing from the admin list")
	}
	if c := call("PATCH", "/matches/"+idStr(m.ID), map[string]any{"season_id": active}, &m); c != 200 || m.SeasonID == nil || *m.SeasonID != active {
		t.Fatalf("attach to season: %d %+v", c, m)
	}
	conn.Exec(`DELETE FROM matches WHERE id=$1`, m.ID)

	var team struct {
		ID         int64  `json:"id"`
		GroupLabel string `json:"group_label"`
	}
	slug := "test-" + idStr(time.Now().UnixNano()%1e9)
	if c := call("POST", "/teams", map[string]any{"name": "Test FC " + slug, "slug": slug, "group_id": nil}, &team); c != 201 || team.GroupLabel != "" {
		t.Fatalf("team without group: %d %+v", c, team)
	}
	conn.Exec(`DELETE FROM teams WHERE id=$1`, team.ID)
}

// With no season at all (all deleted in the admin), match lists are empty rather than a 500.
func TestMatchesWithoutSeason(t *testing.T) {
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("TEST_DATABASE_URL not set")
	}
	ctx := context.Background()
	admin, err := db.Open(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer admin.Close()
	name := "umfl_noseason_" + idStr(time.Now().UnixNano()%1e9)
	if _, err := admin.Exec(`CREATE DATABASE ` + name); err != nil {
		t.Skip("cannot create database: ", err)
	}
	defer admin.Exec(`DROP DATABASE IF EXISTS ` + name + ` WITH (FORCE)`)
	u, _ := url.Parse(dsn)
	u.Path = "/" + name
	conn, err := db.Open(ctx, u.String())
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	if err := db.Migrate(ctx, conn); err != nil {
		t.Fatal(err)
	}
	if _, err := conn.Exec(`DELETE FROM matches; DELETE FROM stages; DELETE FROM seasons`); err != nil {
		t.Fatal(err)
	}
	s := New(conn, &config.Config{UploadDir: t.TempDir(), JWTSecret: []byte("test-secret-test-secret-test-secret!!"), AccessTTL: time.Hour})
	rec := httptest.NewRecorder()
	s.Routes().ServeHTTP(rec, httptest.NewRequest("GET", "/api/v1/matches", nil))
	if rec.Code != 200 {
		t.Fatalf("public matches without season: %d %s", rec.Code, rec.Body.String())
	}
}
