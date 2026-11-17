package api

// Video files uploaded from the admin (Videolar → «Fayl yuklash»).
// Files live in UPLOAD_DIR/videos and are served at /uploads/videos/<name>
// by http.FileServer, which answers Range requests, so the site player can seek.

import (
	"context"
	"errors"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/sanedidi/unitedmfl/backend/internal/httpx"
)

const videoURLPrefix = "/uploads/videos/"

var reVideoFile = regexp.MustCompile(`^[0-9a-f]{32}\.(mp4|mov|webm)$`)

var videoMIME = map[string]string{".mp4": "video/mp4", ".mov": "video/quicktime", ".webm": "video/webm"}

func (s *Server) videosDir() string { return filepath.Join(s.Cfg.UploadDir, "videos") }

// videoExt recognises MP4 / MOV (ISO media "ftyp" box) and WebM (EBML header)
// from the first bytes of the file. Still-image formats that share the ftyp
// box (HEIC, AVIF) are rejected.
func videoExt(head []byte) (string, bool) {
	if len(head) >= 12 && string(head[4:8]) == "ftyp" {
		switch string(head[8:12]) {
		case "qt  ":
			return ".mov", true
		case "heic", "heix", "hevc", "hevx", "mif1", "msf1", "avif", "avis":
			return "", false
		}
		return ".mp4", true
	}
	if len(head) >= 4 && head[0] == 0x1A && head[1] == 0x45 && head[2] == 0xDF && head[3] == 0xA3 {
		return ".webm", true
	}
	return "", false
}

// videoFileName returns the stored file name when url points to an uploaded video.
func videoFileName(url string) (string, bool) {
	i := strings.LastIndex(url, videoURLPrefix)
	if i < 0 {
		return "", false
	}
	name := url[i+len(videoURLPrefix):]
	return name, reVideoFile.MatchString(name)
}

// serveVideos serves only finished uploads (never *.part files) with the right type.
func (s *Server) serveVideos() http.Handler {
	fs := http.StripPrefix(videoURLPrefix, http.FileServer(http.Dir(s.videosDir())))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		name := strings.TrimPrefix(r.URL.Path, videoURLPrefix)
		if !reVideoFile.MatchString(name) {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", videoMIME[filepath.Ext(name)])
		w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
		fs.ServeHTTP(w, r)
	})
}

// uploadVideo streams one multipart «file» part straight to disk (no temp copy).
func (s *Server) uploadVideo(w http.ResponseWriter, r *http.Request) {
	// a large file over a slow line takes much longer than the server's ReadTimeout
	_ = http.NewResponseController(w).SetReadDeadline(time.Now().Add(3 * time.Hour))
	limit := s.Cfg.MaxVideoBytes
	tooBig := httpx.BadRequest(fmt.Sprintf("Video %d MB dan katta bo‘lmasligi kerak", limit>>20))
	if r.ContentLength > limit+1<<20 {
		httpx.Fail(w, r, tooBig)
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, limit+1<<20) // + multipart headers
	mr, err := r.MultipartReader()
	if err != nil {
		httpx.Fail(w, r, httpx.BadRequest("Video fayli yuborilmadi"))
		return
	}
	var part *multipart.Part
	for {
		p, err := mr.NextPart()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			httpx.Fail(w, r, httpx.BadRequest("Faylni o‘qib bo‘lmadi"))
			return
		}
		if p.FormName() == "file" {
			part = p
			break
		}
		_ = p.Close()
	}
	if part == nil {
		httpx.Fail(w, r, httpx.BadRequest("«file» maydoni topilmadi"))
		return
	}
	defer part.Close()

	head := make([]byte, 512)
	n, _ := io.ReadFull(part, head)
	ext, ok := videoExt(head[:n])
	if !ok {
		httpx.Fail(w, r, httpx.BadRequest("Faqat MP4, MOV yoki WebM video yuklash mumkin"))
		return
	}
	if err := os.MkdirAll(s.videosDir(), 0o755); err != nil {
		httpx.Fail(w, r, err)
		return
	}
	name := randomName(ext)
	final := filepath.Join(s.videosDir(), name)
	tmp := final + ".part"
	dst, err := os.OpenFile(tmp, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o644)
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	done := false
	defer func() {
		if !done {
			_ = dst.Close()
			_ = os.Remove(tmp)
		}
	}()
	if _, err := dst.Write(head[:n]); err != nil {
		httpx.Fail(w, r, err)
		return
	}
	size, err := io.Copy(dst, part)
	if err != nil {
		var mbe *http.MaxBytesError
		if errors.As(err, &mbe) {
			httpx.Fail(w, r, tooBig)
		} else {
			httpx.Fail(w, r, httpx.BadRequest("Yuklash uzildi, qaytadan urinib ko‘ring"))
		}
		return
	}
	size += int64(n)
	if size > limit {
		httpx.Fail(w, r, tooBig)
		return
	}
	if err := dst.Close(); err != nil {
		httpx.Fail(w, r, err)
		return
	}
	if err := os.Rename(tmp, final); err != nil {
		httpx.Fail(w, r, err)
		return
	}
	done = true
	url := s.Cfg.PublicBaseURL + videoURLPrefix + name
	orig := sanitizeFilename(part.FileName())
	s.audit(r, "upload", "video_file", 0, map[string]any{"name": orig, "url": url, "size": size})
	httpx.JSON(w, http.StatusCreated, map[string]any{"url": url, "size": size, "mime": videoMIME[ext], "name": orig})
}

// prepareVideo checks that a «file» video points to an uploaded file and a
// «link» video to a web address.
func prepareVideo(_ context.Context, _ *Server, body map[string]any, _ bool) error {
	src, _ := body["source"].(string)
	url, hasURL := body["url"].(string)
	if !hasURL {
		return nil
	}
	url = strings.TrimSpace(url)
	switch src {
	case "file":
		if _, ok := videoFileName(url); !ok {
			return httpx.Validation(map[string]any{"url": "Video faylini yuklang"})
		}
	case "link":
		if url != "" && !strings.HasPrefix(url, "https://") && !strings.HasPrefix(url, "http://") {
			return httpx.Validation(map[string]any{"url": "Havola https:// bilan boshlanishi kerak"})
		}
	}
	return nil
}

// videoChanged removes the old file when an uploaded video was replaced.
func videoChanged(s *Server, _ int64, old, cur map[string]any) {
	if old == nil {
		return
	}
	if o, _ := old["url"].(string); o != "" && o != cur["url"] {
		s.removeVideoFile(o)
	}
}

func videoDeleted(s *Server, _ int64, old map[string]any) {
	if u, _ := old["url"].(string); u != "" {
		s.removeVideoFile(u)
	}
}

// removeVideoFile deletes an uploaded file once no video row points to it any more.
func (s *Server) removeVideoFile(url string) {
	name, ok := videoFileName(url)
	if !ok {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	var used bool
	if err := s.DB.QueryRowContext(ctx, `SELECT EXISTS (SELECT 1 FROM videos WHERE url LIKE '%' || $1)`, videoURLPrefix+name).Scan(&used); err != nil || used {
		return
	}
	_ = os.Remove(filepath.Join(s.videosDir(), name))
}
