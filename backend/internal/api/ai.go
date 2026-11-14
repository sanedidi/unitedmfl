package api

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/lib/pq"

	"github.com/sanedidi/unitedmfl/backend/internal/auth"
	"github.com/sanedidi/unitedmfl/backend/internal/httpx"
)

// The admin talks to the AI service only through these endpoints: the API
// checks permissions, loads assets, stores the pictures in /uploads and keeps
// the generation history. Keys and settings stay inside the AI service.

var errAIOff = httpx.NewError(http.StatusServiceUnavailable, "ai_off", "AI-servis o‘rnatilmagan (AI_SERVICE_URL bo‘sh)")

// aiJobs tracks running generations so they can be cancelled.
type aiJobs struct {
	mu     sync.Mutex
	cancel map[int64]context.CancelFunc
}

func (j *aiJobs) add(id int64, c context.CancelFunc) {
	j.mu.Lock()
	defer j.mu.Unlock()
	if j.cancel == nil {
		j.cancel = map[int64]context.CancelFunc{}
	}
	j.cancel[id] = c
}

func (j *aiJobs) done(id int64) {
	j.mu.Lock()
	defer j.mu.Unlock()
	delete(j.cancel, id)
}

func (j *aiJobs) stop(id int64) bool {
	j.mu.Lock()
	defer j.mu.Unlock()
	if c, ok := j.cancel[id]; ok {
		c()
		return true
	}
	return false
}

func (s *Server) mountAI(r chi.Router) {
	r.Route("/ai", func(r chi.Router) {
		r.Get("/providers", s.aiProxy(http.MethodGet, "/v1/providers"))
		r.Get("/settings", s.aiProxy(http.MethodGet, "/v1/settings"))
		r.Post("/improve", s.aiImprove)
		r.Post("/generations", s.aiStart)
		r.Get("/generations", s.aiList)
		r.Get("/generations/{id}", s.aiGet)
		r.Post("/generations/{id}/cancel", s.aiCancel)
		r.Post("/generations/{id}/apply", s.aiMark("applied"))
		r.Post("/generations/{id}/save", s.aiMark("saved"))
		// connections and shared settings: administrators only
		r.Group(func(r chi.Router) {
			r.Use(s.can(auth.PermUsers))
			r.Put("/settings", s.aiProxy(http.MethodPut, "/v1/settings"))
			r.Put("/providers/{p}", s.aiProviderProxy(http.MethodPut, ""))
			r.Post("/providers/{p}/test", s.aiProviderProxy(http.MethodPost, "/test"))
			r.Delete("/providers/{p}", s.aiProviderProxy(http.MethodDelete, ""))
		})
	})
}

var aiHTTP = &http.Client{Timeout: 15 * time.Minute}

// aiCall sends body (raw JSON bytes or a value) to the AI service and returns the raw reply.
func (s *Server) aiCall(ctx context.Context, method, path string, body any) (json.RawMessage, error) {
	if s.Cfg.AIServiceURL == "" {
		return nil, errAIOff
	}
	var rd io.Reader
	switch b := body.(type) {
	case nil:
	case []byte:
		rd = bytes.NewReader(b)
	default:
		raw, err := json.Marshal(b)
		if err != nil {
			return nil, err
		}
		rd = bytes.NewReader(raw)
	}
	req, err := http.NewRequestWithContext(ctx, method, s.Cfg.AIServiceURL+path, rd)
	if err != nil {
		return nil, err
	}
	req.Header.Set("X-Internal-Token", s.Cfg.AIInternalToken)
	if rd != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	res, err := aiHTTP.Do(req)
	if err != nil {
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		return nil, httpx.NewError(http.StatusServiceUnavailable, "ai_unreachable", "AI-servisga ulanib bo‘lmadi")
	}
	defer res.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(res.Body, 400<<20))
	if err != nil {
		return nil, err
	}
	if res.StatusCode >= 300 {
		var e struct {
			Error *httpx.Error `json:"error"`
		}
		if json.Unmarshal(raw, &e) == nil && e.Error != nil {
			e.Error.Status = res.StatusCode
			return nil, e.Error
		}
		return nil, httpx.NewError(http.StatusBadGateway, "ai_error", fmt.Sprintf("AI-servis xatosi (%d)", res.StatusCode))
	}
	return raw, nil
}

func (s *Server) aiProxy(method, path string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var body any
		if method != http.MethodGet {
			raw, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 1<<20))
			if err != nil {
				httpx.Fail(w, r, httpx.BadRequest("So‘rov juda katta"))
				return
			}
			body = raw
		}
		raw, err := s.aiCall(r.Context(), method, path, body)
		if err != nil {
			httpx.Fail(w, r, err)
			return
		}
		if method != http.MethodGet {
			s.audit(r, "update", "ai_settings", 0, nil)
		}
		writeRaw(w, http.StatusOK, raw)
	}
}

func (s *Server) aiProviderProxy(method, suffix string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		p := chi.URLParam(r, "p")
		if p != "openai" && p != "gemini" {
			httpx.Fail(w, r, httpx.ErrNotFound)
			return
		}
		var body any
		if method == http.MethodPut {
			raw, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 64<<10))
			if err != nil {
				httpx.Fail(w, r, httpx.BadRequest("So‘rov juda katta"))
				return
			}
			body = raw
		}
		raw, err := s.aiCall(r.Context(), method, "/v1/providers/"+p+suffix, body)
		if err != nil {
			httpx.Fail(w, r, err)
			return
		}
		if method != http.MethodPost {
			s.audit(r, strings.ToLower(method), "ai_provider", 0, map[string]any{"provider": p})
		}
		if method == http.MethodDelete {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		writeRaw(w, http.StatusOK, raw)
	}
}

type aiImproveIn struct {
	Prompt string   `json:"prompt"`
	Layout string   `json:"layout"`
	Assets []string `json:"assets"`
}

func (s *Server) aiImprove(w http.ResponseWriter, r *http.Request) {
	var in aiImproveIn
	if err := httpx.Decode(r, &in); err != nil {
		httpx.Fail(w, r, err)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 2*time.Minute)
	defer cancel()
	raw, err := s.aiCall(ctx, http.MethodPost, "/v1/improve", in)
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	writeRaw(w, http.StatusOK, raw)
}

// aiAsset is a reference picture chosen on the banner page.
type aiAsset struct {
	Kind  string `json:"kind"` // logo | url
	URL   string `json:"url"`
	Label string `json:"label"`
}

type aiStartIn struct {
	PromptOriginal string    `json:"prompt_original"`
	Prompt         string    `json:"prompt"`
	Layout         string    `json:"layout"`
	Formats        []string  `json:"formats"`
	Assets         []aiAsset `json:"assets"`
	Target         string    `json:"target"`
	TargetID       *int64    `json:"target_id"`
}

type aiImageOut struct {
	URL    string `json:"url"`
	Mime   string `json:"mime"`
	Width  int    `json:"width"`
	Height int    `json:"height"`
}

type aiVariantOut struct {
	Images map[string]aiImageOut `json:"images"`
}

// aiGeneration is a history row as the admin sees it.
type aiGeneration struct {
	ID             int64           `json:"id"`
	UserName       string          `json:"user_name"`
	Target         string          `json:"target"`
	TargetID       *int64          `json:"target_id"`
	Layout         string          `json:"layout"`
	PromptOriginal string          `json:"prompt_original"`
	Prompt         string          `json:"prompt"`
	Formats        []string        `json:"formats"`
	Assets         json.RawMessage `json:"assets"`
	Status         string          `json:"status"`
	Error          string          `json:"error"`
	Provider       string          `json:"provider"`
	Model          string          `json:"model"`
	DurationMS     int             `json:"duration_ms"`
	Variants       json.RawMessage `json:"variants"`
	AppliedVariant *int            `json:"applied_variant"`
	Warnings       json.RawMessage `json:"warnings"`
	CreatedAt      time.Time       `json:"created_at"`
	UpdatedAt      time.Time       `json:"updated_at"`
}

const aiCols = `id, user_name, target, target_id, layout, prompt_original, prompt, formats, assets, status, error, provider, model, duration_ms, variants, applied_variant, warnings, created_at, updated_at`

func scanGeneration(row interface{ Scan(...any) error }) (aiGeneration, error) {
	var g aiGeneration
	var tid sql.NullInt64
	var av sql.NullInt64
	err := row.Scan(&g.ID, &g.UserName, &g.Target, &tid, &g.Layout, &g.PromptOriginal, &g.Prompt, pq.Array(&g.Formats), &g.Assets, &g.Status, &g.Error, &g.Provider, &g.Model, &g.DurationMS, &g.Variants, &av, &g.Warnings, &g.CreatedAt, &g.UpdatedAt)
	if tid.Valid {
		g.TargetID = &tid.Int64
	}
	if av.Valid {
		v := int(av.Int64)
		g.AppliedVariant = &v
	}
	if g.Formats == nil {
		g.Formats = []string{}
	}
	return g, err
}

func (s *Server) loadGeneration(ctx context.Context, id int64) (aiGeneration, error) {
	g, err := scanGeneration(s.DB.QueryRowContext(ctx, `SELECT `+aiCols+` FROM ai_generations WHERE id=$1`, id))
	if errors.Is(err, sql.ErrNoRows) {
		return g, httpx.ErrNotFound
	}
	return g, err
}

func (s *Server) aiStart(w http.ResponseWriter, r *http.Request) {
	if s.Cfg.AIServiceURL == "" {
		httpx.Fail(w, r, errAIOff)
		return
	}
	var in aiStartIn
	if err := httpx.Decode(r, &in); err != nil {
		httpx.Fail(w, r, err)
		return
	}
	in.Prompt = strings.TrimSpace(in.Prompt)
	errs := map[string]any{}
	if len([]rune(in.Prompt)) < 5 || len([]rune(in.Prompt)) > 4000 {
		errs["prompt"] = "Tasdiqlangan prompt kerak (5–4000 belgi)"
	}
	if len(in.Formats) == 0 || len(in.Formats) > 6 {
		errs["formats"] = "Kamida bitta formatni tanlang"
	}
	if len(in.Assets) > 14 {
		errs["assets"] = "Ko‘pi bilan 14 ta asset"
	}
	if len(errs) > 0 {
		httpx.Fail(w, r, httpx.Validation(errs))
		return
	}
	if in.Target == "" {
		in.Target = "banner"
	}
	c := claimsFrom(r.Context())
	labels := make([]string, 0, len(in.Assets))
	for _, a := range in.Assets {
		labels = append(labels, a.Label)
	}
	assetsJSON, _ := json.Marshal(labels)
	var id int64
	err := s.DB.QueryRowContext(r.Context(), `INSERT INTO ai_generations (user_id, user_name, target, target_id, layout, prompt_original, prompt, formats, assets)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
		c.UserID, c.Name, in.Target, in.TargetID, in.Layout, strings.TrimSpace(in.PromptOriginal), in.Prompt, pq.Array(in.Formats), assetsJSON).Scan(&id)
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Minute)
	s.ai.add(id, cancel)
	go s.runGeneration(ctx, cancel, id, in)
	s.audit(r, "create", "ai_generation", id, map[string]any{"target": in.Target, "target_id": in.TargetID})
	g, err := s.loadGeneration(r.Context(), id)
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusAccepted, g)
}

func (s *Server) runGeneration(ctx context.Context, cancel context.CancelFunc, id int64, in aiStartIn) {
	defer cancel()
	defer s.ai.done(id)
	finish := func(status, msg string, res *aiImagesResult, variants []aiVariantOut, warnings []string) {
		if warnings == nil {
			warnings = []string{}
		}
		if variants == nil {
			variants = []aiVariantOut{}
		}
		vj, _ := json.Marshal(variants)
		wj, _ := json.Marshal(warnings)
		provider, model, ms := "", "", int64(0)
		if res != nil {
			provider, model, ms = res.Provider, res.Model, res.MS
		}
		if _, err := s.DB.Exec(`UPDATE ai_generations SET status=$2, error=$3, provider=$4, model=$5, duration_ms=$6, variants=$7, warnings=$8, updated_at=now()
			WHERE id=$1 AND status='running'`, id, status, msg, provider, model, ms, vj, wj); err != nil {
			slog.Error("ai generation update", "id", id, "err", err)
		}
	}
	assets, warnings := s.loadAssets(ctx, in.Assets)
	raw, err := s.aiCall(ctx, http.MethodPost, "/v1/images", map[string]any{"prompt": in.Prompt, "layout": in.Layout, "formats": in.Formats, "assets": assets})
	if err != nil {
		switch {
		case errors.Is(err, context.Canceled):
			finish("cancelled", "Bekor qilindi", nil, nil, warnings)
		case errors.Is(err, context.DeadlineExceeded):
			finish("error", "Vaqt tugadi (15 daqiqa)", nil, nil, warnings)
		default:
			finish("error", err.Error(), nil, nil, warnings)
		}
		return
	}
	var res aiImagesResult
	if err := json.Unmarshal(raw, &res); err != nil {
		finish("error", "AI-servis javobini o‘qib bo‘lmadi", nil, nil, warnings)
		return
	}
	variants := make([]aiVariantOut, 0, len(res.Variants))
	for _, v := range res.Variants {
		out := aiVariantOut{Images: map[string]aiImageOut{}}
		for key, img := range v.Images {
			url, err := s.saveAIImage(img.Mime, img.Data)
			if err != nil {
				finish("error", "Rasmni saqlab bo‘lmadi: "+err.Error(), &res, nil, warnings)
				return
			}
			out.Images[key] = aiImageOut{URL: url, Mime: img.Mime, Width: img.Width, Height: img.Height}
		}
		variants = append(variants, out)
	}
	finish("done", "", &res, variants, append(warnings, res.Warnings...))
}

type aiImagesResult struct {
	Provider string `json:"provider"`
	Model    string `json:"model"`
	MS       int64  `json:"ms"`
	Variants []struct {
		Images map[string]struct {
			Mime   string `json:"mime"`
			Data   []byte `json:"data"`
			Width  int    `json:"width"`
			Height int    `json:"height"`
		} `json:"images"`
	} `json:"variants"`
	Warnings []string `json:"warnings"`
}

func (s *Server) saveAIImage(mime string, data []byte) (string, error) {
	ext, ok := imageTypes[mime]
	if !ok {
		return "", fmt.Errorf("format %s", mime)
	}
	name := "ai-" + randomName(ext)
	if err := os.WriteFile(filepath.Join(s.imagesDir(), name), data, 0o644); err != nil {
		return "", err
	}
	return s.Cfg.PublicBaseURL + "/uploads/images/" + name, nil
}

type aiAssetData struct {
	Label string `json:"label"`
	Mime  string `json:"mime"`
	Data  []byte `json:"data"`
}

var assetHTTP = &http.Client{Timeout: 20 * time.Second}

// loadAssets reads each chosen asset: uploads from disk, the league logo from
// the site container, anything else over HTTP. Non-raster files are skipped.
func (s *Server) loadAssets(ctx context.Context, list []aiAsset) ([]aiAssetData, []string) {
	var out []aiAssetData
	var warnings []string
	for _, a := range list {
		data, err := s.readAsset(ctx, a)
		if err != nil {
			warnings = append(warnings, fmt.Sprintf("«%s» o‘tkazib yuborildi: %v", a.Label, err))
			continue
		}
		mime := http.DetectContentType(data)
		if bytes.HasPrefix(data, []byte("RIFF")) && len(data) > 12 && string(data[8:12]) == "WEBP" {
			mime = "image/webp"
		}
		if mime != "image/png" && mime != "image/jpeg" && mime != "image/webp" {
			warnings = append(warnings, fmt.Sprintf("«%s» o‘tkazib yuborildi: faqat PNG, JPG yoki WebP (SVG emas)", a.Label))
			continue
		}
		out = append(out, aiAssetData{Label: a.Label, Mime: mime, Data: data})
	}
	return out, warnings
}

func (s *Server) readAsset(ctx context.Context, a aiAsset) ([]byte, error) {
	src := strings.TrimSpace(a.URL)
	if a.Kind == "logo" {
		src = s.Cfg.WebInternalURL + "/icon.png"
	}
	if p := strings.TrimPrefix(src, s.Cfg.PublicBaseURL); strings.HasPrefix(p, "/uploads/") {
		rel := filepath.Clean(strings.TrimPrefix(p, "/uploads/"))
		if strings.HasPrefix(rel, "..") || filepath.IsAbs(rel) {
			return nil, errors.New("noto‘g‘ri yo‘l")
		}
		f, err := os.Open(filepath.Join(s.Cfg.UploadDir, rel))
		if err != nil {
			return nil, errors.New("fayl topilmadi")
		}
		defer f.Close()
		return io.ReadAll(io.LimitReader(f, 15<<20))
	}
	if !strings.HasPrefix(src, "http://") && !strings.HasPrefix(src, "https://") {
		return nil, errors.New("havola noto‘g‘ri")
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, src, nil)
	if err != nil {
		return nil, err
	}
	res, err := assetHTTP.Do(req)
	if err != nil {
		return nil, errors.New("yuklab bo‘lmadi")
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("HTTP %d", res.StatusCode)
	}
	return io.ReadAll(io.LimitReader(res.Body, 15<<20))
}

func (s *Server) aiList(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	limit, _ := strconv.Atoi(q.Get("limit"))
	if limit <= 0 || limit > 100 {
		limit = 20
	}
	page, _ := strconv.Atoi(q.Get("page"))
	if page < 1 {
		page = 1
	}
	where, args := []string{"true"}, []any{}
	add := func(cond string, v any) {
		args = append(args, v)
		where = append(where, fmt.Sprintf(cond, len(args)))
	}
	if v := q.Get("q"); v != "" {
		add("(prompt ILIKE $%d OR prompt_original ILIKE $%[1]d)", "%"+v+"%")
	}
	if v := q.Get("provider"); v != "" {
		add("provider = $%d", v)
	}
	if v := q.Get("status"); v != "" {
		add("status = $%d", v)
	}
	if v := q.Get("target"); v != "" {
		add("target = $%d", v)
	}
	cond := strings.Join(where, " AND ")
	var total int
	if err := s.DB.QueryRowContext(r.Context(), `SELECT count(*) FROM ai_generations WHERE `+cond, args...).Scan(&total); err != nil {
		httpx.Fail(w, r, err)
		return
	}
	rows, err := s.DB.QueryContext(r.Context(), `SELECT `+aiCols+` FROM ai_generations WHERE `+cond+
		fmt.Sprintf(` ORDER BY created_at DESC LIMIT %d OFFSET %d`, limit, (page-1)*limit), args...)
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	defer rows.Close()
	items := []aiGeneration{}
	for rows.Next() {
		g, err := scanGeneration(rows)
		if err != nil {
			httpx.Fail(w, r, err)
			return
		}
		items = append(items, g)
	}
	var month, errs int
	_ = s.DB.QueryRowContext(r.Context(), `SELECT count(*) FILTER (WHERE status<>'error' AND status<>'cancelled'), count(*) FILTER (WHERE status='error')
		FROM ai_generations WHERE created_at >= date_trunc('month', now())`).Scan(&month, &errs)
	httpx.JSON(w, http.StatusOK, map[string]any{"items": items, "total": total, "month": map[string]int{"total": month, "errors": errs}})
}

func (s *Server) aiGet(w http.ResponseWriter, r *http.Request) {
	id, err := idParam(r, "id")
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	g, err := s.loadGeneration(r.Context(), id)
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, g)
}

func (s *Server) aiCancel(w http.ResponseWriter, r *http.Request) {
	id, err := idParam(r, "id")
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	if !s.ai.stop(id) {
		// not running in this process (e.g. after a restart): close the row
		_, _ = s.DB.ExecContext(r.Context(), `UPDATE ai_generations SET status='cancelled', error='Bekor qilindi', updated_at=now() WHERE id=$1 AND status='running'`, id)
	}
	deadline := time.Now().Add(5 * time.Second)
	for {
		g, err := s.loadGeneration(r.Context(), id)
		if err != nil || g.Status != "running" || time.Now().After(deadline) {
			if err != nil {
				httpx.Fail(w, r, err)
				return
			}
			httpx.JSON(w, http.StatusOK, g)
			return
		}
		time.Sleep(100 * time.Millisecond)
	}
}

func (s *Server) aiMark(status string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id, err := idParam(r, "id")
		if err != nil {
			httpx.Fail(w, r, err)
			return
		}
		var in struct {
			Variant  *int   `json:"variant"`
			TargetID *int64 `json:"target_id"`
		}
		if r.ContentLength != 0 {
			if err := httpx.Decode(r, &in); err != nil {
				httpx.Fail(w, r, err)
				return
			}
		}
		g, err := s.loadGeneration(r.Context(), id)
		if err != nil {
			httpx.Fail(w, r, err)
			return
		}
		if g.Status == "running" || g.Status == "error" || g.Status == "cancelled" {
			httpx.Fail(w, r, httpx.NewError(http.StatusConflict, "not_ready", "Natija tayyor emas"))
			return
		}
		var count int
		var variants []json.RawMessage
		_ = json.Unmarshal(g.Variants, &variants)
		count = len(variants)
		if status == "applied" && (in.Variant == nil || *in.Variant < 0 || *in.Variant >= count) {
			httpx.Fail(w, r, httpx.Validation(map[string]any{"variant": "Variantni tanlang"}))
			return
		}
		_, err = s.DB.ExecContext(r.Context(), `UPDATE ai_generations SET status=$2, applied_variant=COALESCE($3, applied_variant), target_id=COALESCE($4, target_id), updated_at=now() WHERE id=$1`,
			id, status, in.Variant, in.TargetID)
		if err != nil {
			httpx.Fail(w, r, err)
			return
		}
		s.audit(r, status, "ai_generation", id, map[string]any{"variant": in.Variant})
		g, err = s.loadGeneration(r.Context(), id)
		if err != nil {
			httpx.Fail(w, r, err)
			return
		}
		httpx.JSON(w, http.StatusOK, g)
	}
}

// ResetStaleAIJobs closes generations that were running when the API stopped.
func (s *Server) ResetStaleAIJobs(ctx context.Context) {
	_, _ = s.DB.ExecContext(ctx, `UPDATE ai_generations SET status='error', error='Server qayta ishga tushdi — generatsiya to‘xtadi', updated_at=now() WHERE status='running'`)
}
