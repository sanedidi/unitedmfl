package api

import (
	"context"
	"database/sql"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/sanedidi/unitedmfl/backend/internal/httpx"
)

// Match photo reports. Every upload (JPG, PNG, WebP, GIF, HEIC/HEIF) is
// converted to WebP by libvips: a large image (long side ≤ 2400 px, q82) and a
// thumbnail (≤ 640 px, q78). EXIF rotation is applied and all metadata,
// GPS included, is stripped. The original file is not kept.

const (
	photoLong  = 2400
	thumbLong  = 640
	photoMaxMB = 40
)

// photoSlots limits concurrent conversions: a 100-photo upload must not
// starve the API of CPU.
var photoSlots = make(chan struct{}, 2)

type matchPhoto struct {
	ID            int64  `json:"id"`
	MatchID       int64  `json:"match_id"`
	URL           string `json:"url"`
	ThumbURL      string `json:"thumb_url"`
	Width         int    `json:"width"`
	Height        int    `json:"height"`
	Bytes         int64  `json:"bytes"`
	OriginalBytes int64  `json:"original_bytes"`
	Caption       string `json:"caption"`
	Ord           int    `json:"ord"`
}

// photoKind sniffs the upload; HEIC/HEIF/AVIF are ISO-BMFF files with an ftyp brand.
func photoKind(head []byte) string {
	if len(head) >= 12 && string(head[4:8]) == "ftyp" {
		switch string(head[8:12]) {
		case "heic", "heix", "heim", "heis", "hevc", "hevx", "mif1", "msf1", "avif":
			return "heic"
		}
	}
	switch http.DetectContentType(head) {
	case "image/jpeg":
		return "jpg"
	case "image/png":
		return "png"
	case "image/gif":
		return "gif"
	}
	if len(head) >= 12 && string(head[0:4]) == "RIFF" && string(head[8:12]) == "WEBP" {
		return "webp"
	}
	return ""
}

// convertPhoto turns src into two WebP files in dir and returns their sizes.
// It is a variable so tests can run without libvips.
var convertPhoto = func(ctx context.Context, src, full, thumb string) error {
	run := func(long, q int, out string) error {
		ctx, cancel := context.WithTimeout(ctx, 90*time.Second)
		defer cancel()
		// "x>" — only ever shrink; vipsthumbnail applies EXIF orientation itself.
		cmd := exec.CommandContext(ctx, "vipsthumbnail", src,
			"--size", fmt.Sprintf("%dx%d>", long, long),
			"-o", fmt.Sprintf("%s[Q=%d,strip,smart_subsample]", out, q))
		if b, err := cmd.CombinedOutput(); err != nil {
			return fmt.Errorf("vipsthumbnail: %v: %s", err, strings.TrimSpace(string(b)))
		}
		return nil
	}
	if err := run(photoLong, 82, full); err != nil {
		return err
	}
	return run(thumbLong, 78, thumb)
}

// webpSize reads the canvas size from a WebP header.
func webpSize(path string) (int, int) {
	f, err := os.Open(path)
	if err != nil {
		return 0, 0
	}
	defer f.Close()
	d := make([]byte, 30)
	if n, _ := io.ReadFull(f, d); n < 30 || string(d[0:4]) != "RIFF" || string(d[8:12]) != "WEBP" {
		return 0, 0
	}
	switch string(d[12:16]) {
	case "VP8X":
		return (int(d[24]) | int(d[25])<<8 | int(d[26])<<16) + 1, (int(d[27]) | int(d[28])<<8 | int(d[29])<<16) + 1
	case "VP8 ":
		return int(binary.LittleEndian.Uint16(d[26:28]) & 0x3fff), int(binary.LittleEndian.Uint16(d[28:30]) & 0x3fff)
	case "VP8L":
		b := binary.LittleEndian.Uint32(d[21:25])
		return int(b&0x3fff) + 1, int((b>>14)&0x3fff) + 1
	}
	return 0, 0
}

const photoCols = `id, match_id, url, thumb_url, width, height, bytes, original_bytes, caption, ord`

func scanPhoto(row interface{ Scan(...any) error }) (matchPhoto, error) {
	var p matchPhoto
	err := row.Scan(&p.ID, &p.MatchID, &p.URL, &p.ThumbURL, &p.Width, &p.Height, &p.Bytes, &p.OriginalBytes, &p.Caption, &p.Ord)
	return p, err
}

func (s *Server) listMatchPhotos(w http.ResponseWriter, r *http.Request) {
	id, err := idParam(r, "id")
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	var photographer string
	if err := s.DB.QueryRowContext(r.Context(), `SELECT photographer FROM matches WHERE id=$1`, id).Scan(&photographer); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			err = httpx.ErrNotFound
		}
		httpx.Fail(w, r, err)
		return
	}
	rows, err := s.DB.QueryContext(r.Context(), `SELECT `+photoCols+` FROM match_photos WHERE match_id=$1 ORDER BY ord, id`, id)
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	defer rows.Close()
	items := []matchPhoto{}
	for rows.Next() {
		p, err := scanPhoto(rows)
		if err != nil {
			httpx.Fail(w, r, err)
			return
		}
		items = append(items, p)
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"items": items, "photographer": photographer})
}

// uploadMatchPhoto takes one file per request so the admin can show progress
// for every photo of a large batch.
func (s *Server) uploadMatchPhoto(w http.ResponseWriter, r *http.Request) {
	matchID, err := idParam(r, "id")
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	var exists bool
	if err := s.DB.QueryRowContext(r.Context(), `SELECT EXISTS (SELECT 1 FROM matches WHERE id=$1)`, matchID).Scan(&exists); err != nil || !exists {
		if err == nil {
			err = httpx.ErrNotFound
		}
		httpx.Fail(w, r, err)
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, photoMaxMB<<20)
	file, _, err := r.FormFile("file")
	if err != nil {
		httpx.Fail(w, r, httpx.BadRequest(fmt.Sprintf("«file» maydoni topilmadi yoki fayl %d MB dan katta", photoMaxMB)))
		return
	}
	defer file.Close()
	head := make([]byte, 512)
	n, _ := io.ReadFull(file, head)
	kind := photoKind(head[:n])
	if kind == "" {
		httpx.Fail(w, r, httpx.BadRequest("Faqat JPG, PNG, WebP, GIF yoki HEIC"))
		return
	}
	tmp, err := os.CreateTemp("", "photo-*."+kind)
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	defer os.Remove(tmp.Name())
	orig, err := io.Copy(tmp, io.MultiReader(strings.NewReader(string(head[:n])), file))
	tmp.Close()
	if err != nil {
		httpx.Fail(w, r, httpx.BadRequest(fmt.Sprintf("Fayl %d MB dan katta", photoMaxMB)))
		return
	}

	base := fmt.Sprintf("m%d-%s", matchID, randomName(""))
	full := filepath.Join(s.imagesDir(), base+".webp")
	thumb := filepath.Join(s.imagesDir(), base+"-t.webp")
	select {
	case photoSlots <- struct{}{}:
	case <-r.Context().Done():
		httpx.Fail(w, r, r.Context().Err())
		return
	}
	err = convertPhoto(r.Context(), tmp.Name(), full, thumb)
	<-photoSlots
	if err != nil {
		os.Remove(full)
		os.Remove(thumb)
		httpx.Fail(w, r, httpx.BadRequest("Rasmni WebP ga o‘tkazib bo‘lmadi — fayl buzilgan yoki format qo‘llab-quvvatlanmaydi"))
		slog.Warn("photo convert", "match", matchID, "err", err)
		return
	}
	width, height := webpSize(full)
	var size int64
	if st, err := os.Stat(full); err == nil {
		size = st.Size()
	}
	url := s.Cfg.PublicBaseURL + "/uploads/images/" + base + ".webp"
	thumbURL := s.Cfg.PublicBaseURL + "/uploads/images/" + base + "-t.webp"
	p, err := scanPhoto(s.DB.QueryRowContext(r.Context(), `INSERT INTO match_photos (match_id, url, thumb_url, width, height, bytes, original_bytes, ord)
		VALUES ($1, $2, $3, $4, $5, $6, $7, coalesce((SELECT max(ord) FROM match_photos WHERE match_id=$1), 0) + 1)
		RETURNING `+photoCols, matchID, url, thumbURL, width, height, size, orig))
	if err != nil {
		os.Remove(full)
		os.Remove(thumb)
		httpx.Fail(w, r, err)
		return
	}
	s.audit(r, "upload", "match_photo", p.ID, map[string]any{"match_id": matchID, "bytes": size, "original_bytes": orig})
	httpx.JSON(w, http.StatusCreated, p)
}

func (s *Server) patchMatchPhoto(w http.ResponseWriter, r *http.Request) {
	id, err := idParam(r, "id")
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	var body struct {
		Caption *string `json:"caption"`
	}
	if err := httpx.Decode(r, &body); err != nil {
		httpx.Fail(w, r, err)
		return
	}
	if body.Caption == nil {
		httpx.Fail(w, r, httpx.BadRequest("«caption» kerak"))
		return
	}
	caption := strings.TrimSpace(*body.Caption)
	if len([]rune(caption)) > 300 {
		httpx.Fail(w, r, httpx.Validation(map[string]any{"caption": "300 belgidan oshmasin"}))
		return
	}
	p, err := scanPhoto(s.DB.QueryRowContext(r.Context(), `UPDATE match_photos SET caption=$2 WHERE id=$1 RETURNING `+photoCols, id, caption))
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			err = httpx.ErrNotFound
		}
		httpx.Fail(w, r, err)
		return
	}
	s.audit(r, "update", "match_photo", id, map[string]any{"caption": caption})
	httpx.JSON(w, http.StatusOK, p)
}

// removePhotoFiles deletes the WebP files behind the given public URLs.
func (s *Server) removePhotoFiles(urls ...string) {
	for _, u := range urls {
		if i := strings.Index(u, "/uploads/images/"); i >= 0 {
			name := filepath.Base(u[i+len("/uploads/images/"):])
			if name != "." && name != "/" {
				os.Remove(filepath.Join(s.imagesDir(), name))
			}
		}
	}
}

func (s *Server) deleteMatchPhoto(w http.ResponseWriter, r *http.Request) {
	id, err := idParam(r, "id")
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	var url, thumb string
	if err := s.DB.QueryRowContext(r.Context(), `DELETE FROM match_photos WHERE id=$1 RETURNING url, thumb_url`, id).Scan(&url, &thumb); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			err = httpx.ErrNotFound
		}
		httpx.Fail(w, r, err)
		return
	}
	s.removePhotoFiles(url, thumb)
	s.audit(r, "delete", "match_photo", id, nil)
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) deleteMatchPhotos(w http.ResponseWriter, r *http.Request) {
	matchID, err := idParam(r, "id")
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	rows, err := s.DB.QueryContext(r.Context(), `DELETE FROM match_photos WHERE match_id=$1 RETURNING url, thumb_url`, matchID)
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	var files []string
	for rows.Next() {
		var a, b string
		if rows.Scan(&a, &b) == nil {
			files = append(files, a, b)
		}
	}
	rows.Close()
	s.removePhotoFiles(files...)
	s.audit(r, "delete", "match_photos", matchID, map[string]any{"count": len(files) / 2})
	w.WriteHeader(http.StatusNoContent)
}

// reorderMatchPhotos sets the order; the first photo is the cover.
func (s *Server) reorderMatchPhotos(w http.ResponseWriter, r *http.Request) {
	matchID, err := idParam(r, "id")
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	var ids []int64
	if err := httpx.Decode(r, &ids); err != nil {
		httpx.Fail(w, r, err)
		return
	}
	tx, err := s.DB.BeginTx(r.Context(), nil)
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	defer tx.Rollback()
	for i, id := range ids {
		if _, err := tx.ExecContext(r.Context(), `UPDATE match_photos SET ord=$1 WHERE id=$2 AND match_id=$3`, i+1, id, matchID); err != nil {
			httpx.Fail(w, r, err)
			return
		}
	}
	if err := tx.Commit(); err != nil {
		httpx.Fail(w, r, err)
		return
	}
	s.audit(r, "reorder", "match_photos", matchID, map[string]any{"ids": ids})
	w.WriteHeader(http.StatusNoContent)
}
