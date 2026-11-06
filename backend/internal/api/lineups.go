package api

import (
	"context"
	"database/sql"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/lib/pq"

	"github.com/sanedidi/unitedmfl/backend/internal/httpx"
	"github.com/sanedidi/unitedmfl/backend/internal/lineup"
)

// formations returns the formation catalog (slots and roles) for the site and the admin.
func (s *Server) formations(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "public, max-age=3600")
	httpx.JSON(w, 200, map[string]any{"items": lineup.CatalogFormations(), "bench_max": s.Cfg.LineupBenchMax})
}

func sideParam(r *http.Request) (string, error) {
	side := chi.URLParam(r, "side")
	if side != "home" && side != "away" {
		return "", httpx.BadRequest("side: home yoki away")
	}
	return side, nil
}

type lineupMeta struct {
	Formation   string     `json:"formation"`
	Status      string     `json:"status"`
	Source      string     `json:"source"`
	Coach       string     `json:"coach"`
	Assistant   string     `json:"assistant"`
	Version     int        `json:"version"`
	PublishedAt *time.Time `json:"published_at"`
	UpdatedAt   time.Time  `json:"updated_at"`
}

// loadSide reads a side's lineup rows and meta inside tx (or the pool when tx is nil).
func (s *Server) loadSide(ctx context.Context, q interface {
	QueryContext(context.Context, string, ...any) (*sql.Rows, error)
	QueryRowContext(context.Context, string, ...any) *sql.Row
}, matchID int64, side string) (lineupMeta, []lineup.Player, error) {
	meta := lineupMeta{Status: "draft", Source: "manual"}
	err := q.QueryRowContext(ctx, `SELECT formation, status, source, coach, assistant, version, published_at, updated_at
		FROM lineup_meta WHERE match_id=$1 AND side=$2`, matchID, side).
		Scan(&meta.Formation, &meta.Status, &meta.Source, &meta.Coach, &meta.Assistant, &meta.Version, &meta.PublishedAt, &meta.UpdatedAt)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return meta, nil, err
	}
	rows, err := q.QueryContext(ctx, `SELECT player_id, player_name, number, position, role, slot, is_starter, is_captain
		FROM lineups WHERE match_id=$1 AND side=$2 ORDER BY NOT is_starter, slot NULLS LAST, number NULLS LAST`, matchID, side)
	if err != nil {
		return meta, nil, err
	}
	defer rows.Close()
	var ps []lineup.Player
	for rows.Next() {
		var p lineup.Player
		var num, slot sql.NullInt64
		var pid sql.NullInt64
		if err := rows.Scan(&pid, &p.Name, &num, &p.Position, &p.Role, &slot, &p.Starter, &p.Captain); err != nil {
			return meta, nil, err
		}
		if pid.Valid {
			v := pid.Int64
			p.PlayerID = &v
		}
		if num.Valid {
			v := int(num.Int64)
			p.Number = &v
		}
		if slot.Valid {
			v := int(slot.Int64)
			p.Slot = &v
		}
		ps = append(ps, p)
	}
	return meta, ps, rows.Err()
}

// suspendedPlayers returns player ids sent off in the team's previous finished
// match (a one-match ban is the common rule; the check is only a warning).
func (s *Server) suspendedPlayers(ctx context.Context, matchID int64, side string) (map[int64]bool, error) {
	rows, err := s.DB.QueryContext(ctx, `WITH cur AS (
			SELECT m.kickoff_at, CASE WHEN $2='home' THEN m.home_team_id ELSE m.away_team_id END AS team_id FROM matches m WHERE m.id=$1),
		prev AS (
			SELECT m.id FROM matches m, cur WHERE cur.team_id IS NOT NULL AND m.status='finished' AND m.id<>$1
			  AND (m.home_team_id=cur.team_id OR m.away_team_id=cur.team_id)
			  AND (cur.kickoff_at IS NULL OR m.kickoff_at < cur.kickoff_at)
			ORDER BY m.kickoff_at DESC NULLS LAST LIMIT 1)
		SELECT DISTINCT e.player_id FROM match_events e, prev, cur
		WHERE e.match_id=prev.id AND e.team_id=cur.team_id AND e.type IN ('red','second_yellow') AND e.player_id IS NOT NULL`, matchID, side)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[int64]bool{}
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		out[id] = true
	}
	return out, rows.Err()
}

func (s *Server) checksFor(ctx context.Context, matchID int64, side string, meta lineupMeta, ps []lineup.Player) []lineup.Check {
	if susp, err := s.suspendedPlayers(ctx, matchID, side); err == nil {
		for i := range ps {
			if ps[i].PlayerID != nil && susp[*ps[i].PlayerID] {
				ps[i].Suspended = true
			}
		}
	}
	cs := lineup.Validate(meta.Formation, ps, lineup.Options{BenchMax: s.Cfg.LineupBenchMax})
	if len(ps) > 0 && strings.TrimSpace(meta.Coach) == "" {
		cs = append(cs, lineup.Check{Level: "warning", Code: "coach", Text: "Bosh murabbiy ko‘rsatilmagan"})
	}
	return cs
}

// getLineups returns both sides with meta, rows and validation results.
func (s *Server) getLineups(w http.ResponseWriter, r *http.Request) {
	id, err := idParam(r, "id")
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	out := map[string]any{}
	for _, side := range []string{"home", "away"} {
		meta, ps, err := s.loadSide(r.Context(), s.DB, id, side)
		if err != nil {
			httpx.Fail(w, r, err)
			return
		}
		susp, _ := s.suspendedPlayers(r.Context(), id, side)
		ids := make([]int64, 0, len(susp))
		for k := range susp {
			ids = append(ids, k)
		}
		if ps == nil {
			ps = []lineup.Player{}
		}
		out[side] = map[string]any{"meta": meta, "players": ps, "checks": s.checksFor(r.Context(), id, side, meta, ps), "suspended": ids}
	}
	out["bench_max"] = s.Cfg.LineupBenchMax
	httpx.JSON(w, 200, out)
}

type sideInput struct {
	Formation string          `json:"formation"`
	Coach     string          `json:"coach"`
	Assistant string          `json:"assistant"`
	Source    string          `json:"source"`
	Version   int             `json:"version"`
	Players   []lineup.Player `json:"players"`
}

// putLineupSide saves one side as a whole. A published side stays published,
// so it must stay valid; a draft can be saved in any state.
func (s *Server) putLineupSide(w http.ResponseWriter, r *http.Request) {
	id, err := idParam(r, "id")
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	side, err := sideParam(r)
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	var in sideInput
	if err := httpx.Decode(r, &in); err != nil {
		httpx.Fail(w, r, err)
		return
	}
	in.Formation = strings.TrimSpace(in.Formation)
	if in.Formation != "" {
		if _, err := lineup.Parse(in.Formation); err != nil {
			httpx.Fail(w, r, httpx.Validation(map[string]any{"formation": err.Error()}))
			return
		}
	}
	if !contains([]string{"", "manual", "protocol", "copy"}, in.Source) {
		in.Source = "manual"
	}
	for i := range in.Players {
		p := &in.Players[i]
		p.Name = s.resolvePlayerName(r.Context(), p.PlayerID, strings.TrimSpace(p.Name))
		if p.Name == "" {
			httpx.Fail(w, r, httpx.Validation(map[string]any{"players": "o‘yinchi ismi majburiy"}))
			return
		}
		if !p.Starter {
			p.Slot = nil
		}
		p.Role = strings.ToUpper(strings.TrimSpace(p.Role))
		if len(p.Role) > 4 {
			p.Role = p.Role[:4]
		}
	}
	ctx := r.Context()
	tx, err := s.DB.BeginTx(ctx, nil)
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	defer tx.Rollback()
	var exists bool
	if err := tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM matches WHERE id=$1)`, id).Scan(&exists); err != nil || !exists {
		httpx.Fail(w, r, httpx.ErrNotFound)
		return
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO lineup_meta(match_id, side) VALUES ($1,$2) ON CONFLICT DO NOTHING`, id, side); err != nil {
		httpx.Fail(w, r, err)
		return
	}
	var version int
	var status string
	if err := tx.QueryRowContext(ctx, `SELECT version, status FROM lineup_meta WHERE match_id=$1 AND side=$2 FOR UPDATE`, id, side).Scan(&version, &status); err != nil {
		httpx.Fail(w, r, err)
		return
	}
	if in.Version > 0 && in.Version != version {
		httpx.Fail(w, r, httpx.NewError(http.StatusConflict, "version", "Tarkibni boshqa foydalanuvchi o‘zgartirdi. Sahifani yangilang."))
		return
	}
	meta := lineupMeta{Formation: in.Formation, Status: status, Coach: strings.TrimSpace(in.Coach), Assistant: strings.TrimSpace(in.Assistant)}
	checks := s.checksFor(ctx, id, side, meta, in.Players)
	if status == "published" && lineup.HasErrors(checks) {
		httpx.JSON(w, http.StatusUnprocessableEntity, map[string]any{"error": map[string]any{"code": "invalid", "message": "E’lon qilingan tarkibda xato bo‘lishi mumkin emas. Tuzating yoki saytdan yashiring."}, "checks": checks})
		return
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM lineups WHERE match_id=$1 AND side=$2`, id, side); err != nil {
		httpx.Fail(w, r, err)
		return
	}
	for _, p := range in.Players {
		if _, err := tx.ExecContext(ctx, `INSERT INTO lineups(match_id, side, team_id, player_id, player_name, number, position, role, slot, is_starter, is_captain)
			SELECT $1, $2, CASE WHEN $2='home' THEN home_team_id ELSE away_team_id END, $3, $4, $5, $6, $7, $8, $9, $10 FROM matches WHERE id=$1`,
			id, side, p.PlayerID, p.Name, p.Number, p.Position, p.Role, p.Slot, p.Starter, p.Captain); err != nil {
			httpx.Fail(w, r, dbError(err))
			return
		}
	}
	src := in.Source
	if src == "" {
		src = "manual"
	}
	if err := tx.QueryRowContext(ctx, `UPDATE lineup_meta SET formation=$3, coach=$4, assistant=$5, source=$6, version=version+1,
		updated_by=$7, updated_at=now() WHERE match_id=$1 AND side=$2 RETURNING version`,
		id, side, in.Formation, meta.Coach, meta.Assistant, src, claimsFrom(ctx).UserID).Scan(&version); err != nil {
		httpx.Fail(w, r, err)
		return
	}
	if err := tx.Commit(); err != nil {
		httpx.Fail(w, r, err)
		return
	}
	s.audit(r, "lineup_save", "match", id, map[string]any{"side": side, "players": len(in.Players), "formation": in.Formation})
	if status == "published" {
		s.broadcastMatch(ctx, id)
	}
	httpx.JSON(w, 200, map[string]any{"version": version, "status": status, "checks": checks})
}

// publishLineups validates and publishes the requested sides.
func (s *Server) publishLineups(w http.ResponseWriter, r *http.Request) {
	id, err := idParam(r, "id")
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	var in struct {
		Sides []string `json:"sides"`
	}
	if err := httpx.Decode(r, &in); err != nil {
		httpx.Fail(w, r, err)
		return
	}
	if len(in.Sides) == 0 {
		in.Sides = []string{"home", "away"}
	}
	all := map[string][]lineup.Check{}
	failed := false
	for _, side := range in.Sides {
		if side != "home" && side != "away" {
			httpx.Fail(w, r, httpx.BadRequest("sides: home, away"))
			return
		}
		meta, ps, err := s.loadSide(r.Context(), s.DB, id, side)
		if err != nil {
			httpx.Fail(w, r, err)
			return
		}
		cs := s.checksFor(r.Context(), id, side, meta, ps)
		all[side] = cs
		if lineup.HasErrors(cs) {
			failed = true
		}
	}
	if failed {
		httpx.JSON(w, http.StatusUnprocessableEntity, map[string]any{"error": map[string]any{"code": "invalid", "message": "Tarkibda xatolar bor — e’lon qilinmadi."}, "checks": all})
		return
	}
	if _, err := s.DB.ExecContext(r.Context(), `UPDATE lineup_meta SET status='published', published_at=now(), published_by=$3, updated_at=now()
		WHERE match_id=$1 AND side = ANY($2)`, id, pq.Array(in.Sides), claimsFrom(r.Context()).UserID); err != nil {
		httpx.Fail(w, r, err)
		return
	}
	s.audit(r, "lineup_publish", "match", id, map[string]any{"sides": in.Sides})
	s.broadcastMatch(r.Context(), id)
	httpx.JSON(w, 200, map[string]any{"status": "published", "checks": all})
}

// unpublishLineups hides a side (or both) from the site.
func (s *Server) unpublishLineups(w http.ResponseWriter, r *http.Request) {
	id, err := idParam(r, "id")
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	sides := []string{"home", "away"}
	if sd := r.URL.Query().Get("side"); sd == "home" || sd == "away" {
		sides = []string{sd}
	}
	if _, err := s.DB.ExecContext(r.Context(), `UPDATE lineup_meta SET status='draft', updated_at=now() WHERE match_id=$1 AND side = ANY($2)`, id, pq.Array(sides)); err != nil {
		httpx.Fail(w, r, err)
		return
	}
	s.audit(r, "lineup_unpublish", "match", id, map[string]any{"sides": sides})
	s.broadcastMatch(r.Context(), id)
	w.WriteHeader(http.StatusNoContent)
}

// copyLastLineup copies the team's lineup from its most recent other match into
// this match as a draft.
func (s *Server) copyLastLineup(w http.ResponseWriter, r *http.Request) {
	id, err := idParam(r, "id")
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	side, err := sideParam(r)
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	ctx := r.Context()
	var fromID int64
	var fromSide, fromLabel string
	err = s.DB.QueryRowContext(ctx, `WITH cur AS (
			SELECT m.kickoff_at, CASE WHEN $2='home' THEN m.home_team_id ELSE m.away_team_id END AS team_id FROM matches m WHERE m.id=$1)
		SELECT m.id, CASE WHEN m.home_team_id=cur.team_id THEN 'home' ELSE 'away' END,
		       coalesce(h.name,'?') || ' — ' || coalesce(a.name,'?') || coalesce(', ' || to_char(m.kickoff_at AT TIME ZONE 'Asia/Tashkent', 'DD.MM.YYYY'), '')
		FROM matches m JOIN cur ON cur.team_id IN (m.home_team_id, m.away_team_id)
		LEFT JOIN teams h ON h.id=m.home_team_id LEFT JOIN teams a ON a.id=m.away_team_id
		WHERE m.id<>$1 AND EXISTS (SELECT 1 FROM lineups l WHERE l.match_id=m.id AND l.team_id=cur.team_id)
		ORDER BY (m.kickoff_at < coalesce(cur.kickoff_at, 'infinity')) DESC, m.kickoff_at DESC NULLS LAST LIMIT 1`, id, side).Scan(&fromID, &fromSide, &fromLabel)
	if errors.Is(err, sql.ErrNoRows) {
		httpx.Fail(w, r, httpx.NewError(http.StatusNotFound, "not_found", "Bu jamoaning oldingi matchlarida tarkib topilmadi"))
		return
	}
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	tx, err := s.DB.BeginTx(ctx, nil)
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	defer tx.Rollback()
	if _, err := tx.ExecContext(ctx, `INSERT INTO lineup_meta(match_id, side) VALUES ($1,$2) ON CONFLICT DO NOTHING`, id, side); err != nil {
		httpx.Fail(w, r, err)
		return
	}
	var status string
	if err := tx.QueryRowContext(ctx, `SELECT status FROM lineup_meta WHERE match_id=$1 AND side=$2 FOR UPDATE`, id, side).Scan(&status); err != nil {
		httpx.Fail(w, r, err)
		return
	}
	if status == "published" {
		httpx.Fail(w, r, httpx.NewError(http.StatusConflict, "published", "Tarkib e’lon qilingan. Nusxa olishdan oldin saytdan yashiring."))
		return
	}
	stmts := []struct {
		q    string
		args []any
	}{
		{`DELETE FROM lineups WHERE match_id=$1 AND side=$2`, []any{id, side}},
		{`INSERT INTO lineups(match_id, side, team_id, player_id, player_name, number, position, role, slot, is_starter, is_captain)
			SELECT $1, $2, l.team_id, l.player_id, l.player_name, l.number, l.position, l.role, l.slot, l.is_starter, l.is_captain
			FROM lineups l WHERE l.match_id=$3 AND l.side=$4`, []any{id, side, fromID, fromSide}},
		{`UPDATE lineup_meta t SET formation=coalesce(f.formation,''), coach=coalesce(f.coach,''), assistant=coalesce(f.assistant,''),
			source='copy', version=t.version+1, updated_by=$5, updated_at=now()
			FROM (SELECT 1) one LEFT JOIN lineup_meta f ON f.match_id=$3 AND f.side=$4
			WHERE t.match_id=$1 AND t.side=$2`, []any{id, side, fromID, fromSide, claimsFrom(ctx).UserID}},
	}
	for _, st := range stmts {
		if _, err := tx.ExecContext(ctx, st.q, st.args...); err != nil {
			httpx.Fail(w, r, err)
			return
		}
	}
	if err := tx.Commit(); err != nil {
		httpx.Fail(w, r, err)
		return
	}
	s.audit(r, "lineup_copy", "match", id, map[string]any{"side": side, "from_match": fromID})
	httpx.JSON(w, 200, map[string]any{"from_match_id": fromID, "from": fromLabel})
}

var staffRes = &resource{table: "team_staff", entity: "team_staff", touch: true, order: "team_id, ord, id",
	search: []string{"full_name"}, filters: map[string]string{"team_id": "team_id"},
	fields: map[string]field{"team_id": reqInt, "full_name": reqTxt(120),
		"role":      enum("head_coach", "assistant", "gk_coach", "fitness", "doctor", "manager", "other"),
		"photo_url": txt(500), "show_on_site": boolean, "ord": {kind: kInt}}}
