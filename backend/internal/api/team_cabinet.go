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
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/sanedidi/unitedmfl/backend/internal/auth"
	"github.com/sanedidi/unitedmfl/backend/internal/httpx"
	"github.com/sanedidi/unitedmfl/backend/internal/roster"
	"github.com/sanedidi/unitedmfl/backend/internal/xlsx"
)

// Team cabinet, the team's side. The registration site serves it at
// /jamoa/{login}: the login comes from the link, the team types the password
// the league gave it. The session token goes in «Authorization: Bearer tc_…».

const (
	teamTokenPrefix   = "tc_"
	teamSessionShort  = 12 * time.Hour
	teamSessionLong   = 30 * 24 * time.Hour // «Eslab qolish»
	teamMaxAttempts   = 5
	teamLockFor       = 15 * time.Minute
	teamCtxKey        = ctxKey(2)
	teamSeenEvery     = 5 * time.Minute
	cabRequestNumber  = "UMF-O-%04d"
	cabFilesURLPrefix = "/api/v1/admin/team-cabinet/"
)

type teamSession struct {
	TeamID    int64
	SessionID int64
	Login     string
}

func teamFrom(ctx context.Context) *teamSession {
	t, _ := ctx.Value(teamCtxKey).(*teamSession)
	return t
}

func (s *Server) mountTeamCabinet(r chi.Router) {
	r.Get("/team/accounts/{login}", s.teamAccountInfo)
	r.With(s.teamLoginLimiter.Middleware).Post("/team/login", s.teamLogin)
	r.Group(func(r chi.Router) {
		r.Use(s.requireTeam)
		r.Post("/team/logout", s.teamLogout)
		r.Get("/team/me", s.teamMe)
		r.With(s.teamSaveLimiter.Middleware).Put("/team/draft", s.teamSaveDraft)
		r.Delete("/team/draft", s.teamDiscardDraft)
		r.Post("/team/submit", s.teamSubmit)
		r.Post("/team/withdraw", s.teamWithdraw)
		r.With(s.teamUploadLimiter.Middleware).Post("/team/files", s.teamUpload)
		r.Get("/team/files/{file}", s.teamFile)
		r.With(s.teamUploadLimiter.Middleware).Post("/team/import", s.teamImport)
	})
}

func (s *Server) cabDir(teamID int64) string {
	return filepath.Join(s.Cfg.UploadDir, "team-cabinet", strconv.FormatInt(teamID, 10))
}

func (s *Server) cabEvent(ctx context.Context, teamID int64, reqID *int64, kind, note string, userID *int64) {
	if _, err := s.DB.ExecContext(ctx, `INSERT INTO team_cabinet_events (team_id, request_id, kind, note, user_id) VALUES ($1, $2, $3, $4, $5)`,
		teamID, reqID, kind, note, userID); err != nil {
		slog.Warn("team cabinet event", "err", err)
	}
}

// deviceLabel turns a User-Agent into «iPhone · Safari»-like text for the admin.
func deviceLabel(ua string) string {
	l := strings.ToLower(ua)
	dev := "Kompyuter"
	switch {
	case strings.Contains(l, "iphone"):
		dev = "iPhone"
	case strings.Contains(l, "ipad"):
		dev = "iPad"
	case strings.Contains(l, "android"):
		dev = "Android"
	case strings.Contains(l, "mac os"):
		dev = "Mac"
	case strings.Contains(l, "windows"):
		dev = "Windows"
	}
	br := ""
	switch {
	case strings.Contains(l, "telegram"):
		br = "Telegram"
	case strings.Contains(l, "edg/"):
		br = "Edge"
	case strings.Contains(l, "yabrowser"):
		br = "Yandex"
	case strings.Contains(l, "chrome/") || strings.Contains(l, "crios/"):
		br = "Chrome"
	case strings.Contains(l, "firefox/") || strings.Contains(l, "fxios/"):
		br = "Firefox"
	case strings.Contains(l, "safari/"):
		br = "Safari"
	}
	if br != "" {
		return dev + " · " + br
	}
	return dev
}

// ---------- sign in ----------

func normLogin(s string) string { return strings.ToLower(strings.TrimSpace(s)) }

func (s *Server) teamAccountInfo(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	var name, crest string
	var enabled bool
	err := s.DB.QueryRowContext(r.Context(), `SELECT t.name, t.crest_url, a.enabled FROM team_accounts a JOIN teams t ON t.id = a.team_id WHERE a.login = $1`,
		normLogin(chi.URLParam(r, "login"))).Scan(&name, &crest, &enabled)
	if errors.Is(err, sql.ErrNoRows) {
		httpx.Fail(w, r, httpx.NewError(http.StatusNotFound, "not_found", "Bunday kabinet yo‘q — havolani tekshiring"))
		return
	}
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	httpx.JSON(w, 200, map[string]any{"name": name, "crest_url": crest, "enabled": enabled})
}

var errBadCredentials = httpx.NewError(http.StatusUnauthorized, "bad_credentials", "Login yoki parol noto‘g‘ri")

func (s *Server) teamLogin(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Login    string `json:"login"`
		Password string `json:"password"`
		Remember bool   `json:"remember"`
	}
	if err := httpx.Decode(r, &in); err != nil {
		httpx.Fail(w, r, err)
		return
	}
	ctx := r.Context()
	login := normLogin(in.Login)
	var teamID int64
	var hash, name string
	var enabled bool
	var locked *time.Time
	err := s.DB.QueryRowContext(ctx, `SELECT a.team_id, a.password_hash, a.enabled, a.locked_until, t.name
		FROM team_accounts a JOIN teams t ON t.id = a.team_id WHERE a.login = $1`, login).Scan(&teamID, &hash, &enabled, &locked, &name)
	if errors.Is(err, sql.ErrNoRows) || in.Password == "" {
		httpx.Fail(w, r, errBadCredentials)
		return
	}
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	if !enabled {
		httpx.Fail(w, r, httpx.NewError(http.StatusForbidden, "disabled", "Kabinet yopilgan. Savollar bo‘lsa — liga ma’muriyatiga yozing"))
		return
	}
	if locked != nil && locked.After(time.Now()) {
		mins := int(time.Until(*locked).Minutes()) + 1
		httpx.Fail(w, r, httpx.NewError(http.StatusTooManyRequests, "locked", fmt.Sprintf("Ko‘p xato urinish — %d daqiqadan keyin qayta urinib ko‘ring", mins)))
		return
	}
	if !auth.CheckPassword(hash, in.Password) {
		var failed int
		if err := s.DB.QueryRowContext(ctx, `UPDATE team_accounts SET failed_attempts = failed_attempts + 1 WHERE team_id = $1 RETURNING failed_attempts`, teamID).Scan(&failed); err != nil {
			httpx.Fail(w, r, err)
			return
		}
		if failed >= teamMaxAttempts {
			_, _ = s.DB.ExecContext(ctx, `UPDATE team_accounts SET failed_attempts = 0, locked_until = $2 WHERE team_id = $1`, teamID, time.Now().Add(teamLockFor))
			s.cabEvent(ctx, teamID, nil, "locked", fmt.Sprintf("%d marta xato parol · %s", teamMaxAttempts, httpx.ClientIP(r)), nil)
			httpx.Fail(w, r, httpx.NewError(http.StatusTooManyRequests, "locked", fmt.Sprintf("%d marta xato — kirish %d daqiqaga to‘xtatildi", teamMaxAttempts, int(teamLockFor.Minutes()))))
			return
		}
		httpx.JSON(w, http.StatusUnauthorized, map[string]any{"error": httpx.NewError(http.StatusUnauthorized, "bad_credentials",
			fmt.Sprintf("Login yoki parol noto‘g‘ri. Yana %d ta urinish qoldi", teamMaxAttempts-failed)), "attempts_left": teamMaxAttempts - failed})
		return
	}
	token, tokenHash, err := auth.NewRefreshToken()
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	token = teamTokenPrefix + token
	tokenHash = auth.HashToken(token)
	ttl := teamSessionShort
	if in.Remember {
		ttl = teamSessionLong
	}
	expires := time.Now().Add(ttl)
	ua := clip(r.UserAgent(), 300)
	if _, err := s.DB.ExecContext(ctx, `INSERT INTO team_sessions (team_id, token_hash, user_agent, expires_at) VALUES ($1, $2, $3, $4)`,
		teamID, tokenHash, ua, expires); err != nil {
		httpx.Fail(w, r, err)
		return
	}
	_, _ = s.DB.ExecContext(ctx, `UPDATE team_accounts SET failed_attempts = 0, locked_until = NULL, last_login_at = now(), last_login_ua = $2 WHERE team_id = $1`, teamID, ua)
	_, _ = s.DB.ExecContext(ctx, `DELETE FROM team_sessions WHERE team_id = $1 AND expires_at < now()`, teamID)
	s.cabEvent(ctx, teamID, nil, "login", deviceLabel(ua), nil)
	httpx.JSON(w, 200, map[string]any{"token": token, "expires_at": expires, "team": map[string]any{"id": teamID, "name": name, "login": login}})
}

func (s *Server) requireTeam(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := r.Header.Get("Authorization")
		tok := strings.TrimPrefix(h, "Bearer ")
		if !strings.HasPrefix(h, "Bearer ") || !strings.HasPrefix(tok, teamTokenPrefix) {
			httpx.Fail(w, r, httpx.ErrUnauthorized)
			return
		}
		ts := &teamSession{}
		var seen time.Time
		var enabled bool
		err := s.DB.QueryRowContext(r.Context(), `SELECT se.id, se.team_id, se.last_seen_at, a.login, a.enabled
			FROM team_sessions se JOIN team_accounts a ON a.team_id = se.team_id
			WHERE se.token_hash = $1 AND se.expires_at > now()`, auth.HashToken(tok)).Scan(&ts.SessionID, &ts.TeamID, &seen, &ts.Login, &enabled)
		if err != nil || !enabled {
			if err != nil && !errors.Is(err, sql.ErrNoRows) {
				slog.Warn("team session", "err", err)
			}
			httpx.Fail(w, r, httpx.ErrUnauthorized)
			return
		}
		if time.Since(seen) > teamSeenEvery {
			_, _ = s.DB.ExecContext(r.Context(), `UPDATE team_sessions SET last_seen_at = now() WHERE id = $1`, ts.SessionID)
		}
		next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), teamCtxKey, ts)))
	})
}

func (s *Server) teamLogout(w http.ResponseWriter, r *http.Request) {
	ts := teamFrom(r.Context())
	_, _ = s.DB.ExecContext(r.Context(), `DELETE FROM team_sessions WHERE id = $1`, ts.SessionID)
	w.WriteHeader(http.StatusNoContent)
}

// ---------- change requests ----------

type changeRequest struct {
	ID           int64
	TeamID       int64
	Status       string
	Draft        cabDoc
	Items        []changeItem
	Comment      string
	InternalNote string
	SubmittedAt  *time.Time
	DecidedAt    *time.Time
	DecidedBy    *int64
	CreatedAt    time.Time
	UpdatedAt    time.Time
}

const reqCols = `id, team_id, status, draft, items, comment, internal_note, submitted_at, decided_at, decided_by, created_at, updated_at`

func scanReq(row interface{ Scan(...any) error }) (*changeRequest, error) {
	q := &changeRequest{}
	var draft, items []byte
	if err := row.Scan(&q.ID, &q.TeamID, &q.Status, &draft, &items, &q.Comment, &q.InternalNote, &q.SubmittedAt, &q.DecidedAt, &q.DecidedBy, &q.CreatedAt, &q.UpdatedAt); err != nil {
		return nil, err
	}
	_ = json.Unmarshal(draft, &q.Draft)
	_ = json.Unmarshal(items, &q.Items)
	if q.Items == nil {
		q.Items = []changeItem{}
	}
	if q.Draft.Players == nil {
		q.Draft.Players = []cabPlayer{}
	}
	if q.Draft.Staff == nil {
		q.Draft.Staff = []cabStaff{}
	}
	if q.Draft.Team.Colors == nil {
		q.Draft.Team.Colors = []string{}
	}
	return q, nil
}

func (q *changeRequest) number() string { return fmt.Sprintf(cabRequestNumber, q.ID) }

func openStatus(st string) bool { return st == "draft" || st == "submitted" || st == "changes" }

// openRequest returns the team's draft / sent / returned request, or nil.
func openRequest(ctx context.Context, q rowQuerierCtx, teamID int64, lock bool) (*changeRequest, error) {
	sqlText := `SELECT ` + reqCols + ` FROM team_change_requests WHERE team_id = $1 AND status IN ('draft', 'submitted', 'changes')`
	if lock {
		sqlText += ` FOR UPDATE`
	}
	cr, err := scanReq(q.QueryRowContext(ctx, sqlText, teamID))
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	return cr, err
}

func (q *changeRequest) json(withDraft bool) map[string]any {
	m := map[string]any{"id": q.ID, "number": q.number(), "status": q.Status, "items": q.Items, "comment": q.Comment,
		"submitted_at": q.SubmittedAt, "decided_at": q.DecidedAt, "created_at": q.CreatedAt, "updated_at": q.UpdatedAt}
	if withDraft {
		m["draft"] = q.Draft
	}
	return m
}

// teamView is everything the cabinet page needs.
func (s *Server) teamView(ctx context.Context, ts *teamSession) (map[string]any, error) {
	live, err := loadLiveDoc(ctx, s.DB, ts.TeamID)
	if err != nil {
		return nil, err
	}
	var slug string
	_ = s.DB.QueryRowContext(ctx, `SELECT slug FROM teams WHERE id = $1`, ts.TeamID).Scan(&slug)
	req, err := openRequest(ctx, s.DB, ts.TeamID, false)
	if err != nil {
		return nil, err
	}
	out := map[string]any{"team": map[string]any{"id": ts.TeamID, "name": live.Team.Name, "slug": slug, "login": ts.Login, "site_url": s.siteTeamURL(slug)},
		"live": live, "request": nil, "last": nil}
	draft := live
	editable := true
	if req != nil {
		out["request"] = req.json(false)
		draft = &req.Draft
		editable = req.Status != "submitted"
	}
	items := []changeItem{}
	checks := []cabCheck{}
	if req != nil && req.Status == "submitted" {
		items = req.Items
	} else {
		items = diffDoc(live, draft)
		if len(items) > 0 {
			idx, err := s.playerIndex(ctx)
			if err != nil {
				return nil, err
			}
			checks = checkDoc(ts.TeamID, draft, items, idx)
		}
	}
	out["draft"] = draft
	out["items"] = items
	out["checks"] = checks
	out["editable"] = editable
	out["can_submit"] = editable && len(items) > 0 && !cabHasErrors(checks)
	last, err := scanReq(s.DB.QueryRowContext(ctx, `SELECT `+reqCols+` FROM team_change_requests
		WHERE team_id = $1 AND status IN ('approved', 'partial', 'rejected') ORDER BY decided_at DESC NULLS LAST, id DESC LIMIT 1`, ts.TeamID))
	if err == nil {
		out["last"] = last.json(false)
	} else if !errors.Is(err, sql.ErrNoRows) {
		return nil, err
	}
	return out, nil
}

func (s *Server) siteTeamURL(slug string) string {
	if s.Cfg.SiteURL == "" || slug == "" {
		return ""
	}
	return s.Cfg.SiteURL + "/jamoalar/" + slug
}

func (s *Server) writeTeamView(w http.ResponseWriter, r *http.Request, status int) {
	v, err := s.teamView(r.Context(), teamFrom(r.Context()))
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	httpx.JSON(w, status, v)
}

func (s *Server) teamMe(w http.ResponseWriter, r *http.Request) { s.writeTeamView(w, r, 200) }

var errCabLocked = httpx.NewError(http.StatusConflict, "locked", "So‘rov tekshiruvda — o‘zgartirish uchun avval uni qaytarib oling")

func (s *Server) cabFileExists(teamID int64) func(string) bool {
	dir := s.cabDir(teamID)
	return func(name string) bool {
		_, err := os.Stat(filepath.Join(dir, name))
		return err == nil
	}
}

func (s *Server) teamSaveDraft(w http.ResponseWriter, r *http.Request) {
	ts := teamFrom(r.Context())
	var in struct {
		Draft cabDoc `json:"draft"`
	}
	r.Body = http.MaxBytesReader(w, r.Body, 2<<20)
	if err := httpx.Decode(r, &in); err != nil {
		httpx.Fail(w, r, err)
		return
	}
	ctx := r.Context()
	tx, err := s.DB.BeginTx(ctx, nil)
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	defer tx.Rollback()
	// the team row serialises concurrent saves (the open request may not exist yet)
	if _, err := tx.ExecContext(ctx, `SELECT 1 FROM teams WHERE id = $1 FOR UPDATE`, ts.TeamID); err != nil {
		httpx.Fail(w, r, err)
		return
	}
	req, err := openRequest(ctx, tx, ts.TeamID, true)
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	if req != nil && req.Status == "submitted" {
		httpx.Fail(w, r, errCabLocked)
		return
	}
	live, err := loadLiveDoc(ctx, tx, ts.TeamID)
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	clean, err := s.sanitizeDoc(in.Draft, live, s.cabFileExists(ts.TeamID))
	if err != nil {
		httpx.Fail(w, r, httpx.BadRequest(err.Error()))
		return
	}
	body, _ := json.Marshal(clean)
	changed := len(diffDoc(live, &clean)) > 0
	switch {
	case req == nil && changed:
		var id int64
		if err := tx.QueryRowContext(ctx, `INSERT INTO team_change_requests (team_id, draft) VALUES ($1, $2) RETURNING id`, ts.TeamID, body).Scan(&id); err != nil {
			httpx.Fail(w, r, err)
			return
		}
	case req != nil && req.Status == "draft" && !changed:
		// everything was undone: no draft any more
		if _, err := tx.ExecContext(ctx, `DELETE FROM team_change_requests WHERE id = $1`, req.ID); err != nil {
			httpx.Fail(w, r, err)
			return
		}
	case req != nil:
		if _, err := tx.ExecContext(ctx, `UPDATE team_change_requests SET draft = $2, updated_at = now() WHERE id = $1`, req.ID, body); err != nil {
			httpx.Fail(w, r, err)
			return
		}
	}
	if err := tx.Commit(); err != nil {
		httpx.Fail(w, r, err)
		return
	}
	s.writeTeamView(w, r, 200)
}

func (s *Server) teamDiscardDraft(w http.ResponseWriter, r *http.Request) {
	ts := teamFrom(r.Context())
	ctx := r.Context()
	req, err := openRequest(ctx, s.DB, ts.TeamID, false)
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	switch {
	case req == nil:
	case req.Status == "submitted":
		httpx.Fail(w, r, errCabLocked)
		return
	case req.Status == "draft":
		_, err = s.DB.ExecContext(ctx, `DELETE FROM team_change_requests WHERE id = $1 AND status = 'draft'`, req.ID)
	default: // changes: the team gives up this round
		_, err = s.DB.ExecContext(ctx, `UPDATE team_change_requests SET status = 'withdrawn', updated_at = now() WHERE id = $1 AND status = 'changes'`, req.ID)
		if err == nil {
			s.cabEvent(ctx, ts.TeamID, &req.ID, "withdrawn", "Jamoa so‘rovni bekor qildi", nil)
		}
	}
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	s.writeTeamView(w, r, 200)
}

func (s *Server) teamSubmit(w http.ResponseWriter, r *http.Request) {
	ts := teamFrom(r.Context())
	ctx := r.Context()
	tx, err := s.DB.BeginTx(ctx, nil)
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	defer tx.Rollback()
	req, err := openRequest(ctx, tx, ts.TeamID, true)
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	if req == nil {
		httpx.Fail(w, r, httpx.NewError(http.StatusConflict, "empty", "O‘zgarish yo‘q — avval nimanidir o‘zgartiring"))
		return
	}
	if req.Status == "submitted" {
		httpx.Fail(w, r, httpx.NewError(http.StatusConflict, "state", "So‘rov allaqachon yuborilgan"))
		return
	}
	live, err := loadLiveDoc(ctx, tx, ts.TeamID)
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	items := diffDoc(live, &req.Draft)
	idx, err := s.playerIndex(ctx)
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	if checks := checkDoc(ts.TeamID, &req.Draft, items, idx); cabHasErrors(checks) {
		httpx.JSON(w, http.StatusUnprocessableEntity, map[string]any{"error": httpx.NewError(422, "invalid", "Yuborishdan oldin xatolarni tuzating"), "checks": checks})
		return
	}
	body, _ := json.Marshal(items)
	if _, err := tx.ExecContext(ctx, `UPDATE team_change_requests SET status = 'submitted', items = $2, submitted_at = now(), submitted_by = $3, updated_at = now()
		WHERE id = $1`, req.ID, body, ts.Login); err != nil {
		httpx.Fail(w, r, err)
		return
	}
	if err := tx.Commit(); err != nil {
		httpx.Fail(w, r, err)
		return
	}
	note := fmt.Sprintf("%d band", len(items))
	if req.Status == "changes" {
		note += " · tuzatilgandan keyin"
	}
	s.cabEvent(ctx, ts.TeamID, &req.ID, "submitted", note, nil)
	s.writeTeamView(w, r, 200)
}

func (s *Server) teamWithdraw(w http.ResponseWriter, r *http.Request) {
	ts := teamFrom(r.Context())
	ctx := r.Context()
	res, err := s.DB.ExecContext(ctx, `UPDATE team_change_requests SET status = 'draft', items = '[]', updated_at = now()
		WHERE team_id = $1 AND status = 'submitted'`, ts.TeamID)
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	if n, _ := res.RowsAffected(); n == 0 {
		httpx.Fail(w, r, httpx.NewError(http.StatusConflict, "state", "Tekshiruvdagi so‘rov yo‘q"))
		return
	}
	if req, _ := openRequest(ctx, s.DB, ts.TeamID, false); req != nil {
		s.cabEvent(ctx, ts.TeamID, &req.ID, "withdrawn", "Jamoa tahrirlash uchun qaytarib oldi", nil)
	}
	s.writeTeamView(w, r, 200)
}

// ---------- files ----------

func (s *Server) teamUpload(w http.ResponseWriter, r *http.Request) {
	ts := teamFrom(r.Context())
	if req, err := openRequest(r.Context(), s.DB, ts.TeamID, false); err != nil {
		httpx.Fail(w, r, err)
		return
	} else if req != nil && req.Status == "submitted" {
		httpx.Fail(w, r, errCabLocked)
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, 11<<20)
	kind := r.FormValue("kind")
	file, hdr, err := r.FormFile("file")
	if err != nil {
		httpx.Fail(w, r, httpx.BadRequest("Fayl topilmadi yoki 10 MB dan katta"))
		return
	}
	defer file.Close()
	head := make([]byte, 512)
	n, _ := io.ReadFull(file, head)
	switch kind {
	case "logo", "photo", "kit":
		img := photoKind(head[:n])
		if img != "jpg" && img != "png" && img != "webp" && img != "heic" {
			httpx.Fail(w, r, httpx.BadRequest("Faqat JPG, PNG yoki WebP rasm"))
			return
		}
		s.regUploadImage(w, r, io.MultiReader(bytes.NewReader(head[:n]), file), img)
		return
	case "medical":
	default:
		httpx.Fail(w, r, httpx.BadRequest("kind: logo, photo, kit yoki medical"))
		return
	}
	ext, ok := medicalTypes[sniff(head[:n])]
	if !ok {
		httpx.Fail(w, r, httpx.BadRequest("Faqat PDF, JPG yoki PNG"))
		return
	}
	dir := s.cabDir(ts.TeamID)
	if err := os.MkdirAll(dir, 0o750); err != nil {
		httpx.Fail(w, r, err)
		return
	}
	name := randomName(ext)
	full := filepath.Join(dir, name)
	dst, err := os.Create(full)
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	_, werr := dst.Write(head[:n])
	if werr == nil {
		_, werr = io.Copy(dst, file)
	}
	dst.Close()
	if werr != nil {
		os.Remove(full)
		httpx.Fail(w, r, httpx.BadRequest("Fayl 10 MB dan katta"))
		return
	}
	httpx.JSON(w, http.StatusCreated, roster.File{File: name, Name: clip(sanitizeFilename(hdr.Filename), 120)})
}

func (s *Server) serveCabFile(w http.ResponseWriter, r *http.Request, teamID int64, name string) {
	if !reMedicalFile.MatchString(name) {
		httpx.Fail(w, r, httpx.ErrNotFound)
		return
	}
	full := filepath.Join(s.cabDir(teamID), name)
	if _, err := os.Stat(full); err != nil {
		httpx.Fail(w, r, httpx.ErrNotFound)
		return
	}
	w.Header().Set("Cache-Control", "private, no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Content-Disposition", `inline; filename="`+name+`"`)
	http.ServeFile(w, r, full)
}

func (s *Server) teamFile(w http.ResponseWriter, r *http.Request) {
	s.serveCabFile(w, r, teamFrom(r.Context()).TeamID, chi.URLParam(r, "file"))
}

// teamImport reads a TARKIB.xlsx; the site adds the rows to the draft as new people.
func (s *Server) teamImport(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, 6<<20)
	file, _, err := r.FormFile("file")
	if err != nil {
		httpx.Fail(w, r, httpx.BadRequest("Fayl topilmadi yoki 5 MB dan katta"))
		return
	}
	defer file.Close()
	data, err := io.ReadAll(io.LimitReader(file, 6<<20))
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	wb, err := xlsx.Read(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		httpx.Fail(w, r, httpx.BadRequest("Faylni o‘qib bo‘lmadi: .xlsx formatidagi TARKIB faylini yuklang"))
		return
	}
	imp := roster.ParseTarkib(wb.Rows)
	if len(imp.Players)+len(imp.Staff) == 0 {
		httpx.Fail(w, r, httpx.BadRequest("Faylda o‘yinchilar topilmadi: ustunlar «ISM» va «FAMILIYA» bo‘lishi kerak"))
		return
	}
	httpx.JSON(w, 200, map[string]any{"import": imp})
}
