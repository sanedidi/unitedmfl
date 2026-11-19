package api

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"image"
	"image/color"
	"image/draw"
	"image/png"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/sanedidi/unitedmfl/backend/internal/config"
	"github.com/sanedidi/unitedmfl/backend/internal/db"
)

// fakeTelegram is a Bot API stand-in that keeps sticker sets in memory.
type fakeTelegram struct {
	mu      sync.Mutex
	token   string
	owner   int64
	sets    map[string][]tgStkSticker
	seq     int
	failAdd string // next addStickerToSet answers 400 with this text
	calls   []string
}

func (f *fakeTelegram) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	reply := func(result any) { json.NewEncoder(w).Encode(map[string]any{"ok": true, "result": result}) }
	fail := func(code int, desc string) {
		json.NewEncoder(w).Encode(map[string]any{"ok": false, "error_code": code, "description": desc})
	}
	parts := strings.Split(strings.TrimPrefix(r.URL.Path, "/bot"), "/")
	if len(parts) != 2 || parts[0] != f.token {
		fail(401, "Unauthorized")
		return
	}
	method := parts[1]
	f.calls = append(f.calls, method)
	params := map[string]string{}
	var file []byte
	if strings.HasPrefix(r.Header.Get("Content-Type"), "multipart/") {
		if err := r.ParseMultipartForm(4 << 20); err != nil {
			fail(400, "bad multipart")
			return
		}
		for k, v := range r.MultipartForm.Value {
			params[k] = v[0]
		}
		if fh := r.MultipartForm.File["sticker"]; len(fh) > 0 {
			rd, _ := fh[0].Open()
			var b bytes.Buffer
			b.ReadFrom(rd)
			file = b.Bytes()
		}
	} else {
		var m map[string]any
		json.NewDecoder(r.Body).Decode(&m)
		for k, v := range m {
			params[k] = fmt.Sprint(v)
		}
	}
	checkPNG := func() bool {
		img, err := png.Decode(bytes.NewReader(file))
		if err != nil || img.Bounds().Dx() != 512 || img.Bounds().Dy() != 512 || len(file) > 512<<10 {
			fail(400, "Bad Request: STICKER_PNG_DIMENSIONS")
			return false
		}
		return true
	}
	newSticker := func() tgStkSticker {
		f.seq++
		return tgStkSticker{FileID: fmt.Sprintf("file-%d", f.seq), FileUniqueID: fmt.Sprintf("uniq-%d", f.seq)}
	}
	switch method {
	case "getMe":
		reply(map[string]any{"id": 777, "is_bot": true, "username": "umfl_test_bot", "first_name": "Test"})
	case "sendMessage":
		reply(map[string]any{"message_id": 1})
	case "getStickerSet":
		set, ok := f.sets[params["name"]]
		if !ok {
			fail(400, "Bad Request: STICKERSET_INVALID")
			return
		}
		reply(tgStkSet{Name: params["name"], Stickers: set})
	case "createNewStickerSet":
		if params["user_id"] != fmt.Sprint(f.owner) {
			fail(400, "Bad Request: PEER_ID_INVALID")
			return
		}
		if !strings.HasSuffix(params["name"], "_by_umfl_test_bot") || !strings.Contains(params["stickers"], "attach://sticker") || !checkPNG() {
			fail(400, "Bad Request: invalid sticker set name is specified")
			return
		}
		f.sets[params["name"]] = []tgStkSticker{newSticker()}
		reply(true)
	case "addStickerToSet":
		if f.failAdd != "" {
			fail(400, f.failAdd)
			f.failAdd = ""
			return
		}
		set, ok := f.sets[params["name"]]
		if !ok || !checkPNG() {
			if ok {
				return
			}
			fail(400, "Bad Request: STICKERSET_INVALID")
			return
		}
		f.sets[params["name"]] = append(set, newSticker())
		reply(true)
	case "replaceStickerInSet":
		set := f.sets[params["name"]]
		for i, k := range set {
			if k.FileID == params["old_sticker"] {
				if !checkPNG() {
					return
				}
				set[i] = newSticker()
				reply(true)
				return
			}
		}
		fail(400, "Bad Request: STICKER_ID_INVALID")
	case "deleteStickerFromSet":
		for name, set := range f.sets {
			for i, k := range set {
				if k.FileID == params["sticker"] {
					f.sets[name] = append(set[:i:i], set[i+1:]...)
					reply(true)
					return
				}
			}
		}
		fail(400, "Bad Request: STICKER_ID_INVALID")
	case "getUpdates":
		reply([]any{})
	default:
		fail(404, "Not Found: method "+method)
	}
}

func (f *fakeTelegram) set(name string) []tgStkSticker {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]tgStkSticker(nil), f.sets[name]...)
}

// logoPNG is a coloured disc on a white page.
func logoPNG(t *testing.T, c color.NRGBA) []byte {
	img := image.NewNRGBA(image.Rect(0, 0, 400, 400))
	draw.Draw(img, img.Rect, &image.Uniform{color.White}, image.Point{}, draw.Src)
	for y := 0; y < 400; y++ {
		for x := 0; x < 400; x++ {
			if (x-200)*(x-200)+(y-200)*(y-200) < 150*150 {
				img.SetNRGBA(x, y, c)
			}
		}
	}
	var b bytes.Buffer
	if err := png.Encode(&b, img); err != nil {
		t.Fatal(err)
	}
	return b.Bytes()
}

// Telegram stickers: connect a bot, pick the owner among /start senders,
// create the set, then follow team changes — added, logo changed, deleted —
// with retries on Telegram errors.
func TestTelegramStickers(t *testing.T) {
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
	// a clean slate: only this test's teams carry logos
	for _, q := range []string{`DELETE FROM tg_stickers`, `DELETE FROM tg_sticker_sets`, `DELETE FROM tg_bot_starts`,
		`UPDATE tg_sticker_settings SET token_enc = NULL, bot_id = 0, bot_username = '', owner_id = 0, enabled = false, problem = '', last_error = '',
		 set_slug = 'unitedmfl', set_title = 'United MFL — Jamoalar', outline = true, auto_update = true`,
		`UPDATE teams SET crest_url = ''`} {
		if _, err := conn.Exec(q); err != nil {
			t.Fatal(err)
		}
	}

	const token = "777:AAH-test-token-test-token-test-token"
	tg := &fakeTelegram{token: token, owner: 555, sets: map[string][]tgStkSticker{}}
	tgSrv := httptest.NewServer(tg)
	defer tgSrv.Close()

	dir := t.TempDir()
	s := New(conn, &config.Config{UploadDir: dir, TelegramAPIURL: tgSrv.URL, JWTSecret: []byte("test-secret-test-secret-test-secret!!"), AccessTTL: time.Hour})
	h := s.Routes()
	var uid int64
	if err := conn.QueryRow(`INSERT INTO users (name, email, password_hash, role) VALUES ('Admin', 'stk-'||floor(random()*1e9)::text||'@x.uz', 'x', 'admin') RETURNING id`).Scan(&uid); err != nil {
		t.Fatal(err)
	}
	tok, _, _ := s.Tokens.Sign(uid, "admin", "Admin")
	call := func(method, path string, body any, out any) int {
		var b []byte
		if body != nil {
			b, _ = json.Marshal(body)
		}
		req := httptest.NewRequest(method, "/api/v1/admin"+path, bytes.NewReader(b))
		req.Header.Set("Authorization", "Bearer "+tok)
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		if out != nil {
			json.Unmarshal(rec.Body.Bytes(), out)
		}
		if rec.Code >= 300 {
			t.Logf("%s %s → %d %s", method, path, rec.Code, rec.Body.String())
		}
		return rec.Code
	}
	saveLogo := func(name string, c color.NRGBA) string {
		os.MkdirAll(filepath.Join(dir, "images"), 0o755)
		if err := os.WriteFile(filepath.Join(dir, "images", name), logoPNG(t, c), 0o644); err != nil {
			t.Fatal(err)
		}
		return "/uploads/images/" + name
	}
	team := func(slug string, crest string) int64 {
		var id int64
		if err := conn.QueryRow(`INSERT INTO teams (slug, name, short_name, crest_url) VALUES ($1 || floor(random()*1e9)::text, $1, upper(left($1, 2)), $2) RETURNING id`, slug, crest).Scan(&id); err != nil {
			t.Fatal(err)
		}
		return id
	}
	var state stkStateView
	get := func() stkStateView {
		var v stkStateView
		if c := call("GET", "/tg-stickers", nil, &v); c != 200 {
			t.Fatalf("state: %d", c)
		}
		return v
	}
	status := func(v stkStateView, id int64) stkTeamView {
		for _, x := range v.Teams {
			if x.TeamID == id {
				return x
			}
		}
		t.Fatalf("team %d not listed", id)
		return stkTeamView{}
	}

	alpha := team("alpha", saveLogo("alpha.png", color.NRGBA{20, 60, 200, 255}))
	beta := team("beta", saveLogo("beta.png", color.NRGBA{200, 30, 30, 255}))
	gamma := team("gamma", "") // no logo

	// token: a wrong one is refused, the right one connects the bot
	if c := call("PUT", "/tg-stickers/token", map[string]string{"token": "777:AAH-wrong-token-wrong-token-wrong-token"}, nil); c != 422 {
		t.Fatalf("wrong token accepted: %d", c)
	}
	if c := call("PUT", "/tg-stickers/token", map[string]string{"token": token}, &state); c != 200 || !state.Connected || state.BotUsername != "umfl_test_bot" {
		t.Fatalf("token: %d %+v", c, state)
	}
	if strings.Contains(state.TokenMasked, "test-token") {
		t.Fatal("token leaked to the admin")
	}
	var box []byte
	conn.QueryRow(`SELECT token_enc FROM tg_sticker_settings`).Scan(&box)
	if bytes.Contains(box, []byte("test-token")) {
		t.Fatal("token stored in plain text")
	}

	// owner: only an account that sent /start can be chosen
	if c := call("PUT", "/tg-stickers/owner", map[string]int64{"tg_user_id": 555}, nil); c != 400 {
		t.Fatalf("owner without /start: %d", c)
	}
	RecordBotStart(ctx, conn, 777, 555, "liga_owner", "Liga")
	if c := call("PUT", "/tg-stickers/owner", map[string]int64{"tg_user_id": 555}, &state); c != 200 || state.Owner == nil || state.Owner.Username != "liga_owner" {
		t.Fatalf("owner: %d %+v", c, state.Owner)
	}
	if v := get(); status(v, alpha).Status != "waiting" || status(v, gamma).Status != "no_logo" {
		t.Fatalf("before create: %+v %+v", status(v, alpha), status(v, gamma))
	}

	// a bad link is refused before Telegram is asked
	if c := call("PATCH", "/tg-stickers", map[string]any{"set_slug": "9 bad"}, nil); c != 422 {
		t.Fatalf("bad slug: %d", c)
	}
	// create: the set opens with the first logo, the rest is queued
	if c := call("POST", "/tg-stickers/create", nil, &state); c != 200 || !state.Enabled {
		t.Fatalf("create: %d", c)
	}
	const setName = "unitedmfl_by_umfl_test_bot"
	if got := tg.set(setName); len(got) != 1 {
		t.Fatalf("set after create: %v", got)
	}
	if state.SetURL != "https://t.me/addstickers/"+setName {
		t.Fatalf("set url %q", state.SetURL)
	}
	if st := status(state, alpha); st.Status != "ready" || st.Image == "" {
		t.Fatalf("alpha after create: %+v", st)
	}
	if st := status(state, beta); st.Status != "queued" {
		t.Fatalf("beta after create: %+v", st)
	}

	// the worker adds the queued team
	s.stkTick(ctx)
	v := get()
	if status(v, beta).Status != "ready" || len(tg.set(setName)) != 2 || v.Counts["ready"] != 2 || v.Counts["no_logo"] < 1 {
		t.Fatalf("after tick: %+v counts=%v set=%v", status(v, beta), v.Counts, tg.set(setName))
	}

	// a new logo replaces the sticker in place
	var before string
	conn.QueryRow(`SELECT file_id FROM tg_stickers WHERE team_id = $1`, alpha).Scan(&before)
	if c := call("PATCH", fmt.Sprintf("/teams/%d", alpha), map[string]any{"crest_url": saveLogo("alpha2.png", color.NRGBA{10, 160, 60, 255})}, nil); c != 200 {
		t.Fatalf("patch team: %d", c)
	}
	s.stkTick(ctx)
	var after string
	conn.QueryRow(`SELECT file_id FROM tg_stickers WHERE team_id = $1`, alpha).Scan(&after)
	if after == before || len(tg.set(setName)) != 2 || status(get(), alpha).Status != "ready" {
		t.Fatalf("replace: %s → %s, set %v", before, after, tg.set(setName))
	}

	// a deleted team loses its sticker
	if c := call("DELETE", fmt.Sprintf("/teams/%d", beta), nil, nil); c != 204 {
		t.Fatalf("delete team: %d", c)
	}
	s.stkTick(ctx)
	var n int
	conn.QueryRow(`SELECT count(*) FROM tg_stickers WHERE team_id = $1`, beta).Scan(&n)
	if n != 0 || len(tg.set(setName)) != 1 {
		t.Fatalf("delete: rows=%d set=%v", n, tg.set(setName))
	}

	// a Telegram error is retried later, not lost
	tg.failAdd = "Bad Request: something went wrong"
	if c := call("PATCH", fmt.Sprintf("/teams/%d", gamma), map[string]any{"crest_url": saveLogo("gamma.png", color.NRGBA{120, 0, 160, 255})}, nil); c != 200 {
		t.Fatalf("gamma logo: %d", c)
	}
	s.stkTick(ctx)
	g := status(get(), gamma)
	if g.Status != "queued" || g.Attempts != 1 || g.LastError == "" || g.NextTryAt == nil {
		t.Fatalf("retry: %+v", g)
	}
	// «Hammasini sinxronlash» runs it again now
	if c := call("POST", "/tg-stickers/sync", nil, nil); c != 200 {
		t.Fatalf("sync: %d", c)
	}
	s.stkTick(ctx)
	if g := status(get(), gamma); g.Status != "ready" || len(tg.set(setName)) != 2 {
		t.Fatalf("after sync: %+v", g)
	}

	// turning the outline off redraws every sticker
	conn.QueryRow(`SELECT file_id FROM tg_stickers WHERE team_id = $1`, alpha).Scan(&before)
	if c := call("PATCH", "/tg-stickers", map[string]any{"outline": false}, nil); c != 200 {
		t.Fatalf("outline: %d", c)
	}
	s.stkTick(ctx)
	conn.QueryRow(`SELECT file_id FROM tg_stickers WHERE team_id = $1`, alpha).Scan(&after)
	if after == before {
		t.Fatal("outline change did not redraw")
	}

	// preview and the team page block
	var pv struct {
		Image string `json:"image"`
	}
	if c := call("POST", "/tg-stickers/preview", map[string]any{"team_id": alpha, "outline": true}, &pv); c != 200 || !strings.HasPrefix(pv.Image, "data:image/png;base64,") {
		t.Fatalf("preview: %d", c)
	}
	var tv struct {
		Enabled bool        `json:"enabled"`
		Team    stkTeamView `json:"team"`
	}
	if c := call("GET", fmt.Sprintf("/teams/%d/sticker", alpha), nil, &tv); c != 200 || !tv.Enabled || tv.Team.Status != "ready" {
		t.Fatalf("team sticker: %d %+v", c, tv)
	}

	// a revoked token stops the worker and shows the problem
	tg.mu.Lock()
	tg.token = "777:AAH-another-token-another-token-xx"
	tg.mu.Unlock()
	conn.Exec(`UPDATE tg_stickers SET state = 'queued', next_try_at = now() WHERE team_id = $1`, alpha)
	s.stkTick(ctx)
	if v := get(); v.Problem != "token_invalid" {
		t.Fatalf("problem = %q", v.Problem)
	}
}
