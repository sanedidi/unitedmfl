package api

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/go-chi/chi/v5"

	"github.com/sanedidi/unitedmfl/backend/internal/auth"
	"github.com/sanedidi/unitedmfl/backend/internal/httpx"
	"github.com/sanedidi/unitedmfl/backend/internal/media"
)

// Media reja (Kontent → Media reja): the Instagram plan of every group, counted
// back from the group's final match. The logic lives in internal/media; the bot
// (internal/tgbot) reminds managers and takes their links.

func (s *Server) mountMedia(r chi.Router) {
	r.Group(func(r chi.Router) {
		r.Use(s.canEdit(auth.PermMedia)) // reading needs view, everything else is editing
		r.Get("/media/overview", s.mediaOverview)
		r.Get("/media/groups/{id}", s.mediaGroup)
		r.Get("/media/groups/{id}/matches", s.mediaFinalCandidates)
		r.Post("/media/groups/{id}/plan", s.mediaCreatePlan)
		r.Delete("/media/plans/{id}", s.mediaDeletePlan)
		r.Post("/media/plans/{id}/preview", s.mediaPreview)
		r.Post("/media/plans/{id}/move", s.mediaMove)
		r.Post("/media/plans/{id}/keep", s.mediaKeep)
		r.Put("/media/plans/{id}/teams", s.mediaSetTeams)
		r.Post("/media/plans/{id}/remind", s.mediaRemind)
		r.Get("/media/tasks/{id}", s.mediaTask)
		r.Patch("/media/tasks/{id}", s.mediaPatchTask)
		r.Post("/media/tasks/{id}/approve", s.mediaApprove)
		r.Post("/media/tasks/{id}/return", s.mediaReturn)
		r.Post("/media/tasks/{id}/submit", s.mediaSubmit)
		r.Get("/media/review", s.mediaReview)
		r.Post("/media/review/approve", s.mediaApproveMany)
		r.Get("/media/template", s.mediaTemplate)
		r.Put("/media/template", s.mediaSaveTemplate)
		r.Put("/media/teams/{id}/manager", s.mediaSetManager)
	})
}

// mediaNow is the clock of the media handlers (tests move it).
var mediaNow = time.Now

func actorOf(r *http.Request) (*int64, string) {
	if c := claimsFrom(r.Context()); c != nil {
		id := c.UserID
		return &id, c.Name
	}
	return nil, ""
}

// mediaErr maps the package's plain errors to 400s with their Uzbek text.
func mediaErr(err error) error {
	for _, e := range []error{media.ErrDone, media.ErrNoLink, media.ErrComment, media.ErrBadDay, media.ErrNoTeams, media.ErrNotReady} {
		if errors.Is(err, e) {
			msg := err.Error()
			return httpx.BadRequest(strings.ToUpper(msg[:1]) + msg[1:])
		}
	}
	if errors.Is(err, media.ErrNoTask) {
		return httpx.ErrNotFound
	}
	return err
}

type mediaTeam struct {
	ID           int64             `json:"id"`
	Name         string            `json:"name"`
	ShortName    string            `json:"short_name"`
	CrestURL     string            `json:"crest_url"`
	Instagram    string            `json:"instagram"`
	ManagerName  string            `json:"manager_name"`
	ManagerPhone string            `json:"manager_phone"`
	Bot          []mediaBotAccount `json:"bot"`
}

type mediaBotAccount struct {
	Username string `json:"username"`
	Name     string `json:"name"`
}

// mediaTeams loads teams by id (keeps the order of ids) with their bot links.
func (s *Server) mediaTeams(ctx context.Context, ids []int64) ([]mediaTeam, error) {
	out := []mediaTeam{}
	if len(ids) == 0 {
		return out, nil
	}
	rows, err := s.DB.QueryContext(ctx, `SELECT t.id, t.name, t.short_name, t.crest_url, t.instagram, t.manager_name, t.manager_phone,
		coalesce((SELECT json_agg(json_build_object('username', l.username, 'name', l.name) ORDER BY l.created_at)
		          FROM media_manager_links l WHERE l.team_id = t.id AND l.phone = t.manager_phone AND t.manager_phone <> ''), '[]')
		FROM teams t WHERE t.id = ANY($1::bigint[])`, pgIDs(ids))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	byID := map[int64]mediaTeam{}
	for rows.Next() {
		var t mediaTeam
		var bot []byte
		if err := rows.Scan(&t.ID, &t.Name, &t.ShortName, &t.CrestURL, &t.Instagram, &t.ManagerName, &t.ManagerPhone, &bot); err != nil {
			return nil, err
		}
		_ = json.Unmarshal(bot, &t.Bot)
		byID[t.ID] = t
	}
	for _, id := range ids {
		if t, ok := byID[id]; ok {
			out = append(out, t)
		}
	}
	return out, rows.Err()
}

func pgIDs(ids []int64) string {
	parts := make([]string, len(ids))
	for i, id := range ids {
		parts[i] = fmt.Sprint(id)
	}
	return "{" + strings.Join(parts, ",") + "}"
}

type planSummary struct {
	*media.Plan
	Start   string `json:"start"`
	End     string `json:"end"`
	Total   int    `json:"total"`
	Done    int    `json:"done"`
	Review  int    `json:"review"`
	Overdue int    `json:"overdue"`
	Today   int    `json:"today"`
}

func (s *Server) summarize(ctx context.Context, p *media.Plan, today string) (*planSummary, error) {
	ps := &planSummary{Plan: p}
	err := s.DB.QueryRowContext(ctx, `SELECT coalesce(to_char(min(due_date),'YYYY-MM-DD'),''), coalesce(to_char(max(due_date),'YYYY-MM-DD'),''),
		count(*), count(*) FILTER (WHERE status='done'), count(*) FILTER (WHERE status='review'),
		count(*) FILTER (WHERE status IN ('todo','returned') AND due_date < $2::date),
		count(*) FILTER (WHERE due_date = $2::date)
		FROM media_tasks WHERE plan_id = $1`, p.ID, today).Scan(&ps.Start, &ps.End, &ps.Total, &ps.Done, &ps.Review, &ps.Overdue, &ps.Today)
	return ps, err
}

func (s *Server) mediaOverview(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	now := mediaNow()
	today := media.Today(now)
	plans, err := media.Plans(ctx, s.DB)
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	byGroup := map[int64]*media.Plan{}
	for _, p := range plans {
		byGroup[p.GroupID] = p
	}
	rows, err := s.DB.QueryContext(ctx, `SELECT g.id, g.code, g.name, coalesce(array_to_json(array_agg(t.id ORDER BY t.group_ord, t.id) FILTER (WHERE t.id IS NOT NULL)), '[]')
		FROM team_groups g LEFT JOIN teams t ON t.group_id = g.id AND t.is_active
		WHERE g.season_id IS NULL OR g.season_id = (SELECT id FROM seasons ORDER BY is_active DESC, id DESC LIMIT 1)
		GROUP BY g.id ORDER BY g.ord, g.id`)
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	type groupRow struct {
		ID    int64        `json:"id"`
		Code  string       `json:"code"`
		Name  string       `json:"name"`
		Teams []mediaTeam  `json:"teams"`
		Plan  *planSummary `json:"plan"`
		Bot   int          `json:"bot"` // teams with a linked manager
		ids   []int64
	}
	var groups []*groupRow
	for rows.Next() {
		g := &groupRow{}
		var ids []byte
		if err := rows.Scan(&g.ID, &g.Code, &g.Name, &ids); err != nil {
			rows.Close()
			httpx.Fail(w, r, err)
			return
		}
		_ = json.Unmarshal(ids, &g.ids)
		groups = append(groups, g)
	}
	rows.Close()
	type kpi struct {
		TodayTotal int `json:"today_total"`
		TodaySent  int `json:"today_sent"`
		Review     int `json:"review"`
		Overdue    int `json:"overdue"`
		Done       int `json:"done"`
		Total      int `json:"total"`
	}
	var k kpi
	if err := s.DB.QueryRowContext(ctx, `SELECT count(*) FILTER (WHERE due_date = $1::date), count(*) FILTER (WHERE due_date = $1::date AND status IN ('review','done')),
		count(*) FILTER (WHERE status = 'review'), count(*) FILTER (WHERE status IN ('todo','returned') AND due_date < $1::date),
		count(*) FILTER (WHERE status = 'done'), count(*) FROM media_tasks`, today).Scan(&k.TodayTotal, &k.TodaySent, &k.Review, &k.Overdue, &k.Done, &k.Total); err != nil {
		httpx.Fail(w, r, err)
		return
	}
	out := []*groupRow{}
	for _, g := range groups {
		ids := g.ids
		if p := byGroup[g.ID]; p != nil {
			if len(p.TeamIDs) > 0 {
				ids = p.TeamIDs
			}
			if g.Plan, err = s.summarize(ctx, p, today); err != nil {
				httpx.Fail(w, r, err)
				return
			}
		}
		if g.Teams, err = s.mediaTeams(ctx, ids); err != nil {
			httpx.Fail(w, r, err)
			return
		}
		for _, t := range g.Teams {
			if len(t.Bot) > 0 {
				g.Bot++
			}
		}
		out = append(out, g)
	}
	httpx.JSON(w, 200, map[string]any{"bot": s.Cfg.TelegramToken != "", "today": today, "kpi": k, "groups": out})
}

type mediaEvent struct {
	ID     int64     `json:"id"`
	TaskID *int64    `json:"task_id"`
	At     time.Time `json:"at"`
	Kind   string    `json:"kind"`
	Actor  string    `json:"actor"`
	Text   string    `json:"text"`
}

func (s *Server) mediaEvents(ctx context.Context, where string, arg int64, limit int) ([]mediaEvent, error) {
	rows, err := s.DB.QueryContext(ctx, `SELECT id, task_id, at, kind, actor, text FROM media_task_events WHERE `+where+` ORDER BY at DESC, id DESC LIMIT `+itoa(limit), arg)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []mediaEvent{}
	for rows.Next() {
		var e mediaEvent
		if err := rows.Scan(&e.ID, &e.TaskID, &e.At, &e.Kind, &e.Actor, &e.Text); err != nil {
			return nil, err
		}
		out = append(out, e)
	}
	return out, rows.Err()
}

type finalMatch struct {
	ID        int64      `json:"id"`
	KickoffAt *time.Time `json:"kickoff_at"`
	Day       string     `json:"day"`
	Home      string     `json:"home"`
	Away      string     `json:"away"`
	Venue     string     `json:"venue"`
	Round     string     `json:"round"`
	Status    string     `json:"status"`
}

const finalMatchSQL = `SELECT m.id, m.kickoff_at, coalesce(to_char(m.kickoff_at AT TIME ZONE 'Asia/Tashkent','YYYY-MM-DD'),''),
	coalesce(h.name,''), coalesce(a.name,''), m.venue, m.round, m.status
	FROM matches m LEFT JOIN teams h ON h.id = m.home_team_id LEFT JOIN teams a ON a.id = m.away_team_id`

func scanFinal(sc interface{ Scan(...any) error }) (*finalMatch, error) {
	var f finalMatch
	err := sc.Scan(&f.ID, &f.KickoffAt, &f.Day, &f.Home, &f.Away, &f.Venue, &f.Round, &f.Status)
	return &f, err
}

func (s *Server) mediaGroup(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	id, err := idParam(r, "id")
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	now := mediaNow()
	today := media.Today(now)
	var g struct {
		ID   int64  `json:"id"`
		Code string `json:"code"`
		Name string `json:"name"`
	}
	if err := s.DB.QueryRowContext(ctx, `SELECT id, code, name FROM team_groups WHERE id = $1`, id).Scan(&g.ID, &g.Code, &g.Name); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			err = httpx.ErrNotFound
		}
		httpx.Fail(w, r, err)
		return
	}
	members, err := media.GroupTeams(ctx, s.DB, id)
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	p, err := media.PlanForGroup(ctx, s.DB, id)
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	out := map[string]any{"bot": s.Cfg.TelegramToken != "", "today": today, "group": g, "plan": nil, "final_match": nil,
		"tasks": []any{}, "activity": []any{}, "members_changed": false, "members": members}
	ids := members
	if p != nil {
		ids = p.TeamIDs
		sum, err := s.summarize(ctx, p, today)
		if err != nil {
			httpx.Fail(w, r, err)
			return
		}
		out["plan"] = sum
		out["members_changed"] = !sameSet(members, p.TeamIDs)
		if p.FinalMatchID != nil {
			if f, err := scanFinal(s.DB.QueryRowContext(ctx, finalMatchSQL+` WHERE m.id = $1`, *p.FinalMatchID)); err == nil {
				out["final_match"] = f
			}
		}
		tasks, err := media.Tasks(ctx, s.DB, `t.plan_id = $1 ORDER BY t.due_date, t.ord, t.team_id`, now, p.ID)
		if err != nil {
			httpx.Fail(w, r, err)
			return
		}
		out["tasks"] = tasks
		ev, err := s.mediaEvents(ctx, "plan_id = $1", p.ID, 30)
		if err != nil {
			httpx.Fail(w, r, err)
			return
		}
		out["activity"] = ev
	}
	teams, err := s.mediaTeams(ctx, ids)
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	out["teams"] = teams
	httpx.JSON(w, 200, out)
}

func sameSet(a, b []int64) bool {
	if len(a) != len(b) {
		return false
	}
	m := map[int64]bool{}
	for _, x := range a {
		m[x] = true
	}
	for _, x := range b {
		if !m[x] {
			return false
		}
	}
	return true
}

// mediaFinalCandidates are the matches of the group's teams, latest first.
func (s *Server) mediaFinalCandidates(w http.ResponseWriter, r *http.Request) {
	id, err := idParam(r, "id")
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	rows, err := s.DB.QueryContext(r.Context(), finalMatchSQL+` WHERE m.kickoff_at IS NOT NULL AND m.status <> 'cancelled'
		AND (h.group_id = $1 OR a.group_id = $1) ORDER BY m.kickoff_at DESC LIMIT 50`, id)
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	defer rows.Close()
	out := []*finalMatch{}
	for rows.Next() {
		f, err := scanFinal(rows)
		if err != nil {
			httpx.Fail(w, r, err)
			return
		}
		out = append(out, f)
	}
	httpx.JSON(w, 200, map[string]any{"items": out})
}

type finalBody struct {
	FinalMatchID *int64 `json:"final_match_id"`
	FinalDate    string `json:"final_date"`
}

// resolveFinal turns the body into (match, day): a match gives its kickoff day.
func (s *Server) resolveFinal(ctx context.Context, b finalBody) (*int64, string, error) {
	if b.FinalMatchID != nil {
		day, err := media.MatchDay(ctx, s.DB, *b.FinalMatchID)
		if err != nil {
			return nil, "", httpx.Validation(map[string]any{"final_match_id": "Match topilmadi"})
		}
		if day == "" {
			return nil, "", httpx.Validation(map[string]any{"final_match_id": "Matchning sanasi kiritilmagan"})
		}
		return b.FinalMatchID, day, nil
	}
	if !media.ValidDay(b.FinalDate) {
		return nil, "", httpx.Validation(map[string]any{"final_date": "Final o‘yinni yoki sanani tanlang"})
	}
	return nil, b.FinalDate, nil
}

func (s *Server) mediaCreatePlan(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	id, err := idParam(r, "id")
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	var b finalBody
	if err := httpx.Decode(r, &b); err != nil {
		httpx.Fail(w, r, err)
		return
	}
	matchID, day, err := s.resolveFinal(ctx, b)
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	if p, _ := media.PlanForGroup(ctx, s.DB, id); p != nil {
		httpx.Fail(w, r, httpx.NewError(http.StatusConflict, "exists", "Bu guruhning rejasi allaqachon bor"))
		return
	}
	_, name := actorOf(r)
	tx, err := s.DB.BeginTx(ctx, nil)
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	defer tx.Rollback()
	planID, err := media.CreatePlan(ctx, tx, id, matchID, day, name, mediaNow())
	if err != nil {
		httpx.Fail(w, r, mediaErr(dbError(err)))
		return
	}
	if err := tx.Commit(); err != nil {
		httpx.Fail(w, r, err)
		return
	}
	s.audit(r, "create", "media_plan", planID, map[string]any{"group_id": id, "final_date": day, "final_match_id": matchID})
	httpx.JSON(w, http.StatusCreated, map[string]any{"id": planID})
}

func (s *Server) loadPlanParam(w http.ResponseWriter, r *http.Request) *media.Plan {
	id, err := idParam(r, "id")
	if err != nil {
		httpx.Fail(w, r, err)
		return nil
	}
	p, err := media.LoadPlan(r.Context(), s.DB, id)
	if err == nil && p == nil {
		err = httpx.ErrNotFound
	}
	if err != nil {
		httpx.Fail(w, r, err)
		return nil
	}
	return p
}

func (s *Server) mediaDeletePlan(w http.ResponseWriter, r *http.Request) {
	p := s.loadPlanParam(w, r)
	if p == nil {
		return
	}
	if _, err := s.DB.ExecContext(r.Context(), `DELETE FROM media_plans WHERE id = $1`, p.ID); err != nil {
		httpx.Fail(w, r, err)
		return
	}
	s.audit(r, "delete", "media_plan", p.ID, map[string]any{"group_id": p.GroupID})
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) mediaPreview(w http.ResponseWriter, r *http.Request) {
	p := s.loadPlanParam(w, r)
	if p == nil {
		return
	}
	var b finalBody
	if err := httpx.Decode(r, &b); err != nil {
		httpx.Fail(w, r, err)
		return
	}
	_, day, err := s.resolveFinal(r.Context(), b)
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	pv, err := media.Preview(r.Context(), s.DB, p, day, mediaNow())
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	httpx.JSON(w, 200, pv)
}

func (s *Server) mediaMove(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	p := s.loadPlanParam(w, r)
	if p == nil {
		return
	}
	var b struct {
		finalBody
		Notify bool `json:"notify"`
	}
	if err := httpx.Decode(r, &b); err != nil {
		httpx.Fail(w, r, err)
		return
	}
	matchID, day, err := s.resolveFinal(ctx, b.finalBody)
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	// a bare date detaches the plan from its match (matchID is nil then)
	_, name := actorOf(r)
	now := mediaNow()
	tx, err := s.DB.BeginTx(ctx, nil)
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	defer tx.Rollback()
	n, err := media.Move(ctx, tx, p.ID, matchID, day, name, now)
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	if b.Notify && n > 0 {
		for _, team := range p.TeamIDs {
			team := team
			_ = media.Outbox(ctx, tx, &team, false, fmt.Sprintf("📅 <b>Final ko‘chirildi:</b> %s → %s\n\nMedia reja yangi sanaga surildi. Yangi jadval — /reja", media.ShortDay(p.FinalDate), media.ShortDay(day)),
				[][]media.Button{{{Text: "📋 Mening rejam", Data: "QP"}}})
		}
	}
	if err := tx.Commit(); err != nil {
		httpx.Fail(w, r, err)
		return
	}
	s.audit(r, "update", "media_plan", p.ID, map[string]any{"final_date": day, "final_match_id": matchID, "moved": n})
	httpx.JSON(w, 200, map[string]any{"moved": n, "final_date": day})
}

func (s *Server) mediaKeep(w http.ResponseWriter, r *http.Request) {
	p := s.loadPlanParam(w, r)
	if p == nil {
		return
	}
	_, name := actorOf(r)
	if err := media.Keep(r.Context(), s.DB, p, name); err != nil {
		httpx.Fail(w, r, err)
		return
	}
	s.audit(r, "update", "media_plan", p.ID, map[string]any{"kept": p.PendingDate})
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) mediaSetTeams(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	p := s.loadPlanParam(w, r)
	if p == nil {
		return
	}
	var b struct {
		TeamIDs []int64 `json:"team_ids"`
	}
	if err := httpx.Decode(r, &b); err != nil {
		httpx.Fail(w, r, err)
		return
	}
	seen := map[int64]bool{}
	for _, id := range b.TeamIDs {
		if seen[id] {
			httpx.Fail(w, r, httpx.BadRequest("Jamoa ikki marta keltirilgan"))
			return
		}
		seen[id] = true
	}
	_, name := actorOf(r)
	tx, err := s.DB.BeginTx(ctx, nil)
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	defer tx.Rollback()
	if err := media.SetTeams(ctx, tx, p.ID, b.TeamIDs, name, mediaNow()); err != nil {
		httpx.Fail(w, r, mediaErr(dbError(err)))
		return
	}
	if err := tx.Commit(); err != nil {
		httpx.Fail(w, r, err)
		return
	}
	s.audit(r, "update", "media_plan", p.ID, map[string]any{"team_ids": b.TeamIDs})
	w.WriteHeader(http.StatusNoContent)
}

// mediaRemind sends every open task due today or earlier to the team managers now.
func (s *Server) mediaRemind(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	p := s.loadPlanParam(w, r)
	if p == nil {
		return
	}
	if s.Cfg.TelegramToken == "" {
		httpx.Fail(w, r, httpx.BadRequest("Telegram bot ulanmagan: serverda TELEGRAM_BOT_TOKEN yo‘q"))
		return
	}
	now := mediaNow()
	settings, err := media.LoadSettings(ctx, s.DB)
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	tasks, err := media.Tasks(ctx, s.DB, `t.plan_id = $1 AND t.status IN ('todo','returned') AND t.due_date <= $2::date ORDER BY t.due_date, t.ord`, now, p.ID, media.Today(now))
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	teams, err := s.mediaTeams(ctx, p.TeamIDs)
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	linked := map[int64]bool{}
	names := map[int64]string{}
	for _, t := range teams {
		linked[t.ID] = len(t.Bot) > 0
		names[t.ID] = t.Name
	}
	sent, noBot := 0, []string{}
	missing := map[int64]bool{}
	for _, t := range tasks {
		if !linked[t.TeamID] {
			if !missing[t.TeamID] {
				missing[t.TeamID] = true
				noBot = append(noBot, names[t.TeamID])
			}
			continue
		}
		kind := "morning"
		if t.State == "overdue" {
			kind = "overdue"
		}
		team := t.TeamID
		if err := media.Outbox(ctx, s.DB, &team, false, media.ReminderText(t, settings, kind), media.ReminderButtons(t, kind)); err != nil {
			httpx.Fail(w, r, err)
			return
		}
		sent++
	}
	_, name := actorOf(r)
	media.Event(ctx, s.DB, p.ID, nil, "reminder", name, fmt.Sprintf("Menejerlarga qo‘lda eslatma yuborildi: %d ta topshiriq", sent))
	httpx.JSON(w, 200, map[string]any{"sent": sent, "no_bot": noBot})
}

func (s *Server) mediaTask(w http.ResponseWriter, r *http.Request) {
	id, err := idParam(r, "id")
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	t, err := media.GetTask(r.Context(), s.DB, id, mediaNow())
	if err == nil && t == nil {
		err = httpx.ErrNotFound
	}
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	ev, err := s.mediaEvents(r.Context(), "task_id = $1", id, 50)
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	teams, err := s.mediaTeams(r.Context(), []int64{t.TeamID})
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	var team *mediaTeam
	if len(teams) == 1 {
		team = &teams[0]
	}
	httpx.JSON(w, 200, map[string]any{"task": t, "events": ev, "team": team})
}

func (s *Server) taskAction(w http.ResponseWriter, r *http.Request, do func(ctx context.Context, q media.Q, id int64) (*media.Task, error), action string) {
	id, err := idParam(r, "id")
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	tx, err := s.DB.BeginTx(r.Context(), nil)
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	defer tx.Rollback()
	t, err := do(r.Context(), tx, id)
	if err != nil {
		httpx.Fail(w, r, mediaErr(err))
		return
	}
	if err := tx.Commit(); err != nil {
		httpx.Fail(w, r, err)
		return
	}
	s.audit(r, action, "media_task", id, map[string]any{"status": t.Status, "due_date": t.DueDate})
	httpx.JSON(w, 200, t)
}

func (s *Server) mediaPatchTask(w http.ResponseWriter, r *http.Request) {
	var b struct {
		DueDate *string `json:"due_date"` // "" puts the task back on the template day
	}
	if err := httpx.Decode(r, &b); err != nil {
		httpx.Fail(w, r, err)
		return
	}
	if b.DueDate == nil {
		httpx.Fail(w, r, httpx.BadRequest("O‘zgartirish yo‘q"))
		return
	}
	_, name := actorOf(r)
	s.taskAction(w, r, func(ctx context.Context, q media.Q, id int64) (*media.Task, error) {
		return media.SetDue(ctx, q, id, *b.DueDate, name, mediaNow())
	}, "update")
}

func (s *Server) mediaApprove(w http.ResponseWriter, r *http.Request) {
	uid, name := actorOf(r)
	s.taskAction(w, r, func(ctx context.Context, q media.Q, id int64) (*media.Task, error) {
		return media.Approve(ctx, q, id, uid, name, mediaNow())
	}, "approve")
}

func (s *Server) mediaReturn(w http.ResponseWriter, r *http.Request) {
	var b struct {
		Comment string `json:"comment"`
	}
	if err := httpx.Decode(r, &b); err != nil {
		httpx.Fail(w, r, err)
		return
	}
	if utf8.RuneCountInString(b.Comment) > 500 {
		httpx.Fail(w, r, httpx.Validation(map[string]any{"comment": "500 belgidan oshmasin"}))
		return
	}
	uid, name := actorOf(r)
	s.taskAction(w, r, func(ctx context.Context, q media.Q, id int64) (*media.Task, error) {
		return media.Return(ctx, q, id, uid, name, b.Comment, mediaNow())
	}, "return")
}

// mediaSubmit: the admin pastes the link for a team that has no bot.
func (s *Server) mediaSubmit(w http.ResponseWriter, r *http.Request) {
	var b struct {
		Link string `json:"link"`
	}
	if err := httpx.Decode(r, &b); err != nil {
		httpx.Fail(w, r, err)
		return
	}
	_, name := actorOf(r)
	s.taskAction(w, r, func(ctx context.Context, q media.Q, id int64) (*media.Task, error) {
		return media.Submit(ctx, q, id, b.Link, name+" (admin)", mediaNow())
	}, "submit")
}

func (s *Server) mediaReview(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	status := r.URL.Query().Get("status")
	if status == "" {
		status = "review"
	}
	order := "t.submitted_at NULLS LAST, t.due_date"
	switch status {
	case "review":
	case "returned", "done":
		order = "t.reviewed_at DESC NULLS LAST, t.due_date DESC"
	default:
		httpx.Fail(w, r, httpx.BadRequest("status: review, returned yoki done"))
		return
	}
	now := mediaNow()
	tasks, err := media.Tasks(ctx, s.DB, `t.status = $1 ORDER BY `+order+` LIMIT 300`, now, status)
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	ids := []int64{}
	seen := map[int64]bool{}
	for _, t := range tasks {
		if !seen[t.TeamID] {
			seen[t.TeamID] = true
			ids = append(ids, t.TeamID)
		}
	}
	teams, err := s.mediaTeams(ctx, ids)
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	byID := map[int64]mediaTeam{}
	for _, t := range teams {
		byID[t.ID] = t
	}
	var counts struct {
		Review   int `json:"review"`
		Returned int `json:"returned"`
		Done     int `json:"done"`
	}
	_ = s.DB.QueryRowContext(ctx, `SELECT count(*) FILTER (WHERE status='review'), count(*) FILTER (WHERE status='returned'), count(*) FILTER (WHERE status='done') FROM media_tasks`).
		Scan(&counts.Review, &counts.Returned, &counts.Done)
	httpx.JSON(w, 200, map[string]any{"items": tasks, "teams": byID, "counts": counts})
}

func (s *Server) mediaApproveMany(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	var b struct {
		IDs []int64 `json:"ids"`
	}
	if err := httpx.Decode(r, &b); err != nil {
		httpx.Fail(w, r, err)
		return
	}
	if len(b.IDs) == 0 || len(b.IDs) > 200 {
		httpx.Fail(w, r, httpx.BadRequest("1 dan 200 gacha topshiriq tanlang"))
		return
	}
	uid, name := actorOf(r)
	tx, err := s.DB.BeginTx(ctx, nil)
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	defer tx.Rollback()
	n := 0
	for _, id := range b.IDs {
		if _, err := media.Approve(ctx, tx, id, uid, name, mediaNow()); err != nil {
			if errors.Is(err, media.ErrDone) || errors.Is(err, media.ErrNoTask) {
				continue
			}
			httpx.Fail(w, r, err)
			return
		}
		n++
	}
	if err := tx.Commit(); err != nil {
		httpx.Fail(w, r, err)
		return
	}
	s.audit(r, "approve", "media_task", 0, map[string]any{"ids": b.IDs, "approved": n})
	httpx.JSON(w, 200, map[string]any{"approved": n})
}

func (s *Server) mediaTemplate(w http.ResponseWriter, r *http.Request) {
	items, err := media.LoadTemplate(r.Context(), s.DB)
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	st, err := media.LoadSettings(r.Context(), s.DB)
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	httpx.JSON(w, 200, map[string]any{"items": items, "settings": st})
}

func validateTemplate(items []media.Item, st media.Settings) map[string]any {
	f := map[string]any{}
	if len(items) == 0 || len(items) > 30 {
		f["items"] = "1 dan 30 gacha topshiriq bo‘lsin"
	}
	for i := range items {
		it := &items[i]
		it.Title = strings.TrimSpace(it.Title)
		it.Short = strings.TrimSpace(it.Short)
		it.Description = strings.TrimSpace(it.Description)
		it.Sponsor = strings.ToUpper(strings.TrimSpace(it.Sponsor))
		key := fmt.Sprintf("items.%d", i)
		switch {
		case it.Title == "" || utf8.RuneCountInString(it.Title) > 80:
			f[key+".title"] = "Nomi 1–80 belgi"
		case utf8.RuneCountInString(it.Short) > 20:
			f[key+".short"] = "Qisqa nomi 20 belgidan oshmasin"
		case utf8.RuneCountInString(it.Description) > 1000:
			f[key+".description"] = "Izoh 1000 belgidan oshmasin"
		case it.Stage < 1 || it.Stage > 9:
			f[key+".stage"] = "Bosqich 1–9"
		case utf8.RuneCountInString(it.Sponsor) > 20:
			f[key+".sponsor"] = "Homiy nomi 20 belgidan oshmasin"
		case it.Rival < 0 || it.Rival > 9:
			f[key+".rival"] = "Raqib raqami 0–9"
		case len(it.Offsets) == 0 || len(it.Offsets) > 9:
			f[key+".offsets"] = "Har bir jamoa uchun kun kiriting"
		}
		for _, o := range it.Offsets {
			if o < -60 || o > 30 {
				f[key+".offsets"] = "Kun −60 … +30 oralig‘ida bo‘lsin"
			}
		}
	}
	for k, v := range map[string]string{"evening_time": st.EveningTime, "morning_time": st.MorningTime, "deadline_time": st.DeadlineTime,
		"overdue_time": st.OverdueTime, "escalate_time": st.EscalateTime, "report_time": st.ReportTime} {
		if !media.ValidTime(v) {
			f["settings."+k] = "Vaqt SS:DD ko‘rinishida"
		}
	}
	return f
}

func (s *Server) mediaSaveTemplate(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	var b struct {
		Items    []media.Item   `json:"items"`
		Settings media.Settings `json:"settings"`
		Apply    string         `json:"apply"` // new, unstarted, running
	}
	if err := httpx.Decode(r, &b); err != nil {
		httpx.Fail(w, r, err)
		return
	}
	if f := validateTemplate(b.Items, b.Settings); len(f) > 0 {
		httpx.Fail(w, r, httpx.Validation(f))
		return
	}
	switch b.Apply {
	case "", "new", "unstarted", "running":
	default:
		httpx.Fail(w, r, httpx.BadRequest("apply: new, unstarted yoki running"))
		return
	}
	now := mediaNow()
	today := media.Today(now)
	_, name := actorOf(r)
	tx, err := s.DB.BeginTx(ctx, nil)
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	defer tx.Rollback()
	items, err := media.SaveTemplate(ctx, tx, b.Items)
	if err != nil {
		httpx.Fail(w, r, dbError(err))
		return
	}
	if err := media.SaveSettings(ctx, tx, b.Settings); err != nil {
		httpx.Fail(w, r, dbError(err))
		return
	}
	updated := 0
	if b.Apply == "unstarted" || b.Apply == "running" {
		plans, err := media.Plans(ctx, tx)
		if err != nil {
			httpx.Fail(w, r, err)
			return
		}
		for _, p := range plans {
			var started bool
			if err := tx.QueryRowContext(ctx, `SELECT EXISTS (SELECT 1 FROM media_tasks WHERE plan_id=$1 AND due_date <= $2::date)`, p.ID, today).Scan(&started); err != nil {
				httpx.Fail(w, r, err)
				return
			}
			switch {
			case !started:
				err = media.Sync(ctx, tx, p.ID, items, false, now)
			case b.Apply == "running" && p.FinalDate >= today:
				err = media.Sync(ctx, tx, p.ID, items, true, now)
			default:
				continue
			}
			if err != nil {
				httpx.Fail(w, r, err)
				return
			}
			media.Event(ctx, tx, p.ID, nil, "plan", name, "Shablon o‘zgardi — reja yangilandi")
			updated++
		}
	}
	if err := tx.Commit(); err != nil {
		httpx.Fail(w, r, err)
		return
	}
	s.audit(r, "update", "media_template", 0, map[string]any{"items": len(items), "apply": b.Apply, "plans": updated})
	httpx.JSON(w, 200, map[string]any{"items": items, "settings": b.Settings, "plans_updated": updated})
}

func (s *Server) mediaSetManager(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	id, err := idParam(r, "id")
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	var b struct {
		Name  string `json:"name"`
		Phone string `json:"phone"`
	}
	if err := httpx.Decode(r, &b); err != nil {
		httpx.Fail(w, r, err)
		return
	}
	b.Name = strings.TrimSpace(b.Name)
	phone, ok := auth.NormalizePhone(b.Phone)
	switch {
	case !ok:
		httpx.Fail(w, r, httpx.Validation(map[string]any{"phone": "Telefon raqam noto‘g‘ri"}))
		return
	case utf8.RuneCountInString(b.Name) > 80:
		httpx.Fail(w, r, httpx.Validation(map[string]any{"name": "80 belgidan oshmasin"}))
		return
	}
	res, err := s.DB.ExecContext(ctx, `UPDATE teams SET manager_name=$2, manager_phone=$3, updated_at=now() WHERE id=$1`, id, b.Name, phone)
	if err != nil {
		httpx.Fail(w, r, dbError(err))
		return
	}
	if n, _ := res.RowsAffected(); n == 0 {
		httpx.Fail(w, r, httpx.ErrNotFound)
		return
	}
	// a link made with another number stops working at once
	if _, err := s.DB.ExecContext(ctx, `DELETE FROM media_manager_links WHERE team_id=$1 AND phone <> $2`, id, phone); err != nil {
		httpx.Fail(w, r, err)
		return
	}
	s.audit(r, "update", "team_manager", id, map[string]any{"name": b.Name, "phone": phone})
	teams, err := s.mediaTeams(ctx, []int64{id})
	if err != nil || len(teams) == 0 {
		httpx.Fail(w, r, httpx.ErrNotFound)
		return
	}
	httpx.JSON(w, 200, teams[0])
}
