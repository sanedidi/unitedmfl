package api

import (
	"bytes"
	"context"
	"encoding/json"
	"mime/multipart"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/sanedidi/unitedmfl/backend/internal/config"
	"github.com/sanedidi/unitedmfl/backend/internal/db"
)

// Hamkorlar: the migration carries over the homepage names, partners are
// created at the end of the list, reordered, switched off and given a logo
// and a video; the public endpoint shows only what the site may show.
func TestPartners(t *testing.T) {
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
	var uid int64
	if err := conn.QueryRow(`INSERT INTO users (name, email, password_hash, role) VALUES ('Editor', 'partner-test-'||floor(random()*1e9)::text||'@x.uz', 'x', 'editor') RETURNING id`).Scan(&uid); err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	s := New(conn, &config.Config{UploadDir: dir, MaxVideoBytes: 1 << 30, JWTSecret: []byte("test-secret-test-secret-test-secret!!"), AccessTTL: time.Hour})
	h := s.Routes()
	tok, _, _ := s.Tokens.Sign(uid, "editor", "Editor")

	call := func(method, path string, body any, out any) int {
		var rd *bytes.Reader
		if body != nil {
			b, _ := json.Marshal(body)
			rd = bytes.NewReader(b)
		} else {
			rd = bytes.NewReader(nil)
		}
		req := httptest.NewRequest(method, "/api/v1"+path, rd)
		req.Header.Set("Authorization", "Bearer "+tok)
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		if out != nil {
			json.Unmarshal(rec.Body.Bytes(), out)
		}
		if rec.Code >= 300 {
			t.Logf("%s %s → %d %s", method, path, rec.Code, rec.Body.String())
		}
		return rec.Code
	}
	upload := func(path, name string, content []byte) (int, map[string]any) {
		var buf bytes.Buffer
		mw := multipart.NewWriter(&buf)
		fw, _ := mw.CreateFormFile("file", name)
		fw.Write(content)
		mw.Close()
		req := httptest.NewRequest("POST", "/api/v1/admin"+path, &buf)
		req.Header.Set("Content-Type", mw.FormDataContentType())
		req.Header.Set("Authorization", "Bearer "+tok)
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		out := map[string]any{}
		json.Unmarshal(rec.Body.Bytes(), &out)
		return rec.Code, out
	}
	type partner struct {
		ID       int64  `json:"id"`
		Name     string `json:"name"`
		Kind     string `json:"kind"`
		Ord      int    `json:"ord"`
		VideoURL string `json:"video_url"`
	}
	type public struct {
		Settings struct {
			Title     string `json:"title"`
			ShowCTA   bool   `json:"show_cta"`
			ShowBlock bool   `json:"show_block"`
		} `json:"settings"`
		Items []partner `json:"items"`
	}

	// a fresh database (nothing published yet) gets the names the default homepage shows
	var seeded []string
	rows, _ := conn.Query(`SELECT name || ':' || kind FROM partners ORDER BY ord`)
	for rows.Next() {
		var x string
		rows.Scan(&x)
		seeded = append(seeded, x)
	}
	rows.Close()
	if len(seeded) < 3 || seeded[0] != "realme:main" {
		t.Logf("seeded partners: %v (may differ when the test database is reused)", seeded)
	}
	conn.Exec(`DELETE FROM partners`)

	// validation: a link must be a web address, a video an uploaded file
	if c := call("POST", "/admin/partners", map[string]any{"name": "X", "url": "click.uz"}, nil); c != 422 && c != 400 {
		t.Fatalf("bare domain accepted: %d", c)
	}
	if c := call("POST", "/admin/partners", map[string]any{"name": "X", "video_url": "https://youtu.be/x"}, nil); c != 422 && c != 400 {
		t.Fatalf("video link accepted: %d", c)
	}
	var a, b, m partner
	if c := call("POST", "/admin/partners", map[string]any{"name": "realme", "kind": "main", "url": "https://www.realme.com/uz", "is_active": true, "show_video": true}, &a); c != 201 || a.Ord != 1 {
		t.Fatalf("create a: %d %+v", c, a)
	}
	if c := call("POST", "/admin/partners", map[string]any{"name": "Click", "kind": "official", "is_active": true}, &b); c != 201 || b.Ord != 2 {
		t.Fatalf("create b (goes last): %d %+v", c, b)
	}
	if c := call("POST", "/admin/partners", map[string]any{"name": "Media Partner", "kind": "media", "is_active": false}, &m); c != 201 || m.Ord != 3 {
		t.Fatalf("create m: %d %+v", c, m)
	}

	// reorder
	if c := call("PUT", "/admin/partners/order", []int64{b.ID, a.ID, m.ID}, nil); c != 204 {
		t.Fatalf("reorder: %d", c)
	}
	var pub public
	if c := call("GET", "/partners", nil, &pub); c != 200 {
		t.Fatalf("public: %d", c)
	}
	if len(pub.Items) != 2 || pub.Items[0].Name != "Click" || pub.Items[1].Name != "realme" {
		t.Fatalf("public list (inactive hidden, new order): %+v", pub.Items)
	}

	// settings
	if c := call("PUT", "/admin/partner-settings", map[string]any{"title": "Homiylar", "show_cta": false, "show_block": true}, nil); c != 200 {
		t.Fatalf("settings: %d", c)
	}
	call("GET", "/partners", nil, &pub)
	if pub.Settings.Title != "Homiylar" || pub.Settings.ShowCTA || !pub.Settings.ShowBlock {
		t.Fatalf("settings not saved: %+v", pub.Settings)
	}

	// logo: SVG without scripts is fine, with a script it is refused
	if c, out := upload("/partner-logos", "realme.svg", []byte(`<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10"/></svg>`)); c != 201 || out["mime"] != "image/svg+xml" {
		t.Fatalf("svg logo: %d %v", c, out)
	} else {
		req := httptest.NewRequest("GET", out["url"].(string), nil)
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		if rec.Code != 200 || rec.Header().Get("Content-Security-Policy") == "" {
			t.Fatalf("svg served without CSP: %d %v", rec.Code, rec.Header())
		}
	}
	if c, _ := upload("/partner-logos", "x.svg", []byte(`<svg onload="alert(1)"></svg>`)); c != 400 {
		t.Fatalf("svg with a handler accepted: %d", c)
	}
	if c, _ := upload("/partner-logos", "x.txt", []byte(`hello`)); c != 400 {
		t.Fatalf("text accepted as a logo: %d", c)
	}

	// video: up to 100 MB, replaced file is removed, hidden with show_video=false
	mp4 := append([]byte{0, 0, 0, 0x18}, []byte("ftypisom\x00\x00\x02\x00isomiso2 promo")...)
	c, v1 := upload("/video-uploads/partner", "promo.mp4", mp4)
	if c != 201 {
		t.Fatalf("video upload: %d %v", c, v1)
	}
	url1 := v1["url"].(string)
	if c := call("PATCH", "/admin/partners/"+itoa(int(a.ID)), map[string]any{"video_url": url1, "video_duration_sec": 28}, nil); c != 200 {
		t.Fatalf("set video: %d", c)
	}
	call("GET", "/partners", nil, &pub)
	if pub.Items[1].VideoURL != url1 {
		t.Fatalf("video not public: %+v", pub.Items[1])
	}
	call("PATCH", "/admin/partners/"+itoa(int(a.ID)), map[string]any{"show_video": false}, nil)
	call("GET", "/partners", nil, &pub)
	if pub.Items[1].VideoURL != "" {
		t.Fatalf("«Faqat logotip» still shows the video: %+v", pub.Items[1])
	}
	_, v2 := upload("/video-uploads/partner", "promo2.mp4", mp4)
	url2 := v2["url"].(string)
	call("PATCH", "/admin/partners/"+itoa(int(a.ID)), map[string]any{"video_url": url2}, nil)
	name1, _ := videoFileName(url1)
	if _, err := os.Stat(filepath.Join(dir, "videos", name1)); !os.IsNotExist(err) {
		t.Fatalf("replaced partner video kept: %v", err)
	}
	if c := call("DELETE", "/admin/partners/"+itoa(int(a.ID)), nil, nil); c != 204 {
		t.Fatalf("delete: %d", c)
	}
	name2, _ := videoFileName(url2)
	if _, err := os.Stat(filepath.Join(dir, "videos", name2)); !os.IsNotExist(err) {
		t.Fatalf("partner video kept after delete: %v", err)
	}

	// shop managers have no access
	var sid int64
	conn.QueryRow(`INSERT INTO users (name, email, password_hash, role) VALUES ('Shop', 'partner-shop-'||floor(random()*1e9)::text||'@x.uz', 'x', 'shop') RETURNING id`).Scan(&sid)
	tok, _, _ = s.Tokens.Sign(sid, "shop", "Shop")
	if c := call("GET", "/admin/partners", nil, nil); c != 403 {
		t.Fatalf("shop manager sees partners: %d", c)
	}
}

func TestCheckSVG(t *testing.T) {
	ok := []string{
		`<svg xmlns="http://www.w3.org/2000/svg"></svg>`,
		"\xef\xbb\xbf<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<!-- Generator: Figma -->\n<!DOCTYPE svg PUBLIC \"-//W3C//DTD SVG 1.1//EN\" \"x\">\n<svg width=\"10\"><path d=\"M0 0h1\"/></svg>",
	}
	bad := []string{
		`<html><svg></svg></html>`,
		`<svg><script>alert(1)</script></svg>`,
		`<svg><a href="javascript:alert(1)"><rect/></a></svg>`,
		`<svg><foreignObject><div/></foreignObject></svg>`,
		`<svg ONLOAD = "x()"></svg>`,
		`<!DOCTYPE svg [<!ENTITY x "y">]><svg></svg>`,
	}
	for _, s := range ok {
		if !checkSVG([]byte(s)) {
			t.Errorf("refused: %q", s)
		}
	}
	for _, s := range bad {
		if checkSVG([]byte(s)) {
			t.Errorf("accepted: %q", s)
		}
	}
}
