package api

// Sponsors and partners («Kontent» → «Hamkorlar»): a logo, an optional link and
// promo video, a kind that decides the logo size and group on the site, an
// order and an on/off switch. The homepage Partners block and the /hamkorlar
// page read them from GET /partners together with the block settings.

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"

	"github.com/go-chi/chi/v5"

	"github.com/sanedidi/unitedmfl/backend/internal/auth"
	"github.com/sanedidi/unitedmfl/backend/internal/httpx"
)

const (
	partnerVideoMaxBytes = 100 << 20 // «MP4 yoki WebM · 100 MB gacha»
	partnerLogoMaxBytes  = 5 << 20
)

var partnersRes = &resource{table: "partners", entity: "partner", touch: true, order: "ord, id",
	search: []string{"name"}, filters: map[string]string{"kind": "kind", "active": "is_active"},
	fields: map[string]field{
		"name": reqTxt(80), "url": txt(500), "kind": enum("main", "official", "media"), "description": txt(300),
		"logo_url": txt(500), "logo_name": txt(200), "logo_size": optInt,
		"video_url": txt(500), "video_name": txt(200), "video_size": optInt, "video_duration_sec": optInt,
		"show_video": boolean, "is_active": boolean, "ord": {kind: kInt},
	},
	prepare: preparePartner, afterWrite: partnerChanged, afterDelete: partnerDeleted}

func (s *Server) mountPartners(r chi.Router) {
	s.mountCRUD(r, auth.PermPartners, "/partners", partnersRes)
	r.Group(func(r chi.Router) {
		r.Use(s.can(auth.PermPartners))
		r.Put("/partners/order", s.reorderPartners)
		r.Get("/partner-settings", s.partnerSettings)
		r.Put("/partner-settings", s.savePartnerSettings)
		r.Post("/partner-logos", s.uploadPartnerLogo)
		// under /video-uploads so the proxy streams it like other video uploads (nginx location prefix)
		r.Post("/video-uploads/partner", s.uploadPartnerVideo)
	})
}

func isWebURL(u string) bool {
	return strings.HasPrefix(u, "https://") || strings.HasPrefix(u, "http://")
}

// preparePartner checks the addresses and puts a new partner at the end of the list.
func preparePartner(ctx context.Context, s *Server, body map[string]any, creating bool) error {
	errs := map[string]any{}
	if u, ok := body["url"].(string); ok {
		u = strings.TrimSpace(u)
		if u != "" && !isWebURL(u) {
			errs["url"] = "Havola https:// bilan boshlanishi kerak"
		}
	}
	if u, ok := body["logo_url"].(string); ok {
		u = strings.TrimSpace(u)
		if u != "" && !isWebURL(u) && !strings.HasPrefix(u, "/uploads/images/") {
			errs["logo_url"] = "Logotipni yuklang"
		}
	}
	if u, ok := body["video_url"].(string); ok {
		if u = strings.TrimSpace(u); u != "" {
			if _, ok := videoFileName(u); !ok {
				errs["video_url"] = "Video faylini yuklang"
			}
		}
	}
	if len(errs) > 0 {
		return httpx.Validation(errs)
	}
	if _, ok := body["ord"]; creating && !ok {
		var next int64
		if err := s.DB.QueryRowContext(ctx, `SELECT coalesce(max(ord), 0) + 1 FROM partners`).Scan(&next); err != nil {
			return err
		}
		body["ord"] = json.Number(strconv.FormatInt(next, 10))
	}
	return nil
}

// partnerChanged removes a replaced video file from disk.
func partnerChanged(s *Server, _ int64, old, cur map[string]any) {
	if old == nil {
		return
	}
	if o, _ := old["video_url"].(string); o != "" && o != cur["video_url"] {
		s.removeVideoFile(o)
	}
}

func partnerDeleted(s *Server, _ int64, old map[string]any) {
	if u, _ := old["video_url"].(string); u != "" {
		s.removeVideoFile(u)
	}
}

func (s *Server) reorderPartners(w http.ResponseWriter, r *http.Request) {
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
		if _, err := tx.ExecContext(r.Context(), `UPDATE partners SET ord=$1, updated_at=now() WHERE id=$2`, i+1, id); err != nil {
			httpx.Fail(w, r, err)
			return
		}
	}
	if err := tx.Commit(); err != nil {
		httpx.Fail(w, r, err)
		return
	}
	s.audit(r, "reorder", "partner", 0, map[string]any{"ids": ids})
	w.WriteHeader(http.StatusNoContent)
}

const partnerSettingsQuery = `SELECT json_build_object('title', title, 'show_cta', show_cta, 'show_block', show_block)
	FROM (SELECT title, show_cta, show_block FROM partner_settings WHERE id = 1
	      UNION ALL SELECT 'Final homiylari', true, true WHERE NOT EXISTS (SELECT 1 FROM partner_settings)) t`

func (s *Server) partnerSettings(w http.ResponseWriter, r *http.Request) {
	s.respondQuery(w, r, partnerSettingsQuery)
}

func (s *Server) savePartnerSettings(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Title     string `json:"title"`
		ShowCTA   bool   `json:"show_cta"`
		ShowBlock bool   `json:"show_block"`
	}
	if err := httpx.Decode(r, &in); err != nil {
		httpx.Fail(w, r, err)
		return
	}
	in.Title = strings.TrimSpace(in.Title)
	if n := len([]rune(in.Title)); n > 80 {
		httpx.Fail(w, r, httpx.Validation(map[string]any{"title": "80 belgidan oshmasin"}))
		return
	}
	if _, err := s.DB.ExecContext(r.Context(), `INSERT INTO partner_settings (id, title, show_cta, show_block, updated_at)
		VALUES (1, $1, $2, $3, now())
		ON CONFLICT (id) DO UPDATE SET title=EXCLUDED.title, show_cta=EXCLUDED.show_cta, show_block=EXCLUDED.show_block, updated_at=now()`,
		in.Title, in.ShowCTA, in.ShowBlock); err != nil {
		httpx.Fail(w, r, err)
		return
	}
	s.audit(r, "update", "partner_settings", 1, map[string]any{"title": in.Title, "show_cta": in.ShowCTA, "show_block": in.ShowBlock})
	s.respondQuery(w, r, partnerSettingsQuery)
}

// publicPartners: the block settings and the switched-on partners in order.
// A video hidden with «Faqat logotip» is left out.
func (s *Server) publicPartners(w http.ResponseWriter, r *http.Request) {
	s.respondQuery(w, r, `SELECT json_build_object('settings', (`+partnerSettingsQuery+`),
		'items', (SELECT coalesce(json_agg(p ORDER BY p.ord, p.id), '[]') FROM (
			SELECT id, name, url, kind, description, logo_url,
			       CASE WHEN show_video THEN video_url ELSE '' END AS video_url,
			       CASE WHEN show_video AND video_url <> '' THEN video_duration_sec END AS video_duration_sec, ord
			FROM partners WHERE is_active) p))`)
}

func (s *Server) uploadPartnerVideo(w http.ResponseWriter, r *http.Request) {
	s.receiveVideo(w, r, min(s.Cfg.MaxVideoBytes, partnerVideoMaxBytes), "partner_video")
}

// ---------- logos: PNG, JPG, WebP or SVG ----------

var (
	reSVGStart = regexp.MustCompile(`(?is)^\s*(<\?xml[^>]*\?>\s*)?(<!--.*?-->\s*)*(<!doctype[^>]*>\s*)?(<!--.*?-->\s*)*<svg[\s>]`)
	// anything that could run script or pull in another document
	reSVGUnsafe = regexp.MustCompile(`(?i)<\s*(script|foreignobject|iframe|embed|object|handler)\b|\son[a-z]+\s*=|javascript:|<!entity`)
)

// checkSVG accepts a standalone SVG drawing without scripts or event handlers.
// Uploaded SVGs are also served with a sandboxing CSP (see noDirListing).
func checkSVG(b []byte) bool {
	b = bytes.TrimPrefix(b, []byte("\xef\xbb\xbf"))
	return reSVGStart.Match(b) && !reSVGUnsafe.Match(b)
}

func (s *Server) uploadPartnerLogo(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, partnerLogoMaxBytes+1<<20)
	file, hdr, err := r.FormFile("file")
	if err != nil {
		httpx.Fail(w, r, httpx.BadRequest("«file» maydoni topilmadi yoki fayl 5 MB dan katta"))
		return
	}
	defer file.Close()
	data, err := io.ReadAll(io.LimitReader(file, partnerLogoMaxBytes+1))
	if err != nil {
		httpx.Fail(w, r, httpx.BadRequest("Faylni o‘qib bo‘lmadi"))
		return
	}
	if len(data) > partnerLogoMaxBytes {
		httpx.Fail(w, r, httpx.BadRequest("Logotip 5 MB dan katta bo‘lmasligi kerak"))
		return
	}
	mime := http.DetectContentType(data)
	if strings.HasPrefix(string(data), "RIFF") && len(data) >= 12 && string(data[8:12]) == "WEBP" {
		mime = "image/webp"
	}
	ext, ok := map[string]string{"image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp"}[mime]
	if !ok {
		if !checkSVG(data) {
			httpx.Fail(w, r, httpx.BadRequest("Faqat SVG, PNG, JPG yoki WebP logotip yuklash mumkin (SVG ichida skript bo‘lmasin)"))
			return
		}
		ext, mime = ".svg", "image/svg+xml"
	}
	name := randomName(ext)
	if err := os.WriteFile(filepath.Join(s.imagesDir(), name), data, 0o644); err != nil {
		httpx.Fail(w, r, err)
		return
	}
	url := s.Cfg.PublicBaseURL + "/uploads/images/" + name
	orig := sanitizeFilename(hdr.Filename)
	s.audit(r, "upload", "partner_logo", 0, map[string]any{"name": orig, "url": url})
	httpx.JSON(w, http.StatusCreated, map[string]any{"url": url, "size": len(data), "mime": mime, "name": orig})
}
