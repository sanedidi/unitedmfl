package api

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http/httptest"
	"os"
	"testing"
	"time"

	"github.com/sanedidi/unitedmfl/backend/internal/config"
	"github.com/sanedidi/unitedmfl/backend/internal/db"
)

func TestVisitSource(t *testing.T) {
	cases := []struct{ utm, ref, want string }{
		{"", "", "direct"},
		{"", "https://unitedmfl.uz/jadval", "direct"},
		{"", "https://www.unitedmfl.com/", "direct"},
		{"", "https://l.instagram.com/?u=x", "instagram"},
		{"", "https://t.me/unitedmfl", "telegram"},
		{"", "android-app://org.telegram.messenger", "telegram"},
		{"", "https://www.google.co.uz/", "google"},
		{"", "https://yandex.uz/search", "yandex"},
		{"", "https://m.facebook.com/", "facebook"},
		{"", "https://youtu.be/x", "youtube"},
		{"", "https://kun.uz/news/1", "other"},
		{"IG", "https://t.me/x", "instagram"},
		{"telegram_channel", "", "telegram"},
		{"newsletter", "", "other"},
	}
	for _, c := range cases {
		if got := visitSource(c.utm, c.ref, "unitedmfl.uz"); got != c.want {
			t.Errorf("visitSource(%q, %q) = %q, want %q", c.utm, c.ref, got, c.want)
		}
	}
}

func TestCleanTrackPath(t *testing.T) {
	cases := []struct {
		in, want string
		ok       bool
	}{
		{"/", "/", true},
		{"/jadval/", "/jadval", true},
		{"/matchlar/12-a1-blacstone?tab=tarkib#x", "/matchlar/12-a1-blacstone", true},
		{"/preview", "", false},
		{"/preview/abc", "", false},
		{"/previews", "/previews", true},
		{"/api/v1/track", "", false},
		{"//evil.com", "", false},
		{"jadval", "", false},
	}
	for _, c := range cases {
		got, ok := cleanTrackPath(c.in)
		if got != c.want || ok != c.ok {
			t.Errorf("cleanTrackPath(%q) = %q,%v want %q,%v", c.in, got, ok, c.want, c.ok)
		}
	}
}

func TestIsBot(t *testing.T) {
	if !isBot("") || !isBot("Mozilla/5.0 (compatible; Googlebot/2.1)") || !isBot("TelegramBot (like TwitterBot)") || !isBot("facebookexternalhit/1.1") {
		t.Error("bots not detected")
	}
	if isBot("Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1") {
		t.Error("iPhone Safari taken for a bot")
	}
}

// Views and heartbeats from the site end up in the Dashboard numbers: unique
// visitors, «online now», the chart, top pages and sources; bots are ignored.
func TestVisitors(t *testing.T) {
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("TEST_DATABASE_URL not set")
	}
	ctx := context.Background()
	conn, err := db.Open(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	if err := db.Migrate(ctx, conn); err != nil {
		t.Fatal(err)
	}
	for _, q := range []string{`DELETE FROM site_hits`, `DELETE FROM site_online`, `DELETE FROM site_daily`} {
		conn.Exec(q)
	}
	var uid int64
	if err := conn.QueryRow(`INSERT INTO users (name, email, password_hash, role) VALUES ('Shop', 'visit-test-'||floor(random()*1e9)::text||'@x.uz', 'x', 'shop') RETURNING id`).Scan(&uid); err != nil {
		t.Fatal(err)
	}
	s := New(conn, &config.Config{UploadDir: t.TempDir(), JWTSecret: []byte("test-secret-test-secret-test-secret!!"), AccessTTL: time.Hour})
	h := s.Routes()
	tok, _, _ := s.Tokens.Sign(uid, "shop", "Shop")

	const iphone = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1"
	send := func(ua string, body map[string]any) {
		b, _ := json.Marshal(body)
		req := httptest.NewRequest("POST", "/api/v1/track", bytes.NewReader(b))
		req.Header.Set("Content-Type", "text/plain;charset=UTF-8")
		req.Header.Set("User-Agent", ua)
		req.Host = "unitedmfl.uz"
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		if rec.Code != 204 {
			t.Fatalf("track → %d", rec.Code)
		}
	}
	a, b, c := "aaaaaaaaaaaaaaaaaaaaaaaa", "bbbbbbbbbbbbbbbbbbbbbbbb", "cccccccccccccccccccccccc"
	send(iphone, map[string]any{"t": "view", "p": "/", "v": a, "l": 1, "r": "https://l.instagram.com/"})
	send(iphone, map[string]any{"t": "view", "p": "/jadval/", "v": a})
	send(iphone, map[string]any{"t": "view", "p": "/", "v": b, "l": 1, "r": "https://t.me/unitedmfl"})
	send(iphone, map[string]any{"t": "view", "p": "/matchlar/77-x-y", "v": c, "l": 1})
	send(iphone, map[string]any{"t": "ping", "p": "/matchlar/77-x-y", "v": c})
	send("Googlebot/2.1", map[string]any{"t": "view", "p": "/", "v": "dddddddddddddddddddddddd", "l": 1})
	send(iphone, map[string]any{"t": "view", "p": "/preview", "v": a})
	send(iphone, map[string]any{"t": "nonsense", "p": "/", "v": a})
	// an old visitor: 3 days ago, and a quiet tab
	conn.Exec(`INSERT INTO site_hits (at, visitor, path, source) VALUES (now() - interval '3 days', 'old', '/', 'google')`)
	conn.Exec(`INSERT INTO site_online (visitor, path, seen_at) VALUES ('quiet', '/', now() - interval '20 minutes')`)

	get := func(path string, out any) {
		req := httptest.NewRequest("GET", "/api/v1"+path, nil)
		req.Header.Set("Authorization", "Bearer "+tok)
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		if rec.Code != 200 {
			t.Fatalf("GET %s → %d %s", path, rec.Code, rec.Body.String())
		}
		json.Unmarshal(rec.Body.Bytes(), out)
	}
	var on onlineNow
	get("/admin/visitors/online", &on)
	if on.Total != 3 || on.Match != 1 {
		t.Fatalf("online = %+v, want 3 total, 1 on a match", on)
	}
	var st struct {
		Online  onlineNow        `json:"online"`
		Today   visitTotals      `json:"t_today"`
		Week    visitTotals      `json:"t_7d"`
		Month   visitTotals      `json:"t_30d"`
		Series  []visitPoint     `json:"series"`
		Pages   []visitPage      `json:"pages"`
		Sources []visitSourceRow `json:"sources"`
	}
	get("/admin/visitors?period=30d", &st)
	if st.Today.Visitors != 3 || st.Today.Views != 4 {
		t.Errorf("today = %+v, want 3 visitors / 4 views", st.Today)
	}
	if st.Week.Visitors != 4 || st.Month.Visitors != 4 {
		t.Errorf("7d = %+v, 30d = %+v, want 4 visitors", st.Week, st.Month)
	}
	if len(st.Series) != 30 || st.Series[29].Visitors == nil || *st.Series[29].Visitors != 3 || *st.Series[26].Visitors != 1 {
		t.Errorf("series wrong: %d points, last %+v", len(st.Series), st.Series[len(st.Series)-1])
	}
	if len(st.Pages) == 0 || st.Pages[0].Path != "/" || st.Pages[0].Title != "Bosh sahifa" || st.Pages[0].Views != 3 {
		t.Errorf("pages = %+v", st.Pages)
	}
	want := map[string]int{"instagram": 1, "telegram": 1, "direct": 1, "google": 1}
	for _, sr := range st.Sources {
		if want[sr.Source] != sr.Visits {
			t.Errorf("source %s = %d, want %d", sr.Source, sr.Visits, want[sr.Source])
		}
		delete(want, sr.Source)
	}
	if len(want) != 0 {
		t.Errorf("missing sources %v", want)
	}
	get("/admin/visitors?period=today", &st)
	if len(st.Series) != 24 {
		t.Errorf("today series has %d points, want 24", len(st.Series))
	}
	// housekeeping: quiet tabs go, today and the last days land in site_daily
	s.visitHousekeeping(ctx)
	var quiet, daily, todayVisitors int
	conn.QueryRow(`SELECT count(*) FROM site_online WHERE visitor = 'quiet'`).Scan(&quiet)
	conn.QueryRow(`SELECT count(*) FROM site_daily`).Scan(&daily)
	conn.QueryRow(`SELECT visitors FROM site_daily WHERE day = (now() AT TIME ZONE 'Asia/Tashkent')::date`).Scan(&todayVisitors)
	if quiet != 0 || daily != 1 || todayVisitors != 3 {
		t.Errorf("housekeeping: quiet=%d daily=%d today=%d", quiet, daily, todayVisitors)
	}
}
