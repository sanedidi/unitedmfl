package api

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/sanedidi/unitedmfl/backend/internal/config"
	"github.com/sanedidi/unitedmfl/backend/internal/db"
)

// Runs only with TEST_DATABASE_URL pointing at a throwaway Postgres database.
func TestInstagramSync(t *testing.T) {
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
	_, _ = conn.Exec(`DELETE FROM instagram_posts; DELETE FROM instagram_account`)

	posts := []map[string]any{
		{"id": "111", "caption": "Gol!", "media_type": "IMAGE", "media_url": "IMG/111", "permalink": "https://www.instagram.com/p/AAA/", "timestamp": "2026-11-10T18:10:00+0000"},
		{"id": "222", "caption": "Reel", "media_type": "VIDEO", "media_product_type": "REELS", "media_url": "VID/222", "thumbnail_url": "IMG/222", "permalink": "https://www.instagram.com/reel/BBB/", "timestamp": "2026-11-11T10:00:00+0000"},
	}
	var srv *httptest.Server
	srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("access_token") != "" && r.URL.Query().Get("access_token") != "good-token-1234567890" {
			w.WriteHeader(400)
			_, _ = w.Write([]byte(`{"error":{"message":"Invalid OAuth access token","code":190}}`))
			return
		}
		switch {
		case r.URL.Path == "/v23.0/me":
			_ = json.NewEncoder(w).Encode(map[string]string{"user_id": "999", "username": "unitedmfl"})
		case r.URL.Path == "/v23.0/me/media":
			out := []map[string]any{}
			for _, p := range posts {
				c := map[string]any{}
				for k, v := range p {
					if s, ok := v.(string); ok && (strings.HasPrefix(s, "IMG/") || strings.HasPrefix(s, "VID/")) {
						v = srv.URL + "/" + s
					}
					c[k] = v
				}
				out = append(out, c)
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"data": out})
		case strings.HasPrefix(r.URL.Path, "/IMG/"):
			w.Header().Set("Content-Type", "image/jpeg")
			_, _ = w.Write([]byte("\xff\xd8\xff fake jpeg"))
		default:
			w.WriteHeader(404)
		}
	}))
	defer srv.Close()

	dir := t.TempDir()
	cfg := &config.Config{UploadDir: dir, MaxUploadBytes: 1 << 20, InstagramAPIURL: srv.URL, InstagramSyncEvery: time.Hour}
	s := &Server{DB: conn, Cfg: cfg}

	if err := s.igConnect(ctx, "bad-token-1234567890"); err == nil {
		t.Fatal("bad token accepted")
	}
	if err := s.igConnect(ctx, "good-token-1234567890"); err != nil {
		t.Fatal(err)
	}
	if err := s.igSync(ctx); err != nil {
		t.Fatal(err)
	}
	rec := httptest.NewRecorder()
	s.publicInstagram(rec, httptest.NewRequest("GET", "/api/v1/instagram", nil))
	var feed struct {
		Username string `json:"username"`
		Posts    []struct {
			ID, ImageURL, MediaType string
			IsReel                  bool `json:"is_reel"`
		} `json:"posts"`
	}
	body := rec.Body.String()
	if err := json.Unmarshal([]byte(strings.ReplaceAll(body, "image_url", "ImageURL")), &feed); err != nil {
		t.Fatal(err, body)
	}
	if feed.Username != "unitedmfl" || len(feed.Posts) != 2 || feed.Posts[0].ID != "222" || !feed.Posts[0].IsReel {
		t.Fatalf("unexpected feed: %s", body)
	}
	if _, err := os.Stat(filepath.Join(dir, "images", "ig-222.jpg")); err != nil {
		t.Fatal("thumbnail not mirrored", err)
	}

	// a post deleted on Instagram disappears together with its file
	posts = posts[1:]
	if err := s.igSync(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(dir, "images", "ig-111.jpg")); !os.IsNotExist(err) {
		t.Fatal("removed post image still on disk")
	}
	var n int
	_ = conn.QueryRow(`SELECT count(*) FROM instagram_posts`).Scan(&n)
	if n != 1 {
		t.Fatalf("posts = %d, want 1", n)
	}
}
