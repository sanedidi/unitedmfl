package api

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/sanedidi/unitedmfl/backend/internal/httpx"
)

// Site visitors («Sayt tashriflari» on the admin Dashboard).
//
// The public site posts {t:"view"} on every page view and {t:"ping"} once a
// minute while the tab is visible. A visitor is an HMAC of the anonymous id
// the browser keeps in localStorage (no cookies); without one, an HMAC of
// IP + user agent + day. The IP address itself is never stored.

const (
	visitTZ        = "Asia/Tashkent"
	onlineWindow   = 5 * time.Minute
	visitRetention = "90 days"
)

// Tashkent has had no daylight saving time since 1992.
var tashkent = time.FixedZone(visitTZ, 5*3600)

var (
	visitorIDRe = regexp.MustCompile(`^[A-Za-z0-9_-]{16,64}$`)
	botUARe     = regexp.MustCompile(`(?i)bot|crawl|spider|slurp|headless|lighthouse|pagespeed|preview|facebookexternalhit|curl|wget|python|go-http|java/|okhttp|axios|node-fetch|monitor|uptime|scanner|phantom|selenium|puppeteer|playwright`)
)

type trackReq struct {
	T string `json:"t"` // view | ping
	P string `json:"p"` // path
	V string `json:"v"` // anonymous browser id
	L int    `json:"l"` // 1 = first page of the visit (this tab)
	R string `json:"r"` // document.referrer (first page only)
	S string `json:"s"` // utm_source (first page only)
}

// track records a page view or a heartbeat from the public site. It always
// answers 204 so the site never waits on it or shows an error.
func (s *Server) track(w http.ResponseWriter, r *http.Request) {
	defer w.WriteHeader(http.StatusNoContent)
	ua := r.UserAgent()
	if isBot(ua) {
		return
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, 4096))
	if err != nil {
		return
	}
	var req trackReq
	if json.Unmarshal(body, &req) != nil || (req.T != "view" && req.T != "ping") {
		return
	}
	path, ok := cleanTrackPath(req.P)
	if !ok {
		return
	}
	ip := httpx.ClientIP(r)
	visitor := s.visitorKey(req.V, ip, ua, time.Now())
	if !s.trackLimiter.Allow(visitor) {
		return
	}
	ctx := r.Context()
	if req.T == "view" {
		source := ""
		if req.L == 1 {
			source = visitSource(req.S, req.R, r.Host)
		}
		if _, err := s.DB.ExecContext(ctx, `INSERT INTO site_hits (visitor, path, source) VALUES ($1, $2, $3)`, visitor, path, source); err != nil {
			slog.Warn("track view", "err", err)
			return
		}
	}
	if _, err := s.DB.ExecContext(ctx, `INSERT INTO site_online (visitor, path, seen_at) VALUES ($1, $2, now())
		ON CONFLICT (visitor) DO UPDATE SET path = EXCLUDED.path, seen_at = now()`, visitor, path); err != nil {
		slog.Warn("track online", "err", err)
	}
}

func isBot(ua string) bool {
	return strings.TrimSpace(ua) == "" || botUARe.MatchString(ua)
}

// visitorKey turns the browser id (or, without one, IP + UA + day) into an
// opaque key that cannot be turned back into either.
func (s *Server) visitorKey(id, ip, ua string, now time.Time) string {
	mac := hmac.New(sha256.New, s.Cfg.JWTSecret)
	if visitorIDRe.MatchString(id) {
		mac.Write([]byte("vid|" + id))
	} else {
		mac.Write([]byte("ipua|" + ip + "|" + ua + "|" + now.In(tashkent).Format("2006-01-02")))
	}
	return hex.EncodeToString(mac.Sum(nil))[:32]
}

// cleanTrackPath keeps the path only (no query or fragment) and drops pages
// that are not part of the public site.
func cleanTrackPath(p string) (string, bool) {
	if i := strings.IndexAny(p, "?#"); i >= 0 {
		p = p[:i]
	}
	if !strings.HasPrefix(p, "/") || strings.HasPrefix(p, "//") || len(p) > 300 {
		return "", false
	}
	if len(p) > 1 {
		p = strings.TrimRight(p, "/")
	}
	for _, skip := range []string{"/preview", "/internal", "/api/", "/uploads/", "/_next/"} {
		if p == skip || strings.HasPrefix(p, strings.TrimRight(skip, "/")+"/") {
			return "", false
		}
	}
	return p, true
}

// visitSource names where a visit came from: utm_source wins, then the
// referrer; no referrer (or our own site) is a direct visit.
func visitSource(utm, referrer, ownHost string) string {
	if u := strings.ToLower(strings.TrimSpace(utm)); u != "" {
		switch {
		case strings.Contains(u, "insta") || u == "ig":
			return "instagram"
		case strings.Contains(u, "telegram") || u == "tg":
			return "telegram"
		case strings.Contains(u, "facebook") || u == "fb":
			return "facebook"
		case strings.Contains(u, "youtube") || u == "yt":
			return "youtube"
		case strings.Contains(u, "tiktok"):
			return "tiktok"
		case strings.Contains(u, "google"):
			return "google"
		case strings.Contains(u, "yandex"):
			return "yandex"
		}
		return "other"
	}
	ref := strings.TrimSpace(referrer)
	if ref == "" {
		return "direct"
	}
	ru, err := url.Parse(ref)
	if err != nil {
		return "other"
	}
	host := strings.ToLower(ru.Hostname())
	if ru.Scheme == "android-app" { // android-app://org.telegram.messenger
		host = strings.ToLower(ru.Host)
	}
	own := strings.ToLower(ownHost)
	if h, _, ok := strings.Cut(own, ":"); ok {
		own = h
	}
	bare := func(h string) string { return strings.TrimPrefix(h, "www.") }
	switch {
	case host == "":
		return "direct"
	case bare(host) == bare(own), strings.HasSuffix(host, "unitedmfl.uz"), strings.HasSuffix(host, "unitedmfl.com"):
		return "direct"
	case strings.Contains(host, "instagram"):
		return "instagram"
	case host == "t.me" || strings.Contains(host, "telegram"):
		return "telegram"
	case strings.Contains(host, "facebook") || host == "fb.com" || strings.HasSuffix(host, ".fb.com") || host == "fb.me":
		return "facebook"
	case strings.Contains(host, "youtube") || host == "youtu.be":
		return "youtube"
	case strings.Contains(host, "tiktok"):
		return "tiktok"
	case strings.Contains(host, "google"):
		return "google"
	case strings.Contains(host, "yandex") || host == "ya.ru":
		return "yandex"
	}
	return "other"
}

// ---------- admin ----------

type visitTotals struct {
	Visitors     int `json:"visitors"`
	Views        int `json:"views"`
	PrevVisitors int `json:"prev_visitors"`
}

type visitPoint struct {
	Label    string `json:"label"`
	Visitors *int   `json:"visitors"` // null for hours that have not come yet
	Views    *int   `json:"views"`
}

type visitPage struct {
	Path  string `json:"path"`
	Title string `json:"title"`
	Views int    `json:"views"`
}

type visitSourceRow struct {
	Source string `json:"source"`
	Visits int    `json:"visits"`
}

type onlineNow struct {
	Total int `json:"total"`
	Match int `json:"match"` // on a match page
}

func (s *Server) onlineCount(ctx context.Context) (onlineNow, error) {
	var o onlineNow
	err := s.DB.QueryRowContext(ctx, `SELECT count(*), count(*) FILTER (WHERE path LIKE '/matchlar/%')
		FROM site_online WHERE seen_at > now() - $1::interval`, strconv.Itoa(int(onlineWindow.Seconds()))+" seconds").Scan(&o.Total, &o.Match)
	return o, err
}

// visitorsOnline feeds the «N onlayn» counter in the admin topbar.
func (s *Server) visitorsOnline(w http.ResponseWriter, r *http.Request) {
	o, err := s.onlineCount(r.Context())
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, o)
}

// visitorStats feeds the «Sayt tashriflari» block: ?period=today|7d|30d.
func (s *Server) visitorStats(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	period := r.URL.Query().Get("period")
	if period != "today" && period != "7d" {
		period = "30d"
	}
	now := time.Now()
	local := now.In(tashkent)
	d0 := time.Date(local.Year(), local.Month(), local.Day(), 0, 0, 0, 0, tashkent)
	day := 24 * time.Hour

	totals := func(from, to, prevFrom, prevTo time.Time) (visitTotals, error) {
		var t visitTotals
		err := s.DB.QueryRowContext(ctx, `SELECT
			(SELECT count(DISTINCT visitor) FROM site_hits WHERE at >= $1 AND at < $2),
			(SELECT count(*)                FROM site_hits WHERE at >= $1 AND at < $2),
			(SELECT count(DISTINCT visitor) FROM site_hits WHERE at >= $3 AND at < $4)`,
			from, to, prevFrom, prevTo).Scan(&t.Visitors, &t.Views, &t.PrevVisitors)
		return t, err
	}
	out := map[string]any{"period": period, "updated_at": now.UTC()}
	online, err := s.onlineCount(ctx)
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	out["online"] = online
	// «Bugun» is compared with yesterday up to the same time of day; 7 and 30
	// days with the 7 and 30 days before them.
	ranges := map[string][4]time.Time{
		"today": {d0, now, d0.Add(-day), now.Add(-day)},
		"7d":    {d0.Add(-6 * day), now, d0.Add(-13 * day), d0.Add(-6 * day)},
		"30d":   {d0.Add(-29 * day), now, d0.Add(-59 * day), d0.Add(-29 * day)},
	}
	for _, k := range []string{"today", "7d", "30d"} {
		rg := ranges[k]
		t, err := totals(rg[0], rg[1], rg[2], rg[3])
		if err != nil {
			httpx.Fail(w, r, err)
			return
		}
		out["t_"+k] = t
	}
	from := ranges[period][0]
	out["from"] = from.Format("2006-01-02")
	out["to"] = d0.Format("2006-01-02")

	// chart: hours for «Bugun», days otherwise
	var series []visitPoint
	if period == "today" {
		series = make([]visitPoint, 24)
		for h := range series {
			series[h].Label = strconv.Itoa(h) + ":00"
			if h <= local.Hour() {
				zero, zero2 := 0, 0
				series[h].Visitors, series[h].Views = &zero, &zero2
			}
		}
		rows, err := s.DB.QueryContext(ctx, `SELECT extract(hour FROM at AT TIME ZONE '`+visitTZ+`')::int, count(DISTINCT visitor), count(*)
			FROM site_hits WHERE at >= $1 GROUP BY 1`, d0)
		if err != nil {
			httpx.Fail(w, r, err)
			return
		}
		for rows.Next() {
			var h, v, pv int
			if rows.Scan(&h, &v, &pv) == nil && h >= 0 && h < 24 && series[h].Visitors != nil {
				*series[h].Visitors, *series[h].Views = v, pv
			}
		}
		rows.Close()
	} else {
		n := 30
		if period == "7d" {
			n = 7
		}
		series = make([]visitPoint, n)
		index := map[string]int{}
		for i := range series {
			d := d0.AddDate(0, 0, i-n+1)
			series[i].Label = d.Format("2006-01-02")
			index[series[i].Label] = i
			zero, zero2 := 0, 0
			series[i].Visitors, series[i].Views = &zero, &zero2
		}
		rows, err := s.DB.QueryContext(ctx, `SELECT to_char((at AT TIME ZONE '`+visitTZ+`')::date, 'YYYY-MM-DD'), count(DISTINCT visitor), count(*)
			FROM site_hits WHERE at >= $1 GROUP BY 1`, from)
		if err != nil {
			httpx.Fail(w, r, err)
			return
		}
		for rows.Next() {
			var d string
			var v, pv int
			if rows.Scan(&d, &v, &pv) == nil {
				if i, ok := index[d]; ok {
					*series[i].Visitors, *series[i].Views = v, pv
				}
			}
		}
		rows.Close()
	}
	out["series"] = series

	pages := []visitPage{}
	rows, err := s.DB.QueryContext(ctx, `SELECT path, count(*) FROM site_hits WHERE at >= $1 GROUP BY path ORDER BY 2 DESC, path LIMIT 5`, from)
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	for rows.Next() {
		var p visitPage
		if rows.Scan(&p.Path, &p.Views) == nil {
			pages = append(pages, p)
		}
	}
	rows.Close()
	for i := range pages {
		pages[i].Title = s.pageTitle(ctx, pages[i].Path)
	}
	out["pages"] = pages

	sources := []visitSourceRow{}
	rows, err = s.DB.QueryContext(ctx, `SELECT source, count(*) FROM site_hits WHERE at >= $1 AND source <> '' GROUP BY source ORDER BY 2 DESC, source`, from)
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	for rows.Next() {
		var sr visitSourceRow
		if rows.Scan(&sr.Source, &sr.Visits) == nil {
			sources = append(sources, sr)
		}
	}
	rows.Close()
	out["sources"] = sources
	httpx.JSON(w, http.StatusOK, out)
}

var sectionTitles = map[string]string{
	"/":              "Bosh sahifa",
	"/matchlar":      "Matchlar",
	"/jadval":        "Turnir jadvali",
	"/statistika":    "Statistika",
	"/jamoalar":      "Jamoalar",
	"/oyinchilar":    "O‘yinchilar",
	"/yangiliklar":   "Yangiliklar",
	"/media":         "Media",
	"/merch":         "Merch",
	"/biz-haqimizda": "Biz haqimizda",
	"/hamkorlar":     "Hamkorlar",
	"/qidiruv":       "Qidiruv",
}

var leadingID = regexp.MustCompile(`^(\d+)`)

// pageTitle names a site page for the «Ommabop sahifalar» list.
func (s *Server) pageTitle(ctx context.Context, path string) string {
	if t, ok := sectionTitles[path]; ok {
		return t
	}
	section, rest, _ := strings.Cut(strings.TrimPrefix(path, "/"), "/")
	if rest == "" || strings.Contains(rest, "/") {
		return path
	}
	rest, _ = url.PathUnescape(rest)
	var title sql.NullString
	switch section {
	case "matchlar":
		if m := leadingID.FindString(rest); m != "" {
			_ = s.DB.QueryRowContext(ctx, `SELECT coalesce(h.name, 'Aniqlanmagan') || ' — ' || coalesce(a.name, 'Aniqlanmagan')
				FROM matches m LEFT JOIN teams h ON h.id = m.home_team_id LEFT JOIN teams a ON a.id = m.away_team_id WHERE m.id = $1`, m).Scan(&title)
		}
	case "oyinchilar":
		if m := leadingID.FindString(rest); m != "" {
			_ = s.DB.QueryRowContext(ctx, `SELECT full_name FROM players WHERE id = $1`, m).Scan(&title)
		}
	case "jamoalar":
		_ = s.DB.QueryRowContext(ctx, `SELECT name FROM teams WHERE slug = $1`, rest).Scan(&title)
	case "yangiliklar":
		_ = s.DB.QueryRowContext(ctx, `SELECT '«' || title || '»' FROM news WHERE slug = $1`, rest).Scan(&title)
	case "merch":
		_ = s.DB.QueryRowContext(ctx, `SELECT name FROM products WHERE slug = $1`, rest).Scan(&title)
	}
	if title.Valid && title.String != "" {
		return title.String
	}
	return path
}

// RunVisitStats keeps the visit tables small: it forgets tabs that went
// quiet, rolls the last days into site_daily and deletes raw hits older than
// 90 days. Runs at start and every 15 minutes.
func (s *Server) RunVisitStats(ctx context.Context) {
	tick := time.NewTicker(15 * time.Minute)
	defer tick.Stop()
	for {
		s.visitHousekeeping(ctx)
		select {
		case <-ctx.Done():
			return
		case <-tick.C:
		}
	}
}

func (s *Server) visitHousekeeping(ctx context.Context) {
	steps := []string{
		`DELETE FROM site_online WHERE seen_at < now() - interval '15 minutes'`,
		// whole Tashkent days only: from the start of the day before yesterday
		`INSERT INTO site_daily (day, visitors, views, updated_at)
		 SELECT (at AT TIME ZONE '` + visitTZ + `')::date, count(DISTINCT visitor), count(*), now()
		 FROM site_hits
		 WHERE at >= (date_trunc('day', now() AT TIME ZONE '` + visitTZ + `') - interval '2 days') AT TIME ZONE '` + visitTZ + `'
		 GROUP BY 1
		 ON CONFLICT (day) DO UPDATE SET visitors = EXCLUDED.visitors, views = EXCLUDED.views, updated_at = now()`,
		`DELETE FROM site_hits WHERE at < now() - interval '` + visitRetention + `'`,
	}
	for _, q := range steps {
		if _, err := s.DB.ExecContext(ctx, q); err != nil && ctx.Err() == nil {
			slog.Warn("visit housekeeping", "err", err)
		}
	}
}
