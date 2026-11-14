package api

import (
	"bytes"
	"context"
	"encoding/json"
	"image"
	"image/color"
	"image/png"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/sanedidi/unitedmfl/backend/internal/config"
	"github.com/sanedidi/unitedmfl/backend/internal/db"
)

func tinyPNG() []byte {
	img := image.NewRGBA(image.Rect(0, 0, 8, 8))
	for i := range img.Pix {
		img.Pix[i] = 200
	}
	img.Set(0, 0, color.Black)
	var b bytes.Buffer
	_ = png.Encode(&b, img)
	return b.Bytes()
}

// Runs only with TEST_DATABASE_URL pointing at a throwaway Postgres database.
func TestAIGenerationFlow(t *testing.T) {
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
	conn.Exec(`DELETE FROM ai_generations`)
	var uid int64
	if err := conn.QueryRow(`INSERT INTO users (name, email, password_hash, role) VALUES ('Muharrir', 'ai-test-'||floor(random()*1e9)::text||'@x.uz', 'x', 'editor') RETURNING id`).Scan(&uid); err != nil {
		t.Fatal(err)
	}

	upload := t.TempDir()
	os.MkdirAll(filepath.Join(upload, "images"), 0o755)
	os.WriteFile(filepath.Join(upload, "images", "crest.png"), tinyPNG(), 0o644)

	// site container serving the logo
	web := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/icon.png" {
			w.Write(tinyPNG())
			return
		}
		w.WriteHeader(404)
	}))
	defer web.Close()

	var gotAssets []string
	block := make(chan struct{})
	ai := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("X-Internal-Token") != "tok-1234567890abcdef" {
			w.WriteHeader(401)
			return
		}
		switch r.URL.Path {
		case "/v1/improve":
			io.WriteString(w, `{"prompt":"Yaxshilangan","added":["rakurs"],"provider":"openai","model":"gpt-5.6-luna","ms":12}`)
		case "/v1/settings":
			if r.Method == http.MethodPut {
				w.WriteHeader(422)
				io.WriteString(w, `{"error":{"code":"validation","message":"Ma’lumotlar noto‘g‘ri","fields":{"variants":"1 dan 4 gacha"}}}`)
				return
			}
			io.WriteString(w, `{"provider":"openai","variants":2}`)
		case "/v1/images":
			var in struct {
				Prompt string
				Assets []struct{ Label, Mime string }
			}
			json.NewDecoder(r.Body).Decode(&in)
			gotAssets = nil
			for _, a := range in.Assets {
				gotAssets = append(gotAssets, a.Label+":"+a.Mime)
			}
			if in.Prompt == "uzoq kutish kerak" {
				select {
				case <-r.Context().Done():
				case <-block:
				}
				return
			}
			img := map[string]any{"mime": "image/png", "data": tinyPNG(), "width": 2400, "height": 1100}
			json.NewEncoder(w).Encode(map[string]any{"provider": "openai", "model": "gpt-image-2.5-sunburst", "ms": 900,
				"variants": []any{map[string]any{"images": map[string]any{"hero_desktop": img, "hero_mobile": img}}, map[string]any{"images": map[string]any{"hero_desktop": img}}},
				"warnings": []string{"2-variant, Hero — mobil: xato"}})
		default:
			w.WriteHeader(404)
		}
	}))
	defer ai.Close()
	defer close(block)

	cfg := &config.Config{UploadDir: upload, AIServiceURL: ai.URL, AIInternalToken: "tok-1234567890abcdef", WebInternalURL: web.URL, JWTSecret: []byte("test-secret-test-secret-test-secret!!"), AccessTTL: time.Hour}
	s := New(conn, cfg)
	h := s.Routes()
	editorTok, _, _ := s.Tokens.Sign(uid, "editor", "Muharrir")
	call := func(tok, method, path string, body any, out any) int {
		var rd io.Reader
		if body != nil {
			b, _ := json.Marshal(body)
			rd = bytes.NewReader(b)
		}
		req := httptest.NewRequest(method, "/api/v1/admin"+path, rd)
		req.Header.Set("Authorization", "Bearer "+tok)
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		if out != nil {
			json.Unmarshal(rec.Body.Bytes(), out)
		}
		return rec.Code
	}

	// editors may read settings and improve prompts, but not change settings
	if c := call(editorTok, "GET", "/ai/settings", nil, nil); c != 200 {
		t.Fatalf("settings: %d", c)
	}
	if c := call(editorTok, "PUT", "/ai/settings", map[string]any{"variants": 9}, nil); c != 403 {
		t.Fatalf("editor put settings: %d", c)
	}
	adminTok, _, _ := s.Tokens.Sign(uid, "admin", "Bosh admin")
	var e struct {
		Error struct {
			Code   string
			Fields map[string]string
		}
	}
	if c := call(adminTok, "PUT", "/ai/settings", map[string]any{"variants": 9}, &e); c != 422 || e.Error.Fields["variants"] == "" {
		t.Fatalf("validation passthrough: %d %+v", c, e)
	}
	var imp map[string]any
	if c := call(editorTok, "POST", "/ai/improve", map[string]any{"prompt": "Tungi stadion", "layout": "shade"}, &imp); c != 200 || imp["prompt"] != "Yaxshilangan" {
		t.Fatalf("improve: %d %v", c, imp)
	}

	// start → poll → done
	var g aiGeneration
	body := map[string]any{"prompt_original": "Tungi stadion", "prompt": "Yaxshilangan prompt matni", "layout": "shade", "formats": []string{"hero_desktop", "hero_mobile"},
		"assets": []map[string]string{{"kind": "logo", "label": "Liga logotipi"}, {"kind": "url", "url": "/uploads/images/crest.png", "label": "A1 gerbi"}, {"kind": "url", "url": "/uploads/../secret", "label": "Yomon"}}}
	if c := call(editorTok, "POST", "/ai/generations", body, &g); c != 202 || g.Status != "running" {
		t.Fatalf("start: %d %+v", c, g)
	}
	deadline := time.Now().Add(5 * time.Second)
	for g.Status == "running" && time.Now().Before(deadline) {
		time.Sleep(50 * time.Millisecond)
		call(editorTok, "GET", "/ai/generations/"+idStr(g.ID), nil, &g)
	}
	if g.Status != "done" || g.Provider != "openai" || g.UserName != "Muharrir" {
		t.Fatalf("done: %+v", g)
	}
	if strings.Join(gotAssets, ",") != "Liga logotipi:image/png,A1 gerbi:image/png" {
		t.Fatalf("assets sent: %v", gotAssets)
	}
	var variants []aiVariantOut
	json.Unmarshal(g.Variants, &variants)
	if len(variants) != 2 || !strings.HasPrefix(variants[0].Images["hero_desktop"].URL, "/uploads/images/ai-") {
		t.Fatalf("variants: %s", g.Variants)
	}
	file := filepath.Join(upload, "images", strings.TrimPrefix(variants[0].Images["hero_mobile"].URL, "/uploads/images/"))
	if _, err := os.Stat(file); err != nil {
		t.Fatalf("saved file: %v", err)
	}
	var warns []string
	json.Unmarshal(g.Warnings, &warns)
	if len(warns) != 2 || !strings.Contains(warns[0], "Yomon") {
		t.Fatalf("warnings: %v", warns)
	}

	// apply validates the variant
	if c := call(editorTok, "POST", "/ai/generations/"+idStr(g.ID)+"/apply", map[string]any{"variant": 5}, nil); c != 422 {
		t.Fatalf("bad variant: %d", c)
	}
	if c := call(editorTok, "POST", "/ai/generations/"+idStr(g.ID)+"/apply", map[string]any{"variant": 0, "target_id": 7}, &g); c != 200 || g.Status != "applied" || *g.AppliedVariant != 0 || *g.TargetID != 7 {
		t.Fatalf("apply: %d %+v", c, g)
	}

	// cancel a long one
	body["prompt"] = "uzoq kutish kerak"
	call(editorTok, "POST", "/ai/generations", body, &g)
	time.Sleep(100 * time.Millisecond)
	if c := call(editorTok, "POST", "/ai/generations/"+idStr(g.ID)+"/cancel", nil, &g); c != 200 || g.Status != "cancelled" {
		t.Fatalf("cancel: %d %+v", c, g)
	}

	var list struct {
		Items []aiGeneration
		Total int
		Month map[string]int
	}
	call(editorTok, "GET", "/ai/generations?limit=10", nil, &list)
	if list.Total != 2 || list.Items[0].Status != "cancelled" || list.Month["total"] != 1 {
		t.Fatalf("list: %+v", list)
	}
	call(editorTok, "GET", "/ai/generations?status=applied&q=Yaxshilangan", nil, &list)
	if list.Total != 1 {
		t.Fatalf("filter: %+v", list.Total)
	}

	// no AI service configured
	cfg.AIServiceURL = ""
	if c := call(editorTok, "POST", "/ai/generations", body, &e); c != 503 || e.Error.Code != "ai_off" {
		t.Fatalf("ai off: %d", c)
	}
}

func idStr(n int64) string { return strconv.FormatInt(n, 10) }
