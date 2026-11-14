package api

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
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

func TestTeamKitFlow(t *testing.T) {
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("TEST_DATABASE_URL not set")
	}
	ctx, stop := context.WithCancel(context.Background())
	defer stop()
	conn, err := db.Open(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	if err := db.Migrate(ctx, conn); err != nil {
		t.Fatal(err)
	}
	var uid int64
	if err := conn.QueryRow(`INSERT INTO users (name, email, password_hash, role) VALUES ('Admin', 'kit-test-'||floor(random()*1e9)::text||'@x.uz', 'x', 'admin') RETURNING id`).Scan(&uid); err != nil {
		t.Fatal(err)
	}
	upload := t.TempDir()
	os.MkdirAll(filepath.Join(upload, "images"), 0o755)
	for _, n := range []string{"kit.png", "p1.png", "p2.png", "p3.png", "p1b.png", "coach.png"} {
		os.WriteFile(filepath.Join(upload, "images", n), tinyPNG(), 0o644)
	}

	var mu sync.Mutex
	var dressed []map[string]any
	describes := 0
	ai := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/v1/settings":
			io.WriteString(w, `{"provider":"openai","image_model":{"openai":"gpt-image-2.5-sunburst"},"kit":{"auto_on_kit":true,"auto_on_player":true,"describe":true,"quality":"high"}}`)
		case "/v1/kit/describe":
			mu.Lock()
			describes++
			mu.Unlock()
			io.WriteString(w, `{"description":"Oq forma, yashil yoqa","provider":"openai","model":"gpt-6-luna"}`)
		case "/v1/kit/dress":
			var in map[string]any
			json.NewDecoder(r.Body).Decode(&in)
			mu.Lock()
			dressed = append(dressed, in)
			mu.Unlock()
			if in["player"] == "Guruh Rasm" && in["hint"] == "" {
				io.WriteString(w, `{"status":"multi","analysis":{"people":3,"face_visible":true},"warnings":[]}`)
				return
			}
			json.NewEncoder(w).Encode(map[string]any{"status": "done", "model": "gpt-image-2.5-sunburst",
				"image":    map[string]any{"mime": "image/png", "data": tinyPNG(), "width": 1200, "height": 1600},
				"analysis": map[string]any{"people": 1, "face_visible": true, "graphic": in["player"] == "Afisha Odam", "studio": in["player"] == "Afisha Odam"}})
		default:
			w.WriteHeader(404)
		}
	}))
	defer ai.Close()

	cfg := &config.Config{UploadDir: upload, AIServiceURL: ai.URL, AIInternalToken: "tok-1234567890abcdef", WebInternalURL: "http://127.0.0.1:9", JWTSecret: []byte("test-secret-test-secret-test-secret!!"), AccessTTL: time.Hour}
	s := New(conn, cfg)
	s.StartKitWorker(ctx)
	h := s.Routes()
	tok, _, _ := s.Tokens.Sign(uid, "admin", "Admin")
	call := func(method, path string, body any, out any) int {
		var rd io.Reader
		if body != nil {
			b, _ := json.Marshal(body)
			rd = bytes.NewReader(b)
		}
		req := httptest.NewRequest(method, "/api/v1"+path, rd)
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
	type kp struct {
		ID          int64  `json:"id"`
		FullName    string `json:"full_name"`
		PhotoURL    string `json:"photo_url"`
		KitPhotoURL string `json:"kit_photo_url"`
		ApprovedURL string `json:"kit_approved_url"`
		Status      string `json:"kit_status"`
		Error       string `json:"kit_error"`
	}
	type view struct {
		Team struct {
			KitURL      string `json:"kit_url"`
			Description string `json:"kit_description"`
		} `json:"team"`
		Players []kp           `json:"players"`
		Staff   []kp           `json:"staff"`
		Counts  map[string]int `json:"counts"`
	}
	slug := "kit-" + idStr(time.Now().UnixNano()%1e9)
	var team struct {
		ID int64 `json:"id"`
	}
	// a team can be saved without a kit
	if c := call("POST", "/admin/teams", map[string]any{"name": "Kit FC " + slug, "slug": slug, "is_active": true}, &team); c != 201 {
		t.Fatal(c)
	}
	defer conn.Exec(`DELETE FROM players WHERE team_id=$1; DELETE FROM teams WHERE id=$1`, team.ID)
	players := map[string]int64{}
	for _, p := range []struct{ name, photo string }{{"Oddiy Odam", "/uploads/images/p1.png"}, {"Rasmsiz Odam", ""}, {"Guruh Rasm", "/uploads/images/p2.png"}, {"Afisha Odam", "/uploads/images/p3.png"}} {
		var out struct {
			ID int64 `json:"id"`
		}
		if c := call("POST", "/admin/players", map[string]any{"full_name": p.name, "team_id": team.ID, "photo_url": p.photo, "is_active": true}, &out); c != 201 {
			t.Fatal(c)
		}
		players[p.name] = out.ID
	}
	var coach struct {
		ID int64 `json:"id"`
	}
	if c := call("POST", "/admin/team-staff", map[string]any{"team_id": team.ID, "full_name": "Timur Kapadze", "role": "head_coach", "photo_url": "/uploads/images/coach.png", "show_on_site": true, "ord": 1}, &coach); c != 201 {
		t.Fatal(c)
	}
	defer conn.Exec(`DELETE FROM team_staff WHERE team_id=$1`, team.ID)
	wait := func() view {
		var v view
		for i := 0; i < 100; i++ {
			v = view{}
			call("GET", "/admin/teams/"+idStr(team.ID)+"/kit", nil, &v)
			if v.Counts["queued"] == 0 && v.Counts["running"] == 0 {
				return v
			}
			time.Sleep(50 * time.Millisecond)
		}
		t.Fatalf("queue did not drain: %+v %+v", v.Counts, v.Players)
		return v
	}
	time.Sleep(100 * time.Millisecond)
	if v := wait(); len(dressed) != 0 || v.Counts["review"] != 0 {
		t.Fatalf("no kit yet, nothing may be generated: %d %+v", len(dressed), v.Counts)
	}
	// uploading the kit describes it and dresses the squad
	if c := call("PATCH", "/admin/teams/"+idStr(team.ID), map[string]any{"kit_url": "/uploads/images/kit.png"}, nil); c != 200 {
		t.Fatal(c)
	}
	var v view
	for i := 0; i < 100; i++ {
		v = wait()
		if v.Counts["review"] == 3 && v.Counts["multi"] == 1 {
			break
		}
		time.Sleep(50 * time.Millisecond)
	}
	if v.Team.Description != "Oq forma, yashil yoqa" || v.Counts["review"] != 3 || v.Counts["multi"] != 1 || v.Counts["skipped"] != 1 || describes != 1 || len(v.Staff) != 1 || v.Staff[0].Status != "review" {
		t.Fatalf("after kit: %+v %+v describes=%d", v.Team, v.Counts, describes)
	}
	mu.Lock()
	first := dressed[0]
	coachAsked := false
	for _, d := range dressed {
		if d["player"] == "Bosh murabbiy Timur Kapadze (coaching staff of the team)" {
			coachAsked = true
		}
	}
	mu.Unlock()
	if !coachAsked {
		t.Fatal("the head coach was not dressed")
	}
	if first["team"] != "Kit FC "+slug || first["description"] != "Oq forma, yashil yoqa" || first["photo"].(map[string]any)["mime"] != "image/png" || first["kit"] == nil {
		t.Fatalf("dress request: %+v", first)
	}
	// the site still shows the original until approved
	var pub struct {
		Players []struct {
			FullName string `json:"full_name"`
			PhotoURL string `json:"photo_url"`
		} `json:"players"`
	}
	pubPhoto := func(name string) string {
		call("GET", "/teams/"+slug, nil, &pub)
		for _, p := range pub.Players {
			if p.FullName == name {
				return p.PhotoURL
			}
		}
		return "?"
	}
	if got := pubPhoto("Oddiy Odam"); got != "/uploads/images/p1.png" {
		t.Fatalf("before approve: %s", got)
	}
	// approve one, then the rest of the team
	var p kp
	if c := call("POST", "/admin/players/"+idStr(players["Oddiy Odam"])+"/kit/approve", nil, &p); c != 200 || p.Status != "approved" || p.ApprovedURL == "" || !strings.Contains(p.ApprovedURL, "/uploads/images/ai-") {
		t.Fatalf("approve: %d %+v", c, p)
	}
	if got := pubPhoto("Oddiy Odam"); got != p.ApprovedURL {
		t.Fatalf("site photo after approve: %s", got)
	}
	var n struct{ Players int64 }
	if c := call("POST", "/admin/teams/"+idStr(team.ID)+"/kit/approve", nil, &n); c != 200 || n.Players != 2 {
		t.Fatalf("approve all: %d %+v", c, n)
	}
	var cp kp
	if c := call("GET", "/admin/team-staff/"+idStr(coach.ID)+"/kit", nil, &cp); c != 200 || cp.Status != "approved" || cp.ApprovedURL == "" {
		t.Fatalf("coach approved: %d %+v", c, cp)
	}
	if c := call("POST", "/admin/team-staff/"+idStr(coach.ID)+"/kit/revert", nil, &cp); c != 200 || cp.ApprovedURL != "" {
		t.Fatalf("coach revert: %+v", cp)
	}
	// several people: regenerate with a hint
	if c := call("POST", "/admin/players/"+idStr(players["Guruh Rasm"])+"/kit/regenerate", map[string]any{"hint": "chapdagi, 10-raqam"}, &p); c != 200 || (p.Status != "queued" && p.Status != "running" && p.Status != "review") {
		t.Fatalf("regenerate: %d %+v", c, p)
	}
	wait()
	call("GET", "/admin/players/"+idStr(players["Guruh Rasm"])+"/kit", nil, &p)
	mu.Lock()
	last := dressed[len(dressed)-1]
	mu.Unlock()
	if p.Status != "review" || last["hint"] != "chapdagi, 10-raqam" {
		t.Fatalf("multi with hint: %+v %+v", p, last["hint"])
	}
	// reject keeps the original on the site; approving a rejected one later is allowed
	if c := call("POST", "/admin/players/"+idStr(players["Guruh Rasm"])+"/kit/reject", nil, &p); c != 200 || p.Status != "rejected" || p.ApprovedURL != "" {
		t.Fatalf("reject: %+v", p)
	}
	// a new original photo drops the approved kit picture and dresses again
	before := len(dressed)
	if c := call("PATCH", "/admin/players/"+idStr(players["Oddiy Odam"]), map[string]any{"photo_url": "/uploads/images/p1b.png"}, nil); c != 200 {
		t.Fatal(c)
	}
	if got := pubPhoto("Oddiy Odam"); got != "/uploads/images/p1b.png" {
		t.Fatalf("new original must show at once: %s", got)
	}
	for i := 0; i < 100 && len(dressed) == before; i++ {
		time.Sleep(50 * time.Millisecond)
	}
	wait()
	call("GET", "/admin/players/"+idStr(players["Oddiy Odam"])+"/kit", nil, &p)
	if p.Status != "review" || p.ApprovedURL != "" {
		t.Fatalf("after new photo: %+v", p)
	}
	// revert an approved picture back to the original
	call("POST", "/admin/players/"+idStr(players["Afisha Odam"])+"/kit/revert", nil, &p)
	if p.ApprovedURL != "" || p.Status != "rejected" {
		t.Fatalf("revert: %+v", p)
	}
	// run all again, then stop: queued ones are cancelled
	block := make(chan struct{})
	defer close(block)
	if c := call("POST", "/admin/teams/"+idStr(team.ID)+"/kit/run", nil, &n); c != 200 || n.Players != 5 {
		t.Fatalf("run: %d %+v", c, n)
	}
	call("POST", "/admin/teams/"+idStr(team.ID)+"/kit/stop", nil, &n)
	v = wait()
	if v.Counts["queued"] != 0 || v.Counts["running"] != 0 {
		t.Fatalf("stop: %+v", v.Counts)
	}
	// the kit shows a number: players need one, and the dress request carries it
	if c := call("PATCH", "/admin/teams/"+idStr(team.ID), map[string]any{"kit_has_number": true, "kit_number_style": "oq raqam halqada"}, nil); c != 200 {
		t.Fatal(c)
	}
	var e struct {
		Error struct {
			Fields map[string]any `json:"fields"`
		} `json:"error"`
	}
	if c := call("POST", "/admin/players", map[string]any{"full_name": "Raqamsiz", "team_id": team.ID, "number": nil, "photo_url": "/uploads/images/p1.png"}, &e); c != 422 || e.Error.Fields["number"] == nil {
		t.Fatalf("number must be required: %d %+v", c, e)
	}
	var np struct {
		ID int64 `json:"id"`
	}
	before = len(dressed)
	if c := call("POST", "/admin/players", map[string]any{"full_name": "Ntumba", "team_id": team.ID, "number": 21, "photo_url": "/uploads/images/p1.png"}, &np); c != 201 {
		t.Fatal(c)
	}
	for i := 0; i < 100 && len(dressed) == before; i++ {
		time.Sleep(50 * time.Millisecond)
	}
	mu.Lock()
	last = dressed[len(dressed)-1]
	mu.Unlock()
	if last["number"] != "21" || last["number_on_kit"] != true || last["number_style"] != "oq raqam halqada" || last["staff"] != false {
		t.Fatalf("number in dress request: %+v", last)
	}
	// a changed number re-dresses the player
	wait()
	before = len(dressed)
	if c := call("PATCH", "/admin/players/"+idStr(np.ID), map[string]any{"number": 17, "team_id": team.ID}, nil); c != 200 {
		t.Fatal(c)
	}
	for i := 0; i < 100 && len(dressed) == before; i++ {
		time.Sleep(50 * time.Millisecond)
	}
	mu.Lock()
	last = dressed[len(dressed)-1]
	mu.Unlock()
	if last["number"] != "17" {
		t.Fatalf("number change must re-dress: %+v", last["number"])
	}
	// removing the kit keeps nothing pending
	if c := call("PATCH", "/admin/teams/"+idStr(team.ID), map[string]any{"kit_url": ""}, nil); c != 200 {
		t.Fatal(c)
	}
}
