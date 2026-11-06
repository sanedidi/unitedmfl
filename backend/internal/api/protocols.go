package api

import (
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
	"time"

	"github.com/sanedidi/unitedmfl/backend/internal/httpx"
	"github.com/sanedidi/unitedmfl/backend/internal/protocol"
)

var protocolTypes = map[string]string{"application/pdf": ".pdf", "image/jpeg": ".jpg", "image/png": ".png"}

func (s *Server) listProtocols(w http.ResponseWriter, r *http.Request) {
	limit, offset := pageParams(r)
	status := r.URL.Query().Get("status")
	s.respondQuery(w, r, `SELECT json_build_object('items', coalesce((SELECT json_agg(p) FROM (
		SELECT p.id, p.file_name, p.mime, p.size_bytes, p.pages, p.status, p.progress, p.method, p.match_id, p.error, p.created_at, p.applied_at,
		       jsonb_array_length(p.issues) AS issues_count,
		       (SELECT count(*) FROM jsonb_array_elements(p.issues) i WHERE i->>'severity' IN ('error','warning')) AS problems_count,
		       p.extracted->>'tournament' AS tournament, p.extracted->>'stage' AS stage, p.extracted->>'date' AS date,
		       p.extracted->'home'->>'name' AS home_name, p.extracted->'away'->>'name' AS away_name,
		       u.name AS uploaded_by_name
		FROM protocols p LEFT JOIN users u ON u.id = p.uploaded_by
		WHERE ($1 = '' OR p.status = $1) ORDER BY p.id DESC LIMIT $2 OFFSET $3) p), '[]'),
		'total', (SELECT count(*) FROM protocols WHERE ($1 = '' OR status = $1)))`, status, limit, offset)
}

func (s *Server) getProtocol(w http.ResponseWriter, r *http.Request) {
	id, err := idParam(r, "id")
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	s.respondQuery(w, r, `SELECT json_build_object('protocol', row_to_json(p), 'file_url', '/api/v1/admin/protocols/' || p.id || '/file',
		'suggested_matches', (SELECT coalesce(json_agg(x), '[]') FROM (`+matchSelect+` WHERE m.id = p.match_id) x))
		FROM protocols p WHERE p.id = $1`, id)
}

func (s *Server) protocolFile(w http.ResponseWriter, r *http.Request) {
	id, err := idParam(r, "id")
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	var path, mime, name string
	if err := s.DB.QueryRowContext(r.Context(), `SELECT file_path, mime, file_name FROM protocols WHERE id=$1`, id).Scan(&path, &mime, &name); err != nil {
		httpx.Fail(w, r, httpx.ErrNotFound)
		return
	}
	s.serveFile(w, r, path, mime, name)
}

// uploadProtocol stores the file and starts asynchronous recognition.
func (s *Server) uploadProtocol(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, s.Cfg.MaxUploadBytes)
	file, hdr, err := r.FormFile("file")
	if err != nil {
		httpx.Fail(w, r, httpx.BadRequest(fmt.Sprintf("«file» maydoni topilmadi yoki fayl %d MB dan katta", s.Cfg.MaxUploadBytes>>20)))
		return
	}
	defer file.Close()
	head := make([]byte, 512)
	n, _ := io.ReadFull(file, head)
	mime := http.DetectContentType(head[:n])
	ext, ok := protocolTypes[mime]
	if !ok {
		httpx.Fail(w, r, httpx.BadRequest("Faqat PDF, JPG yoki PNG"))
		return
	}
	var matchID *int64
	if v := r.FormValue("match_id"); v != "" {
		if id, err := strconv.ParseInt(v, 10, 64); err == nil {
			matchID = &id
		}
	}
	path := filepath.Join(s.protocolsDir(), randomName(ext))
	dst, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_EXCL, 0o640)
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	_, _ = dst.Write(head[:n])
	size, err := io.Copy(dst, file)
	dst.Close()
	if err != nil {
		_ = os.Remove(path)
		httpx.Fail(w, r, err)
		return
	}
	var id int64
	err = s.DB.QueryRowContext(r.Context(), `INSERT INTO protocols(file_name, file_path, mime, size_bytes, status, progress, match_id, uploaded_by)
		VALUES ($1,$2,$3,$4,'processing',5,$5,$6) RETURNING id`, sanitizeFilename(hdr.Filename), path, mime, size+int64(n), matchID, claimsFrom(r.Context()).UserID).Scan(&id)
	if err != nil {
		_ = os.Remove(path)
		httpx.Fail(w, r, err)
		return
	}
	s.audit(r, "upload", "protocol", id, map[string]any{"file": hdr.Filename})
	go s.processProtocol(id)
	httpx.JSON(w, http.StatusAccepted, map[string]any{"id": id, "status": "processing"})
}

// processProtocol extracts words, parses, validates and tries to find the match.
func (s *Server) processProtocol(id int64) {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()
	var path, mime string
	var matchID sql.NullInt64
	if err := s.DB.QueryRowContext(ctx, `SELECT file_path, mime, match_id FROM protocols WHERE id=$1`, id).Scan(&path, &mime, &matchID); err != nil {
		slog.Error("protocol load", "id", id, "err", err)
		return
	}
	fail := func(err error) {
		slog.Warn("protocol failed", "id", id, "err", err)
		_, _ = s.DB.ExecContext(ctx, `UPDATE protocols SET status='failed', progress=100, error=$2, updated_at=now() WHERE id=$1`, id,
			"Faylni o‘qib bo‘lmadi: "+err.Error())
	}
	_, _ = s.DB.ExecContext(ctx, `UPDATE protocols SET progress=30, updated_at=now() WHERE id=$1`, id)
	words, method, pages, err := protocol.ExtractWords(ctx, path, mime)
	if err != nil {
		fail(err)
		return
	}
	if len(words) < 20 {
		fail(errors.New("matn topilmadi — sifat past, qayta skanerlang"))
		return
	}
	_, _ = s.DB.ExecContext(ctx, `UPDATE protocols SET progress=70, updated_at=now() WHERE id=$1`, id)
	ex := protocol.Parse(words)
	issues := protocol.Validate(ex)
	if !matchID.Valid {
		if mid, ok := s.findMatchFor(ctx, ex); ok {
			matchID = sql.NullInt64{Int64: mid, Valid: true}
		}
	}
	if !matchID.Valid {
		issues = append(issues, protocol.Issue{Severity: "error", Code: "match_not_found",
			Message: "Match avtomatik topilmadi — qo‘llashda matchni tanlang", Ref: "match"})
	}
	exJSON, _ := json.Marshal(ex)
	isJSON, _ := json.Marshal(issues)
	_, err = s.DB.ExecContext(ctx, `UPDATE protocols SET status='review', progress=100, method=$2, pages=$3, extracted=$4, issues=$5,
		match_id=$6, error='', updated_at=now() WHERE id=$1`, id, method, pages, exJSON, isJSON, nullInt(matchID))
	if err != nil {
		slog.Error("protocol save", "id", id, "err", err)
	}
}

func nullInt(n sql.NullInt64) any {
	if n.Valid {
		return n.Int64
	}
	return nil
}

// findMatchFor matches a protocol to a fixture by team names (either order) and date.
func (s *Server) findMatchFor(ctx context.Context, ex *protocol.Extracted) (int64, bool) {
	if ex.Home.Name == "" || ex.Away.Name == "" {
		return 0, false
	}
	var date any
	if t, err := time.Parse("02.01.2006", ex.Date); err == nil {
		date = t.Format("2006-01-02")
	}
	var id int64
	err := s.DB.QueryRowContext(ctx, `SELECT m.id FROM matches m JOIN teams h ON h.id=m.home_team_id JOIN teams a ON a.id=m.away_team_id
		WHERE ((lower(h.name)=lower($1) AND lower(a.name)=lower($2)) OR (lower(h.name)=lower($2) AND lower(a.name)=lower($1)))
		  AND ($3::date IS NULL OR (m.kickoff_at AT TIME ZONE 'Asia/Tashkent')::date = $3::date)
		ORDER BY m.kickoff_at DESC LIMIT 1`, ex.Home.Name, ex.Away.Name, date).Scan(&id)
	return id, err == nil
}

func (s *Server) loadExtracted(ctx context.Context, id int64) (*protocol.Extracted, string, error) {
	var raw []byte
	var status string
	err := s.DB.QueryRowContext(ctx, `SELECT extracted, status FROM protocols WHERE id=$1`, id).Scan(&raw, &status)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, "", httpx.ErrNotFound
	}
	if err != nil {
		return nil, "", err
	}
	if raw == nil {
		return nil, status, httpx.BadRequest("Protokol hali tanib olinmagan")
	}
	var ex protocol.Extracted
	if err := json.Unmarshal(raw, &ex); err != nil {
		return nil, status, err
	}
	return &ex, status, nil
}

func (s *Server) saveExtracted(ctx context.Context, id int64, ex *protocol.Extracted, matchID *int64) ([]protocol.Issue, error) {
	issues := protocol.Validate(ex)
	exJSON, _ := json.Marshal(ex)
	isJSON, _ := json.Marshal(issues)
	_, err := s.DB.ExecContext(ctx, `UPDATE protocols SET extracted=$2, issues=$3, match_id=coalesce($4, match_id), updated_at=now() WHERE id=$1`,
		id, exJSON, isJSON, matchID)
	return issues, err
}

// updateProtocolExtracted stores manual corrections from the review screen.
func (s *Server) updateProtocolExtracted(w http.ResponseWriter, r *http.Request) {
	id, err := idParam(r, "id")
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	_, status, err := s.loadExtracted(r.Context(), id)
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	if status != "review" {
		httpx.Fail(w, r, httpx.BadRequest("Faqat «review» holatidagi protokolni tahrirlash mumkin"))
		return
	}
	var in struct {
		Extracted protocol.Extracted `json:"extracted"`
		MatchID   *int64             `json:"match_id"`
	}
	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, 2<<20))
	if err := dec.Decode(&in); err != nil {
		httpx.Fail(w, r, httpx.BadRequest("JSON noto‘g‘ri"))
		return
	}
	issues, err := s.saveExtracted(r.Context(), id, &in.Extracted, in.MatchID)
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	s.audit(r, "edit", "protocol", id, nil)
	httpx.JSON(w, 200, map[string]any{"issues": issues})
}

// rederiveProtocol rebuilds events from the (edited) G/S/Q/A cells.
func (s *Server) rederiveProtocol(w http.ResponseWriter, r *http.Request) {
	id, err := idParam(r, "id")
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	ex, _, err := s.loadExtracted(r.Context(), id)
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	protocol.Rederive(ex)
	issues, err := s.saveExtracted(r.Context(), id, ex, nil)
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	httpx.JSON(w, 200, map[string]any{"extracted": ex, "issues": issues})
}

func (s *Server) reprocessProtocol(w http.ResponseWriter, r *http.Request) {
	id, err := idParam(r, "id")
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	res, err := s.DB.ExecContext(r.Context(), `UPDATE protocols SET status='processing', progress=5, updated_at=now() WHERE id=$1 AND status IN ('review','failed')`, id)
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	if n, _ := res.RowsAffected(); n == 0 {
		httpx.Fail(w, r, httpx.BadRequest("Protokolni qayta ishlab bo‘lmaydi"))
		return
	}
	go s.processProtocol(id)
	httpx.JSON(w, http.StatusAccepted, map[string]any{"id": id, "status": "processing"})
}

func (s *Server) rejectProtocol(w http.ResponseWriter, r *http.Request) {
	id, err := idParam(r, "id")
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	res, err := s.DB.ExecContext(r.Context(), `UPDATE protocols SET status='rejected', updated_at=now() WHERE id=$1 AND status IN ('review','failed')`, id)
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	if n, _ := res.RowsAffected(); n == 0 {
		httpx.Fail(w, r, httpx.BadRequest("Protokolni rad etib bo‘lmaydi"))
		return
	}
	s.audit(r, "reject", "protocol", id, nil)
	w.WriteHeader(http.StatusNoContent)
}

var positionMap = map[string]string{"DR": "GK", "HM": "DF", "YH": "MF", "HJ": "FW"}

type applyInput struct {
	MatchID              *int64 `json:"match_id"`
	SwapSides            bool   `json:"swap_sides"`
	CreateMissingPlayers bool   `json:"create_missing_players"`
	PublishPDF           bool   `json:"publish_pdf"`
	Force                bool   `json:"force"`
}

// applyProtocol writes the protocol into the match in one transaction.
func (s *Server) applyProtocol(w http.ResponseWriter, r *http.Request) {
	id, err := idParam(r, "id")
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	var in applyInput
	if err := httpx.Decode(r, &in); err != nil {
		httpx.Fail(w, r, err)
		return
	}
	ex, status, err := s.loadExtracted(r.Context(), id)
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	if status != "review" {
		httpx.Fail(w, r, httpx.BadRequest("Faqat «review» holatidagi protokolni qo‘llash mumkin"))
		return
	}
	matchID := in.MatchID
	if matchID == nil {
		var m sql.NullInt64
		_ = s.DB.QueryRowContext(r.Context(), `SELECT match_id FROM protocols WHERE id=$1`, id).Scan(&m)
		if m.Valid {
			matchID = &m.Int64
		}
	}
	if matchID == nil {
		httpx.Fail(w, r, httpx.Validation(map[string]any{"match_id": "Matchni tanlang"}))
		return
	}
	issues := protocol.Validate(ex)
	if protocol.Blocking(issues) && !in.Force {
		httpx.JSON(w, http.StatusUnprocessableEntity, map[string]any{"error": httpx.NewError(422, "blocking_issues", "Protokolda xatolar bor — tuzating yoki force=true"), "issues": issues})
		return
	}
	summary, err := s.applyTx(r.Context(), id, *matchID, ex, in, claimsFrom(r.Context()).UserID)
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	s.audit(r, "apply", "protocol", id, map[string]any{"match_id": *matchID, "summary": summary})
	s.broadcastMatch(r.Context(), *matchID)
	httpx.JSON(w, 200, map[string]any{"match_id": *matchID, "summary": summary})
}

func (s *Server) applyTx(ctx context.Context, protocolID, matchID int64, ex *protocol.Extracted, in applyInput, userID int64) (map[string]int, error) {
	tx, err := s.DB.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()

	var homeTeam, awayTeam sql.NullInt64
	if err := tx.QueryRowContext(ctx, `SELECT home_team_id, away_team_id FROM matches WHERE id=$1 FOR UPDATE`, matchID).Scan(&homeTeam, &awayTeam); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, httpx.Validation(map[string]any{"match_id": "Match topilmadi"})
		}
		return nil, err
	}
	// protocol side → match side
	mapSide := func(side string) string {
		if !in.SwapSides {
			return side
		}
		if side == protocol.Home {
			return protocol.Away
		}
		return protocol.Home
	}
	teamFor := func(side string) sql.NullInt64 {
		if mapSide(side) == protocol.Home {
			return homeTeam
		}
		return awayTeam
	}
	h, a := ex.Home, ex.Away
	if in.SwapSides {
		h, a = a, h
	}
	if _, err := tx.ExecContext(ctx, `UPDATE matches SET home_score=$2, away_score=$3, home_ht=$4, away_ht=$5, home_et=$6, away_et=$7,
		home_pen=$8, away_pen=$9, attendance=coalesce($10, attendance), added_time_1h=$11, added_time_2h=$12,
		status='finished', period='FT', clock_started_at=NULL, protocol_id=$13, updated_at=now() WHERE id=$1`,
		matchID, h.Total, a.Total, h.Half1, a.Half1, h.Extra, a.Extra, h.Penalty, a.Penalty, ex.Attendance, ex.AddedTime1, ex.AddedTime2, protocolID); err != nil {
		return nil, err
	}
	for _, q := range []string{`DELETE FROM lineups WHERE match_id=$1`, `DELETE FROM match_officials WHERE match_id=$1`,
		`DELETE FROM match_events WHERE match_id=$1 AND source='protocol'`} {
		if _, err := tx.ExecContext(ctx, q, matchID); err != nil {
			return nil, err
		}
	}
	summary := map[string]int{}
	playerIDs := map[string]int64{} // "side#number" → player id
	for _, p := range ex.Players {
		team := teamFor(p.Side)
		var pid sql.NullInt64
		if team.Valid {
			err := tx.QueryRowContext(ctx, `SELECT id FROM players WHERE team_id=$1 AND (number=$2 OR lower(full_name)=lower($3))
				ORDER BY (lower(full_name)=lower($3)) DESC, (number=$2) DESC LIMIT 1`, team.Int64, p.Number, p.Name).Scan(&pid)
			if errors.Is(err, sql.ErrNoRows) && in.CreateMissingPlayers && p.Name != "" {
				err = tx.QueryRowContext(ctx, `INSERT INTO players(team_id, full_name, number, position) VALUES ($1,$2,$3,$4) RETURNING id`,
					team.Int64, p.Name, p.Number, positionMap[p.Position]).Scan(&pid)
				if err == nil {
					summary["players_created"]++
				}
			}
			if err != nil && !errors.Is(err, sql.ErrNoRows) {
				return nil, err
			}
		}
		if pid.Valid {
			playerIDs[p.Side+"#"+strconv.Itoa(p.Number)] = pid.Int64
		}
		if _, err := tx.ExecContext(ctx, `INSERT INTO lineups(match_id, side, team_id, player_id, player_name, number, position, is_starter, is_captain)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, matchID, mapSide(p.Side), team, pid, p.Name, p.Number, positionMap[p.Position], p.Starter, p.Captain); err != nil {
			return nil, err
		}
		summary["lineups"]++
	}
	// Lineups confirmed through the protocol review go straight to the site.
	if _, err := tx.ExecContext(ctx, `INSERT INTO lineup_meta(match_id, side, status, source, published_at, updated_at)
		SELECT $1, s, 'published', 'protocol', now(), now() FROM unnest(ARRAY['home','away']) s
		WHERE EXISTS (SELECT 1 FROM lineups WHERE match_id=$1 AND side=s)
		ON CONFLICT (match_id, side) DO UPDATE SET status='published', source='protocol', published_at=now(), updated_at=now(), version=lineup_meta.version+1`, matchID); err != nil {
		return nil, err
	}
	pidFor := func(side string, num int) any {
		if id, ok := playerIDs[side+"#"+strconv.Itoa(num)]; ok {
			return id
		}
		return nil
	}
	for _, e := range ex.Events {
		if e.Raw != "" {
			if _, _, ok := protocol.ParseMinute(e.Raw); !ok {
				summary["events_skipped"]++
				continue
			}
		}
		if _, err := tx.ExecContext(ctx, `INSERT INTO match_events(match_id, team_id, side, type, minute, extra_minute, player_id, player_name,
			related_player_id, related_player_name, source, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'protocol',$11)`,
			matchID, teamFor(e.Side), mapSide(e.Side), e.Type, e.Minute, e.Extra, pidFor(e.Side, e.Number), e.Player,
			pidFor(e.Side, e.RelatedNumber), e.Related, userID); err != nil {
			return nil, err
		}
		summary["events"]++
	}
	for _, o := range ex.Officials {
		if _, err := tx.ExecContext(ctx, `INSERT INTO match_officials(match_id, side, role, name) VALUES ($1,'',$2,$3)`, matchID, o.Role, o.Name); err != nil {
			return nil, err
		}
		summary["officials"]++
	}
	for _, o := range ex.TeamOfficials {
		if _, err := tx.ExecContext(ctx, `INSERT INTO match_officials(match_id, side, role, name) VALUES ($1,$2,$3,$4)`, matchID, mapSide(o.Side), o.Role, o.Name); err != nil {
			return nil, err
		}
		summary["team_officials"]++
	}
	if _, err := tx.ExecContext(ctx, `UPDATE protocols SET status='applied', match_id=$2, publish_pdf=$3, applied_by=$4, applied_at=now(), updated_at=now() WHERE id=$1`,
		protocolID, matchID, in.PublishPDF, userID); err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return summary, nil
}
