package api

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/lib/pq"

	"github.com/sanedidi/unitedmfl/backend/internal/httpx"
)

type kind int

const (
	kText kind = iota
	kInt
	kBool
	kTime
	kDate
	kTextArray
)

type field struct {
	kind     kind
	required bool
	nullable bool
	max      int      // max length for text
	enum     []string // allowed values
	pattern  *regexp.Regexp
}

// resource describes a table exposed through generic admin CRUD.
type resource struct {
	table   string
	fields  map[string]field
	order   string            // ORDER BY for list
	filters map[string]string // query param → column (equality)
	search  []string          // columns searched by ?q=
	touch   bool              // has updated_at
	entity  string            // audit entity name
}

var reSlug = regexp.MustCompile(`^[a-z0-9]+(?:-[a-z0-9]+)*$`)

func (s *Server) mountCRUD(r chi.Router, perm, path string, res *resource) {
	h := s.crud(res)
	r.Group(func(r chi.Router) {
		r.Use(s.can(perm))
		r.Get(path, h.list)
		r.Post(path, h.create)
		r.Get(path+"/{id}", h.get)
		r.Patch(path+"/{id}", h.patch)
		r.Delete(path+"/{id}", h.delete)
	})
}

type crudHandlers struct {
	s   *Server
	res *resource
}

func (s *Server) crud(res *resource) crudHandlers { return crudHandlers{s, res} }

func idParam(r *http.Request, name string) (int64, error) {
	id, err := strconv.ParseInt(chi.URLParam(r, name), 10, 64)
	if err != nil || id <= 0 {
		return 0, httpx.BadRequest("ID noto‘g‘ri")
	}
	return id, nil
}

func pageParams(r *http.Request) (limit, offset int) {
	limit, _ = strconv.Atoi(r.URL.Query().Get("limit"))
	page, _ := strconv.Atoi(r.URL.Query().Get("page"))
	if limit <= 0 || limit > 200 {
		limit = 50
	}
	if page < 1 {
		page = 1
	}
	return limit, (page - 1) * limit
}

// writeRaw writes a JSON document produced by Postgres.
func writeRaw(w http.ResponseWriter, status int, raw []byte) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_, _ = w.Write(raw)
}

func (h crudHandlers) list(w http.ResponseWriter, r *http.Request) {
	limit, offset := pageParams(r)
	var where []string
	var args []any
	q := r.URL.Query()
	for param, col := range h.res.filters {
		if v := q.Get(param); v != "" {
			args = append(args, v)
			where = append(where, fmt.Sprintf("%s::text = $%d", col, len(args)))
		}
	}
	if term := strings.TrimSpace(q.Get("q")); term != "" && len(h.res.search) > 0 {
		args = append(args, "%"+term+"%")
		var ors []string
		for _, c := range h.res.search {
			ors = append(ors, fmt.Sprintf("%s ILIKE $%d", c, len(args)))
		}
		where = append(where, "("+strings.Join(ors, " OR ")+")")
	}
	w2 := ""
	if len(where) > 0 {
		w2 = "WHERE " + strings.Join(where, " AND ")
	}
	args = append(args, limit, offset)
	query := fmt.Sprintf(`SELECT json_build_object(
		'items', coalesce((SELECT json_agg(t) FROM (SELECT * FROM %[1]s %[2]s ORDER BY %[3]s LIMIT $%[4]d OFFSET $%[5]d) t), '[]'),
		'total', (SELECT count(*) FROM %[1]s %[2]s))`, h.res.table, w2, h.res.order, len(args)-1, len(args))
	var raw []byte
	if err := h.s.DB.QueryRowContext(r.Context(), query, args...).Scan(&raw); err != nil {
		httpx.Fail(w, r, err)
		return
	}
	writeRaw(w, 200, raw)
}

func (h crudHandlers) get(w http.ResponseWriter, r *http.Request) {
	id, err := idParam(r, "id")
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	var raw []byte
	err = h.s.DB.QueryRowContext(r.Context(), fmt.Sprintf(`SELECT row_to_json(t) FROM %s t WHERE id=$1`, h.res.table), id).Scan(&raw)
	if errors.Is(err, sql.ErrNoRows) {
		httpx.Fail(w, r, httpx.ErrNotFound)
		return
	}
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	writeRaw(w, 200, raw)
}

// convert validates a JSON value for a field and converts it to a driver value.
func convert(name string, f field, v any) (any, error) {
	if v == nil {
		if f.nullable {
			return nil, nil
		}
		return nil, fmt.Errorf("%s bo‘sh bo‘lishi mumkin emas", name)
	}
	switch f.kind {
	case kText:
		s, ok := v.(string)
		if !ok {
			return nil, fmt.Errorf("%s matn bo‘lishi kerak", name)
		}
		s = strings.TrimSpace(s)
		if f.required && s == "" {
			return nil, fmt.Errorf("%s majburiy", name)
		}
		if f.max > 0 && len([]rune(s)) > f.max {
			return nil, fmt.Errorf("%s juda uzun (max %d)", name, f.max)
		}
		if len(f.enum) > 0 && !contains(f.enum, s) {
			return nil, fmt.Errorf("%s qiymati noto‘g‘ri (%s)", name, strings.Join(f.enum, ", "))
		}
		if f.pattern != nil && s != "" && !f.pattern.MatchString(s) {
			return nil, fmt.Errorf("%s formati noto‘g‘ri", name)
		}
		return s, nil
	case kInt:
		n, ok := v.(json.Number)
		if !ok {
			return nil, fmt.Errorf("%s son bo‘lishi kerak", name)
		}
		i, err := n.Int64()
		if err != nil {
			return nil, fmt.Errorf("%s butun son bo‘lishi kerak", name)
		}
		return i, nil
	case kBool:
		b, ok := v.(bool)
		if !ok {
			return nil, fmt.Errorf("%s true/false bo‘lishi kerak", name)
		}
		return b, nil
	case kTime:
		s, ok := v.(string)
		if !ok {
			return nil, fmt.Errorf("%s sana-vaqt (RFC3339) bo‘lishi kerak", name)
		}
		t, err := time.Parse(time.RFC3339, s)
		if err != nil {
			return nil, fmt.Errorf("%s sana-vaqt formati noto‘g‘ri (RFC3339)", name)
		}
		return t, nil
	case kDate:
		s, ok := v.(string)
		if !ok {
			return nil, fmt.Errorf("%s sana (YYYY-MM-DD) bo‘lishi kerak", name)
		}
		if _, err := time.Parse("2006-01-02", s); err != nil {
			return nil, fmt.Errorf("%s sana formati noto‘g‘ri (YYYY-MM-DD)", name)
		}
		return s, nil
	case kTextArray:
		arr, ok := v.([]any)
		if !ok {
			return nil, fmt.Errorf("%s ro‘yxat bo‘lishi kerak", name)
		}
		out := make([]string, 0, len(arr))
		for _, x := range arr {
			s, ok := x.(string)
			if !ok {
				return nil, fmt.Errorf("%s faqat matnlardan iborat bo‘lishi kerak", name)
			}
			out = append(out, strings.TrimSpace(s))
		}
		return pq.Array(out), nil
	}
	return nil, fmt.Errorf("unknown field kind")
}

func contains(list []string, s string) bool {
	for _, x := range list {
		if x == s {
			return true
		}
	}
	return false
}

func decodeMap(r *http.Request) (map[string]any, error) {
	dec := json.NewDecoder(http.MaxBytesReader(nil, r.Body, 1<<20))
	dec.UseNumber()
	var m map[string]any
	if err := dec.Decode(&m); err != nil {
		return nil, httpx.BadRequest("JSON noto‘g‘ri")
	}
	return m, nil
}

func (h crudHandlers) build(body map[string]any, creating bool) ([]string, []any, error) {
	fieldErrs := map[string]any{}
	var cols []string
	var vals []any
	for k, v := range body {
		f, ok := h.res.fields[k]
		if !ok {
			fieldErrs[k] = "noma’lum maydon"
			continue
		}
		cv, err := convert(k, f, v)
		if err != nil {
			fieldErrs[k] = err.Error()
			continue
		}
		cols = append(cols, k)
		vals = append(vals, cv)
	}
	if creating {
		for k, f := range h.res.fields {
			if _, ok := body[k]; f.required && !ok {
				fieldErrs[k] = "majburiy maydon"
			}
		}
	}
	if len(fieldErrs) > 0 {
		return nil, nil, httpx.Validation(fieldErrs)
	}
	if len(cols) == 0 {
		return nil, nil, httpx.BadRequest("O‘zgartirish uchun maydon yo‘q")
	}
	return cols, vals, nil
}

func dbError(err error) error {
	var pqErr *pq.Error
	if errors.As(err, &pqErr) {
		switch pqErr.Code {
		case "23505":
			return httpx.NewError(http.StatusConflict, "duplicate", "Bunday qiymat allaqachon mavjud: "+pqErr.Constraint)
		case "23503":
			return httpx.NewError(http.StatusConflict, "reference", "Bog‘liq yozuv topilmadi yoki ishlatilmoqda")
		case "23514":
			return httpx.BadRequest("Qiymat ruxsat etilmagan: " + pqErr.Constraint)
		}
	}
	return err
}

func (h crudHandlers) create(w http.ResponseWriter, r *http.Request) {
	body, err := decodeMap(r)
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	cols, vals, err := h.build(body, true)
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	ph := make([]string, len(cols))
	for i := range cols {
		ph[i] = fmt.Sprintf("$%d", i+1)
	}
	var raw []byte
	var id int64
	q := fmt.Sprintf(`INSERT INTO %[1]s (%[2]s) VALUES (%[3]s) RETURNING id, row_to_json(%[1]s.*)`, h.res.table, strings.Join(cols, ","), strings.Join(ph, ","))
	if err := h.s.DB.QueryRowContext(r.Context(), q, vals...).Scan(&id, &raw); err != nil {
		httpx.Fail(w, r, dbError(err))
		return
	}
	h.s.audit(r, "create", h.res.entity, id, body)
	writeRaw(w, http.StatusCreated, raw)
}

func (h crudHandlers) patch(w http.ResponseWriter, r *http.Request) {
	id, err := idParam(r, "id")
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	body, err := decodeMap(r)
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	cols, vals, err := h.build(body, false)
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	sets := make([]string, len(cols))
	for i, c := range cols {
		sets[i] = fmt.Sprintf("%s=$%d", c, i+1)
	}
	if h.res.touch {
		sets = append(sets, "updated_at=now()")
	}
	vals = append(vals, id)
	var raw []byte
	q := fmt.Sprintf(`UPDATE %[1]s SET %[2]s WHERE id=$%[3]d RETURNING row_to_json(%[1]s.*)`, h.res.table, strings.Join(sets, ","), len(vals))
	err = h.s.DB.QueryRowContext(r.Context(), q, vals...).Scan(&raw)
	if errors.Is(err, sql.ErrNoRows) {
		httpx.Fail(w, r, httpx.ErrNotFound)
		return
	}
	if err != nil {
		httpx.Fail(w, r, dbError(err))
		return
	}
	h.s.audit(r, "update", h.res.entity, id, body)
	if h.res.table == "matches" {
		h.s.broadcastMatch(r.Context(), id)
	}
	writeRaw(w, 200, raw)
}

func (h crudHandlers) delete(w http.ResponseWriter, r *http.Request) {
	id, err := idParam(r, "id")
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	res, err := h.s.DB.ExecContext(r.Context(), fmt.Sprintf(`DELETE FROM %s WHERE id=$1`, h.res.table), id)
	if err != nil {
		httpx.Fail(w, r, dbError(err))
		return
	}
	if n, _ := res.RowsAffected(); n == 0 {
		httpx.Fail(w, r, httpx.ErrNotFound)
		return
	}
	h.s.audit(r, "delete", h.res.entity, id, nil)
	w.WriteHeader(http.StatusNoContent)
}

// ---------- resource definitions ----------

var (
	txt      = func(max int) field { return field{kind: kText, max: max} }
	reqTxt   = func(max int) field { return field{kind: kText, max: max, required: true} }
	enum     = func(v ...string) field { return field{kind: kText, enum: v} }
	optInt   = field{kind: kInt, nullable: true}
	reqInt   = field{kind: kInt, required: true}
	boolean  = field{kind: kBool}
	optTime  = field{kind: kTime, nullable: true}
	optDate  = field{kind: kDate, nullable: true}
	textList = field{kind: kTextArray}
	slugF    = field{kind: kText, required: true, max: 120, pattern: reSlug}
)

var teamsRes = &resource{table: "teams", entity: "team", touch: true, order: "group_label, name",
	search: []string{"name", "slug"}, filters: map[string]string{"group": "group_label", "active": "is_active"},
	fields: map[string]field{"slug": slugF, "name": reqTxt(80), "short_name": txt(8), "group_label": txt(4), "group_is_provisional": boolean,
		"crest_url": txt(500), "colors": textList, "leader": txt(120), "instagram": txt(200), "telegram": txt(200), "is_active": boolean}}

var playersRes = &resource{table: "players", entity: "player", touch: true, order: "team_id, number NULLS LAST, full_name",
	search: []string{"full_name"}, filters: map[string]string{"team_id": "team_id", "position": "position", "active": "is_active"},
	fields: map[string]field{"team_id": optInt, "full_name": reqTxt(120), "number": optInt, "position": enum("", "GK", "DF", "MF", "FW"),
		"photo_url": txt(500), "instagram": txt(200), "is_active": boolean}}

var seasonsRes = &resource{table: "seasons", entity: "season", order: "id DESC",
	fields: map[string]field{"name": reqTxt(80), "slug": slugF, "is_active": boolean, "teams_planned": optInt, "matches_planned": optInt}}

var stagesRes = &resource{table: "stages", entity: "stage", order: "season_id, ord", filters: map[string]string{"season_id": "season_id"},
	fields: map[string]field{"season_id": reqInt, "name": reqTxt(80), "kind": {kind: kText, required: true, enum: []string{"group", "round_of_16", "quarter", "semi", "final", "other"}},
		"ord": {kind: kInt}, "status": enum("scheduled", "active", "finished"), "note": txt(500)}}

var adjustmentsRes = &resource{table: "standing_adjustments", entity: "standing_adjustment", order: "created_at DESC",
	filters: map[string]string{"season_id": "season_id"},
	fields:  map[string]field{"season_id": reqInt, "team_id": reqInt, "points": reqInt, "reason": reqTxt(300)}}

var matchesRes = &resource{table: "matches", entity: "match", touch: true, order: "kickoff_at NULLS LAST",
	fields: map[string]field{"season_id": reqInt, "stage_id": optInt, "round": txt(60), "home_team_id": optInt, "away_team_id": optInt,
		"kickoff_at": optTime, "venue": txt(200), "ticket_url": txt(500),
		"status":     enum("scheduled", "live", "halftime", "finished", "postponed", "cancelled"),
		"home_score": optInt, "away_score": optInt, "home_ht": optInt, "away_ht": optInt, "home_et": optInt, "away_et": optInt,
		"home_pen": optInt, "away_pen": optInt, "attendance": optInt, "added_time_1h": optInt, "added_time_2h": optInt,
		"banner_url": txt(500), "video_url": txt(500), "notes": txt(2000), "published": boolean, "show_in_hero": boolean}}

var newsRes = &resource{table: "news", entity: "news", touch: true, order: "coalesce(published_at, created_at) DESC",
	search: []string{"title"}, filters: map[string]string{"status": "status", "category": "category"},
	fields: map[string]field{"slug": slugF, "title": reqTxt(200), "category": txt(40), "excerpt": txt(500), "body": txt(100000),
		"cover_url": txt(500), "status": enum("draft", "published", "scheduled"), "published_at": optTime, "match_id": optInt,
		"tags": textList, "seo_description": txt(160), "on_home": boolean}}

var bannersRes = &resource{table: "banners", entity: "banner", touch: true, order: "ord, id",
	fields: map[string]field{"title": reqTxt(120), "badge": txt(30), "badge_type": enum("accent", "stage", "category", "live", "demo"),
		"event_date": optDate, "event_time": txt(10), "venue": txt(160), "cta_label": txt(40), "cta_url": txt(500),
		"image_desktop": txt(500), "image_mobile": txt(500), "show_from": optTime, "show_until": optTime,
		"is_active": boolean, "status": enum("draft", "published"), "ord": {kind: kInt}, "note": txt(500)}}

var videosRes = &resource{table: "videos", entity: "video", order: "coalesce(published_at, created_at) DESC",
	filters: map[string]string{"status": "status", "match_id": "match_id"},
	fields: map[string]field{"title": reqTxt(200), "url": reqTxt(500), "youtube_id": txt(20), "kind": enum("highlight", "interview", "announcement", "full"),
		"match_id": optInt, "duration_sec": optInt, "thumbnail_url": txt(500), "status": enum("draft", "published"), "published_at": optTime}}

var productsRes = &resource{table: "products", entity: "product", touch: true, order: "ord, id",
	search: []string{"name"}, filters: map[string]string{"status": "status", "category": "category"},
	fields: map[string]field{"slug": slugF, "name": reqTxt(120), "category": txt(40), "price_uzs": reqInt, "sale_price_uzs": optInt,
		"description": txt(5000), "images": textList, "external_url": txt(500), "visible": boolean, "featured": boolean,
		"status": enum("active", "in_review", "out_of_stock", "hidden"), "ord": {kind: kInt}}}

var variantsRes = &resource{table: "product_variants", entity: "product_variant", order: "product_id, id",
	filters: map[string]string{"product_id": "product_id"},
	fields:  map[string]field{"product_id": reqInt, "size": reqTxt(20), "sku": txt(60), "stock": optInt, "available": boolean}}

var requestsRes = &resource{table: "contact_requests", entity: "contact_request", touch: true, order: "created_at DESC",
	search: []string{"name", "phone"}, filters: map[string]string{"status": "status", "topic": "topic"},
	fields: map[string]field{"status": enum("new", "in_progress", "closed"), "assignee_id": optInt, "internal_note": txt(2000)}}
