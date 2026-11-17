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

// Upload a file, save it as a video, replace it, delete the video: the
// files are served with Range support and removed when no longer used.
func TestVideoFileUpload(t *testing.T) {
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
	if err := conn.QueryRow(`INSERT INTO users (name, email, password_hash, role) VALUES ('Admin', 'video-test-'||floor(random()*1e9)::text||'@x.uz', 'x', 'admin') RETURNING id`).Scan(&uid); err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	s := New(conn, &config.Config{UploadDir: dir, MaxVideoBytes: 1 << 20, JWTSecret: []byte("test-secret-test-secret-test-secret!!"), AccessTTL: time.Hour})
	h := s.Routes()
	tok, _, _ := s.Tokens.Sign(uid, "admin", "Admin")

	upload := func(content []byte) (int, map[string]any) {
		var buf bytes.Buffer
		mw := multipart.NewWriter(&buf)
		fw, _ := mw.CreateFormFile("file", "sharh.mp4")
		fw.Write(content)
		mw.Close()
		req := httptest.NewRequest("POST", "/api/v1/admin/video-uploads", &buf)
		req.Header.Set("Content-Type", mw.FormDataContentType())
		req.Header.Set("Authorization", "Bearer "+tok)
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		out := map[string]any{}
		json.Unmarshal(rec.Body.Bytes(), &out)
		return rec.Code, out
	}
	call := func(method, path string, body any, out any) int {
		b, _ := json.Marshal(body)
		req := httptest.NewRequest(method, "/api/v1/admin"+path, bytes.NewReader(b))
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
	mp4 := append([]byte{0, 0, 0, 0x18}, []byte("ftypisom\x00\x00\x02\x00isomiso2 some video bytes")...)

	// not a video
	if c, out := upload([]byte("\x89PNG\r\n\x1a\nimage")); c != 400 {
		t.Fatalf("png accepted: %d %v", c, out)
	}
	// too big
	if c, _ := upload(append(append([]byte{}, mp4...), make([]byte, 2<<20)...)); c != 400 {
		t.Fatalf("2 MB video accepted with a 1 MB limit: %d", c)
	}
	c, up := upload(mp4)
	if c != 201 {
		t.Fatalf("upload: %d %v", c, up)
	}
	url1, _ := up["url"].(string)
	name1, ok := videoFileName(url1)
	if !ok {
		t.Fatalf("bad url %q", url1)
	}
	if _, err := os.Stat(filepath.Join(dir, "videos", name1)); err != nil {
		t.Fatal(err)
	}
	if left, _ := filepath.Glob(filepath.Join(dir, "videos", "*.part")); len(left) > 0 {
		t.Fatalf("temp files left: %v", left)
	}

	// served with the right type and Range support
	req := httptest.NewRequest("GET", url1, nil)
	req.Header.Set("Range", "bytes=4-7")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != 206 || rec.Body.String() != "ftyp" || rec.Header().Get("Content-Type") != "video/mp4" {
		t.Fatalf("serve: %d %q %q", rec.Code, rec.Body.String(), rec.Header().Get("Content-Type"))
	}

	// a «file» video must point to an uploaded file
	if c := call("POST", "/videos", map[string]any{"title": "X", "source": "file", "url": "https://youtu.be/abc"}, nil); c != 422 && c != 400 {
		t.Fatalf("file video with a link: %d", c)
	}
	var v struct {
		ID     int64  `json:"id"`
		Source string `json:"source"`
	}
	if c := call("POST", "/videos", map[string]any{"title": "Yarim final sharhi", "source": "file", "url": url1, "kind": "highlight", "status": "draft"}, &v); c != 201 || v.Source != "file" {
		t.Fatalf("create: %d %+v", c, v)
	}
	// replace the file: the old one is removed
	_, up2 := upload(mp4)
	url2, _ := up2["url"].(string)
	if c := call("PATCH", "/videos/"+itoa(int(v.ID)), map[string]any{"source": "file", "url": url2}, nil); c != 200 {
		t.Fatalf("patch: %d", c)
	}
	if _, err := os.Stat(filepath.Join(dir, "videos", name1)); !os.IsNotExist(err) {
		t.Fatalf("old file kept after replace: %v", err)
	}
	// delete the video: its file goes too
	if c := call("DELETE", "/videos/"+itoa(int(v.ID)), nil, nil); c != 204 {
		t.Fatalf("delete: %d", c)
	}
	name2, _ := videoFileName(url2)
	if _, err := os.Stat(filepath.Join(dir, "videos", name2)); !os.IsNotExist(err) {
		t.Fatalf("file kept after delete: %v", err)
	}
	if c := call("DELETE", "/videos/"+itoa(int(v.ID)), nil, nil); c != 404 {
		t.Fatalf("second delete: %d", c)
	}
}

