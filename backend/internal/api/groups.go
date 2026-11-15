package api

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"

	"github.com/sanedidi/unitedmfl/backend/internal/httpx"
)

// Groups are created in the admin (Turnir → Guruhlar). Teams point to one via
// teams.group_id; the old group_label / group_is_provisional columns are kept
// in sync by database triggers (migration 0016).

var groupsRes = &resource{table: "team_groups", entity: "group", touch: true, order: "ord, id",
	filters: map[string]string{"season_id": "season_id"},
	fields:  map[string]field{"name": reqTxt(40), "code": reqTxt(4), "season_id": optInt, "ord": {kind: kInt}, "confirmed": boolean},
	prepare: prepareGroup}

// prepareGroup trims and upper-cases the code and puts new groups into the active season.
func prepareGroup(ctx context.Context, s *Server, body map[string]any, creating bool) error {
	if v, ok := body["code"].(string); ok {
		body["code"] = strings.ToUpper(strings.TrimSpace(v))
	}
	if v, ok := body["name"].(string); ok {
		body["name"] = strings.TrimSpace(v)
	}
	if creating {
		if _, ok := body["season_id"]; !ok {
			var id int64
			if err := s.DB.QueryRowContext(ctx, `SELECT id FROM seasons ORDER BY is_active DESC, id DESC LIMIT 1`).Scan(&id); err == nil {
				body["season_id"] = json.Number(strconv.FormatInt(id, 10))
			}
		}
		if _, ok := body["ord"]; !ok {
			var next int64
			_ = s.DB.QueryRowContext(ctx, `SELECT coalesce(max(ord), 0) + 1 FROM team_groups`).Scan(&next)
			body["ord"] = json.Number(strconv.FormatInt(next, 10))
		}
	}
	return nil
}

// setGroupTeams makes the given teams (in this order) the whole membership of
// the group: listed teams move here from any other group, teams left out lose it.
func (s *Server) setGroupTeams(w http.ResponseWriter, r *http.Request) {
	id, err := idParam(r, "id")
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
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
	var exists bool
	if err := tx.QueryRowContext(r.Context(), `SELECT true FROM team_groups WHERE id=$1`, id).Scan(&exists); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			err = httpx.ErrNotFound
		}
		httpx.Fail(w, r, err)
		return
	}
	keep := make([]any, 0, len(ids)+1)
	keep = append(keep, id)
	ph := []string{}
	for i, tid := range ids {
		if _, err := tx.ExecContext(r.Context(), `UPDATE teams SET group_id=$1, updated_at=now() WHERE id=$2 AND group_id IS DISTINCT FROM $1`, id, tid); err != nil {
			httpx.Fail(w, r, dbError(err))
			return
		}
		if _, err := tx.ExecContext(r.Context(), `UPDATE teams SET group_ord=$1 WHERE id=$2`, i+1, tid); err != nil {
			httpx.Fail(w, r, dbError(err))
			return
		}
		keep = append(keep, tid)
		ph = append(ph, "$"+itoa(len(keep)))
	}
	q := `UPDATE teams SET group_id=NULL, group_ord=0, updated_at=now() WHERE group_id=$1`
	if len(ph) > 0 {
		q += ` AND id NOT IN (` + strings.Join(ph, ",") + `)`
	}
	if _, err := tx.ExecContext(r.Context(), q, keep...); err != nil {
		httpx.Fail(w, r, err)
		return
	}
	if err := tx.Commit(); err != nil {
		httpx.Fail(w, r, err)
		return
	}
	s.audit(r, "update", "group_teams", id, map[string]any{"teams": ids})
	w.WriteHeader(http.StatusNoContent)
}

// groupInfo is the name, order and status of every group, keyed by code, for
// the standings (which group teams by code).
func (s *Server) groupInfo(ctx context.Context) map[string]map[string]any {
	out := map[string]map[string]any{}
	rows, err := s.DB.QueryContext(ctx, `SELECT code, name, ord, confirmed FROM team_groups ORDER BY ord, id`)
	if err != nil {
		return out
	}
	defer rows.Close()
	for rows.Next() {
		var code, name string
		var ord int
		var confirmed bool
		if rows.Scan(&code, &name, &ord, &confirmed) == nil {
			if _, dup := out[code]; !dup {
				out[code] = map[string]any{"name": name, "ord": ord, "confirmed": confirmed}
			}
		}
	}
	return out
}
