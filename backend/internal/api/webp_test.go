package api

import (
	"bytes"
	"context"
	"encoding/json"
	"image"
	"image/color"
	"image/jpeg"
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

func testPicture(w, h int) *image.NRGBA {
	img := image.NewNRGBA(image.Rect(0, 0, w, h))
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			img.Set(x, y, color.NRGBA{uint8(x * 255 / w), uint8(y * 255 / h), uint8((x ^ y) & 0xff), uint8(128 + (x+y)%128)})
		}
	}
	return img
}

// Admin uploads are stored as WebP: PNG losslessly (same size, same pixels),
// JPEG as a photo; a WebP upload is kept byte-for-byte. Then images uploaded
// before the change get WebP twins and every database reference switches.
func TestImagesBecomeWebP(t *testing.T) {
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("TEST_DATABASE_URL not set")
	}
	if _, err := exec.LookPath("vipsthumbnail"); err != nil {
		t.Skip("libvips (vipsthumbnail) not installed")
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
	if err := conn.QueryRow(`INSERT INTO users (name, email, password_hash, role) VALUES ('Editor', 'webp-test-'||floor(random()*1e9)::text||'@x.uz', 'x', 'editor') RETURNING id`).Scan(&uid); err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	s := New(conn, &config.Config{UploadDir: dir, JWTSecret: []byte("test-secret-test-secret-test-secret!!"), AccessTTL: time.Hour})
	h := s.Routes()
	tok, _, _ := s.Tokens.Sign(uid, "editor", "Editor")
	upload := func(name string, content []byte) (int, map[string]any) {
		var buf bytes.Buffer
		mw := multipart.NewWriter(&buf)
		fw, _ := mw.CreateFormFile("file", name)
		fw.Write(content)
		mw.Close()
		req := httptest.NewRequest("POST", "/api/v1/admin/uploads", &buf)
		req.Header.Set("Content-Type", mw.FormDataContentType())
		req.Header.Set("Authorization", "Bearer "+tok)
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		out := map[string]any{}
		json.Unmarshal(rec.Body.Bytes(), &out)
		return rec.Code, out
	}
	file := func(url string) string { return filepath.Join(s.imagesDir(), strings.TrimPrefix(url, "/uploads/images/")) }

	// PNG → lossless WebP
	pic := testPicture(320, 200)
	var pngBuf bytes.Buffer
	png.Encode(&pngBuf, pic)
	code, out := upload("crest.png", pngBuf.Bytes())
	url, _ := out["url"].(string)
	if code != 201 || !strings.HasSuffix(url, ".webp") || out["mime"] != "image/webp" {
		t.Fatalf("png upload: %d %v", code, out)
	}
	if w, h := webpSize(file(url)); w != 320 || h != 200 {
		t.Fatalf("png → webp size %dx%d", w, h)
	}
	back := filepath.Join(dir, "back.png")
	if b, err := exec.Command("vips", "copy", file(url), back).CombinedOutput(); err != nil {
		t.Fatalf("decode webp: %v %s", err, b)
	}
	f, _ := os.Open(back)
	dec, err := png.Decode(f)
	f.Close()
	if err != nil {
		t.Fatal(err)
	}
	for y := 0; y < 200; y++ {
		for x := 0; x < 320; x++ {
			if color.NRGBAModel.Convert(dec.At(x, y)) != color.NRGBAModel.Convert(pic.At(x, y)) {
				t.Fatalf("lossless: pixel %d,%d differs: %v vs %v", x, y, dec.At(x, y), pic.At(x, y))
			}
		}
	}

	// JPEG → WebP photo, same resolution
	var jpgBuf bytes.Buffer
	jpeg.Encode(&jpgBuf, testPicture(1600, 900), &jpeg.Options{Quality: 95})
	code, out = upload("photo.jpg", jpgBuf.Bytes())
	url, _ = out["url"].(string)
	if code != 201 || !strings.HasSuffix(url, ".webp") {
		t.Fatalf("jpg upload: %d %v", code, out)
	}
	if w, h := webpSize(file(url)); w != 1600 || h != 900 {
		t.Fatalf("jpg → webp size %dx%d", w, h)
	}

	// WebP upload: stored as is
	webp, _ := os.ReadFile(file(url))
	code, out = upload("ready.webp", webp)
	url2, _ := out["url"].(string)
	if got, _ := os.ReadFile(file(url2)); code != 201 || !bytes.Equal(got, webp) {
		t.Fatalf("webp upload re-encoded: %d %v", code, out)
	}

	// not an image
	if code, _ := upload("x.txt", []byte("hello")); code != 400 {
		t.Fatalf("text upload: %d", code)
	}

	// ---- images from before: crest PNG, news cover JPG + body, merch gallery ----
	os.WriteFile(filepath.Join(s.imagesDir(), "oldcrest.png"), pngBuf.Bytes(), 0o644)
	os.WriteFile(filepath.Join(s.imagesDir(), "oldcover.jpg"), jpgBuf.Bytes(), 0o644)
	os.WriteFile(filepath.Join(s.imagesDir(), "broken.png"), []byte("not a png"), 0o644)
	var teamID, newsID int64
	slug := "webp-" + randomName("")[:8]
	if err := conn.QueryRow(`INSERT INTO teams (slug, name, crest_url) VALUES ($1, 'WebP FC', '/uploads/images/oldcrest.png') RETURNING id`, slug).Scan(&teamID); err != nil {
		t.Fatal(err)
	}
	if err := conn.QueryRow(`INSERT INTO news (slug, title, cover_url, body) VALUES ($1, 'T', 'https://unitedmfl.uz/uploads/images/oldcover.jpg',
		'<p><img src="/uploads/images/oldcover.jpg"> <img src="/uploads/images/broken.png"> <img src="/uploads/images/missing.jpg"></p>') RETURNING id`, slug).Scan(&newsID); err != nil {
		t.Fatal(err)
	}
	s.ConvertLegacyImages(ctx)
	var crest, cover, body string
	conn.QueryRow(`SELECT crest_url FROM teams WHERE id=$1`, teamID).Scan(&crest)
	conn.QueryRow(`SELECT cover_url, body FROM news WHERE id=$1`, newsID).Scan(&cover, &body)
	if crest != "/uploads/images/oldcrest.webp" || cover != "https://unitedmfl.uz/uploads/images/oldcover.webp" {
		t.Fatalf("not relinked: crest=%q cover=%q", crest, cover)
	}
	want := `<p><img src="/uploads/images/oldcover.webp"> <img src="/uploads/images/broken.png"> <img src="/uploads/images/missing.jpg"></p>`
	if body != want {
		t.Fatalf("body:\n%s\nwant\n%s", body, want)
	}
	for _, n := range []string{"oldcrest.webp", "oldcover.webp", "oldcrest.png", "oldcover.jpg"} {
		if _, err := os.Stat(filepath.Join(s.imagesDir(), n)); err != nil {
			t.Fatalf("%s: %v", n, err)
		}
	}
	if _, err := os.Stat(filepath.Join(s.imagesDir(), "broken.webp")); err == nil {
		t.Fatal("broken file got a twin")
	}
	// second run: nothing to do, nothing changes
	s.ConvertLegacyImages(ctx)
	conn.QueryRow(`SELECT crest_url FROM teams WHERE id=$1`, teamID).Scan(&crest)
	if crest != "/uploads/images/oldcrest.webp" {
		t.Fatalf("second run: %q", crest)
	}
	entries, _ := os.ReadDir(s.imagesDir())
	for _, e := range entries {
		if strings.HasPrefix(e.Name(), ".") {
			t.Fatalf("temp file left: %s", e.Name())
		}
	}
}
