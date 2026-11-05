package api

import (
	"context"
	"database/sql"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// MirrorRemoteImages copies banner images that still point to an allowed
// external host (the league's old WordPress site) into /uploads, so the site
// serves them itself (optimized by Next.js, no hotlinking). Safe to run on
// every start: rows that already point to /uploads are skipped, and failures
// leave the remote URL in place for the next attempt.
func (s *Server) MirrorRemoteImages(ctx context.Context) {
	hosts := map[string]bool{}
	for _, h := range strings.Split(s.Cfg.MirrorImageHosts, ",") {
		if h = strings.TrimSpace(strings.ToLower(h)); h != "" {
			hosts[h] = true
		}
	}
	if len(hosts) == 0 {
		return
	}
	rows, err := s.DB.QueryContext(ctx, `SELECT DISTINCT u FROM (
		SELECT image_desktop AS u FROM banners UNION SELECT image_mobile FROM banners) x WHERE u LIKE 'http%'`)
	if err != nil {
		slog.Warn("mirror: query", "err", err)
		return
	}
	var urls []string
	for rows.Next() {
		var u string
		if rows.Scan(&u) == nil {
			urls = append(urls, u)
		}
	}
	rows.Close()

	client := &http.Client{Timeout: 60 * time.Second}
	changed := false
	for _, raw := range urls {
		pu, err := url.Parse(raw)
		if err != nil || !hosts[strings.ToLower(pu.Hostname())] {
			continue
		}
		local, err := s.download(ctx, client, raw)
		if err != nil {
			slog.Warn("mirror: download failed", "url", raw, "err", err)
			continue
		}
		if err := s.replaceImageURL(ctx, raw, local); err != nil {
			slog.Warn("mirror: update failed", "err", err)
			continue
		}
		changed = true
		slog.Info("mirror: image copied", "from", raw, "to", local)
	}
	if changed {
		s.web.notify()
	}
}

func (s *Server) download(ctx context.Context, client *http.Client, raw string) (string, error) {
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, raw, nil)
	req.Header.Set("User-Agent", "UnitedMFL-image-mirror/1.0")
	res, err := client.Do(req)
	if err != nil {
		return "", err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return "", fmt.Errorf("status %d", res.StatusCode)
	}
	ext := map[string]string{"image/webp": ".webp", "image/jpeg": ".jpg", "image/png": ".png", "image/avif": ".avif", "image/gif": ".gif"}[strings.Split(res.Header.Get("Content-Type"), ";")[0]]
	if ext == "" {
		return "", fmt.Errorf("not an image: %q", res.Header.Get("Content-Type"))
	}
	limit := s.Cfg.MaxUploadBytes
	if err := os.MkdirAll(s.imagesDir(), 0o755); err != nil {
		return "", err
	}
	name := randomName(ext)
	tmp := filepath.Join(s.imagesDir(), name+".part")
	f, err := os.Create(tmp)
	if err != nil {
		return "", err
	}
	n, err := io.Copy(f, io.LimitReader(res.Body, limit+1))
	f.Close()
	if err != nil || n > limit {
		os.Remove(tmp)
		if err == nil {
			err = fmt.Errorf("larger than %d bytes", limit)
		}
		return "", err
	}
	if err := os.Rename(tmp, filepath.Join(s.imagesDir(), name)); err != nil {
		return "", err
	}
	return s.Cfg.PublicBaseURL + "/uploads/images/" + name, nil
}

func (s *Server) replaceImageURL(ctx context.Context, from, to string) error {
	tx, err := s.DB.BeginTx(ctx, &sql.TxOptions{})
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := tx.ExecContext(ctx, `UPDATE banners SET image_desktop = $2, updated_at = now() WHERE image_desktop = $1`, from, to); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `UPDATE banners SET image_mobile = $2, updated_at = now() WHERE image_mobile = $1`, from, to); err != nil {
		return err
	}
	return tx.Commit()
}
