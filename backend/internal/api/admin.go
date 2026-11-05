package api

import (
	"context"
	"database/sql"
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/sanedidi/unitedmfl/backend/internal/httpx"
)

func (s *Server) adminMatches(w http.ResponseWriter, r *http.Request) {
	seasonID, err := s.activeSeasonID(r.Context(), r)
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	q := r.URL.Query()
	stage, _ := strconv.ParseInt(q.Get("stage"), 10, 64)
	limit, offset := pageParams(r)
	s.respondQuery(w, r, `SELECT json_build_object('items', coalesce((SELECT json_agg(x) FROM (`+matchSelect+`
		WHERE m.season_id = $1 AND ($2 = '' OR m.status = $2) AND ($3 = 0 OR m.stage_id = $3)
		  AND ($4 = '' OR h.name ILIKE '%' || $4 || '%' OR a.name ILIKE '%' || $4 || '%' OR m.venue ILIKE '%' || $4 || '%')
		ORDER BY m.kickoff_at DESC NULLS FIRST LIMIT $5 OFFSET $6) x), '[]'),
		'total', (SELECT count(*) FROM matches WHERE season_id = $1))`,
		seasonID, q.Get("status"), stage, strings.TrimSpace(q.Get("q")), limit, offset)
}

func (s *Server) adminMatch(w http.ResponseWriter, r *http.Request) {
	id, err := idParam(r, "id")
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	raw, err := s.matchDetailJSON(r.Context(), id, true)
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

func (s *Server) patchMatch(w http.ResponseWriter, r *http.Request) { s.crud(matchesRes).patch(w, r) }

// setPeriod drives the live state machine: 1H → HT → 2H → (ET) → (PEN) → FT.
func (s *Server) setPeriod(w http.ResponseWriter, r *http.Request) {
	id, err := idParam(r, "id")
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	var in struct {
		Period string `json:"period"`
	}
	if err := httpx.Decode(r, &in); err != nil {
		httpx.Fail(w, r, err)
		return
	}
	var q string
	switch in.Period {
	case "1H":
		q = `UPDATE matches SET status='live', period='1H', clock_started_at=now(), clock_offset_sec=0,
			home_score=coalesce(home_score,0), away_score=coalesce(away_score,0), updated_at=now() WHERE id=$1`
	case "HT":
		q = `UPDATE matches SET status='halftime', period='HT', clock_started_at=NULL, clock_offset_sec=2700,
			home_ht=coalesce(home_score,0), away_ht=coalesce(away_score,0), updated_at=now() WHERE id=$1`
	case "2H":
		q = `UPDATE matches SET status='live', period='2H', clock_started_at=now(), clock_offset_sec=2700, updated_at=now() WHERE id=$1`
	case "ET":
		q = `UPDATE matches SET status='live', period='ET', clock_started_at=now(), clock_offset_sec=5400, updated_at=now() WHERE id=$1`
	case "PEN":
		q = `UPDATE matches SET status='live', period='PEN', clock_started_at=NULL, updated_at=now() WHERE id=$1`
	case "FT":
		q = `UPDATE matches SET status='finished', period='FT', clock_started_at=NULL, updated_at=now() WHERE id=$1`
	default:
		httpx.Fail(w, r, httpx.Validation(map[string]any{"period": "1H, HT, 2H, ET, PEN yoki FT"}))
		return
	}
	res, err := s.DB.ExecContext(r.Context(), q, id)
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	if n, _ := res.RowsAffected(); n == 0 {
		httpx.Fail(w, r, httpx.ErrNotFound)
		return
	}
	s.audit(r, "period", "match", id, map[string]any{"period": in.Period})
	s.broadcastMatch(r.Context(), id)
	s.adminMatch(w, r)
}

type eventInput struct {
	Side              string  `json:"side"`
	Type              string  `json:"type"`
	Minute            int     `json:"minute"`
	ExtraMinute       int     `json:"extra_minute"`
	PlayerID          *int64  `json:"player_id"`
	PlayerName        string  `json:"player_name"`
	RelatedPlayerID   *int64  `json:"related_player_id"`
	RelatedPlayerName string  `json:"related_player_name"`
	Note              string  `json:"note"`
	Source            *string `json:"source"`
}

var eventTypes = []string{"goal", "own_goal", "penalty_goal", "penalty_missed", "yellow", "second_yellow", "red", "sub", "shootout_scored", "shootout_missed", "note"}

func (in *eventInput) validate() error {
	errs := map[string]any{}
	if in.Side != "home" && in.Side != "away" {
		errs["side"] = "home yoki away"
	}
	if !contains(eventTypes, in.Type) {
		errs["type"] = "turi noto‘g‘ri"
	}
	if in.Minute < 0 || in.Minute > 130 || in.ExtraMinute < 0 || in.ExtraMinute > 30 {
		errs["minute"] = "daqiqa 0–130, qo‘shimcha 0–30"
	}
	if len(errs) > 0 {
		return httpx.Validation(errs)
	}
	return nil
}

// resolvePlayerName fills names from player ids.
func (s *Server) resolvePlayerName(ctx context.Context, id *int64, name string) string {
	if id == nil || name != "" {
		return name
	}
	var n string
	_ = s.DB.QueryRowContext(ctx, `SELECT full_name FROM players WHERE id=$1`, *id).Scan(&n)
	return n
}

func (s *Server) addEvent(w http.ResponseWriter, r *http.Request) {
	id, err := idParam(r, "id")
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	var in eventInput
	if err := httpx.Decode(r, &in); err != nil {
		httpx.Fail(w, r, err)
		return
	}
	if err := in.validate(); err != nil {
		httpx.Fail(w, r, err)
		return
	}
	src := "live"
	if in.Source != nil && contains([]string{"live", "manual"}, *in.Source) {
		src = *in.Source
	}
	var idem *string
	if k := strings.TrimSpace(r.Header.Get("Idempotency-Key")); k != "" {
		idem = &k
	}
	in.PlayerName = s.resolvePlayerName(r.Context(), in.PlayerID, in.PlayerName)
	in.RelatedPlayerName = s.resolvePlayerName(r.Context(), in.RelatedPlayerID, in.RelatedPlayerName)
	var eventID int64
	err = s.DB.QueryRowContext(r.Context(), `INSERT INTO match_events(match_id, team_id, side, type, minute, extra_minute, player_id, player_name,
			related_player_id, related_player_name, note, source, created_by, idempotency_key)
		SELECT m.id, CASE WHEN $2='home' THEN m.home_team_id ELSE m.away_team_id END, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13
		FROM matches m WHERE m.id=$1
		ON CONFLICT (match_id, idempotency_key) WHERE idempotency_key IS NOT NULL DO UPDATE SET note = match_events.note
		RETURNING id`, id, in.Side, in.Type, in.Minute, in.ExtraMinute, in.PlayerID, in.PlayerName, in.RelatedPlayerID, in.RelatedPlayerName,
		in.Note, src, claimsFrom(r.Context()).UserID, idem).Scan(&eventID)
	if errors.Is(err, sql.ErrNoRows) {
		httpx.Fail(w, r, httpx.ErrNotFound)
		return
	}
	if err != nil {
		httpx.Fail(w, r, dbError(err))
		return
	}
	if err := s.syncLiveScore(r.Context(), id); err != nil {
		httpx.Fail(w, r, err)
		return
	}
	s.audit(r, "event_add", "match", id, map[string]any{"event_id": eventID, "type": in.Type, "minute": in.Minute})
	s.broadcastMatch(r.Context(), id)
	httpx.JSON(w, http.StatusCreated, map[string]any{"id": eventID})
}

func (s *Server) patchEvent(w http.ResponseWriter, r *http.Request) {
	id, err := idParam(r, "id")
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	eid, err := idParam(r, "eventID")
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	var in eventInput
	if err := httpx.Decode(r, &in); err != nil {
		httpx.Fail(w, r, err)
		return
	}
	if err := in.validate(); err != nil {
		httpx.Fail(w, r, err)
		return
	}
	in.PlayerName = s.resolvePlayerName(r.Context(), in.PlayerID, in.PlayerName)
	in.RelatedPlayerName = s.resolvePlayerName(r.Context(), in.RelatedPlayerID, in.RelatedPlayerName)
	res, err := s.DB.ExecContext(r.Context(), `UPDATE match_events e SET side=$3, type=$4, minute=$5, extra_minute=$6, player_id=$7, player_name=$8,
		related_player_id=$9, related_player_name=$10, note=$11,
		team_id=(SELECT CASE WHEN $3='home' THEN home_team_id ELSE away_team_id END FROM matches WHERE id=$1)
		WHERE e.id=$2 AND e.match_id=$1`, id, eid, in.Side, in.Type, in.Minute, in.ExtraMinute, in.PlayerID, in.PlayerName,
		in.RelatedPlayerID, in.RelatedPlayerName, in.Note)
	if err != nil {
		httpx.Fail(w, r, dbError(err))
		return
	}
	if n, _ := res.RowsAffected(); n == 0 {
		httpx.Fail(w, r, httpx.ErrNotFound)
		return
	}
	if err := s.syncLiveScore(r.Context(), id); err != nil {
		httpx.Fail(w, r, err)
		return
	}
	s.audit(r, "event_update", "match", id, map[string]any{"event_id": eid})
	s.broadcastMatch(r.Context(), id)
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) deleteEvent(w http.ResponseWriter, r *http.Request) {
	id, err := idParam(r, "id")
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	eid, err := idParam(r, "eventID")
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	res, err := s.DB.ExecContext(r.Context(), `DELETE FROM match_events WHERE id=$1 AND match_id=$2`, eid, id)
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	if n, _ := res.RowsAffected(); n == 0 {
		httpx.Fail(w, r, httpx.ErrNotFound)
		return
	}
	if err := s.syncLiveScore(r.Context(), id); err != nil {
		httpx.Fail(w, r, err)
		return
	}
	s.audit(r, "event_delete", "match", id, map[string]any{"event_id": eid})
	s.broadcastMatch(r.Context(), id)
	w.WriteHeader(http.StatusNoContent)
}

// syncLiveScore recomputes the score from goal events while a match is live.
// Penalty shoot-out goals are tracked separately in home_pen/away_pen.
func (s *Server) syncLiveScore(ctx context.Context, matchID int64) error {
	_, err := s.DB.ExecContext(ctx, `UPDATE matches m SET
		home_score = (SELECT count(*) FROM match_events e WHERE e.match_id=m.id AND ((e.side='home' AND e.type IN ('goal','penalty_goal')) OR (e.side='away' AND e.type='own_goal'))),
		away_score = (SELECT count(*) FROM match_events e WHERE e.match_id=m.id AND ((e.side='away' AND e.type IN ('goal','penalty_goal')) OR (e.side='home' AND e.type='own_goal'))),
		home_pen = CASE WHEN m.period='PEN' THEN (SELECT count(*) FROM match_events e WHERE e.match_id=m.id AND e.side='home' AND e.type='shootout_scored') ELSE m.home_pen END,
		away_pen = CASE WHEN m.period='PEN' THEN (SELECT count(*) FROM match_events e WHERE e.match_id=m.id AND e.side='away' AND e.type='shootout_scored') ELSE m.away_pen END,
		updated_at = now()
		WHERE m.id=$1 AND m.status IN ('live','halftime')`, matchID)
	return err
}

func (s *Server) putLineups(w http.ResponseWriter, r *http.Request) {
	id, err := idParam(r, "id")
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	var in []struct {
		Side       string `json:"side"`
		PlayerID   *int64 `json:"player_id"`
		PlayerName string `json:"player_name"`
		Number     *int   `json:"number"`
		Position   string `json:"position"`
		IsStarter  bool   `json:"is_starter"`
		IsCaptain  bool   `json:"is_captain"`
	}
	if err := httpx.Decode(r, &in); err != nil {
		httpx.Fail(w, r, err)
		return
	}
	tx, err := s.DB.BeginTx(r.Context(), nil)
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	defer tx.Rollback()
	if _, err := tx.ExecContext(r.Context(), `DELETE FROM lineups WHERE match_id=$1`, id); err != nil {
		httpx.Fail(w, r, err)
		return
	}
	for i, l := range in {
		if l.Side != "home" && l.Side != "away" {
			httpx.Fail(w, r, httpx.Validation(map[string]any{"[" + strconv.Itoa(i) + "].side": "home yoki away"}))
			return
		}
		name := s.resolvePlayerName(r.Context(), l.PlayerID, strings.TrimSpace(l.PlayerName))
		if name == "" {
			httpx.Fail(w, r, httpx.Validation(map[string]any{"[" + strconv.Itoa(i) + "].player_name": "majburiy"}))
			return
		}
		if _, err := tx.ExecContext(r.Context(), `INSERT INTO lineups(match_id, side, team_id, player_id, player_name, number, position, is_starter, is_captain)
			SELECT $1, $2, CASE WHEN $2='home' THEN home_team_id ELSE away_team_id END, $3, $4, $5, $6, $7, $8 FROM matches WHERE id=$1`,
			id, l.Side, l.PlayerID, name, l.Number, l.Position, l.IsStarter, l.IsCaptain); err != nil {
			httpx.Fail(w, r, dbError(err))
			return
		}
	}
	if err := tx.Commit(); err != nil {
		httpx.Fail(w, r, err)
		return
	}
	s.audit(r, "lineups", "match", id, map[string]any{"count": len(in)})
	s.broadcastMatch(r.Context(), id)
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) reorderBanners(w http.ResponseWriter, r *http.Request) {
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
		if _, err := tx.ExecContext(r.Context(), `UPDATE banners SET ord=$1, updated_at=now() WHERE id=$2`, i+1, id); err != nil {
			httpx.Fail(w, r, err)
			return
		}
	}
	if err := tx.Commit(); err != nil {
		httpx.Fail(w, r, err)
		return
	}
	s.audit(r, "reorder", "banner", 0, map[string]any{"ids": ids})
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) dashboard(w http.ResponseWriter, r *http.Request) {
	seasonID, err := s.activeSeasonID(r.Context(), r)
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	s.respondQuery(w, r, `SELECT json_build_object(
		'kpi', json_build_object(
			'matches_total', (SELECT count(*) FROM matches WHERE season_id=$1),
			'matches_planned', (SELECT matches_planned FROM seasons WHERE id=$1),
			'results_entered', (SELECT count(*) FROM matches WHERE season_id=$1 AND status='finished'),
			'teams', (SELECT count(*) FROM teams WHERE is_active),
			'news_published', (SELECT count(*) FROM news WHERE status='published'),
			'news_drafts', (SELECT count(*) FROM news WHERE status='draft'),
			'requests_new', (SELECT count(*) FROM contact_requests WHERE status='new'),
			'protocols_review', (SELECT count(*) FROM protocols WHERE status='review')),
		'upcoming', (SELECT coalesce(json_agg(x ORDER BY x.kickoff_at), '[]') FROM (`+matchSelect+`
			WHERE m.season_id=$1 AND m.status IN ('scheduled','live','halftime') ORDER BY m.kickoff_at NULLS LAST LIMIT 5) x),
		'recent_results', (SELECT coalesce(json_agg(x ORDER BY x.kickoff_at DESC), '[]') FROM (`+matchSelect+`
			WHERE m.season_id=$1 AND m.status='finished' ORDER BY m.kickoff_at DESC LIMIT 5) x),
		'activity', (SELECT coalesce(json_agg(a), '[]') FROM (SELECT l.action, l.entity, l.entity_id, l.created_at, u.name AS user_name
			FROM audit_log l LEFT JOIN users u ON u.id=l.user_id ORDER BY l.id DESC LIMIT 10) a))`, seasonID)
}

var imageTypes = map[string]string{"image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp", "image/gif": ".gif"}

// uploadImage stores an image and returns its public URL.
func (s *Server) uploadImage(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, 10<<20)
	file, hdr, err := r.FormFile("file")
	if err != nil {
		httpx.Fail(w, r, httpx.BadRequest("«file» maydoni topilmadi yoki fayl 10 MB dan katta"))
		return
	}
	defer file.Close()
	head := make([]byte, 512)
	n, _ := io.ReadFull(file, head)
	mime := http.DetectContentType(head[:n])
	if strings.HasPrefix(string(head[:n]), "RIFF") && strings.Contains(string(head[:min(n, 16)]), "WEBP") {
		mime = "image/webp"
	}
	ext, ok := imageTypes[mime]
	if !ok {
		httpx.Fail(w, r, httpx.BadRequest("Faqat JPG, PNG, WebP yoki GIF"))
		return
	}
	name := randomName(ext)
	dst, err := os.Create(filepath.Join(s.imagesDir(), name))
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	defer dst.Close()
	if _, err := dst.Write(head[:n]); err != nil {
		httpx.Fail(w, r, err)
		return
	}
	size, err := io.Copy(dst, file)
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	url := s.Cfg.PublicBaseURL + "/uploads/images/" + name
	s.audit(r, "upload", "image", 0, map[string]any{"name": sanitizeFilename(hdr.Filename), "url": url})
	httpx.JSON(w, http.StatusCreated, map[string]any{"url": url, "size": size + int64(n), "mime": mime})
}
