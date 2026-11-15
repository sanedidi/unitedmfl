package api

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"math/big"
	"net/http"
	"os"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/lib/pq"

	"github.com/sanedidi/unitedmfl/backend/internal/auth"
	"github.com/sanedidi/unitedmfl/backend/internal/httpx"
	"github.com/sanedidi/unitedmfl/backend/internal/roster"
	"github.com/sanedidi/unitedmfl/backend/internal/xlsx"
)

// Admin side of team self-registration (Arizalar): links and applications.

func (s *Server) mountRegistrationAdmin(r chi.Router) {
	r.Group(func(r chi.Router) {
		r.Use(s.can(auth.PermApplications))
		h := s.crud(regLinksRes)
		r.Get("/registration/config", s.regConfig)
		r.Get("/registration/links", s.adminLinks)
		r.Post("/registration/links", h.create)
		r.Get("/registration/links/{id}", s.adminLink)
		r.Patch("/registration/links/{id}", h.patch)
		r.Delete("/registration/links/{id}", s.deleteLink)
		r.Post("/registration/links/{id}/regenerate", s.regenerateLink)

		r.Get("/applications", s.adminApplications)
		r.Get("/applications/{id}", s.adminApplication)
		r.Patch("/applications/{id}", s.patchApplication)
		r.Delete("/applications/{id}", s.deleteApplication)
		r.Post("/applications/{id}/review", s.reviewApplication)
		r.Post("/applications/{id}/approve", s.approveApplication)
		r.Post("/applications/{id}/request-changes", s.requestChanges)
		r.Post("/applications/{id}/reject", s.rejectApplication)
		r.Get("/applications/{id}/export.xlsx", s.exportApplication)
		r.Get("/applications/{id}/files/{file}", s.adminAppFile)
	})
}

// ---------- links ----------

var reLinkCode = regexp.MustCompile(`^[A-Z0-9]{4,16}$`)

var regLinksRes = &resource{table: "registration_links", entity: "registration_link", touch: true, order: "id DESC",
	fields: map[string]field{"code": {kind: kText, max: 16, pattern: reLinkCode}, "title": reqTxt(120), "season_id": optInt, "stage_id": optInt,
		"kind": enum("multi", "single"), "is_active": boolean, "is_default": boolean, "opens_at": optTime, "closes_at": optTime,
		"max_teams": optInt, "min_players": {kind: kInt}, "max_players": {kind: kInt}, "min_age": optInt,
		"require_logo": boolean, "require_photo": boolean, "require_medical": boolean, "require_phone": boolean, "check_duplicates": boolean,
		"heading": txt(160), "description": txt(2000), "rules_url": txt(500)},
	prepare: prepareRegLink}

const codeAlphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789" // no 0/O, 1/I

func newLinkCode() string {
	b := make([]byte, 6)
	for i := range b {
		n, _ := rand.Int(rand.Reader, big.NewInt(int64(len(codeAlphabet))))
		b[i] = codeAlphabet[n.Int64()]
	}
	return string(b)
}

func prepareRegLink(ctx context.Context, s *Server, body map[string]any, creating bool) error {
	if v, ok := body["code"].(string); ok {
		body["code"] = strings.ToUpper(strings.TrimSpace(v))
		if body["code"] == "" {
			delete(body, "code")
		}
	}
	if creating {
		if _, ok := body["code"]; !ok {
			body["code"] = newLinkCode()
		}
		if _, ok := body["season_id"]; !ok {
			var id int64
			if err := s.DB.QueryRowContext(ctx, `SELECT id FROM seasons ORDER BY is_active DESC, id DESC LIMIT 1`).Scan(&id); err == nil {
				body["season_id"] = json.Number(strconv.FormatInt(id, 10))
			}
		}
	}
	minP, okMin := body["min_players"].(json.Number)
	maxP, okMax := body["max_players"].(json.Number)
	if okMin && okMax {
		a, _ := minP.Int64()
		b, _ := maxP.Int64()
		if a > b {
			return httpx.Validation(map[string]any{"min_players": "maksimaldan katta bo‘lmasin"})
		}
	}
	if v, ok := body["is_default"].(bool); ok && v {
		// only one link is shown on the registration site's root page
		if _, err := s.DB.ExecContext(ctx, `UPDATE registration_links SET is_default = false WHERE is_default`); err != nil {
			return err
		}
	}
	return nil
}

func (s *Server) regConfig(w http.ResponseWriter, r *http.Request) {
	provider := ""
	switch s.sms.(type) {
	case devSMS:
		provider = "dev"
	default:
		if s.sms.Enabled() {
			provider = "eskiz"
		}
	}
	httpx.JSON(w, 200, map[string]any{"register_url": s.Cfg.RegisterURL, "sms": provider})
}

func (s *Server) adminLinkJSON(l *regLink) map[string]any {
	url := ""
	if s.Cfg.RegisterURL != "" {
		url = s.Cfg.RegisterURL + "/" + l.Code
	}
	return map[string]any{
		"id": l.ID, "code": l.Code, "title": l.Title, "season_id": l.SeasonID, "stage_id": l.StageID, "kind": l.Kind,
		"is_active": l.IsActive, "is_default": l.IsDefault, "opens_at": l.OpensAt, "closes_at": l.ClosesAt,
		"max_teams": l.MaxTeams, "min_players": l.MinPlayers, "max_players": l.MaxPlayers, "min_age": l.MinAge,
		"require_logo": l.RequireLogo, "require_photo": l.RequirePhoto, "require_medical": l.RequireMedical,
		"require_phone": l.RequirePhone, "check_duplicates": l.CheckDuplicates,
		"heading": l.Heading, "description": l.Description, "rules_url": l.RulesURL,
		"season": l.SeasonName, "stage": l.StageName, "state": l.state(time.Now()), "url": url,
		"approved": l.Approved, "sent": l.Sent, "drafts": l.Drafts, "slots_left": l.slotsLeft(),
		"created_at": l.CreatedAt, "updated_at": l.UpdatedAt,
	}
}

func (s *Server) adminLinks(w http.ResponseWriter, r *http.Request) {
	rows, err := s.DB.QueryContext(r.Context(), linkSelect+` ORDER BY l.is_default DESC, l.is_active DESC, l.id DESC`)
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	defer rows.Close()
	items := []map[string]any{}
	for rows.Next() {
		l, err := scanLink(rows)
		if err != nil {
			httpx.Fail(w, r, err)
			return
		}
		items = append(items, s.adminLinkJSON(l))
	}
	httpx.JSON(w, 200, map[string]any{"items": items, "total": len(items)})
}

func (s *Server) adminLink(w http.ResponseWriter, r *http.Request) {
	id, err := idParam(r, "id")
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	l, err := s.linkByID(r.Context(), id)
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	httpx.JSON(w, 200, s.adminLinkJSON(l))
}

func (s *Server) deleteLink(w http.ResponseWriter, r *http.Request) {
	id, err := idParam(r, "id")
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	l, err := s.linkByID(r.Context(), id)
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	var used int
	_ = s.DB.QueryRowContext(r.Context(), `SELECT count(*) FROM team_applications WHERE link_id = $1 AND status <> 'draft'`, id).Scan(&used)
	if used > 0 {
		httpx.Fail(w, r, httpx.NewError(http.StatusConflict, "in_use", "Bu havola orqali arizalar yuborilgan — o‘chirish o‘rniga to‘xtating"))
		return
	}
	ids := s.draftIDs(r.Context(), id)
	if _, err := s.DB.ExecContext(r.Context(), `DELETE FROM team_applications WHERE link_id = $1 AND status = 'draft'`, id); err != nil {
		httpx.Fail(w, r, err)
		return
	}
	for _, aid := range ids {
		_ = os.RemoveAll(s.appDir(aid))
	}
	if _, err := s.DB.ExecContext(r.Context(), `DELETE FROM registration_links WHERE id = $1`, id); err != nil {
		httpx.Fail(w, r, dbError(err))
		return
	}
	s.audit(r, "delete", "registration_link", id, map[string]any{"code": l.Code})
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) draftIDs(ctx context.Context, linkID int64) []int64 {
	rows, err := s.DB.QueryContext(ctx, `SELECT id FROM team_applications WHERE link_id = $1 AND status = 'draft'`, linkID)
	if err != nil {
		return nil
	}
	defer rows.Close()
	var out []int64
	for rows.Next() {
		var id int64
		if rows.Scan(&id) == nil {
			out = append(out, id)
		}
	}
	return out
}

// regenerateLink gives the link a new code: the old address stops working,
// started drafts keep their own /a/{token} address.
func (s *Server) regenerateLink(w http.ResponseWriter, r *http.Request) {
	id, err := idParam(r, "id")
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	var code string
	for i := 0; i < 5; i++ {
		err = s.DB.QueryRowContext(r.Context(), `UPDATE registration_links SET code = $2, updated_at = now() WHERE id = $1 RETURNING code`, id, newLinkCode()).Scan(&code)
		if err == nil || errors.Is(err, sql.ErrNoRows) {
			break
		}
	}
	if errors.Is(err, sql.ErrNoRows) {
		httpx.Fail(w, r, httpx.ErrNotFound)
		return
	}
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	s.audit(r, "regenerate", "registration_link", id, map[string]any{"code": code})
	l, err := s.linkByID(r.Context(), id)
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	httpx.JSON(w, 200, s.adminLinkJSON(l))
}

// ---------- applications ----------

var appStatuses = []string{"draft", "submitted", "review", "changes", "approved", "rejected"}

func (s *Server) loadApp(ctx context.Context, id int64) (*application, *regLink, error) {
	s.expireApplications(ctx)
	a, err := scanApp(s.DB.QueryRowContext(ctx, appSelect+` WHERE id = $1`, id))
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil, httpx.ErrNotFound
	}
	if err != nil {
		return nil, nil, err
	}
	var l *regLink
	if a.LinkID != nil {
		if l, err = s.linkByID(ctx, *a.LinkID); err != nil && !errors.Is(err, httpx.ErrNotFound) {
			return nil, nil, err
		}
	}
	return a, l, nil
}

func countChecks(cs []appCheck) (errs, warns int) {
	for _, c := range cs {
		if c.Level == "error" {
			errs++
		} else {
			warns++
		}
	}
	return
}

func (s *Server) adminApplications(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	s.expireApplications(ctx)
	limit, offset := pageParams(r)
	q := r.URL.Query()
	var where []string
	var args []any
	switch st := q.Get("status"); {
	case st == "":
		where = append(where, "status <> 'draft'")
	case st == "active":
		where = append(where, "status IN ('submitted', 'review', 'changes')")
	case contains(appStatuses, st):
		args = append(args, st)
		where = append(where, fmt.Sprintf("status = $%d", len(args)))
	default:
		httpx.Fail(w, r, httpx.BadRequest("status noto‘g‘ri"))
		return
	}
	if v := q.Get("link_id"); v != "" {
		args = append(args, v)
		where = append(where, fmt.Sprintf("link_id::text = $%d", len(args)))
	}
	if term := strings.TrimSpace(q.Get("q")); term != "" {
		args = append(args, "%"+term+"%")
		n := len(args)
		where = append(where, fmt.Sprintf("(team->>'name' ILIKE $%[1]d OR rep->>'name' ILIKE $%[1]d OR rep->>'phone' ILIKE $%[1]d OR rep_phone ILIKE $%[1]d)", n))
	}
	wsql := "WHERE " + strings.Join(where, " AND ")
	var total int
	if err := s.DB.QueryRowContext(ctx, `SELECT count(*) FROM team_applications `+wsql, args...).Scan(&total); err != nil {
		httpx.Fail(w, r, err)
		return
	}
	args = append(args, limit, offset)
	rows, err := s.DB.QueryContext(ctx, appSelect+` `+wsql+fmt.Sprintf(` ORDER BY CASE WHEN status IN ('submitted', 'review') THEN 0 ELSE 1 END,
		coalesce(submitted_at, updated_at) DESC LIMIT $%d OFFSET $%d`, len(args)-1, len(args)), args...)
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	var apps []*application
	for rows.Next() {
		a, err := scanApp(rows)
		if err != nil {
			rows.Close()
			httpx.Fail(w, r, err)
			return
		}
		apps = append(apps, a)
	}
	rows.Close()
	idx, err := s.playerIndex(ctx)
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	links := map[int64]*regLink{}
	items := []map[string]any{}
	for _, a := range apps {
		var l *regLink
		if a.LinkID != nil {
			if l = links[*a.LinkID]; l == nil {
				if l, _ = s.linkByID(ctx, *a.LinkID); l != nil {
					links[*a.LinkID] = l
				}
			}
		}
		env, err := s.checkEnvFor(ctx, a, l, idx)
		if err != nil {
			httpx.Fail(w, r, err)
			return
		}
		errs, warns := countChecks(checkApplication(a, l, env))
		media := 0
		for _, p := range a.Players {
			if p.Role == roster.RoleMedia {
				media++
			}
		}
		var link any
		if l != nil {
			link = map[string]any{"id": l.ID, "title": l.Title, "code": l.Code}
		}
		items = append(items, map[string]any{
			"id": a.ID, "number": a.number(), "status": a.Status,
			"team": map[string]any{"name": a.Team.Name, "short_name": a.Team.ShortName, "crest_url": a.Team.CrestURL, "colors": a.Team.Colors},
			"rep":  map[string]any{"name": a.Rep.Name, "phone": a.Rep.Phone}, "phone_verified": a.PhoneVerifiedAt != nil,
			"players": len(a.Players) - media, "media": media, "staff": len(a.Staff), "link": link,
			"errors": errs, "warnings": warns, "team_id": a.TeamID, "changes_deadline": a.ChangesDeadline,
			"submitted_at": a.SubmittedAt, "updated_at": a.UpdatedAt, "created_at": a.CreatedAt,
		})
	}
	counts := map[string]int{}
	crow, err := s.DB.QueryContext(ctx, `SELECT status, count(*) FROM team_applications GROUP BY status`)
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
	httpx.JSON(w, 200, map[string]any{"items": items, "total": total, "counts": counts})
}

func (s *Server) adminApplication(w http.ResponseWriter, r *http.Request) {
	id, err := idParam(r, "id")
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	ctx := r.Context()
	a, l, err := s.loadApp(ctx, id)
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	env, err := s.checkEnvFor(ctx, a, l, nil)
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	dups := []map[string]any{}
	if env.Players != nil {
		for i, p := range a.Players {
			if m := env.Players[roster.NameKey(p.FirstName, p.LastName)]; len(m) > 0 {
				dups = append(dups, map[string]any{"index": i, "matches": m})
			}
		}
	}
	events := []map[string]any{}
	rows, err := s.DB.QueryContext(ctx, `SELECT e.kind, e.note, e.created_at, coalesce(u.name, '') FROM application_events e
		LEFT JOIN users u ON u.id = e.user_id WHERE e.application_id = $1 ORDER BY e.id DESC LIMIT 100`, id)
	if err == nil {
		for rows.Next() {
			var kind, note, user string
			var at time.Time
			if rows.Scan(&kind, &note, &at, &user) == nil {
				events = append(events, map[string]any{"kind": kind, "note": note, "created_at": at, "user": user})
			}
		}
		rows.Close()
	}
	var team any
	if a.TeamID != nil {
		var tid int64
		var slug, name string
		if s.DB.QueryRowContext(ctx, `SELECT id, slug, name FROM teams WHERE id = $1`, *a.TeamID).Scan(&tid, &slug, &name) == nil {
			team = map[string]any{"id": tid, "slug": slug, "name": name}
		}
	}
	var link any
	if l != nil {
		link = s.adminLinkJSON(l)
	}
	repURL := ""
	if s.Cfg.RegisterURL != "" {
		repURL = s.Cfg.RegisterURL + "/a/" + a.Token
	}
	httpx.JSON(w, 200, map[string]any{
		"id": a.ID, "number": a.number(), "status": a.Status, "link": link,
		"team": a.Team, "rep": a.Rep, "players": a.Players, "staff": a.Staff, "consents": a.Consents,
		"phone_verified": a.PhoneVerifiedAt != nil, "phone_verified_at": a.PhoneVerifiedAt, "otp_required": env.OTPRequired,
		"comments": a.Comments, "changes_deadline": a.ChangesDeadline, "reject_reason": a.RejectReason, "internal_note": a.InternalNote,
		"submitted_at": a.SubmittedAt, "decided_at": a.DecidedAt, "created_at": a.CreatedAt, "updated_at": a.UpdatedAt,
		"checks": checkApplication(a, l, env), "duplicates": dups, "events": events, "created_team": team, "rep_url": repURL,
	})
}

func (s *Server) patchApplication(w http.ResponseWriter, r *http.Request) {
	id, err := idParam(r, "id")
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	var in struct {
		InternalNote string `json:"internal_note"`
	}
	if err := httpx.Decode(r, &in); err != nil {
		httpx.Fail(w, r, err)
		return
	}
	res, err := s.DB.ExecContext(r.Context(), `UPDATE team_applications SET internal_note = $2, updated_at = now() WHERE id = $1`, id, clip(in.InternalNote, 2000))
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	if n, _ := res.RowsAffected(); n == 0 {
		httpx.Fail(w, r, httpx.ErrNotFound)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) deleteApplication(w http.ResponseWriter, r *http.Request) {
	id, err := idParam(r, "id")
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	res, err := s.DB.ExecContext(r.Context(), `DELETE FROM team_applications WHERE id = $1 AND status IN ('draft', 'rejected')`, id)
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	if n, _ := res.RowsAffected(); n == 0 {
		httpx.Fail(w, r, httpx.NewError(http.StatusConflict, "in_use", "Faqat qoralama yoki rad etilgan arizani o‘chirish mumkin"))
		return
	}
	_ = os.RemoveAll(s.appDir(id))
	s.audit(r, "delete", "application", id, nil)
	w.WriteHeader(http.StatusNoContent)
}

func userID(r *http.Request) *int64 {
	if c := claimsFrom(r.Context()); c != nil {
		return &c.UserID
	}
	return nil
}

func (s *Server) reviewApplication(w http.ResponseWriter, r *http.Request) {
	id, err := idParam(r, "id")
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	res, err := s.DB.ExecContext(r.Context(), `UPDATE team_applications SET status = 'review', updated_at = now() WHERE id = $1 AND status = 'submitted'`, id)
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	if n, _ := res.RowsAffected(); n > 0 {
		s.appEvent(r.Context(), id, "review", "", userID(r))
	}
	w.WriteHeader(http.StatusNoContent)
}

// notifyRep sends a short SMS about a decision (best effort).
func (s *Server) notifyRep(a *application, text string) {
	if a.RepPhone == "" || !s.sms.Enabled() {
		return
	}
	if s.Cfg.RegisterURL != "" {
		text += " " + s.Cfg.RegisterURL + "/a/" + a.Token
	}
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
		defer cancel()
		if err := s.sms.Send(ctx, a.RepPhone, text); err != nil {
			slog.Warn("registration notice", "err", err)
		}
	}()
}

type requestChangesInput struct {
	Comments []appComment `json:"comments"`
	Days     int          `json:"days"`
	Notify   bool         `json:"notify"`
}

func (s *Server) requestChanges(w http.ResponseWriter, r *http.Request) {
	id, err := idParam(r, "id")
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	var in requestChangesInput
	if err := httpx.Decode(r, &in); err != nil {
		httpx.Fail(w, r, err)
		return
	}
	var comments []appComment
	for _, c := range in.Comments {
		c.Text = clip(c.Text, 1000)
		if c.Text == "" {
			continue
		}
		if c.Section != "team" && c.Section != "rep" && c.Section != "roster" {
			httpx.Fail(w, r, httpx.BadRequest("Bo‘lim: team, rep yoki roster"))
			return
		}
		comments = append(comments, c)
	}
	if len(comments) == 0 {
		httpx.Fail(w, r, httpx.Validation(map[string]any{"comments": "Kamida bitta izoh yozing"}))
		return
	}
	if in.Days <= 0 {
		in.Days = 7
	}
	if in.Days > 60 {
		in.Days = 60
	}
	a, _, err := s.loadApp(r.Context(), id)
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	if a.Status != "submitted" && a.Status != "review" {
		httpx.Fail(w, r, httpx.NewError(http.StatusConflict, "state", "Bu holatdagi arizani tuzatishga qaytarib bo‘lmaydi"))
		return
	}
	cj, _ := json.Marshal(comments)
	deadline := time.Now().Add(time.Duration(in.Days) * 24 * time.Hour)
	if _, err := s.DB.ExecContext(r.Context(), `UPDATE team_applications SET status = 'changes', comments = $2, changes_deadline = $3,
		updated_at = now() WHERE id = $1`, id, cj, deadline); err != nil {
		httpx.Fail(w, r, err)
		return
	}
	var notes []string
	for _, c := range comments {
		notes = append(notes, c.Text)
	}
	s.appEvent(r.Context(), id, "changes", strings.Join(notes, "\n"), userID(r))
	s.audit(r, "request_changes", "application", id, map[string]any{"comments": len(comments), "days": in.Days})
	if in.Notify {
		s.notifyRep(a, "United MFL: jamoa arizasida tuzatish kerak.")
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) rejectApplication(w http.ResponseWriter, r *http.Request) {
	id, err := idParam(r, "id")
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	var in struct {
		Reason string `json:"reason"`
		Notify bool   `json:"notify"`
	}
	if err := httpx.Decode(r, &in); err != nil {
		httpx.Fail(w, r, err)
		return
	}
	if in.Reason = clip(in.Reason, 1000); in.Reason == "" {
		httpx.Fail(w, r, httpx.Validation(map[string]any{"reason": "Sababini yozing — vakil uni ko‘radi"}))
		return
	}
	a, _, err := s.loadApp(r.Context(), id)
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	if a.Status != "submitted" && a.Status != "review" && a.Status != "changes" {
		httpx.Fail(w, r, httpx.NewError(http.StatusConflict, "state", "Bu holatdagi arizani rad etib bo‘lmaydi"))
		return
	}
	if _, err := s.DB.ExecContext(r.Context(), `UPDATE team_applications SET status = 'rejected', reject_reason = $2, decided_at = now(),
		decided_by = $3, updated_at = now() WHERE id = $1`, id, in.Reason, userID(r)); err != nil {
		httpx.Fail(w, r, err)
		return
	}
	s.appEvent(r.Context(), id, "rejected", in.Reason, userID(r))
	s.audit(r, "reject", "application", id, nil)
	if in.Notify {
		s.notifyRep(a, "United MFL: jamoa arizasi rad etildi.")
	}
	w.WriteHeader(http.StatusNoContent)
}

type approveInput struct {
	GroupID *int64 `json:"group_id"`
	// player index → existing player id to move into the new team; -1 = leave
	// the person out; absent / 0 = create a new player
	Players map[string]int64 `json:"players"`
	Notify  bool             `json:"notify"`
}

func (s *Server) approveApplication(w http.ResponseWriter, r *http.Request) {
	id, err := idParam(r, "id")
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	var in approveInput
	if err := httpx.Decode(r, &in); err != nil {
		httpx.Fail(w, r, err)
		return
	}
	ctx := r.Context()
	a, l, err := s.loadApp(ctx, id)
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	if a.Status != "submitted" && a.Status != "review" {
		httpx.Fail(w, r, httpx.NewError(http.StatusConflict, "state", "Faqat yuborilgan yoki ko‘rib chiqilayotgan arizani tasdiqlash mumkin"))
		return
	}
	env, err := s.checkEnvFor(ctx, a, l, nil)
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	env.OTPRequired = false // the admin has already seen whether the phone was confirmed
	if checks := checkApplication(a, l, env); hasErrors(checks) {
		httpx.JSON(w, http.StatusUnprocessableEntity, map[string]any{"error": httpx.NewError(422, "invalid", "Arizada xatolar bor — tasdiqlashdan oldin tuzatishga qaytaring"), "checks": checks})
		return
	}
	// a transfer is allowed only for a player that really matches by name
	for k, pid := range in.Players {
		i, err := strconv.Atoi(k)
		if err != nil || i < 0 || i >= len(a.Players) {
			httpx.Fail(w, r, httpx.BadRequest("players: indeks noto‘g‘ri"))
			return
		}
		if pid > 0 {
			ok := false
			for _, m := range env.Players[roster.NameKey(a.Players[i].FirstName, a.Players[i].LastName)] {
				ok = ok || m.PlayerID == pid
			}
			if !ok {
				httpx.Fail(w, r, httpx.BadRequest("players: o‘yinchi mos kelmaydi"))
				return
			}
		}
	}

	tx, err := s.DB.BeginTx(ctx, nil)
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	defer tx.Rollback()
	var status string
	if err := tx.QueryRowContext(ctx, `SELECT status FROM team_applications WHERE id = $1 FOR UPDATE`, id).Scan(&status); err != nil {
		httpx.Fail(w, r, err)
		return
	}
	if status != a.Status {
		httpx.Fail(w, r, httpx.NewError(http.StatusConflict, "state", "Ariza holati o‘zgardi — sahifani yangilang"))
		return
	}
	slug := teamSlug(a.Team.Name)
	for i := 2; ; i++ {
		var taken bool
		if err := tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM teams WHERE slug = $1)`, slug).Scan(&taken); err != nil {
			httpx.Fail(w, r, err)
			return
		}
		if !taken {
			break
		}
		slug = teamSlug(a.Team.Name) + "-" + strconv.Itoa(i)
	}
	var teamID int64
	if err := tx.QueryRowContext(ctx, `INSERT INTO teams (slug, name, short_name, crest_url, colors, leader, instagram, telegram, is_active, group_id)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, true, $9) RETURNING id`,
		slug, a.Team.Name, a.Team.ShortName, a.Team.CrestURL, pq.Array(a.Team.Colors), a.Rep.Name, a.Team.Instagram, a.Rep.Telegram, in.GroupID).Scan(&teamID); err != nil {
		httpx.Fail(w, r, dbError(err))
		return
	}
	created, moved := 0, 0
	for i, p := range a.Players {
		action := in.Players[strconv.Itoa(i)]
		if action < 0 {
			continue
		}
		pos := ""
		if p.Role == roster.RoleGoalkeeper {
			pos = "GK"
		}
		medical := ""
		if p.Medical != nil && p.Medical.File != "" {
			medical = fmt.Sprintf("/api/v1/admin/applications/%d/files/%s", a.ID, p.Medical.File)
		}
		var birth any
		if p.BirthDate != "" {
			birth = p.BirthDate
		}
		if action > 0 {
			if _, err := tx.ExecContext(ctx, `UPDATE players SET team_id = $2, number = $3, position = $4,
				photo_url = CASE WHEN $5 <> '' THEN $5 ELSE photo_url END, birth_date = $6, jersey_name = $7, kit_size = $8,
				workplace = $9, is_media = $10, medical_url = CASE WHEN $11 <> '' THEN $11 ELSE medical_url END, is_active = true, updated_at = now()
				WHERE id = $1`, action, teamID, p.Number, pos, p.PhotoURL, birth, p.JerseyName, p.KitSize, p.Workplace, p.Role == roster.RoleMedia, medical); err != nil {
				httpx.Fail(w, r, dbError(err))
				return
			}
			moved++
			continue
		}
		if _, err := tx.ExecContext(ctx, `INSERT INTO players (team_id, full_name, number, position, photo_url, birth_date, jersey_name, kit_size, workplace, is_media, medical_url)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
			teamID, p.FullName(), p.Number, pos, p.PhotoURL, birth, p.JerseyName, p.KitSize, p.Workplace, p.Role == roster.RoleMedia, medical); err != nil {
			httpx.Fail(w, r, dbError(err))
			return
		}
		created++
	}
	for i, st := range a.Staff {
		var birth any
		if st.BirthDate != "" {
			birth = st.BirthDate
		}
		if _, err := tx.ExecContext(ctx, `INSERT INTO team_staff (team_id, full_name, role, birth_date, kit_size, ord) VALUES ($1, $2, $3, $4, $5, $6)`,
			teamID, st.FullName(), st.Role, birth, st.KitSize, i+1); err != nil {
			httpx.Fail(w, r, dbError(err))
			return
		}
	}
	if _, err := tx.ExecContext(ctx, `UPDATE team_applications SET status = 'approved', team_id = $2, decided_at = now(), decided_by = $3,
		comments = '[]', changes_deadline = NULL, updated_at = now() WHERE id = $1`, id, teamID, userID(r)); err != nil {
		httpx.Fail(w, r, err)
		return
	}
	if err := tx.Commit(); err != nil {
		httpx.Fail(w, r, err)
		return
	}
	note := fmt.Sprintf("Jamoa yaratildi: %s · yangi o‘yinchilar %d, ko‘chirilgan %d, shtab %d", a.Team.Name, created, moved, len(a.Staff))
	s.appEvent(ctx, id, "approved", note, userID(r))
	s.audit(r, "approve", "application", id, map[string]any{"team_id": teamID, "players": created, "moved": moved})
	if in.Notify {
		s.notifyRep(a, "United MFL: «"+a.Team.Name+"» jamoasi arizasi tasdiqlandi!")
	}
	httpx.JSON(w, 200, map[string]any{"team_id": teamID, "slug": slug, "players_created": created, "players_moved": moved, "staff": len(a.Staff)})
}

func (s *Server) exportApplication(w http.ResponseWriter, r *http.Request) {
	id, err := idParam(r, "id")
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	a, _, err := s.loadApp(r.Context(), id)
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	b, err := xlsx.Write(roster.ExportTarkib(a.Team.Name, a.Players, a.Staff))
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	name := "TARKIB"
	if a.Team.ShortName != "" {
		name += "-" + a.Team.ShortName
	}
	writeXLSX(w, name+".xlsx", b)
}

func (s *Server) adminAppFile(w http.ResponseWriter, r *http.Request) {
	id, err := idParam(r, "id")
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	s.serveAppFile(w, r, id, chi.URLParam(r, "file"))
}

// ---------- slugs ----------

var slugTranslit = strings.NewReplacer(
	"o‘", "o", "g‘", "g", "oʻ", "o", "gʻ", "g", "o'", "o", "g'", "g", "’", "", "‘", "", "ʻ", "", "'", "",
	"а", "a", "б", "b", "в", "v", "г", "g", "д", "d", "е", "e", "ё", "yo", "ж", "j", "з", "z", "и", "i", "й", "y",
	"к", "k", "л", "l", "м", "m", "н", "n", "о", "o", "п", "p", "р", "r", "с", "s", "т", "t", "у", "u", "ф", "f",
	"х", "x", "ц", "ts", "ч", "ch", "ш", "sh", "щ", "sh", "ъ", "", "ы", "i", "ь", "", "э", "e", "ю", "yu", "я", "ya",
	"ў", "o", "қ", "q", "ғ", "g", "ҳ", "h")

func teamSlug(name string) string {
	s := slugTranslit.Replace(strings.ToLower(strings.TrimSpace(name)))
	var b strings.Builder
	dash := false
	for _, r := range s {
		if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') {
			b.WriteRune(r)
			dash = false
		} else if !dash && b.Len() > 0 {
			b.WriteByte('-')
			dash = true
		}
	}
	out := strings.Trim(b.String(), "-")
	if len(out) > 60 {
		out = strings.Trim(out[:60], "-")
	}
	if out == "" {
		out = "jamoa"
	}
	return out
}
