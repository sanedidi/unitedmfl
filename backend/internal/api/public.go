package api

import (
	"bytes"
	"context"
	"database/sql"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/sanedidi/unitedmfl/backend/internal/httpx"
	"github.com/sanedidi/unitedmfl/backend/internal/standings"
)

const teamJSON = `CASE WHEN %[1]s.id IS NULL THEN NULL ELSE json_build_object('id',%[1]s.id,'name',%[1]s.name,'slug',%[1]s.slug,
	'short_name',%[1]s.short_name,'crest_url',%[1]s.crest_url,'colors',%[1]s.colors) END`

// matchSelect is the shared projection for match cards.
var matchSelect = `SELECT m.id, m.season_id, m.round, m.kickoff_at, m.venue, m.ticket_url, m.status, m.period,
	m.clock_started_at, m.clock_offset_sec, m.home_score, m.away_score, m.home_ht, m.away_ht, m.home_et, m.away_et,
	m.home_pen, m.away_pen, m.attendance, m.banner_url, m.video_url, m.show_in_hero, m.published,
	CASE WHEN st.id IS NULL THEN NULL ELSE json_build_object('id', st.id, 'name', st.name, 'kind', st.kind) END AS stage,
	` + fmt.Sprintf(teamJSON, "h") + ` AS home, ` + fmt.Sprintf(teamJSON, "a") + ` AS away
	FROM matches m
	LEFT JOIN stages st ON st.id = m.stage_id
	LEFT JOIN teams h ON h.id = m.home_team_id
	LEFT JOIN teams a ON a.id = m.away_team_id`

func (s *Server) queryJSON(ctx context.Context, q string, args ...any) ([]byte, error) {
	var raw []byte
	err := s.DB.QueryRowContext(ctx, q, args...).Scan(&raw)
	return raw, err
}

func (s *Server) respondQuery(w http.ResponseWriter, r *http.Request, q string, args ...any) {
	raw, err := s.queryJSON(r.Context(), q, args...)
	if errors.Is(err, sql.ErrNoRows) || (err == nil && string(raw) == "null") {
		httpx.Fail(w, r, httpx.ErrNotFound)
		return
	}
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	writeRaw(w, 200, raw)
}

func (s *Server) activeSeasonID(ctx context.Context, r *http.Request) (int64, error) {
	if v := r.URL.Query().Get("season"); v != "" {
		var id int64
		err := s.DB.QueryRowContext(ctx, `SELECT id FROM seasons WHERE slug=$1 OR id::text=$1`, v).Scan(&id)
		if err != nil {
			return 0, httpx.ErrNotFound
		}
		return id, nil
	}
	var id int64
	err := s.DB.QueryRowContext(ctx, `SELECT id FROM seasons ORDER BY is_active DESC, id DESC LIMIT 1`).Scan(&id)
	return id, err
}

func (s *Server) listSeasons(w http.ResponseWriter, r *http.Request) {
	s.respondQuery(w, r, `SELECT coalesce(json_agg(x ORDER BY x.id DESC), '[]') FROM (
		SELECT se.*, (SELECT coalesce(json_agg(st ORDER BY st.ord), '[]') FROM stages st WHERE st.season_id = se.id) AS stages
		FROM seasons se) x`)
}

func (s *Server) publicTeams(w http.ResponseWriter, r *http.Request) {
	s.respondQuery(w, r, `SELECT coalesce(json_agg(t ORDER BY t.group_label, t.name), '[]') FROM (
		SELECT id, slug, name, short_name, group_label, group_is_provisional, crest_url, colors, leader, instagram, telegram
		FROM teams WHERE is_active) t`)
}

func (s *Server) publicTeam(w http.ResponseWriter, r *http.Request) {
	slug := chi.URLParam(r, "slug")
	s.respondQuery(w, r, `SELECT json_build_object(
		'team', row_to_json(t),
		'players', (SELECT coalesce(json_agg(p ORDER BY p.number NULLS LAST, p.full_name), '[]') FROM
			(SELECT p.id, p.full_name, p.number, p.position, `+displayPhoto+` AS photo_url FROM players p WHERE p.team_id = t.id AND p.is_active) p),
		'matches', (SELECT coalesce(json_agg(x ORDER BY x.kickoff_at), '[]') FROM (`+matchSelect+`
			WHERE m.published AND (m.home_team_id = t.id OR m.away_team_id = t.id)) x))
		FROM (SELECT id, slug, name, short_name, group_label, group_is_provisional, crest_url, colors, leader, instagram, telegram
		      FROM teams WHERE slug = $1 AND is_active) t`, slug)
}

func (s *Server) publicPlayers(w http.ResponseWriter, r *http.Request) {
	limit, offset := pageParams(r)
	q := r.URL.Query()
	s.respondQuery(w, r, `SELECT coalesce(json_agg(p), '[]') FROM (
		SELECT p.id, p.full_name, p.number, p.position, `+displayPhoto+` AS photo_url,
		       json_build_object('id', t.id, 'name', t.name, 'slug', t.slug) AS team
		FROM players p LEFT JOIN teams t ON t.id = p.team_id
		WHERE p.is_active AND ($1 = '' OR t.slug = $1) AND ($2 = '' OR p.position = $2) AND ($3 = '' OR p.full_name ILIKE '%' || $3 || '%')
		ORDER BY t.name, p.number NULLS LAST LIMIT $4 OFFSET $5) p`,
		q.Get("team"), q.Get("position"), strings.TrimSpace(q.Get("q")), limit, offset)
}

func (s *Server) publicPlayer(w http.ResponseWriter, r *http.Request) {
	id, err := idParam(r, "id")
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	s.respondQuery(w, r, `SELECT json_build_object(
		'player', json_build_object('id', p.id, 'full_name', p.full_name, 'number', p.number, 'position', p.position, 'photo_url', `+displayPhoto+`, 'instagram', p.instagram),
		'team', CASE WHEN t.id IS NULL THEN NULL ELSE json_build_object('id', t.id, 'name', t.name, 'slug', t.slug) END,
		'stats', json_build_object(
			'appearances', (SELECT count(DISTINCT match_id) FROM lineups WHERE player_id = p.id AND match_id IN (SELECT id FROM matches WHERE published)),
			'goals', (SELECT count(*) FROM match_events WHERE player_id = p.id AND match_id IN (SELECT id FROM matches WHERE published) AND type IN ('goal','penalty_goal')),
			'yellow', (SELECT count(*) FROM match_events WHERE player_id = p.id AND match_id IN (SELECT id FROM matches WHERE published) AND type IN ('yellow','second_yellow')),
			'red', (SELECT count(*) FROM match_events WHERE player_id = p.id AND match_id IN (SELECT id FROM matches WHERE published) AND type = 'red')),
		'matches', (SELECT coalesce(json_agg(x ORDER BY x.kickoff_at DESC), '[]') FROM (`+matchSelect+`
			WHERE m.published AND m.id IN (SELECT match_id FROM lineups WHERE player_id = p.id
				UNION SELECT match_id FROM match_events WHERE player_id = p.id OR related_player_id = p.id)) x),
		'updated_at', p.updated_at)
		FROM players p LEFT JOIN teams t ON t.id = p.team_id WHERE p.id = $1 AND p.is_active`, id)
}

func (s *Server) publicMatches(w http.ResponseWriter, r *http.Request) {
	seasonID, err := s.activeSeasonID(r.Context(), r)
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	q := r.URL.Query()
	stage, _ := strconv.ParseInt(q.Get("stage"), 10, 64)
	order := "ASC"
	if q.Get("status") == "finished" {
		order = "DESC"
	}
	limit, offset := pageParams(r)
	s.respondQuery(w, r, `SELECT coalesce(json_agg(x), '[]') FROM (`+matchSelect+`
		WHERE m.published AND m.season_id = $1
		  AND ($2 = '' OR m.status = $2 OR ($2 = 'live' AND m.status = 'halftime'))
		  AND ($3 = 0 OR m.stage_id = $3)
		  AND ($4 = '' OR h.slug = $4 OR a.slug = $4)
		ORDER BY m.kickoff_at `+order+` NULLS LAST LIMIT $5 OFFSET $6) x`,
		seasonID, q.Get("status"), stage, q.Get("team"), limit, offset)
}

func (s *Server) matchDetailJSON(ctx context.Context, id int64, adminView bool) ([]byte, error) {
	pub, extra := "AND m.published", ""
	// The site only shows lineups a moderator has published.
	lineupPub := "AND EXISTS (SELECT 1 FROM lineup_meta lm WHERE lm.match_id = l.match_id AND lm.side = l.side AND lm.status = 'published')"
	metaPub := "AND status = 'published'"
	if adminView {
		lineupPub, metaPub = "", ""
		// admins also get the raw row (notes, added time, ids) for the edit form
		pub, extra = "", ",\n\t\t'row', (SELECT row_to_json(mr) FROM matches mr WHERE mr.id = x.id)"
	}
	return s.queryJSON(ctx, `SELECT json_build_object(
		'match', row_to_json(x),
		'events', (SELECT coalesce(json_agg(e ORDER BY e.minute, e.extra_minute, e.id), '[]') FROM
			(SELECT id, side, type, minute, extra_minute, player_id, player_name, related_player_id, related_player_name, note, source, payload
			 FROM match_events WHERE match_id = x.id) e),
		'lineups', (SELECT coalesce(json_agg(l ORDER BY l.side, NOT l.is_starter, l.slot NULLS LAST, l.number NULLS LAST), '[]') FROM
			(SELECT l.side, l.player_id, l.player_name, l.number, l.position, l.role, l.slot, l.is_starter, l.is_captain, coalesce(`+displayPhoto+`, '') AS photo_url
			 FROM lineups l LEFT JOIN players p ON p.id = l.player_id WHERE l.match_id = x.id `+lineupPub+`) l),
		'lineup_meta', (SELECT coalesce(json_agg(lm ORDER BY lm.side), '[]') FROM
			(SELECT side, formation, status, coach, assistant, published_at, updated_at FROM lineup_meta lm WHERE match_id = x.id `+metaPub+`) lm),
		'officials', (SELECT coalesce(json_agg(o ORDER BY o.id), '[]') FROM (SELECT id, side, role, name FROM match_officials WHERE match_id = x.id) o),
		'videos', (SELECT coalesce(json_agg(v), '[]') FROM (SELECT id, title, url, youtube_id, kind, thumbnail_url FROM videos WHERE match_id = x.id AND status='published') v),
		'news', (SELECT coalesce(json_agg(n), '[]') FROM (SELECT slug, title, cover_url, published_at FROM news WHERE match_id = x.id AND status='published' ORDER BY published_at DESC LIMIT 5) n),
		'protocol_pdf', (SELECT CASE WHEN p.id IS NULL THEN NULL ELSE '/api/v1/matches/' || x.id || '/protocol.pdf' END
			FROM protocols p WHERE p.match_id = x.id AND p.status = 'applied' AND p.publish_pdf ORDER BY p.applied_at DESC LIMIT 1),
		'server_time', now()`+extra+`)
		FROM (`+matchSelect+` WHERE m.id = $1 `+pub+`) x`, id)
}

func (s *Server) publicMatch(w http.ResponseWriter, r *http.Request) {
	id, err := idParam(r, "id")
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	raw, err := s.matchDetailJSON(r.Context(), id, false)
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

func (s *Server) publicProtocolPDF(w http.ResponseWriter, r *http.Request) {
	id, err := idParam(r, "id")
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	var path, mime, name string
	err = s.DB.QueryRowContext(r.Context(), `SELECT p.file_path, p.mime, p.file_name FROM protocols p JOIN matches m ON m.id = p.match_id
		WHERE p.match_id=$1 AND m.published AND p.status='applied' AND p.publish_pdf ORDER BY p.applied_at DESC LIMIT 1`, id).Scan(&path, &mime, &name)
	if err != nil {
		httpx.Fail(w, r, httpx.ErrNotFound)
		return
	}
	s.serveFile(w, r, path, mime, name)
}

func (s *Server) serveFile(w http.ResponseWriter, r *http.Request, path, mime, name string) {
	f, err := os.Open(path)
	if err != nil {
		httpx.Fail(w, r, httpx.ErrNotFound)
		return
	}
	defer f.Close()
	st, _ := f.Stat()
	w.Header().Set("Content-Type", mime)
	w.Header().Set("Content-Disposition", fmt.Sprintf(`inline; filename=%q`, sanitizeFilename(name)))
	http.ServeContent(w, r, name, st.ModTime(), f)
}

// computeStandings returns group tables for a season.
func (s *Server) computeStandings(ctx context.Context, seasonID int64) (map[string][]standings.Row, error) {
	rows, err := s.DB.QueryContext(ctx, `SELECT DISTINCT t.id, t.name, t.slug, t.group_label, t.group_is_provisional
		FROM teams t WHERE t.is_active AND t.group_label <> ''`)
	if err != nil {
		return nil, err
	}
	var teams []standings.Team
	for rows.Next() {
		var t standings.Team
		if err := rows.Scan(&t.ID, &t.Name, &t.Slug, &t.Group, &t.Provisional); err != nil {
			rows.Close()
			return nil, err
		}
		teams = append(teams, t)
	}
	rows.Close()
	res, err := s.DB.QueryContext(ctx, `SELECT m.home_team_id, m.away_team_id, m.home_score, m.away_score, extract(epoch FROM coalesce(m.kickoff_at, m.created_at))::bigint
		FROM matches m JOIN stages st ON st.id = m.stage_id
		WHERE m.season_id = $1 AND m.published AND st.kind = 'group' AND m.status = 'finished'
		  AND m.home_team_id IS NOT NULL AND m.away_team_id IS NOT NULL AND m.home_score IS NOT NULL AND m.away_score IS NOT NULL`, seasonID)
	if err != nil {
		return nil, err
	}
	var results []standings.Result
	for res.Next() {
		var x standings.Result
		if err := res.Scan(&x.HomeID, &x.AwayID, &x.HomeGoals, &x.AwayGoals, &x.Order); err != nil {
			res.Close()
			return nil, err
		}
		results = append(results, x)
	}
	res.Close()
	adj := map[int64]int{}
	ar, err := s.DB.QueryContext(ctx, `SELECT team_id, sum(points) FROM standing_adjustments WHERE season_id=$1 GROUP BY team_id`, seasonID)
	if err != nil {
		return nil, err
	}
	for ar.Next() {
		var id int64
		var p int
		if err := ar.Scan(&id, &p); err == nil {
			adj[id] = p
		}
	}
	ar.Close()
	return standings.Compute(teams, results, adj, standings.Rules{Win: s.Cfg.PointsWin, Draw: s.Cfg.PointsDraw, Loss: s.Cfg.PointsLoss}), nil
}

func (s *Server) publicStandings(w http.ResponseWriter, r *http.Request) {
	seasonID, err := s.activeSeasonID(r.Context(), r)
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	tables, err := s.computeStandings(r.Context(), seasonID)
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	var provisional bool
	_ = s.DB.QueryRowContext(r.Context(), `SELECT bool_or(group_is_provisional) FROM teams WHERE is_active AND group_label <> ''`).Scan(&provisional)
	playoff, err := s.queryJSON(r.Context(), `SELECT coalesce(json_agg(x ORDER BY x.kickoff_at), '[]') FROM (`+matchSelect+`
		WHERE m.published AND m.season_id = $1 AND st.kind <> 'group') x`, seasonID)
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	httpx.JSON(w, 200, map[string]any{
		"groups":             tables,
		"groups_provisional": provisional,
		"rules":              map[string]int{"win": s.Cfg.PointsWin, "draw": s.Cfg.PointsDraw, "loss": s.Cfg.PointsLoss},
		"playoff":            rawJSON(playoff),
	})
}

func (s *Server) publicLeaders(w http.ResponseWriter, r *http.Request) {
	seasonID, err := s.activeSeasonID(r.Context(), r)
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	s.respondQuery(w, r, `WITH fm AS (SELECT * FROM matches WHERE season_id = $1 AND published AND status = 'finished' AND home_score IS NOT NULL),
	tg AS (
		SELECT team_id, sum(g) AS goals, count(*) AS played FROM (
			SELECT home_team_id AS team_id, home_score AS g FROM fm UNION ALL SELECT away_team_id, away_score FROM fm) z
		WHERE team_id IS NOT NULL GROUP BY team_id)
	SELECT json_build_object(
		'summary', json_build_object('matches', (SELECT count(*) FROM fm), 'goals', (SELECT coalesce(sum(home_score + away_score), 0) FROM fm),
			'goals_per_match', (SELECT CASE WHEN count(*) = 0 THEN 0 ELSE round(sum(home_score + away_score)::numeric / count(*), 2) END FROM fm)),
		'team_goals', (SELECT coalesce(json_agg(x ORDER BY x.goals DESC, x.name), '[]') FROM
			(SELECT t.id, t.name, t.slug, t.group_label, tg.goals, tg.played FROM tg JOIN teams t ON t.id = tg.team_id) x),
		'scorers', (SELECT coalesce(json_agg(x ORDER BY x.goals DESC, x.name), '[]') FROM
			(SELECT coalesce(p.full_name, e.player_name) AS name, e.player_id, t.name AS team, t.slug AS team_slug, count(*) AS goals
			 FROM match_events e JOIN fm ON fm.id = e.match_id LEFT JOIN players p ON p.id = e.player_id LEFT JOIN teams t ON t.id = e.team_id
			 WHERE e.type IN ('goal','penalty_goal') GROUP BY 1, 2, 3, 4 ORDER BY 5 DESC, 1 LIMIT 20) x),
		'cards', (SELECT coalesce(json_agg(x ORDER BY x.yellow DESC, x.red DESC), '[]') FROM
			(SELECT coalesce(p.full_name, e.player_name) AS name, e.player_id, t.name AS team, t.slug AS team_slug,
			        count(*) FILTER (WHERE e.type IN ('yellow','second_yellow')) AS yellow, count(*) FILTER (WHERE e.type = 'red') AS red
			 FROM match_events e JOIN fm ON fm.id = e.match_id LEFT JOIN players p ON p.id = e.player_id LEFT JOIN teams t ON t.id = e.team_id
			 WHERE e.type IN ('yellow','second_yellow','red') GROUP BY 1, 2, 3, 4 ORDER BY 5 DESC, 6 DESC, 1 LIMIT 20) x))`, seasonID)
}

func (s *Server) publicNews(w http.ResponseWriter, r *http.Request) {
	limit, offset := pageParams(r)
	q := r.URL.Query()
	s.respondQuery(w, r, `SELECT coalesce(json_agg(n), '[]') FROM (
		SELECT slug, title, category, excerpt, cover_url, published_at, on_home, tags FROM news
		WHERE status IN ('published','scheduled') AND published_at <= now()
		  AND ($1 = '' OR category = upper($1)) AND ($2 = '' OR on_home::text = $2)
		ORDER BY published_at DESC LIMIT $3 OFFSET $4) n`, q.Get("category"), q.Get("home"), limit, offset)
}

func (s *Server) publicNewsItem(w http.ResponseWriter, r *http.Request) {
	slug := chi.URLParam(r, "slug")
	raw, err := s.queryJSON(r.Context(), `SELECT json_build_object('slug', slug, 'title', title, 'category', category, 'excerpt', excerpt, 'body', body,
			'cover_url', cover_url, 'published_at', published_at, 'tags', tags, 'seo_description', seo_description, 'match_id', match_id,
			'updated_at', updated_at, 'author', (SELECT name FROM users WHERE id = news.author_id))
		FROM news WHERE slug = $1 AND status IN ('published','scheduled') AND published_at <= now()`, slug)
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

func (s *Server) publicBanners(w http.ResponseWriter, r *http.Request) {
	s.respondQuery(w, r, `SELECT coalesce(json_agg(b ORDER BY b.ord, b.id), '[]') FROM (
		SELECT id, title, badge, badge_type, event_date, event_time, venue, cta_label, cta_url, image_desktop, image_mobile, layout, ord
		FROM banners WHERE is_active AND status = 'published'
		  AND (show_from IS NULL OR show_from <= now()) AND (show_until IS NULL OR show_until >= now())) b`)
}

func (s *Server) publicVideos(w http.ResponseWriter, r *http.Request) {
	limit, offset := pageParams(r)
	s.respondQuery(w, r, `SELECT coalesce(json_agg(v), '[]') FROM (
		SELECT id, title, url, youtube_id, kind, match_id, duration_sec, thumbnail_url, published_at FROM videos
		WHERE status = 'published' ORDER BY published_at DESC NULLS LAST LIMIT $1 OFFSET $2) v`, limit, offset)
}

func (s *Server) publicProducts(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	s.respondQuery(w, r, `SELECT coalesce(json_agg(p ORDER BY p.ord, p.id), '[]') FROM (
		SELECT id, slug, name, category, price_uzs, sale_price_uzs, images, external_url, featured, status, ord FROM products
		WHERE visible AND status <> 'hidden' AND ($1 = '' OR featured::text = $1) AND ($2 = '' OR category = $2)) p`,
		q.Get("featured"), q.Get("category"))
}

func (s *Server) publicProduct(w http.ResponseWriter, r *http.Request) {
	s.respondQuery(w, r, `SELECT json_build_object('product', row_to_json(p),
		'variants', (SELECT coalesce(json_agg(v ORDER BY v.id), '[]') FROM (SELECT id, size, sku, available FROM product_variants WHERE product_id = p.id) v))
		FROM (SELECT id, slug, name, category, price_uzs, sale_price_uzs, description, images, external_url, status FROM products
		      WHERE slug = $1 AND visible AND status <> 'hidden') p`, chi.URLParam(r, "slug"))
}

func (s *Server) createContact(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Name    string `json:"name"`
		Phone   string `json:"phone"`
		Topic   string `json:"topic"`
		Message string `json:"message"`
	}
	if err := httpx.Decode(r, &in); err != nil {
		httpx.Fail(w, r, err)
		return
	}
	in.Name, in.Phone, in.Message = strings.TrimSpace(in.Name), strings.TrimSpace(in.Phone), strings.TrimSpace(in.Message)
	errs := map[string]any{}
	if n := len([]rune(in.Name)); n < 2 || n > 100 {
		errs["name"] = "Ism 2–100 belgi bo‘lishi kerak"
	}
	if !rePhone.MatchString(in.Phone) {
		errs["phone"] = "Telefon raqami noto‘g‘ri"
	}
	if in.Topic == "" {
		in.Topic = "other"
	}
	if !contains([]string{"partnership", "team", "sponsorship", "tickets", "other"}, in.Topic) {
		errs["topic"] = "Mavzu noto‘g‘ri"
	}
	if len([]rune(in.Message)) > 2000 {
		errs["message"] = "Xabar juda uzun"
	}
	if len(errs) > 0 {
		httpx.Fail(w, r, httpx.Validation(errs))
		return
	}
	var id int64
	err := s.DB.QueryRowContext(r.Context(), `INSERT INTO contact_requests(name, phone, topic, message, ip) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
		in.Name, in.Phone, in.Topic, in.Message, httpx.ClientIP(r)).Scan(&id)
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusCreated, map[string]any{"id": id, "message": "Rahmat! Tez orada siz bilan bog‘lanamiz."})
}

// liveStream streams match snapshots over Server-Sent Events.
func (s *Server) liveStream(w http.ResponseWriter, r *http.Request) {
	id, err := idParam(r, "id")
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	fl, ok := w.(http.Flusher)
	if !ok {
		httpx.Fail(w, r, httpx.NewError(500, "no_stream", "Streaming qo‘llab-quvvatlanmaydi"))
		return
	}
	snap, err := s.matchDetailJSON(r.Context(), id, false)
	if err != nil {
		httpx.Fail(w, r, httpx.ErrNotFound)
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no")
	ch, unsub := s.Hub.Subscribe(id)
	defer unsub()
	writeSSE(w, "match", snap)
	fl.Flush()
	ping := time.NewTicker(20 * time.Second)
	defer ping.Stop()
	for {
		select {
		case <-r.Context().Done():
			return
		case msg, ok := <-ch:
			if !ok {
				return
			}
			writeSSE(w, "match", msg)
			fl.Flush()
		case <-ping.C:
			fmt.Fprint(w, ": ping\n\n")
			fl.Flush()
		}
	}
}

// broadcastMatch pushes the current snapshot to live subscribers.
func (s *Server) broadcastMatch(ctx context.Context, id int64) {
	// every match change goes through here: keep updated_at honest for sitemap lastmod
	_, _ = s.DB.ExecContext(ctx, `UPDATE matches SET updated_at = now() WHERE id = $1`, id)
	if s.Hub.Count(id) == 0 {
		return
	}
	if snap, err := s.matchDetailJSON(ctx, id, false); err == nil {
		s.Hub.Publish(id, snap)
	}
}

// writeSSE writes one Server-Sent Event. Postgres JSON output may contain
// newlines, and a bare newline would end the data field, so every line gets
// its own "data:" prefix (clients join them back with "\n").
func writeSSE(w io.Writer, event string, data []byte) {
	var b bytes.Buffer
	b.WriteString("event: ")
	b.WriteString(event)
	b.WriteByte('\n')
	for _, line := range bytes.Split(data, []byte("\n")) {
		b.WriteString("data: ")
		b.Write(bytes.TrimRight(line, "\r"))
		b.WriteByte('\n')
	}
	b.WriteByte('\n')
	_, _ = w.Write(b.Bytes())
}

// publicSitemap lists every public, indexable URL source with its real
// modification time, so the site's sitemap.xml never invents lastmod dates.
func (s *Server) publicSitemap(w http.ResponseWriter, r *http.Request) {
	s.respondQuery(w, r, `SELECT json_build_object(
		'matches', (SELECT coalesce(json_agg(x ORDER BY x.id), '[]') FROM (
			SELECT m.id, m.kickoff_at, m.updated_at, h.name AS home, a.name AS away, st.name AS stage
			FROM matches m LEFT JOIN teams h ON h.id = m.home_team_id LEFT JOIN teams a ON a.id = m.away_team_id
			LEFT JOIN stages st ON st.id = m.stage_id
			WHERE m.published) x),
		'teams', (SELECT coalesce(json_agg(x ORDER BY x.slug), '[]') FROM (
			SELECT t.slug, greatest(t.updated_at,
				(SELECT max(p.updated_at) FROM players p WHERE p.team_id = t.id),
				(SELECT max(m.updated_at) FROM matches m WHERE m.published AND t.id IN (m.home_team_id, m.away_team_id))) AS updated_at
			FROM teams t WHERE t.is_active) x),
		'players', (SELECT coalesce(json_agg(x ORDER BY x.id), '[]') FROM (
			SELECT id, full_name, updated_at FROM players WHERE is_active) x),
		'news', (SELECT coalesce(json_agg(x ORDER BY x.published_at DESC), '[]') FROM (
			SELECT slug, published_at, updated_at FROM news WHERE status IN ('published','scheduled') AND published_at <= now()) x),
		'products', (SELECT coalesce(json_agg(x ORDER BY x.slug), '[]') FROM (
			SELECT slug, updated_at FROM products WHERE visible AND status <> 'hidden') x),
		'videos_updated_at', (SELECT max(coalesce(published_at, created_at)) FROM videos WHERE status = 'published'))`)
}

// newsView counts a page view. The site caches article data, so views are
// reported by the browser (one beacon per page load) instead of by GET.
func (s *Server) newsView(w http.ResponseWriter, r *http.Request) {
	if !s.viewLimiter.Allow(httpx.ClientIP(r) + "|" + chi.URLParam(r, "slug")) {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	_, _ = s.DB.ExecContext(r.Context(), `UPDATE news SET views = views + 1
		WHERE slug = $1 AND status IN ('published','scheduled') AND published_at <= now()`, chi.URLParam(r, "slug"))
	w.WriteHeader(http.StatusNoContent)
}
