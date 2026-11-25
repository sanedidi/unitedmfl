package api

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"math/big"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/lib/pq"

	"github.com/sanedidi/unitedmfl/backend/internal/auth"
	"github.com/sanedidi/unitedmfl/backend/internal/httpx"
	"github.com/sanedidi/unitedmfl/backend/internal/roster"
)

// Team cabinet, the admin's side: logins and passwords (Jamoalar → Kabinet,
// permission «teams») and the review of change requests (Arizalar →
// O‘zgarishlar, permission «applications»).

func (s *Server) mountTeamCabinetAdmin(r chi.Router) {
	r.Group(func(r chi.Router) {
		r.Use(s.can(auth.PermTeams))
		r.Get("/team-cabinets", s.adminCabinets)
		r.Get("/teams/{id}/cabinet", s.adminCabinet)
		r.Post("/teams/{id}/cabinet", s.createCabinet)
		r.Post("/teams/{id}/cabinet/password", s.resetCabinetPassword)
		r.Patch("/teams/{id}/cabinet", s.patchCabinet)
	})
	r.Group(func(r chi.Router) {
		r.Use(s.can(auth.PermApplications))
		r.Get("/team-changes", s.adminChanges)
		r.Get("/team-changes/{id}", s.adminChange)
		r.Patch("/team-changes/{id}", s.patchChange)
		r.Post("/team-changes/{id}/decide", s.decideChange)
		r.Get("/team-cabinet/{team}/files/{file}", s.adminCabFile)
	})
}

// ---------- logins and passwords ----------

var reTeamLogin = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{2,39}$`)

const passwordAlphabet = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789" // no 0/O, 1/l/I

// newTeamPassword: «K7m-Q2x-9Lp» — easy to read out and type on a phone.
func newTeamPassword() string {
	var b strings.Builder
	for g := 0; g < 3; g++ {
		if g > 0 {
			b.WriteByte('-')
		}
		for i := 0; i < 3; i++ {
			n, _ := rand.Int(rand.Reader, big.NewInt(int64(len(passwordAlphabet))))
			b.WriteByte(passwordAlphabet[n.Int64()])
		}
	}
	return b.String()
}

func loginFromSlug(slug string) string {
	var b strings.Builder
	for _, r := range strings.ToLower(slug) {
		switch {
		case r >= 'a' && r <= 'z', r >= '0' && r <= '9':
			b.WriteRune(r)
		case r == '-' || r == '_' || r == ' ':
			if b.Len() > 0 && !strings.HasSuffix(b.String(), "-") {
				b.WriteByte('-')
			}
		}
	}
	l := strings.Trim(b.String(), "-")
	if len(l) > 36 {
		l = strings.Trim(l[:36], "-")
	}
	for len(l) < 3 {
		l += "0"
	}
	return l
}

func (s *Server) cabinetURL(login string) string {
	if s.Cfg.RegisterURL == "" {
		return ""
	}
	return s.Cfg.RegisterURL + "/jamoa/" + login
}

func (s *Server) cabinetMessage(team, login, password string) string {
	var b strings.Builder
	fmt.Fprintf(&b, "United MFL — «%s» jamoa kabineti\n", team)
	if u := s.cabinetURL(login); u != "" {
		fmt.Fprintf(&b, "Havola: %s\n", u)
	}
	fmt.Fprintf(&b, "Login: %s\nParol: %s\n", login, password)
	b.WriteString("Tarkib, shtab, forma va jamoa ma’lumotlarini shu yerda o‘zgartirasiz. O‘zgarishlar liga tasdiqlagandan keyin saytga chiqadi.")
	return b.String()
}

type cabAccount struct {
	Login          string     `json:"login"`
	Enabled        bool       `json:"enabled"`
	FailedAttempts int        `json:"failed_attempts"`
	LockedUntil    *time.Time `json:"locked_until"`
	PasswordSetAt  time.Time  `json:"password_set_at"`
	LastLoginAt    *time.Time `json:"last_login_at"`
	LastDevice     string     `json:"last_device"`
	CreatedAt      time.Time  `json:"created_at"`
	CreatedBy      string     `json:"created_by"`
	Sessions       int        `json:"sessions"`
	URL            string     `json:"url"`
}

func (s *Server) loadAccount(ctx context.Context, teamID int64) (*cabAccount, error) {
	a := &cabAccount{}
	var ua string
	err := s.DB.QueryRowContext(ctx, `SELECT a.login, a.enabled, a.failed_attempts, a.locked_until, a.password_set_at, a.last_login_at, a.last_login_ua,
		a.created_at, coalesce(u.name, ''), (SELECT count(*) FROM team_sessions se WHERE se.team_id = a.team_id AND se.expires_at > now())
		FROM team_accounts a LEFT JOIN users u ON u.id = a.created_by WHERE a.team_id = $1`, teamID).
		Scan(&a.Login, &a.Enabled, &a.FailedAttempts, &a.LockedUntil, &a.PasswordSetAt, &a.LastLoginAt, &ua, &a.CreatedAt, &a.CreatedBy, &a.Sessions)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if ua != "" {
		a.LastDevice = deviceLabel(ua)
	}
	a.URL = s.cabinetURL(a.Login)
	return a, nil
}

type cabEventOut struct {
	Kind      string    `json:"kind"`
	Note      string    `json:"note"`
	Number    string    `json:"number,omitempty"`
	UserName  string    `json:"user_name"`
	CreatedAt time.Time `json:"created_at"`
}

func (s *Server) cabEvents(ctx context.Context, where string, arg any, limit int) ([]cabEventOut, error) {
	rows, err := s.DB.QueryContext(ctx, `SELECT e.kind, e.note, e.request_id, coalesce(u.name, ''), e.created_at
		FROM team_cabinet_events e LEFT JOIN users u ON u.id = e.user_id WHERE `+where+` ORDER BY e.created_at DESC, e.id DESC LIMIT `+strconv.Itoa(limit), arg)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []cabEventOut{}
	for rows.Next() {
		var e cabEventOut
		var rid *int64
		if err := rows.Scan(&e.Kind, &e.Note, &rid, &e.UserName, &e.CreatedAt); err != nil {
			return nil, err
		}
		if rid != nil {
			e.Number = fmt.Sprintf(cabRequestNumber, *rid)
		}
		out = append(out, e)
	}
	return out, rows.Err()
}

func itemCounts(items []changeItem) map[string]int {
	c := map[string]int{"total": len(items)}
	for _, it := range items {
		c[it.Kind+"_"+it.Op]++
		if it.Decision != "" {
			c[it.Decision]++
		}
	}
	return c
}

// changeSummary: «+1 o‘yinchi · 2 o‘zgardi · −1 · logotip, forma».
func changeSummary(items []changeItem) string {
	var add, upd, rem, staff int
	var team []string
	for _, it := range items {
		switch {
		case it.Kind == "team":
			team = append(team, strings.ToLower(it.Title))
		case it.Kind == "staff":
			staff++
		case it.Op == "add":
			add++
		case it.Op == "update":
			upd++
		case it.Op == "remove":
			rem++
		}
	}
	var parts []string
	if add > 0 {
		parts = append(parts, fmt.Sprintf("+%d o‘yinchi", add))
	}
	if upd > 0 {
		parts = append(parts, fmt.Sprintf("%d o‘zgardi", upd))
	}
	if rem > 0 {
		parts = append(parts, fmt.Sprintf("−%d", rem))
	}
	if staff > 0 {
		parts = append(parts, fmt.Sprintf("shtab: %d", staff))
	}
	if len(team) > 0 {
		parts = append(parts, strings.Join(team, ", "))
	}
	if len(parts) == 0 {
		return "—"
	}
	return strings.Join(parts, " · ")
}

func (s *Server) adminCabinets(w http.ResponseWriter, r *http.Request) {
	rows, err := s.DB.QueryContext(r.Context(), `SELECT t.id, t.name, t.slug, t.crest_url, t.is_active,
		a.login, a.enabled, a.last_login_at,
		(SELECT q.status FROM team_change_requests q WHERE q.team_id = t.id AND q.status IN ('draft', 'submitted', 'changes') LIMIT 1)
		FROM teams t LEFT JOIN team_accounts a ON a.team_id = t.id ORDER BY t.is_active DESC, t.name`)
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	defer rows.Close()
	out := []map[string]any{}
	for rows.Next() {
		var id int64
		var name, slug, crest string
		var active bool
		var login, open sql.NullString
		var enabled sql.NullBool
		var last *time.Time
		if err := rows.Scan(&id, &name, &slug, &crest, &active, &login, &enabled, &last, &open); err != nil {
			httpx.Fail(w, r, err)
			return
		}
		state := "none"
		if login.Valid {
			state = "disabled"
			if enabled.Bool {
				state = "active"
			}
		}
		out = append(out, map[string]any{"team": map[string]any{"id": id, "name": name, "slug": slug, "crest_url": crest, "is_active": active},
			"state": state, "login": login.String, "last_login_at": last, "request_status": open.String})
	}
	if err := rows.Err(); err != nil {
		httpx.Fail(w, r, err)
		return
	}
	httpx.JSON(w, 200, map[string]any{"items": out, "register_url": s.Cfg.RegisterURL})
}

func (s *Server) adminCabinet(w http.ResponseWriter, r *http.Request) {
	id, err := idParam(r, "id")
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	ctx := r.Context()
	var name, slug, crest string
	if err := s.DB.QueryRowContext(ctx, `SELECT name, slug, crest_url FROM teams WHERE id = $1`, id).Scan(&name, &slug, &crest); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			err = httpx.ErrNotFound
		}
		httpx.Fail(w, r, err)
		return
	}
	acc, err := s.loadAccount(ctx, id)
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	reqs := []map[string]any{}
	rows, err := s.DB.QueryContext(ctx, `SELECT `+reqCols+` FROM team_change_requests WHERE team_id = $1 AND status <> 'draft' ORDER BY id DESC LIMIT 10`, id)
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	for rows.Next() {
		q, err := scanReq(rows)
		if err != nil {
			rows.Close()
			httpx.Fail(w, r, err)
			return
		}
		reqs = append(reqs, map[string]any{"id": q.ID, "number": q.number(), "status": q.Status, "submitted_at": q.SubmittedAt,
			"decided_at": q.DecidedAt, "counts": itemCounts(q.Items), "summary": changeSummary(q.Items)})
	}
	rows.Close()
	events, err := s.cabEvents(ctx, "e.team_id = $1", id, 30)
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	var hasDraft bool
	_ = s.DB.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM team_change_requests WHERE team_id = $1 AND status = 'draft')`, id).Scan(&hasDraft)
	httpx.JSON(w, 200, map[string]any{"team": map[string]any{"id": id, "name": name, "slug": slug, "crest_url": crest},
		"account": acc, "requests": reqs, "events": events, "has_draft": hasDraft,
		"register_url": s.Cfg.RegisterURL, "suggested_login": loginFromSlug(slug)})
}

func (s *Server) cabinetCredentials(ctx context.Context, teamID int64, login, password string) map[string]any {
	var name string
	_ = s.DB.QueryRowContext(ctx, `SELECT name FROM teams WHERE id = $1`, teamID).Scan(&name)
	return map[string]any{"login": login, "password": password, "url": s.cabinetURL(login), "message": s.cabinetMessage(name, login, password)}
}

func (s *Server) createCabinet(w http.ResponseWriter, r *http.Request) {
	id, err := idParam(r, "id")
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	var in struct {
		Login string `json:"login"`
	}
	if err := httpx.Decode(r, &in); err != nil {
		httpx.Fail(w, r, err)
		return
	}
	ctx := r.Context()
	var slug string
	if err := s.DB.QueryRowContext(ctx, `SELECT slug FROM teams WHERE id = $1`, id).Scan(&slug); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			err = httpx.ErrNotFound
		}
		httpx.Fail(w, r, err)
		return
	}
	login := normLogin(in.Login)
	auto := login == ""
	if auto {
		login = loginFromSlug(slug)
	}
	if !reTeamLogin.MatchString(login) {
		httpx.Fail(w, r, httpx.Validation(map[string]any{"login": "3–40 belgi: lotin kichik harflari, raqamlar va «-»"}))
		return
	}
	password := newTeamPassword()
	hash, err := auth.HashPassword(password)
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	base := login
	for i := 2; ; i++ {
		_, err = s.DB.ExecContext(ctx, `INSERT INTO team_accounts (team_id, login, password_hash, created_by) VALUES ($1, $2, $3, $4)`, id, login, hash, userID(r))
		var pe *pq.Error
		if err == nil || !errors.As(err, &pe) || pe.Code != "23505" {
			break
		}
		if pe.Constraint == "team_accounts_pkey" {
			httpx.Fail(w, r, httpx.NewError(http.StatusConflict, "exists", "Bu jamoaning kabineti allaqachon bor"))
			return
		}
		if !auto || i > 20 {
			httpx.Fail(w, r, httpx.Validation(map[string]any{"login": "Bu login band"}))
			return
		}
		login = fmt.Sprintf("%s-%d", base, i)
	}
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	s.cabEvent(ctx, id, nil, "created", "Login: "+login, userID(r))
	s.audit(r, "create", "team_cabinet", id, map[string]any{"login": login})
	httpx.JSON(w, http.StatusCreated, s.cabinetCredentials(ctx, id, login, password))
}

func (s *Server) resetCabinetPassword(w http.ResponseWriter, r *http.Request) {
	id, err := idParam(r, "id")
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	ctx := r.Context()
	password := newTeamPassword()
	hash, err := auth.HashPassword(password)
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	var login string
	err = s.DB.QueryRowContext(ctx, `UPDATE team_accounts SET password_hash = $2, password_set_at = now(), failed_attempts = 0, locked_until = NULL, updated_at = now()
		WHERE team_id = $1 RETURNING login`, id, hash).Scan(&login)
	if errors.Is(err, sql.ErrNoRows) {
		httpx.Fail(w, r, httpx.NewError(http.StatusNotFound, "not_found", "Kabinet hali yaratilmagan"))
		return
	}
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	// every device is signed out: the old password must not keep working anywhere
	_, _ = s.DB.ExecContext(ctx, `DELETE FROM team_sessions WHERE team_id = $1`, id)
	s.cabEvent(ctx, id, nil, "password", "Parol yangilandi, barcha qurilmalardan chiqildi", userID(r))
	s.audit(r, "password", "team_cabinet", id, nil)
	httpx.JSON(w, 200, s.cabinetCredentials(ctx, id, login, password))
}

func (s *Server) patchCabinet(w http.ResponseWriter, r *http.Request) {
	id, err := idParam(r, "id")
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	var in struct {
		Enabled *bool   `json:"enabled"`
		Login   *string `json:"login"`
	}
	if err := httpx.Decode(r, &in); err != nil {
		httpx.Fail(w, r, err)
		return
	}
	ctx := r.Context()
	acc, err := s.loadAccount(ctx, id)
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	if acc == nil {
		httpx.Fail(w, r, httpx.NewError(http.StatusNotFound, "not_found", "Kabinet hali yaratilmagan"))
		return
	}
	if in.Login != nil {
		login := normLogin(*in.Login)
		if !reTeamLogin.MatchString(login) {
			httpx.Fail(w, r, httpx.Validation(map[string]any{"login": "3–40 belgi: lotin kichik harflari, raqamlar va «-»"}))
			return
		}
		if login != acc.Login {
			_, err := s.DB.ExecContext(ctx, `UPDATE team_accounts SET login = $2, updated_at = now() WHERE team_id = $1`, id, login)
			var pe *pq.Error
			if errors.As(err, &pe) && pe.Code == "23505" {
				httpx.Fail(w, r, httpx.Validation(map[string]any{"login": "Bu login band"}))
				return
			}
			if err != nil {
				httpx.Fail(w, r, err)
				return
			}
			s.cabEvent(ctx, id, nil, "login_changed", acc.Login+" → "+login, userID(r))
		}
	}
	if in.Enabled != nil && *in.Enabled != acc.Enabled {
		if _, err := s.DB.ExecContext(ctx, `UPDATE team_accounts SET enabled = $2, updated_at = now() WHERE team_id = $1`, id, *in.Enabled); err != nil {
			httpx.Fail(w, r, err)
			return
		}
		kind, note := "enabled", "Kabinet yoqildi"
		if !*in.Enabled {
			kind, note = "disabled", "Kabinet o‘chirildi, barcha qurilmalardan chiqildi"
			_, _ = s.DB.ExecContext(ctx, `DELETE FROM team_sessions WHERE team_id = $1`, id)
		}
		s.cabEvent(ctx, id, nil, kind, note, userID(r))
	}
	s.audit(r, "update", "team_cabinet", id, map[string]any{"enabled": in.Enabled, "login": in.Login})
	acc, err = s.loadAccount(ctx, id)
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	httpx.JSON(w, 200, acc)
}

// ---------- change requests ----------

func (s *Server) adminChanges(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	status := r.URL.Query().Get("status")
	where := `q.status <> 'draft'`
	args := []any{}
	switch status {
	case "", "all":
	case "open":
		where = `q.status IN ('submitted', 'changes')`
	case "submitted", "changes", "approved", "partial", "rejected", "withdrawn":
		where = `q.status = $1`
		args = append(args, status)
	default:
		httpx.Fail(w, r, httpx.BadRequest("status noto‘g‘ri"))
		return
	}
	if t := r.URL.Query().Get("team_id"); t != "" {
		tid, err := strconv.ParseInt(t, 10, 64)
		if err != nil {
			httpx.Fail(w, r, httpx.BadRequest("team_id noto‘g‘ri"))
			return
		}
		args = append(args, tid)
		where += ` AND q.team_id = $` + strconv.Itoa(len(args))
	}
	rows, err := s.DB.QueryContext(ctx, `SELECT `+prefixCols("q.", reqCols)+`, t.name, t.crest_url FROM team_change_requests q JOIN teams t ON t.id = q.team_id
		WHERE `+where+` ORDER BY (q.status = 'submitted') DESC, coalesce(q.submitted_at, q.updated_at) DESC LIMIT 300`, args...)
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	defer rows.Close()
	items := []map[string]any{}
	for rows.Next() {
		var name, crest string
		q := &changeRequest{}
		var draft, its []byte
		if err := rows.Scan(&q.ID, &q.TeamID, &q.Status, &draft, &its, &q.Comment, &q.InternalNote, &q.SubmittedAt, &q.DecidedAt, &q.DecidedBy, &q.CreatedAt, &q.UpdatedAt, &name, &crest); err != nil {
			httpx.Fail(w, r, err)
			return
		}
		_ = json.Unmarshal(its, &q.Items)
		items = append(items, map[string]any{"id": q.ID, "number": q.number(), "status": q.Status,
			"team":    map[string]any{"id": q.TeamID, "name": name, "crest_url": crest},
			"summary": changeSummary(q.Items), "counts": itemCounts(q.Items), "submitted_at": q.SubmittedAt, "decided_at": q.DecidedAt, "updated_at": q.UpdatedAt})
	}
	if err := rows.Err(); err != nil {
		httpx.Fail(w, r, err)
		return
	}
	counts := map[string]int{}
	crow, err := s.DB.QueryContext(ctx, `SELECT status, count(*) FROM team_change_requests WHERE status <> 'draft' GROUP BY status`)
	if err == nil {
		for crow.Next() {
			var st string
			var n int
			if crow.Scan(&st, &n) == nil {
				counts[st] = n
			}
		}
		crow.Close()
	}
	httpx.JSON(w, 200, map[string]any{"items": items, "counts": counts})
}

func prefixCols(p, cols string) string {
	parts := strings.Split(cols, ",")
	for i, c := range parts {
		parts[i] = p + strings.TrimSpace(c)
	}
	return strings.Join(parts, ", ")
}

func (s *Server) loadChange(ctx context.Context, q rowQuerierCtx, id int64, lock bool) (*changeRequest, error) {
	sqlText := `SELECT ` + reqCols + ` FROM team_change_requests WHERE id = $1`
	if lock {
		sqlText += ` FOR UPDATE`
	}
	cr, err := scanReq(q.QueryRowContext(ctx, sqlText, id))
	if errors.Is(err, sql.ErrNoRows) {
		return nil, httpx.ErrNotFound
	}
	return cr, err
}

func (s *Server) adminChange(w http.ResponseWriter, r *http.Request) {
	id, err := idParam(r, "id")
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	ctx := r.Context()
	q, err := s.loadChange(ctx, s.DB, id, false)
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	if q.Status == "draft" {
		httpx.Fail(w, r, httpx.ErrNotFound) // drafts are the team's own business
		return
	}
	live, err := loadLiveDoc(ctx, s.DB, q.TeamID)
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	var slug, crest, login string
	_ = s.DB.QueryRowContext(ctx, `SELECT t.slug, t.crest_url, coalesce(a.login, '') FROM teams t LEFT JOIN team_accounts a ON a.team_id = t.id WHERE t.id = $1`, q.TeamID).
		Scan(&slug, &crest, &login)
	out := map[string]any{"request": q.json(true), "internal_note": q.InternalNote,
		"team": map[string]any{"id": q.TeamID, "name": live.Team.Name, "slug": slug, "crest_url": crest, "login": login, "site_url": s.siteTeamURL(slug)},
		"live": live, "checks": []cabCheck{}, "stale": []string{}}
	if q.Status == "submitted" {
		idx, err := s.playerIndex(ctx)
		if err != nil {
			httpx.Fail(w, r, err)
			return
		}
		out["checks"] = checkDoc(q.TeamID, &q.Draft, q.Items, idx)
		// items that no longer change anything (the admin edited the team meanwhile)
		now := map[string]bool{}
		for _, it := range diffDoc(live, &q.Draft) {
			now[it.Key] = true
		}
		stale := []string{}
		for _, it := range q.Items {
			if !now[it.Key] {
				stale = append(stale, it.Key)
			}
		}
		out["stale"] = stale
	}
	events, err := s.cabEvents(ctx, "e.request_id = $1", id, 30)
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	out["events"] = events
	var prev sql.NullInt64
	var prevStatus sql.NullString
	_ = s.DB.QueryRowContext(ctx, `SELECT id, status FROM team_change_requests WHERE team_id = $1 AND id < $2 AND status <> 'draft' ORDER BY id DESC LIMIT 1`, q.TeamID, id).
		Scan(&prev, &prevStatus)
	if prev.Valid {
		out["previous"] = map[string]any{"id": prev.Int64, "number": fmt.Sprintf(cabRequestNumber, prev.Int64), "status": prevStatus.String}
	}
	httpx.JSON(w, 200, out)
}

func (s *Server) patchChange(w http.ResponseWriter, r *http.Request) {
	id, err := idParam(r, "id")
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	var in struct {
		InternalNote *string `json:"internal_note"`
	}
	if err := httpx.Decode(r, &in); err != nil {
		httpx.Fail(w, r, err)
		return
	}
	if in.InternalNote != nil {
		res, err := s.DB.ExecContext(r.Context(), `UPDATE team_change_requests SET internal_note = $2 WHERE id = $1 AND status <> 'draft'`, id, clip(*in.InternalNote, 2000))
		if err != nil {
			httpx.Fail(w, r, err)
			return
		}
		if n, _ := res.RowsAffected(); n == 0 {
			httpx.Fail(w, r, httpx.ErrNotFound)
			return
		}
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) adminCabFile(w http.ResponseWriter, r *http.Request) {
	team, err := idParam(r, "team")
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	s.serveCabFile(w, r, team, chi.URLParam(r, "file"))
}

// ---------- decision ----------

type decideInput struct {
	Approve []string `json:"approve"` // keys of the items that go to the site
	Action  string   `json:"action"`  // approve | return | reject
	Comment string   `json:"comment"` // shown to the team
}

// cabHooks: what to poke after the transaction (kit pictures, stickers, the site).
type cabHooks struct {
	crest       bool
	kitOld      string
	kitNew      string
	kitChanged  bool
	photoEvents []photoEvent
	newIDs      map[string]int64 // item key → id of the created player / staff row
}

type photoEvent struct {
	id       int64
	old, cur map[string]any
}

func boolPos(role string) (string, bool) {
	switch role {
	case roster.RoleGoalkeeper:
		return "GK", false
	case roster.RoleMedia:
		return "", true
	}
	return "", false
}

func nullDate(d string) any {
	if d == "" {
		return nil
	}
	return d
}

func numberArg(n string) any {
	if n == "" {
		return nil
	}
	return n
}

func (s *Server) medicalURL(teamID int64, f *roster.File) string {
	if f == nil || f.File == "" {
		return ""
	}
	return cabFilesURLPrefix + strconv.FormatInt(teamID, 10) + "/files/" + f.File
}

var errCabConflict = func(msg string) error { return httpx.NewError(http.StatusConflict, "conflict", msg) }

// applyItems writes the approved items to teams / players / team_staff.
func (s *Server) applyItems(ctx context.Context, tx *sql.Tx, teamID int64, items []changeItem, h *cabHooks) error {
	teamCols := map[string]string{"short_name": "short_name", "crest_url": "crest_url", "leader": "leader", "instagram": "instagram",
		"telegram": "telegram", "kit_url": "kit_url"}
	for _, it := range items {
		switch it.Kind {
		case "team":
			f := it.Fields[0]
			if f.Field == "colors" {
				colors := strings.Fields(f.After)
				if colors == nil {
					colors = []string{}
				}
				if _, err := tx.ExecContext(ctx, `UPDATE teams SET colors = $2, updated_at = now() WHERE id = $1`, teamID, pq.Array(colors)); err != nil {
					return err
				}
				continue
			}
			col, ok := teamCols[f.Field]
			if !ok {
				continue
			}
			if f.Field == "kit_url" {
				var old string
				_ = tx.QueryRowContext(ctx, `SELECT kit_url FROM teams WHERE id = $1`, teamID).Scan(&old)
				h.kitChanged, h.kitOld, h.kitNew = true, old, f.After
			}
			if f.Field == "crest_url" {
				h.crest = true
			}
			if _, err := tx.ExecContext(ctx, `UPDATE teams SET `+col+` = $2, updated_at = now() WHERE id = $1`, teamID, f.After); err != nil {
				return err
			}
		case "player":
			p := it.Player
			if p == nil {
				continue
			}
			pos, media := boolPos(p.Role)
			switch it.Op {
			case "add":
				var pid int64
				if err := tx.QueryRowContext(ctx, `INSERT INTO players (team_id, full_name, number, position, photo_url, birth_date, jersey_name, kit_size, workplace, is_media, medical_url)
					VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id`,
					teamID, p.fullName(), numberArg(p.Number.String()), pos, p.PhotoURL, nullDate(p.BirthDate), p.JerseyName, p.KitSize, p.Workplace, media,
					s.medicalURL(teamID, p.Medical)).Scan(&pid); err != nil {
					return dbError(err)
				}
				h.newIDs[it.Key] = pid
				if p.PhotoURL != "" {
					h.photoEvents = append(h.photoEvents, photoEvent{id: pid, cur: map[string]any{"photo_url": p.PhotoURL, "team_id": float64(teamID), "number": p.Number.String()}})
				}
			case "remove":
				res, err := tx.ExecContext(ctx, `UPDATE players SET team_id = NULL, updated_at = now() WHERE id = $1 AND team_id = $2`, p.ID, teamID)
				if err != nil {
					return err
				}
				if n, _ := res.RowsAffected(); n == 0 {
					return errCabConflict(p.fullName() + " endi bu jamoada emas — sahifani yangilang")
				}
				h.photoEvents = append(h.photoEvents, photoEvent{id: p.ID, old: map[string]any{"photo_url": p.PhotoURL, "team_id": float64(teamID)},
					cur: map[string]any{"photo_url": p.PhotoURL, "team_id": float64(0)}})
			case "update":
				var oldPhoto, oldNumber string
				if err := tx.QueryRowContext(ctx, `SELECT photo_url, coalesce(number, '') FROM players WHERE id = $1 AND team_id = $2 FOR UPDATE`, p.ID, teamID).
					Scan(&oldPhoto, &oldNumber); err != nil {
					if errors.Is(err, sql.ErrNoRows) {
						return errCabConflict(it.Title + " endi bu jamoada emas — sahifani yangilang")
					}
					return err
				}
				sets := []string{}
				args := []any{p.ID}
				set := func(col string, v any) {
					args = append(args, v)
					sets = append(sets, col+" = $"+strconv.Itoa(len(args)))
				}
				for _, f := range it.Fields {
					switch f.Field {
					case "full_name":
						set("full_name", p.fullName())
					case "number":
						set("number", numberArg(p.Number.String()))
					case "role":
						set("position", pos)
						set("is_media", media)
					case "jersey_name":
						set("jersey_name", p.JerseyName)
					case "birth_date":
						set("birth_date", nullDate(p.BirthDate))
					case "kit_size":
						set("kit_size", p.KitSize)
					case "workplace":
						set("workplace", p.Workplace)
					case "photo_url":
						set("photo_url", p.PhotoURL)
					case "medical":
						set("medical_url", s.medicalURL(teamID, p.Medical))
					}
				}
				if len(sets) == 0 {
					continue
				}
				if _, err := tx.ExecContext(ctx, `UPDATE players SET `+strings.Join(sets, ", ")+`, updated_at = now() WHERE id = $1`, args...); err != nil {
					return dbError(err)
				}
				h.photoEvents = append(h.photoEvents, photoEvent{id: p.ID,
					old: map[string]any{"photo_url": oldPhoto, "team_id": float64(teamID), "number": oldNumber},
					cur: map[string]any{"photo_url": p.PhotoURL, "team_id": float64(teamID), "number": p.Number.String()}})
			}
		case "staff":
			st := it.Staff
			if st == nil {
				continue
			}
			switch it.Op {
			case "add":
				var sid int64
				if err := tx.QueryRowContext(ctx, `INSERT INTO team_staff (team_id, full_name, role, birth_date, kit_size, ord)
					VALUES ($1, $2, $3, $4, $5, (SELECT coalesce(max(ord), 0) + 1 FROM team_staff WHERE team_id = $1)) RETURNING id`,
					teamID, st.fullName(), st.Role, nullDate(st.BirthDate), st.KitSize).Scan(&sid); err != nil {
					return dbError(err)
				}
				h.newIDs[it.Key] = sid
			case "remove":
				if _, err := tx.ExecContext(ctx, `DELETE FROM team_staff WHERE id = $1 AND team_id = $2`, st.ID, teamID); err != nil {
					return err
				}
			case "update":
				res, err := tx.ExecContext(ctx, `UPDATE team_staff SET full_name = $3, role = $4, birth_date = $5, kit_size = $6, updated_at = now()
					WHERE id = $1 AND team_id = $2`, st.ID, teamID, st.fullName(), st.Role, nullDate(st.BirthDate), st.KitSize)
				if err != nil {
					return dbError(err)
				}
				if n, _ := res.RowsAffected(); n == 0 {
					return errCabConflict(it.Title + " endi shtabda emas — sahifani yangilang")
				}
			}
		}
	}
	return nil
}

// syncDraft marks approved items in the draft as live: new rows get their ids,
// uploaded medical files become «already has one».
func syncDraft(d *cabDoc, approved []changeItem, newIDs map[string]int64) {
	for _, it := range approved {
		switch it.Kind {
		case "player":
			if strings.HasPrefix(it.Key, "player:new:") {
				i, err := strconv.Atoi(strings.TrimPrefix(it.Key, "player:new:"))
				if err == nil && i >= 0 && i < len(d.Players) && d.Players[i].ID == 0 {
					d.Players[i].ID = newIDs[it.Key]
					if d.Players[i].Medical != nil {
						d.Players[i].Medical, d.Players[i].HasMedical = nil, true
					}
				}
				continue
			}
			for i := range d.Players {
				if it.Player != nil && d.Players[i].ID == it.Player.ID && d.Players[i].Medical != nil {
					d.Players[i].Medical, d.Players[i].HasMedical = nil, true
				}
			}
		case "staff":
			if strings.HasPrefix(it.Key, "staff:new:") {
				i, err := strconv.Atoi(strings.TrimPrefix(it.Key, "staff:new:"))
				if err == nil && i >= 0 && i < len(d.Staff) && d.Staff[i].ID == 0 {
					d.Staff[i].ID = newIDs[it.Key]
				}
			}
		}
	}
}

func (s *Server) runCabHooks(teamID int64, h *cabHooks) {
	if h.crest {
		teamStickerChanged(s)
	}
	if h.kitChanged {
		teamKitChanged(s, teamID, map[string]any{"kit_url": h.kitOld}, map[string]any{"kit_url": h.kitNew})
	}
	for _, e := range h.photoEvents {
		playerPhotoChanged(s, e.id, e.old, e.cur)
	}
}

func (s *Server) decideChange(w http.ResponseWriter, r *http.Request) {
	id, err := idParam(r, "id")
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	var in decideInput
	if err := httpx.Decode(r, &in); err != nil {
		httpx.Fail(w, r, err)
		return
	}
	in.Comment = clip(in.Comment, 2000)
	switch in.Action {
	case "approve":
		if len(in.Approve) == 0 {
			httpx.Fail(w, r, httpx.BadRequest("Kamida bitta bandni belgilang"))
			return
		}
	case "return":
		if in.Comment == "" {
			httpx.Fail(w, r, httpx.Validation(map[string]any{"comment": "Jamoaga nimani tuzatish kerakligini yozing"}))
			return
		}
	case "reject":
		in.Approve = nil
	default:
		httpx.Fail(w, r, httpx.BadRequest("action: approve, return yoki reject"))
		return
	}
	ctx := r.Context()
	tx, err := s.DB.BeginTx(ctx, nil)
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	defer tx.Rollback()
	q, err := s.loadChange(ctx, tx, id, true)
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	if q.Status != "submitted" {
		httpx.Fail(w, r, httpx.NewError(http.StatusConflict, "state", "So‘rov holati o‘zgardi — sahifani yangilang"))
		return
	}
	approve := map[string]bool{}
	for _, k := range in.Approve {
		approve[k] = true
	}
	byKey := map[string]bool{}
	for _, it := range q.Items {
		byKey[it.Key] = true
	}
	for k := range approve {
		if !byKey[k] {
			httpx.Fail(w, r, httpx.BadRequest("Noma’lum band: "+k))
			return
		}
	}
	var chosen []changeItem
	other := "rejected"
	if in.Action == "return" {
		other = "fix"
	}
	for i := range q.Items {
		if approve[q.Items[i].Key] {
			q.Items[i].Decision = "approved"
			chosen = append(chosen, q.Items[i])
		} else {
			q.Items[i].Decision = other
		}
	}
	hooks := &cabHooks{newIDs: map[string]int64{}}
	if err := s.applyItems(ctx, tx, q.TeamID, chosen, hooks); err != nil {
		httpx.Fail(w, r, err)
		return
	}
	var draftBody any // NULL keeps the draft as it is
	if in.Action == "return" {
		// the team keeps editing this draft: what went live must not show up as a change again
		syncDraft(&q.Draft, chosen, hooks.newIDs)
		b, _ := json.Marshal(q.Draft)
		draftBody = string(b)
	}
	status := "rejected"
	switch {
	case in.Action == "return":
		status = "changes"
	case in.Action == "approve" && len(chosen) == len(q.Items):
		status = "approved"
	case in.Action == "approve":
		status = "partial"
	}
	body, _ := json.Marshal(q.Items)
	if _, err := tx.ExecContext(ctx, `UPDATE team_change_requests SET status = $2, items = $3, comment = $4, decided_at = now(), decided_by = $5, updated_at = now(),
		draft = coalesce($6::jsonb, draft) WHERE id = $1`, id, status, body, in.Comment, userID(r), draftBody); err != nil {
		httpx.Fail(w, r, err)
		return
	}
	if err := tx.Commit(); err != nil {
		httpx.Fail(w, r, err)
		return
	}
	note := fmt.Sprintf("%d / %d band saytga chiqdi", len(chosen), len(q.Items))
	kind := map[string]string{"approved": "approved", "partial": "partial", "changes": "returned", "rejected": "rejected"}[status]
	if in.Comment != "" {
		note += " · " + in.Comment
	}
	s.cabEvent(ctx, q.TeamID, &id, kind, note, userID(r))
	s.audit(r, kind, "team_change", id, map[string]any{"team_id": q.TeamID, "approved": len(chosen), "items": len(q.Items)})
	s.runCabHooks(q.TeamID, hooks)
	httpx.JSON(w, 200, map[string]any{"status": status, "approved": len(chosen), "items": q.Items})
}
