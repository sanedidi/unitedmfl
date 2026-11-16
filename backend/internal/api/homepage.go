package api

import (
	"bytes"
	"crypto/hmac"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/sanedidi/unitedmfl/backend/internal/auth"
	"github.com/sanedidi/unitedmfl/backend/internal/httpx"
)

// Homepage layout builder: the homepage is a list of rows on a 12-column grid,
// each row holds 1–4 blocks (modules). The admin edits one shared draft and
// publishes it as a numbered version; the site renders the newest version
// whose publish_at has passed. Block visibility per device and per time
// (date range, weekdays, match days) is stored here and evaluated by the site
// on every request.

// ---------- schema ----------

type hpLayout struct {
	V    int     `json:"v"`
	Rows []hpRow `json:"rows"`
}

type hpRow struct {
	ID     string    `json:"id"`
	Gap    int       `json:"gap,omitempty"`   // px between blocks: 16, 24, 40, 64
	BG     string    `json:"bg,omitempty"`    // "", "subtle", "dark"
	Pad    string    `json:"pad,omitempty"`   // "", "S", "M", "L"
	Equal  bool      `json:"equal,omitempty"` // stretch blocks to the tallest one
	Hidden bool      `json:"hidden,omitempty"`
	Blocks []hpBlock `json:"blocks"`
}

type hpBlock struct {
	ID          string          `json:"id"`
	Type        string          `json:"type"`
	Variant     string          `json:"variant"`
	Span        int             `json:"span"`
	Title       string          `json:"title,omitempty"`
	HideTitle   bool            `json:"hideTitle,omitempty"`
	LinkLabel   string          `json:"linkLabel,omitempty"`
	LinkHref    string          `json:"linkHref,omitempty"`
	BG          string          `json:"bg,omitempty"` // "", "subtle", "dark"
	Props       json.RawMessage `json:"props,omitempty"`
	Devices     *hpDevices      `json:"devices,omitempty"` // nil: every device
	MobileOrder int             `json:"mobileOrder,omitempty"`
	Schedule    *hpSchedule     `json:"schedule,omitempty"`
	Alt         *hpBlock        `json:"alt,omitempty"` // shown in place while the schedule is off
	Hidden      bool            `json:"hidden,omitempty"`
	Locked      bool            `json:"locked,omitempty"`
}

type hpDevices struct {
	Desktop bool `json:"desktop"`
	Tablet  bool `json:"tablet"`
	Mobile  bool `json:"mobile"`
}

type hpSchedule struct {
	Mode   string `json:"mode"`            // always | range | weekly | match
	Start  string `json:"start,omitempty"` // range, Tashkent local time "2006-01-02T15:04"
	End    string `json:"end,omitempty"`
	Days   []int  `json:"days,omitempty"` // weekly: 0 = Monday … 6 = Sunday
	From   string `json:"from,omitempty"` // weekly "15:04"
	To     string `json:"to,omitempty"`
	Before int    `json:"before,omitempty"` // match: minutes before kick-off
	After  int    `json:"after,omitempty"`  // match: minutes after the final whistle
	OnEnd  string `json:"onEnd,omitempty"`  // hide | replace (with Alt)
}

var hpTypes = map[string]bool{
	"intro": true, "hero": true, "fmatch": true, "live": true, "upcoming": true, "results": true,
	"standings": true, "scorers": true, "stats": true, "news": true, "fnews": true, "video": true,
	"gallery": true, "social": true, "player": true, "team": true, "partners": true, "banner": true,
	"custom": true, "shop": true,
}

var (
	hpVariants = map[string]bool{"compact": true, "standard": true, "wide": true, "featured": true}
	hpSpans    = map[int]bool{3: true, 4: true, 6: true, 8: true, 9: true, 12: true}
	hpGaps     = map[int]bool{0: true, 16: true, 24: true, 40: true, 64: true}
	hpBGs      = map[string]bool{"": true, "subtle": true, "dark": true}
	hpPads     = map[string]bool{"": true, "S": true, "M": true, "L": true}
	reHpID     = regexp.MustCompile(`^[A-Za-z0-9_-]{1,40}$`)
	reHpClock  = regexp.MustCompile(`^([01]\d|2[0-3]):[0-5]\d$`)
)

const (
	hpMaxRows   = 40
	hpMaxBytes  = 256 << 10
	hpLocalTime = "2006-01-02T15:04"
)

// parseHpLayout decodes and validates a layout. Unknown fields are rejected so
// a mismatch between the admin and the API shows up instead of losing data.
func parseHpLayout(raw []byte) (*hpLayout, error) {
	if len(raw) > hpMaxBytes {
		return nil, httpx.BadRequest("Sahifa konfiguratsiyasi juda katta")
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	var l hpLayout
	if err := dec.Decode(&l); err != nil {
		return nil, httpx.BadRequest("Konfiguratsiya o‘qilmadi: " + err.Error())
	}
	if err := l.validate(); err != nil {
		return nil, err
	}
	return &l, nil
}

func (l *hpLayout) validate() error {
	bad := func(path, msg string) error { return httpx.Validation(map[string]any{path: msg}) }
	if l.V != 1 {
		return bad("v", "Noma’lum versiya")
	}
	if len(l.Rows) > hpMaxRows {
		return bad("rows", fmt.Sprintf("Ko‘pi bilan %d ta qator", hpMaxRows))
	}
	ids := map[string]bool{}
	useID := func(path, id string) error {
		if !reHpID.MatchString(id) {
			return bad(path+".id", "Noto‘g‘ri identifikator")
		}
		if ids[id] {
			return bad(path+".id", "Identifikator takrorlangan: "+id)
		}
		ids[id] = true
		return nil
	}
	for i, row := range l.Rows {
		rp := fmt.Sprintf("rows[%d]", i)
		if err := useID(rp, row.ID); err != nil {
			return err
		}
		if len(row.Blocks) == 0 || len(row.Blocks) > 4 {
			return bad(rp+".blocks", "Qatorda 1 tadan 4 tagacha blok bo‘ladi")
		}
		if !hpGaps[row.Gap] || !hpBGs[row.BG] || !hpPads[row.Pad] {
			return bad(rp, "Qator sozlamalari noto‘g‘ri")
		}
		total := 0
		for j := range row.Blocks {
			b := &row.Blocks[j]
			bp := fmt.Sprintf("%s.blocks[%d]", rp, j)
			if err := useID(bp, b.ID); err != nil {
				return err
			}
			if err := b.validate(bp, false); err != nil {
				return err
			}
			total += b.Span
			if b.Alt != nil {
				if err := useID(bp+".alt", b.Alt.ID); err != nil {
					return err
				}
				if err := b.Alt.validate(bp+".alt", true); err != nil {
					return err
				}
			}
		}
		if total > 12 {
			return bad(rp+".blocks", "Qatordagi bloklar kengligi 12 ustundan oshmasin")
		}
	}
	return nil
}

func (b *hpBlock) validate(path string, alt bool) error {
	bad := func(field, msg string) error { return httpx.Validation(map[string]any{path + "." + field: msg}) }
	if !hpTypes[b.Type] {
		return bad("type", "Noma’lum modul: "+b.Type)
	}
	if !hpVariants[b.Variant] {
		return bad("variant", "Noto‘g‘ri variant")
	}
	if alt {
		b.Span = 0 // takes the place (and width) of the block it replaces
	} else if !hpSpans[b.Span] {
		return bad("span", "Kenglik 3, 4, 6, 8, 9 yoki 12 ustun bo‘ladi")
	}
	if b.Type == "hero" && !alt && b.Span != 12 {
		return bad("span", "Hero faqat to‘liq kenglikda (12 ustun)")
	}
	if !hpBGs[b.BG] {
		return bad("bg", "Noto‘g‘ri fon")
	}
	if len([]rune(b.Title)) > 120 || len([]rune(b.LinkLabel)) > 40 || len(b.LinkHref) > 500 {
		return bad("title", "Matn juda uzun")
	}
	if b.LinkHref != "" && !safeHref(b.LinkHref) {
		return bad("linkHref", "Havola / yoki https:// bilan boshlansin")
	}
	if b.MobileOrder < 0 || b.MobileOrder > 999 {
		return bad("mobileOrder", "Noto‘g‘ri tartib")
	}
	if len(b.Props) > 0 && !bytes.Equal(bytes.TrimSpace(b.Props), []byte("null")) {
		var p map[string]any
		if err := json.Unmarshal(b.Props, &p); err != nil {
			return bad("props", "Sozlamalar obyekt bo‘lishi kerak")
		}
		if err := checkProps(p, 0); err != nil {
			return bad("props", err.Error())
		}
	}
	if alt {
		if b.Schedule != nil || b.Alt != nil {
			return bad("alt", "O‘rnini bosuvchi blokning o‘z jadvali bo‘lmaydi")
		}
		return nil
	}
	if b.Schedule != nil {
		if err := b.Schedule.validate(); err != nil {
			return bad("schedule", err.Error())
		}
		if b.Schedule.OnEnd == "replace" && b.Alt == nil {
			return bad("schedule.onEnd", "O‘rnini bosuvchi blokni tanlang")
		}
	}
	if b.Alt != nil && (b.Schedule == nil || b.Schedule.Mode == "always") {
		b.Alt = nil // nothing to replace while the block is always on
	}
	return nil
}

func (s *hpSchedule) validate() error {
	switch s.OnEnd {
	case "", "hide", "replace":
	default:
		return errors.New("Noto‘g‘ri amal")
	}
	switch s.Mode {
	case "always":
	case "range":
		var start, end time.Time
		var err error
		if s.Start == "" && s.End == "" {
			return errors.New("Boshlanish yoki tugash vaqtini kiriting")
		}
		if s.Start != "" {
			if start, err = time.Parse(hpLocalTime, s.Start); err != nil {
				return errors.New("Boshlanish vaqti noto‘g‘ri")
			}
		}
		if s.End != "" {
			if end, err = time.Parse(hpLocalTime, s.End); err != nil {
				return errors.New("Tugash vaqti noto‘g‘ri")
			}
		}
		if s.Start != "" && s.End != "" && !end.After(start) {
			return errors.New("Tugash vaqti boshlanishdan keyin bo‘lsin")
		}
	case "weekly":
		if len(s.Days) == 0 || len(s.Days) > 7 {
			return errors.New("Kamida bitta kunni tanlang")
		}
		for _, d := range s.Days {
			if d < 0 || d > 6 {
				return errors.New("Noto‘g‘ri kun")
			}
		}
		if !reHpClock.MatchString(s.From) || !reHpClock.MatchString(s.To) || s.From == s.To {
			return errors.New("Vaqt oralig‘ini kiriting (SS:DD)")
		}
	case "match":
		if s.Before < 0 || s.Before > 2880 || s.After < 0 || s.After > 2880 {
			return errors.New("Noto‘g‘ri daqiqalar")
		}
	default:
		return errors.New("Noma’lum rejim")
	}
	return nil
}

// checkProps keeps module settings small and flat: strings, numbers, booleans,
// and lists/objects of those two levels deep.
func checkProps(v any, depth int) error {
	if depth > 3 {
		return errors.New("Sozlamalar juda chuqur")
	}
	switch x := v.(type) {
	case nil, bool, float64:
		return nil
	case string:
		if len([]rune(x)) > 4000 {
			return errors.New("Matn juda uzun")
		}
		return nil
	case []any:
		if len(x) > 60 {
			return errors.New("Ro‘yxat juda uzun")
		}
		for _, e := range x {
			if err := checkProps(e, depth+1); err != nil {
				return err
			}
		}
		return nil
	case map[string]any:
		if len(x) > 40 {
			return errors.New("Sozlamalar juda ko‘p")
		}
		for _, e := range x {
			if err := checkProps(e, depth+1); err != nil {
				return err
			}
		}
		return nil
	}
	return errors.New("Noto‘g‘ri qiymat")
}

func safeHref(h string) bool {
	return (strings.HasPrefix(h, "/") && !strings.HasPrefix(h, "//")) || strings.HasPrefix(h, "https://") || strings.HasPrefix(h, "http://") || strings.HasPrefix(h, "#")
}

// defaultHpLayout mirrors the homepage as it was before the builder, so the
// site looks the same until the first version is published.
func defaultHpLayout() []byte {
	props := func(m map[string]any) json.RawMessage { b, _ := json.Marshal(m); return b }
	l := hpLayout{V: 1, Rows: []hpRow{
		{ID: "r_hero", Blocks: []hpBlock{{ID: "b_hero", Type: "hero", Variant: "featured", Span: 12}}},
		{ID: "r_intro", Blocks: []hpBlock{{ID: "b_intro", Type: "intro", Variant: "featured", Span: 12}}},
		{ID: "r_matches", Blocks: []hpBlock{{ID: "b_matches", Type: "upcoming", Variant: "featured", Span: 12, Props: props(map[string]any{"count": 4, "withLive": true, "withResults": true})}}},
		{ID: "r_table", BG: "subtle", Blocks: []hpBlock{
			{ID: "b_table", Type: "standings", Variant: "wide", Span: 8, Props: props(map[string]any{"group": ""})},
			{ID: "b_stats", Type: "stats", Variant: "compact", Span: 4, Props: props(map[string]any{"scorers": 5})},
		}},
		{ID: "r_news", Blocks: []hpBlock{{ID: "b_news", Type: "news", Variant: "featured", Span: 12, Props: props(map[string]any{"count": 5})}}},
		{ID: "r_video", Blocks: []hpBlock{{ID: "b_video", Type: "video", Variant: "featured", Span: 12, Props: props(map[string]any{"count": 3})}}},
		{ID: "r_shop", BG: "subtle", Blocks: []hpBlock{{ID: "b_shop", Type: "shop", Variant: "featured", Span: 12, Props: props(map[string]any{"count": 4})}}},
		{ID: "r_partners", Blocks: []hpBlock{{ID: "b_partners", Type: "partners", Variant: "featured", Span: 12, Title: "Final homiylari", LinkLabel: "Hamkor bo‘lish", LinkHref: "/biz-haqimizda#aloqa",
			Props: props(map[string]any{"items": []map[string]any{{"name": "realme"}, {"name": "Click"}, {"name": "Wildberries"}}, "cta": true})}}},
	}}
	b, _ := json.Marshal(l)
	return b
}

// ---------- routes ----------

func (s *Server) mountHomepage(r chi.Router) {
	r.Group(func(r chi.Router) {
		r.Use(s.can(auth.PermHomepage))
		r.Get("/homepage", s.hpState)
		r.Put("/homepage/draft", s.hpSaveDraft)
		r.Delete("/homepage/draft", s.hpDiscardDraft)
		r.Post("/homepage/publish", s.hpPublish)
		r.Get("/homepage/versions", s.hpVersions)
		r.Get("/homepage/versions/{version}", s.hpVersion)
		r.Post("/homepage/versions/{version}/restore", s.hpRestore)
		r.Delete("/homepage/versions/{version}", s.hpCancelScheduled)
		r.Post("/homepage/preview", s.hpPreviewToken)
	})
}

// publishedHp returns the live version (0 and the default layout if none).
func (s *Server) publishedHp(r *http.Request) (int, []byte, error) {
	var v int
	var cfg []byte
	err := s.DB.QueryRowContext(r.Context(), `SELECT version, config FROM homepage_versions WHERE publish_at <= now() ORDER BY version DESC LIMIT 1`).Scan(&v, &cfg)
	if errors.Is(err, sql.ErrNoRows) {
		return 0, defaultHpLayout(), nil
	}
	return v, cfg, err
}

func (s *Server) publicHomepage(w http.ResponseWriter, r *http.Request) {
	v, cfg, err := s.publishedHp(r)
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	httpx.JSON(w, 200, map[string]any{"version": v, "config": rawJSON(cfg)})
}

type hpDraft struct {
	Config      rawJSON   `json:"config"`
	BaseVersion *int      `json:"base_version"`
	UpdatedAt   time.Time `json:"updated_at"`
	UpdatedBy   string    `json:"updated_by"`
	Exists      bool      `json:"exists"`
}

func (s *Server) loadDraft(r *http.Request) (hpDraft, error) {
	var d hpDraft
	var cfg []byte
	err := s.DB.QueryRowContext(r.Context(), `SELECT d.config, d.base_version, d.updated_at, coalesce(u.name, '')
		FROM homepage_draft d LEFT JOIN users u ON u.id = d.updated_by WHERE d.id = 1`).Scan(&cfg, &d.BaseVersion, &d.UpdatedAt, &d.UpdatedBy)
	if errors.Is(err, sql.ErrNoRows) {
		v, pub, err := s.publishedHp(r)
		if err != nil {
			return d, err
		}
		d.Config = pub
		if v > 0 {
			d.BaseVersion = &v
		}
		return d, nil
	}
	d.Config, d.Exists = cfg, true
	return d, err
}

func (s *Server) hpState(w http.ResponseWriter, r *http.Request) {
	d, err := s.loadDraft(r)
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	v, pub, err := s.publishedHp(r)
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	// jsonb comparison ignores key order and whitespace
	var dirty bool
	if err := s.DB.QueryRowContext(r.Context(), `SELECT $1::jsonb <> $2::jsonb`, []byte(d.Config), pub).Scan(&dirty); err != nil {
		httpx.Fail(w, r, err)
		return
	}
	out := map[string]any{"draft": d, "dirty": dirty, "published": nil, "published_config": rawJSON(pub)}
	if v > 0 {
		var at time.Time
		var by string
		_ = s.DB.QueryRowContext(r.Context(), `SELECT h.publish_at, coalesce(u.name,'') FROM homepage_versions h LEFT JOIN users u ON u.id=h.created_by WHERE h.version=$1`, v).Scan(&at, &by)
		out["published"] = map[string]any{"version": v, "publish_at": at, "by": by}
	}
	raw, err := s.queryJSON(r.Context(), `SELECT coalesce(json_agg(x ORDER BY x.publish_at), '[]') FROM (
		SELECT version, publish_at, summary FROM homepage_versions WHERE publish_at > now()) x`)
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	out["scheduled"] = rawJSON(raw)
	httpx.JSON(w, 200, out)
}

func (s *Server) hpSaveDraft(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Config    json.RawMessage `json:"config"`
		UpdatedAt *time.Time      `json:"updated_at"` // the draft the editor started from; nil = overwrite
	}
	r.Body = http.MaxBytesReader(w, r.Body, hpMaxBytes+4096)
	if err := httpx.Decode(r, &in); err != nil {
		httpx.Fail(w, r, err)
		return
	}
	l, err := parseHpLayout(in.Config)
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	cfg, _ := json.Marshal(l)
	uid := claimsFrom(r.Context()).UserID
	tx, err := s.DB.BeginTx(r.Context(), nil)
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	defer tx.Rollback()
	var cur time.Time
	err = tx.QueryRowContext(r.Context(), `SELECT updated_at FROM homepage_draft WHERE id=1 FOR UPDATE`).Scan(&cur)
	switch {
	case errors.Is(err, sql.ErrNoRows):
		v, _, perr := s.publishedHp(r)
		if perr != nil {
			httpx.Fail(w, r, perr)
			return
		}
		var base *int
		if v > 0 {
			base = &v
		}
		if _, err := tx.ExecContext(r.Context(), `INSERT INTO homepage_draft (id, config, base_version, updated_by) VALUES (1, $1, $2, $3)`, cfg, base, uid); err != nil {
			httpx.Fail(w, r, err)
			return
		}
	case err != nil:
		httpx.Fail(w, r, err)
		return
	default:
		if in.UpdatedAt != nil && !in.UpdatedAt.Equal(cur) {
			var by string
			_ = tx.QueryRowContext(r.Context(), `SELECT coalesce(u.name,'') FROM homepage_draft d LEFT JOIN users u ON u.id=d.updated_by WHERE d.id=1`).Scan(&by)
			httpx.JSON(w, http.StatusConflict, map[string]any{"error": map[string]any{"code": "conflict",
				"message": "Qoralamani boshqa foydalanuvchi o‘zgartirdi" + nameSuffix(by) + ". Sahifani yangilang."}})
			return
		}
		if _, err := tx.ExecContext(r.Context(), `UPDATE homepage_draft SET config=$1, updated_by=$2, updated_at=now() WHERE id=1`, cfg, uid); err != nil {
			httpx.Fail(w, r, err)
			return
		}
	}
	var at time.Time
	if err := tx.QueryRowContext(r.Context(), `SELECT updated_at FROM homepage_draft WHERE id=1`).Scan(&at); err != nil {
		httpx.Fail(w, r, err)
		return
	}
	if err := tx.Commit(); err != nil {
		httpx.Fail(w, r, err)
		return
	}
	// draft saves are not audited: they happen every few seconds while editing
	httpx.JSON(w, 200, map[string]any{"updated_at": at, "config": rawJSON(cfg)})
}

func nameSuffix(n string) string {
	if n == "" {
		return ""
	}
	return " (" + n + ")"
}

func (s *Server) hpDiscardDraft(w http.ResponseWriter, r *http.Request) {
	if _, err := s.DB.ExecContext(r.Context(), `DELETE FROM homepage_draft WHERE id=1`); err != nil {
		httpx.Fail(w, r, err)
		return
	}
	s.hpState(w, r)
}

func (s *Server) hpPublish(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Summary   string          `json:"summary"`
		Changes   json.RawMessage `json:"changes"`
		PublishAt *time.Time      `json:"publish_at"`
		UpdatedAt *time.Time      `json:"updated_at"`
	}
	if err := httpx.Decode(r, &in); err != nil {
		httpx.Fail(w, r, err)
		return
	}
	if len([]rune(in.Summary)) > 300 {
		httpx.Fail(w, r, httpx.Validation(map[string]any{"summary": "Juda uzun"}))
		return
	}
	changes := []byte("[]")
	if len(in.Changes) > 0 {
		var list []string
		if err := json.Unmarshal(in.Changes, &list); err != nil || len(list) > 100 {
			httpx.Fail(w, r, httpx.Validation(map[string]any{"changes": "Noto‘g‘ri ro‘yxat"}))
			return
		}
		changes, _ = json.Marshal(list)
	}
	at := time.Now()
	if in.PublishAt != nil && in.PublishAt.After(at) {
		if in.PublishAt.After(at.AddDate(1, 0, 0)) {
			httpx.Fail(w, r, httpx.Validation(map[string]any{"publish_at": "Bir yildan uzoq emas"}))
			return
		}
		at = *in.PublishAt
	}
	d, err := s.loadDraft(r)
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	if in.UpdatedAt != nil && d.Exists && !in.UpdatedAt.Equal(d.UpdatedAt) {
		httpx.JSON(w, http.StatusConflict, map[string]any{"error": map[string]any{"code": "conflict", "message": "Qoralama o‘zgargan" + nameSuffix(d.UpdatedBy) + ". Sahifani yangilang."}})
		return
	}
	l, err := parseHpLayout(d.Config)
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	cfg, _ := json.Marshal(l)
	tx, err := s.DB.BeginTx(r.Context(), nil)
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	defer tx.Rollback()
	if _, err := tx.ExecContext(r.Context(), `LOCK TABLE homepage_versions IN EXCLUSIVE MODE`); err != nil {
		httpx.Fail(w, r, err)
		return
	}
	var v int
	err = tx.QueryRowContext(r.Context(), `INSERT INTO homepage_versions (version, config, summary, changes, created_by, publish_at)
		VALUES ((SELECT coalesce(max(version), 0) + 1 FROM homepage_versions), $1, $2, $3, $4, $5) RETURNING version`,
		cfg, strings.TrimSpace(in.Summary), changes, claimsFrom(r.Context()).UserID, at).Scan(&v)
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	// the draft now matches what was published; keep it, pointing at the new version
	if _, err := tx.ExecContext(r.Context(), `INSERT INTO homepage_draft (id, config, base_version, updated_by) VALUES (1, $1, $2, $3)
		ON CONFLICT (id) DO UPDATE SET config=EXCLUDED.config, base_version=EXCLUDED.base_version`, cfg, v, claimsFrom(r.Context()).UserID); err != nil {
		httpx.Fail(w, r, err)
		return
	}
	if err := tx.Commit(); err != nil {
		httpx.Fail(w, r, err)
		return
	}
	s.audit(r, "publish", "homepage", int64(v), map[string]any{"summary": in.Summary, "publish_at": at})
	httpx.JSON(w, 201, map[string]any{"version": v, "publish_at": at})
}

func (s *Server) hpVersions(w http.ResponseWriter, r *http.Request) {
	s.respondQuery(w, r, `SELECT coalesce(json_agg(x ORDER BY x.version DESC), '[]') FROM (
		SELECT h.version, h.summary, h.changes, h.created_at, h.publish_at, coalesce(u.name, '') AS by,
		       h.version = (SELECT max(version) FROM homepage_versions WHERE publish_at <= now()) AS live,
		       h.publish_at > now() AS scheduled
		FROM homepage_versions h LEFT JOIN users u ON u.id = h.created_by
		ORDER BY h.version DESC LIMIT 60) x`)
}

func hpVersionParam(r *http.Request) (int, error) {
	v, err := strconv.Atoi(chi.URLParam(r, "version"))
	if err != nil || v <= 0 {
		return 0, httpx.ErrNotFound
	}
	return v, nil
}

func (s *Server) hpVersion(w http.ResponseWriter, r *http.Request) {
	v, err := hpVersionParam(r)
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	s.respondQuery(w, r, `SELECT json_build_object('version', version, 'config', config, 'publish_at', publish_at, 'summary', summary) FROM homepage_versions WHERE version=$1`, v)
}

func (s *Server) hpRestore(w http.ResponseWriter, r *http.Request) {
	v, err := hpVersionParam(r)
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	res, err := s.DB.ExecContext(r.Context(), `INSERT INTO homepage_draft (id, config, base_version, updated_by)
		SELECT 1, config, version, $2 FROM homepage_versions WHERE version=$1
		ON CONFLICT (id) DO UPDATE SET config=EXCLUDED.config, base_version=EXCLUDED.base_version, updated_by=EXCLUDED.updated_by, updated_at=now()`,
		v, claimsFrom(r.Context()).UserID)
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	if n, _ := res.RowsAffected(); n == 0 {
		httpx.Fail(w, r, httpx.ErrNotFound)
		return
	}
	// restoring only changes the draft — not audited as a site change
	s.hpState(w, r)
}

func (s *Server) hpCancelScheduled(w http.ResponseWriter, r *http.Request) {
	v, err := hpVersionParam(r)
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	res, err := s.DB.ExecContext(r.Context(), `DELETE FROM homepage_versions WHERE version=$1 AND publish_at > now()`, v)
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	if n, _ := res.RowsAffected(); n == 0 {
		httpx.Fail(w, r, httpx.NewError(http.StatusConflict, "conflict", "Bu versiya allaqachon saytda"))
		return
	}
	s.audit(r, "unschedule", "homepage", int64(v), nil)
	w.WriteHeader(http.StatusNoContent)
}

// ---------- draft preview ----------

// A preview token lets the site render the current draft for 2 hours without
// an admin session (the site opens it in a new tab or an iframe).
func (s *Server) hpPreviewSign(exp int64) string {
	m := hmac.New(sha256.New, s.Cfg.JWTSecret)
	fmt.Fprintf(m, "homepage-preview:%d", exp)
	return strconv.FormatInt(exp, 36) + "." + base64.RawURLEncoding.EncodeToString(m.Sum(nil))
}

func (s *Server) hpPreviewToken(w http.ResponseWriter, r *http.Request) {
	exp := time.Now().Add(2 * time.Hour).Unix()
	httpx.JSON(w, 200, map[string]any{"token": s.hpPreviewSign(exp), "expires_at": time.Unix(exp, 0)})
}

func (s *Server) hpPreviewValid(tok string) bool {
	head, _, ok := strings.Cut(tok, ".")
	if !ok {
		return false
	}
	exp, err := strconv.ParseInt(head, 36, 64)
	if err != nil || time.Now().Unix() > exp {
		return false
	}
	return hmac.Equal([]byte(tok), []byte(s.hpPreviewSign(exp)))
}

func (s *Server) publicHomepagePreview(w http.ResponseWriter, r *http.Request) {
	if !s.hpPreviewValid(r.URL.Query().Get("token")) {
		httpx.Fail(w, r, httpx.NewError(http.StatusForbidden, "forbidden", "Ko‘rish havolasi eskirgan"))
		return
	}
	d, err := s.loadDraft(r)
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	httpx.JSON(w, 200, map[string]any{"version": -1, "config": d.Config})
}
