package api

import (
	"context"
	"database/sql"
	"fmt"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/lib/pq"
)

// ConvertLegacyImages brings images uploaded before WebP conversion existed in
// line with webp.go: every JPG/PNG/GIF/HEIC/AVIF in /uploads/images gets a
// WebP twin with the same name (abc.png → abc.webp, same conversion rules as
// new uploads) and every reference to it in the database is switched to the
// .webp URL. Originals stay on disk, so a page cached before the switch still
// shows its picture. Safe to run on every start: files that already have a
// twin are not converted again and rows that point to .webp are left alone.
// Instagram copies (ig-*) are managed by the Instagram sync and skipped.
func (s *Server) ConvertLegacyImages(ctx context.Context) {
	if _, err := exec.LookPath("vipsthumbnail"); err != nil {
		return
	}
	entries, err := os.ReadDir(s.imagesDir())
	if err != nil {
		slog.Warn("webp backfill: read dir", "err", err)
		return
	}
	start := time.Now()
	ready := map[string]string{} // old file name → webp file name
	converted, failed := 0, 0
	for _, e := range entries {
		name := e.Name()
		if ctx.Err() != nil {
			return
		}
		if !e.Type().IsRegular() || strings.HasPrefix(name, ".") || strings.HasPrefix(name, "ig-") || strings.HasSuffix(name, ".part") {
			continue
		}
		ext := strings.ToLower(filepath.Ext(name))
		if !legacyImageExt[ext] {
			continue
		}
		twin := strings.TrimSuffix(name, filepath.Ext(name)) + ".webp"
		dst := filepath.Join(s.imagesDir(), twin)
		if _, err := os.Stat(dst); err == nil {
			ready[name] = twin
			continue
		}
		src := filepath.Join(s.imagesDir(), name)
		kind := sniffFile(src)
		if kind == "" {
			continue
		}
		tmp := filepath.Join(s.imagesDir(), tmpEncPrefix+twin) // the .webp extension tells vips the format
		if err := s.convertOne(ctx, src, tmp, kind); err != nil {
			os.Remove(tmp)
			failed++
			slog.Warn("webp backfill: convert", "file", name, "err", err)
			continue
		}
		if err := os.Rename(tmp, dst); err != nil {
			os.Remove(tmp)
			failed++
			continue
		}
		ready[name] = twin
		converted++
	}
	if len(ready) == 0 {
		return
	}
	rows, err := s.relinkImages(ctx, ready)
	if err != nil {
		slog.Warn("webp backfill: database", "err", err)
		return
	}
	if converted > 0 || rows > 0 {
		slog.Info("webp backfill done", "converted", converted, "failed", failed, "rows_updated", rows, "took", time.Since(start).Round(time.Second))
		s.web.notify()
	}
}

var legacyImageExt = map[string]bool{".jpg": true, ".jpeg": true, ".png": true, ".gif": true, ".heic": true, ".heif": true, ".avif": true}

// convertOne encodes one legacy file, sharing the conversion slots with uploads
// so the backfill never takes more CPU than a burst of admin uploads.
func (s *Server) convertOne(ctx context.Context, src, dst, kind string) error {
	if kind == "webp" { // a WebP saved under another extension: copy as is
		b, err := os.ReadFile(src)
		if err != nil {
			return err
		}
		return os.WriteFile(dst, b, 0o644)
	}
	select {
	case photoSlots <- struct{}{}:
	case <-ctx.Done():
		return ctx.Err()
	}
	defer func() { <-photoSlots }()
	return encodeWebP(ctx, src, dst, kind)
}

var reUploadImage = regexp.MustCompile(`/uploads/images/([A-Za-z0-9._-]+\.(?i:jpe?g|png|gif|heic|heif|avif))`)

// relinkImages rewrites /uploads/images/<old> to /uploads/images/<new> in
// every text, varchar, json(b) and text[] column of the public schema, so
// covers, crests, photos, banners, merch galleries, homepage blocks and news
// bodies all switch at once. The audit log keeps its history untouched.
func (s *Server) relinkImages(ctx context.Context, ready map[string]string) (int, error) {
	cols, err := s.DB.QueryContext(ctx, `SELECT c.relname, a.attname, format_type(a.atttypid, a.atttypmod)
		FROM pg_attribute a
		JOIN pg_class c ON c.oid = a.attrelid
		JOIN pg_namespace n ON n.oid = c.relnamespace
		WHERE n.nspname = 'public' AND c.relkind = 'r' AND a.attnum > 0 AND NOT a.attisdropped AND a.attgenerated = ''
		  AND a.atttypid IN ('text'::regtype, 'varchar'::regtype, 'json'::regtype, 'jsonb'::regtype, 'text[]'::regtype, 'varchar[]'::regtype)
		  AND c.relname NOT IN ('audit_log', 'schema_migrations')
		ORDER BY 1, 2`)
	if err != nil {
		return 0, err
	}
	type col struct{ table, name, typ string }
	var list []col
	for cols.Next() {
		var c col
		if err := cols.Scan(&c.table, &c.name, &c.typ); err != nil {
			cols.Close()
			return 0, err
		}
		list = append(list, c)
	}
	cols.Close()
	if err := cols.Err(); err != nil {
		return 0, err
	}
	total := 0
	for _, c := range list {
		n, err := s.relinkColumn(ctx, c.table, c.name, c.typ, ready)
		if err != nil {
			return total, fmt.Errorf("%s.%s: %w", c.table, c.name, err)
		}
		total += n
	}
	return total, nil
}

func (s *Server) relinkColumn(ctx context.Context, table, column, typ string, ready map[string]string) (int, error) {
	tx, err := s.DB.BeginTx(ctx, nil)
	if err != nil {
		return 0, err
	}
	defer tx.Rollback()
	t, c := pq.QuoteIdentifier(table), pq.QuoteIdentifier(column)
	rows, err := tx.QueryContext(ctx, `SELECT ctid::text, `+c+`::text FROM `+t+
		` WHERE `+c+`::text ~* '/uploads/images/[A-Za-z0-9._-]+\.(jpe?g|png|gif|hei[cf]|avif)' FOR UPDATE`)
	if err != nil {
		return 0, err
	}
	type hit struct{ ctid, val string }
	var hits []hit
	for rows.Next() {
		var h hit
		var v sql.NullString
		if err := rows.Scan(&h.ctid, &v); err != nil {
			rows.Close()
			return 0, err
		}
		h.val = v.String
		hits = append(hits, h)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return 0, err
	}
	n := 0
	for _, h := range hits {
		next := reUploadImage.ReplaceAllStringFunc(h.val, func(m string) string {
			if twin, ok := ready[strings.TrimPrefix(m, "/uploads/images/")]; ok {
				return "/uploads/images/" + twin
			}
			return m
		})
		if next == h.val {
			continue
		}
		if _, err := tx.ExecContext(ctx, `UPDATE `+t+` SET `+c+` = $1::`+typ+` WHERE ctid = $2::tid`, next, h.ctid); err != nil {
			return 0, err
		}
		n++
	}
	if err := tx.Commit(); err != nil {
		return 0, err
	}
	return n, nil
}
