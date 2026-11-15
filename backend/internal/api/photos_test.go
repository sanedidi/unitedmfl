package api

import (
	"bytes"
	"context"
	"encoding/json"
	"image"
	"image/color"
	"image/png"
	"mime/multipart"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/sanedidi/unitedmfl/backend/internal/config"
	"github.com/sanedidi/unitedmfl/backend/internal/db"
)

func TestPhotoKind(t *testing.T) {
	heic := append([]byte{0, 0, 0, 24}, []byte("ftypheic\x00\x00\x00\x00mif1heic")...)
	cases := map[string][]byte{
		"heic": heic,
		"jpg":  {0xFF, 0xD8, 0xFF, 0xE0, 0, 0x10, 'J', 'F', 'I', 'F', 0},
		"png":  []byte("\x89PNG\r\n\x1a\n\x00\x00\x00\x0dIHDR"),
		"webp": []byte("RIFF\x00\x00\x00\x00WEBPVP8 "),
		"":     []byte("hello, this is text"),
	}
	for want, head := range cases {
		if got := photoKind(head); got != want {
			t.Errorf("photoKind(%q) = %q, want %q", head[:8], got, want)
		}
	}
}

// Upload → WebP (large + thumb) → caption → order → public JSON → delete.
func TestMatchPhotos(t *testing.T) {
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("TEST_DATABASE_URL not set")
	}
	if _, err := exec.LookPath("vipsthumbnail"); err != nil {
		t.Skip("vipsthumbnail not installed")
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
	var uid, matchID int64
	conn.QueryRow(`INSERT INTO users (name, email, password_hash, role) VALUES ('Admin', 'photo-'||floor(random()*1e9)::text||'@x.uz', 'x', 'admin') RETURNING id`).Scan(&uid)
	if err := conn.QueryRow(`INSERT INTO matches (round, status, published) VALUES ('Photo test', 'finished', true) RETURNING id`).Scan(&matchID); err != nil {
		t.Fatal(err)
	}
	defer conn.Exec(`DELETE FROM matches WHERE id=$1`, matchID)
	up := t.TempDir()
	s := New(conn, &config.Config{UploadDir: up, JWTSecret: []byte("test-secret-test-secret-test-secret!!"), AccessTTL: time.Hour})
	h := s.Routes()
	tok, _, _ := s.Tokens.Sign(uid, "admin", "Admin")
	do := func(method, path, ctype string, body []byte, out any) int {
		req := httptest.NewRequest(method, path, bytes.NewReader(body))
		if !strings.HasPrefix(path, "/api/v1/matches") {
			req.Header.Set("Authorization", "Bearer "+tok)
		}
		if ctype != "" {
			req.Header.Set("Content-Type", ctype)
		}
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
	upload := func(data []byte) (int, matchPhoto) {
		var buf bytes.Buffer
		mw := multipart.NewWriter(&buf)
		fw, _ := mw.CreateFormFile("file", "IMG.png")
		fw.Write(data)
		mw.Close()
		var p matchPhoto
		c := do("POST", "/api/v1/admin/matches/"+idStr(matchID)+"/photos", mw.FormDataContentType(), buf.Bytes(), &p)
		return c, p
	}
	img := image.NewRGBA(image.Rect(0, 0, 3000, 2000))
	for y := 0; y < 2000; y += 4 {
		for x := 0; x < 3000; x += 4 {
			img.Set(x, y, color.RGBA{uint8(x), uint8(y), 90, 255})
		}
	}
	var png1 bytes.Buffer
	png.Encode(&png1, img)

	c, p1 := upload(png1.Bytes())
	if c != 201 || p1.Width != 2400 || p1.Height != 1600 || !strings.HasSuffix(p1.URL, ".webp") || !strings.HasSuffix(p1.ThumbURL, "-t.webp") || p1.Bytes == 0 || p1.OriginalBytes != int64(png1.Len()) {
		t.Fatalf("upload: %d %+v", c, p1)
	}
	if w, h := webpSize(filepath.Join(up, "images", filepath.Base(p1.ThumbURL))); w != 640 || h != 427 {
		t.Fatalf("thumb size %dx%d", w, h)
	}
	_, p2 := upload(png1.Bytes())
	if c, _ := upload([]byte("just some text, not an image at all")); c != 400 {
		t.Fatalf("text upload accepted: %d", c)
	}
	if c := do("PATCH", "/api/v1/admin/match-photos/"+idStr(p2.ID), "application/json", []byte(`{"caption":"Uchinchi gol"}`), nil); c != 200 {
		t.Fatalf("caption: %d", c)
	}
	if c := do("PUT", "/api/v1/admin/matches/"+idStr(matchID)+"/photos/order", "application/json", []byte("["+idStr(p2.ID)+","+idStr(p1.ID)+"]"), nil); c != 204 {
		t.Fatalf("order: %d", c)
	}
	var pub struct {
		Photos []struct {
			ID      int64  `json:"id"`
			Caption string `json:"caption"`
		} `json:"photos"`
	}
	do("GET", "/api/v1/matches/"+idStr(matchID), "", nil, &pub)
	if len(pub.Photos) != 2 || pub.Photos[0].ID != p2.ID || pub.Photos[0].Caption != "Uchinchi gol" {
		t.Fatalf("public photos: %+v", pub.Photos)
	}
	if c := do("DELETE", "/api/v1/admin/match-photos/"+idStr(p1.ID), "", nil, nil); c != 204 {
		t.Fatalf("delete: %d", c)
	}
	if _, err := os.Stat(filepath.Join(up, "images", filepath.Base(p1.URL))); !os.IsNotExist(err) {
		t.Fatalf("file not removed: %v", err)
	}
	if c := do("DELETE", "/api/v1/admin/matches/"+idStr(matchID)+"/photos", "", nil, nil); c != 204 {
		t.Fatalf("delete all: %d", c)
	}
	var list struct {
		Items []matchPhoto `json:"items"`
	}
	do("GET", "/api/v1/admin/matches/"+idStr(matchID)+"/photos", "", nil, &list)
	if len(list.Items) != 0 {
		t.Fatalf("left: %+v", list.Items)
	}
}
