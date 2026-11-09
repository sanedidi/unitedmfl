package tgbot

import (
	"context"
	"database/sql"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/sanedidi/unitedmfl/backend/internal/api"
	"github.com/sanedidi/unitedmfl/backend/internal/auth"
	"github.com/sanedidi/unitedmfl/backend/internal/config"
	"github.com/sanedidi/unitedmfl/backend/internal/db"
)

func TestNormalizePhone(t *testing.T) {
	for in, want := range map[string]string{
		"+998 90 123-45-67": "998901234567", "998901234567": "998901234567", "90 123 45 67": "998901234567",
		"": "", "12": "!", "abc": "!",
	} {
		got, ok := auth.NormalizePhone(in)
		if want == "!" {
			if ok {
				t.Errorf("%q: want invalid, got %q", in, got)
			}
			continue
		}
		if !ok || got != want {
			t.Errorf("%q: got %q %v, want %q", in, got, ok, want)
		}
	}
}

// fakeTelegram records outgoing Bot API calls.
type fakeTelegram struct {
	mu    sync.Mutex
	calls []tgCall
	next  int
}

type tgCall struct {
	Method string
	Params map[string]any
}

func (f *fakeTelegram) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	raw, _ := io.ReadAll(r.Body)
	var p map[string]any
	_ = json.Unmarshal(raw, &p)
	method := r.URL.Path[strings.LastIndex(r.URL.Path, "/")+1:]
	f.mu.Lock()
	f.calls = append(f.calls, tgCall{method, p})
	f.next++
	id := 1000 + f.next
	f.mu.Unlock()
	w.Header().Set("Content-Type", "application/json")
	_, _ = w.Write([]byte(`{"ok":true,"result":{"message_id":` + itoa(id) + `,"chat":{"id":1,"type":"private"}}}`))
}

func itoa(i int) string { return strconv.Itoa(i) }

func (f *fakeTelegram) take() []tgCall {
	f.mu.Lock()
	defer f.mu.Unlock()
	c := f.calls
	f.calls = nil
	return c
}

func lastText(t *testing.T, calls []tgCall, method string) (string, string) {
	t.Helper()
	for i := len(calls) - 1; i >= 0; i-- {
		if calls[i].Method == method {
			kb, _ := json.Marshal(calls[i].Params["reply_markup"])
			txt, _ := calls[i].Params["text"].(string)
			return txt, string(kb)
		}
	}
	t.Fatalf("no %s call in %v", method, calls)
	return "", ""
}

func answers(calls []tgCall) string {
	var s []string
	for _, c := range calls {
		if c.Method == "answerCallbackQuery" {
			txt, _ := c.Params["text"].(string)
			s = append(s, txt)
		}
	}
	return strings.Join(s, " | ")
}

// Integration test of the whole operator flow against a real database:
//
//	TEST_DATABASE_URL=postgres://... go test -mod=vendor ./internal/tgbot/
func TestOperatorFlow(t *testing.T) {
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
	mustExec := func(q string, args ...any) {
		t.Helper()
		if _, err := conn.ExecContext(ctx, q, args...); err != nil {
			t.Fatalf("%s: %v", q, err)
		}
	}
	// a fresh scheduled match between teams 1 and 5
	mustExec(`DELETE FROM telegram_links`)
	mustExec(`DELETE FROM users WHERE email LIKE '%@bot.test'`)
	mustExec(`DELETE FROM matches WHERE venue = 'bot-test'`)
	mustExec(`DELETE FROM players WHERE full_name LIKE 'Bot %'`)
	var matchID int64
	if err := conn.QueryRowContext(ctx, `INSERT INTO matches (season_id, home_team_id, away_team_id, kickoff_at, venue, status)
		SELECT season_id, 1, 5, now(), 'bot-test', 'scheduled' FROM matches WHERE id = 11 RETURNING id`).Scan(&matchID); err != nil {
		t.Fatal(err)
	}
	// home: matchday lineup (2 starters + 1 sub); away: only the roster
	mustExec(`INSERT INTO players (team_id, full_name, number) VALUES (1,'Bot Home One',1),(1,'Bot Home Two',9),(1,'Bot Home Bench',12),(5,'Bot Away Ten',10),(5,'Bot Away Seven',7)`)
	mustExec(`INSERT INTO lineups (match_id, side, team_id, player_id, player_name, number, is_starter)
		SELECT $1, 'home', 1, id, full_name, number, number <> 12 FROM players WHERE team_id = 1 AND full_name LIKE 'Bot %'`, matchID)
	hash, _ := auth.HashPassword("password-123")
	mustExec(`INSERT INTO users (name, email, password_hash, role, phone) VALUES
		('Operator Bot','op@bot.test',$1,'operator','998901234567'), ('Editor Bot','ed@bot.test',$1,'editor','998907654321')`, hash)

	cfg, _ := config.Load()
	server := api.New(conn, cfg)
	fake := &fakeTelegram{}
	tgSrv := httptest.NewServer(fake)
	defer tgSrv.Close()
	b := New(Options{Token: "TEST", APIURL: tgSrv.URL, DB: conn, Tokens: server.Tokens, API: server.Routes()})

	const chat, opTG, strangerTG = 1, 555, 777
	msg := func(from int64, text string, contact *tgContact) []tgCall {
		b.safeHandle(ctx, tgUpdate{Message: &tgMessage{MessageID: 1, From: &tgUser{ID: from, Username: "u"}, Chat: tgChat{ID: chat, Type: "private"}, Text: text, Contact: contact}})
		return fake.take()
	}
	lastMsg := 0
	cb := func(from int64, data string) []tgCall {
		b.safeHandle(ctx, tgUpdate{CallbackQuery: &tgCallback{ID: "q", From: tgUser{ID: from}, Data: data,
			Message: &tgMessage{MessageID: lastMsg, Chat: tgChat{ID: chat, Type: "private"}}}})
		return fake.take()
	}
	mid := itoa(int(matchID))

	// --- strangers ---
	txt, kb := lastText(t, msg(strangerTG, "/start", nil), "sendMessage")
	if !strings.Contains(txt, "telefon raqamingizni") || !strings.Contains(kb, `"request_contact":true`) {
		t.Fatalf("greeting: %s %s", txt, kb)
	}
	txt, _ = lastText(t, msg(strangerTG, "", &tgContact{PhoneNumber: "+998901234567", UserID: 999}), "sendMessage")
	if !strings.Contains(txt, "o‘z") {
		t.Fatalf("someone else's contact must be refused: %s", txt)
	}
	txt, _ = lastText(t, msg(strangerTG, "", &tgContact{PhoneNumber: "+998 99 000 00 00", UserID: strangerTG}), "sendMessage")
	if !strings.Contains(txt, "Ruxsat yo‘q") {
		t.Fatalf("unknown phone: %s", txt)
	}
	txt, _ = lastText(t, msg(strangerTG, "", &tgContact{PhoneNumber: "998907654321", UserID: strangerTG}), "sendMessage")
	if !strings.Contains(txt, "Ruxsat yo‘q") {
		t.Fatalf("editor has no live permission: %s", txt)
	}
	if c := cb(strangerTG, "M:"+mid); !strings.Contains(answers(c), "Ruxsat yo‘q") {
		t.Fatalf("stranger callback: %v", c)
	}

	// --- operator logs in with the number written by the admin ---
	calls := msg(opTG, "", &tgContact{PhoneNumber: "+998 90 123 45 67", UserID: opTG})
	txt, _ = lastText(t, calls[:1], "sendMessage")
	if !strings.Contains(txt, "Xush kelibsiz") {
		t.Fatalf("welcome: %s", txt)
	}
	txt, kb = lastText(t, calls, "sendMessage")
	if !strings.Contains(kb, "M:"+mid) {
		t.Fatalf("match list must contain the test match: %s %s", txt, kb)
	}

	// --- console, kickoff ---
	lastMsg = 50
	txt, kb = lastText(t, cb(opTG, "M:"+mid), "editMessageText")
	if !strings.Contains(kb, "R:"+mid+":1H") {
		t.Fatalf("console must offer kickoff: %s", kb)
	}
	c := cb(opTG, "R:"+mid+":1H")
	txt, kb = lastText(t, c, "editMessageText")
	if !strings.Contains(txt, "LIVE") || !strings.Contains(kb, "E:"+mid+":g") {
		t.Fatalf("live console: %s %s", txt, kb)
	}

	// --- home goal from the lineup: starters first, bench last ---
	txt, kb = lastText(t, cb(opTG, "E:"+mid+":g"), "editMessageText")
	if !strings.Contains(kb, "1 · B. Home One") || !strings.Contains(kb, "🪑 12") {
		t.Fatalf("home picker: %s", kb)
	}
	c = cb(opTG, "P:1") // #9
	if !strings.Contains(answers(c), "Gol") {
		t.Fatalf("goal toast: %v", answers(c))
	}
	// a second tap on the same (now stale) picker records nothing
	if a := answers(cb(opTG, "P:1")); !strings.Contains(a, "eskirgan") {
		t.Fatalf("double tap: %s", a)
	}

	// --- away goal from the roster, with a typed minute ---
	cb(opTG, "S:"+mid+":a")
	txt, kb = lastText(t, cb(opTG, "E:"+mid+":g"), "editMessageText")
	if !strings.Contains(kb, "10 · B. Away Ten") {
		t.Fatalf("away picker from roster: %s", kb)
	}
	if strings.Contains(kb, `"T:`) {
		t.Fatalf("no manual minute button: %s", kb)
	}
	// the operator picks the player 46 minutes later: the minute is taken at that moment
	b.now = func() time.Time { return time.Now().Add(46 * time.Minute) }
	if a := answers(cb(opTG, "P:0")); !strings.Contains(a, "45+2′") {
		t.Fatalf("toast with automatic minute: %s", a)
	}
	b.now = time.Now

	// --- home substitution: off #1, on #12 ---
	cb(opTG, "S:"+mid+":h")
	txt, kb = lastText(t, cb(opTG, "E:"+mid+":s"), "editMessageText")
	if strings.Contains(kb, "🪑") {
		t.Fatalf("sub step 1 lists only players on the pitch: %s", kb)
	}
	txt, kb = lastText(t, cb(opTG, "P:0"), "editMessageText")
	if !strings.Contains(txt, "Chiqadi") || !strings.Contains(kb, "12 · B. Home Bench") {
		t.Fatalf("sub step 2: %s %s", txt, kb)
	}
	cb(opTG, "P:0")

	var hs, as int
	var evs int
	_ = conn.QueryRowContext(ctx, `SELECT home_score, away_score, (SELECT count(*) FROM match_events WHERE match_id=$1) FROM matches WHERE id=$1`, matchID).Scan(&hs, &as, &evs)
	if hs != 1 || as != 1 || evs != 3 {
		t.Fatalf("score %d:%d events %d, want 1:1 and 3", hs, as, evs)
	}
	var subIn, subOut string
	var minute, extra int
	_ = conn.QueryRowContext(ctx, `SELECT player_name, related_player_name FROM match_events WHERE match_id=$1 AND type='sub'`, matchID).Scan(&subIn, &subOut)
	if subIn != "Bot Home Bench" || subOut != "Bot Home One" {
		t.Fatalf("sub in=%q out=%q", subIn, subOut)
	}
	_ = conn.QueryRowContext(ctx, `SELECT minute, extra_minute FROM match_events WHERE match_id=$1 AND side='away'`, matchID).Scan(&minute, &extra)
	if minute != 45 || extra != 2 {
		t.Fatalf("automatic minute %d+%d, want 45+2", minute, extra)
	}
	var createdBy sql.NullInt64
	_ = conn.QueryRowContext(ctx, `SELECT created_by FROM match_events WHERE match_id=$1 LIMIT 1`, matchID).Scan(&createdBy)
	if !createdBy.Valid {
		t.Fatal("events must be attributed to the operator")
	}

	// --- undo the away goal from the log ---
	var awayGoal int64
	_ = conn.QueryRowContext(ctx, `SELECT id FROM match_events WHERE match_id=$1 AND side='away'`, matchID).Scan(&awayGoal)
	txt, kb = lastText(t, cb(opTG, "G:"+mid), "editMessageText")
	if !strings.Contains(kb, "D:"+mid+":"+itoa(int(awayGoal))) {
		t.Fatalf("log: %s", kb)
	}
	cb(opTG, "D:"+mid+":"+itoa(int(awayGoal)))
	if a := answers(cb(opTG, "X:"+mid+":"+itoa(int(awayGoal)))); !strings.Contains(a, "O‘chirildi") {
		t.Fatalf("delete: %s", a)
	}
	_ = conn.QueryRowContext(ctx, `SELECT away_score FROM matches WHERE id=$1`, matchID).Scan(&as)
	if as != 0 {
		t.Fatalf("away score after undo: %d", as)
	}

	// --- half-time, second half, full-time with confirmation ---
	cb(opTG, "R:"+mid+":HT")
	txt, kb = lastText(t, cb(opTG, "M:"+mid), "editMessageText")
	if strings.Contains(kb, "E:"+mid+":g") {
		t.Fatalf("no events at half-time: %s", kb)
	}
	cb(opTG, "R:"+mid+":2H")
	txt, _ = lastText(t, cb(opTG, "R:"+mid+":FT"), "editMessageText")
	if !strings.Contains(txt, "yakunlash?") {
		t.Fatalf("FT confirm: %s", txt)
	}
	var status string
	_ = conn.QueryRowContext(ctx, `SELECT status FROM matches WHERE id=$1`, matchID).Scan(&status)
	if status != "live" {
		t.Fatalf("FT must wait for confirmation, status=%s", status)
	}
	cb(opTG, "R:"+mid+":FT!")
	_ = conn.QueryRowContext(ctx, `SELECT status FROM matches WHERE id=$1`, matchID).Scan(&status)
	if status != "finished" {
		t.Fatalf("status %s", status)
	}

	// --- the admin removes the phone: access is gone at once ---
	mustExec(`UPDATE users SET phone = NULL WHERE email = 'op@bot.test'`)
	if a := answers(cb(opTG, "L")); !strings.Contains(a, "Ruxsat yo‘q") {
		t.Fatalf("after phone removal: %s", a)
	}
	var links int
	_ = conn.QueryRowContext(ctx, `SELECT count(*) FROM telegram_links`).Scan(&links)
	if links != 0 {
		t.Fatalf("stale link kept")
	}
}
