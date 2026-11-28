package api

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"net/http/httptest"
	"os"
	"strconv"
	"strings"
	"testing"
	"time"

	_ "github.com/lib/pq"

	"github.com/sanedidi/unitedmfl/backend/internal/config"
	"github.com/sanedidi/unitedmfl/backend/internal/db"
	"github.com/sanedidi/unitedmfl/backend/internal/media"
)

// TEST_DATABASE_URL=postgres://... go test -mod=vendor -run TestMediaPlan ./internal/api/
func TestMediaPlan(t *testing.T) {
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("TEST_DATABASE_URL not set")
	}
	ctx := context.Background()
	conn, err := sql.Open("postgres", dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	if err := db.Migrate(ctx, conn); err != nil {
		t.Fatal(err)
	}
	must := func(q string, args ...any) {
		t.Helper()
		if _, err := conn.ExecContext(ctx, q, args...); err != nil {
			t.Fatalf("%s: %v", q, err)
		}
	}
	// Saturday 28.11.2026, noon in Tashkent
	now := time.Date(2026, 11, 28, 12, 0, 0, 0, media.TZ)
	mediaNow = func() time.Time { return now }
	defer func() { mediaNow = time.Now }()

	sfx := strconv.FormatInt(time.Now().UnixNano()%1e9, 36)
	var groupID int64
	if err := conn.QueryRow(`INSERT INTO team_groups (season_id, name, code, ord) VALUES (NULL, 'Media '||$1, upper(substr($1, 1, 4)), 99) RETURNING id`, sfx).Scan(&groupID); err != nil {
		t.Fatal(err)
	}
	team := func(name, insta string) int64 {
		var id int64
		if err := conn.QueryRow(`INSERT INTO teams (slug, name, instagram, group_id) VALUES ($1, $2, $3, $4) RETURNING id`,
			"media-"+strings.ToLower(strings.ReplaceAll(name, " ", "-"))+"-"+sfx, name, insta, groupID).Scan(&id); err != nil {
			t.Fatal(err)
		}
		return id
	}
	alf, ben, pxi := team("Alfraganus", "@alfraganus.fc"), team("Benom", ""), team("Prime XI", "https://instagram.com/primexi.uz")
	var matchID int64
	if err := conn.QueryRow(`INSERT INTO matches (home_team_id, away_team_id, kickoff_at, venue) VALUES ($1, $2, '2026-12-05 19:00:00+05', 'media-test') RETURNING id`, alf, ben).Scan(&matchID); err != nil {
		t.Fatal(err)
	}
	var adminID, editorID int64
	_ = conn.QueryRow(`INSERT INTO users (name, email, password_hash, role) VALUES ('Media Admin', 'media-admin-'||$1||'@x.uz', 'x', 'admin') RETURNING id`, sfx).Scan(&adminID)
	_ = conn.QueryRow(`INSERT INTO users (name, email, password_hash, role) VALUES ('Media Editor', 'media-editor-'||$1||'@x.uz', 'x', 'editor') RETURNING id`, sfx).Scan(&editorID)

	s := New(conn, &config.Config{UploadDir: t.TempDir(), JWTSecret: []byte("test-secret-test-secret-test-secret!!"), AccessTTL: time.Hour})
	h := s.Routes()
	tok := func(id int64) string { t, _, _ := s.Tokens.Sign(id, "editor", "x"); return t }
	admin, editor := tok(adminID), tok(editorID)
	call := func(tk, method, path string, body, out any) int {
		t.Helper()
		rd := bytes.NewReader(nil)
		if body != nil {
			b, _ := json.Marshal(body)
			rd = bytes.NewReader(b)
		}
		req := httptest.NewRequest(method, "/api/v1/admin"+path, rd)
		req.Header.Set("Authorization", "Bearer "+tk)
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		if out != nil {
			_ = json.Unmarshal(rec.Body.Bytes(), out)
		}
		if rec.Code >= 400 && out == nil {
			t.Logf("%s %s → %d %s", method, path, rec.Code, rec.Body.String())
		}
		return rec.Code
	}
	type groupResp struct {
		Plan *struct {
			ID          int64  `json:"id"`
			FinalDate   string `json:"final_date"`
			PendingDate string `json:"pending_date"`
			Total       int    `json:"total"`
			Done        int    `json:"done"`
			Overdue     int    `json:"overdue"`
		} `json:"plan"`
		Tasks []media.Task `json:"tasks"`
		Teams []mediaTeam  `json:"teams"`
	}
	load := func() groupResp {
		t.Helper()
		var g groupResp
		if c := call(admin, "GET", fmt.Sprintf("/media/groups/%d", groupID), nil, &g); c != 200 {
			t.Fatalf("group: %d", c)
		}
		return g
	}
	find := func(g groupResp, teamID int64, title string) media.Task {
		t.Helper()
		for _, x := range g.Tasks {
			if x.TeamID == teamID && x.Title == title {
				return x
			}
		}
		t.Fatalf("task %q of team %d not found", title, teamID)
		return media.Task{}
	}

	// --- access: the editor has no Media reja page ---
	if c := call(editor, "GET", "/media/overview", nil, nil); c != 403 {
		t.Fatalf("editor overview: %d", c)
	}

	// --- the final is picked from the group's matches ---
	var cand struct {
		Items []finalMatch `json:"items"`
	}
	if c := call(admin, "GET", fmt.Sprintf("/media/groups/%d/matches", groupID), nil, &cand); c != 200 || len(cand.Items) != 1 || cand.Items[0].Day != "2026-12-05" {
		t.Fatalf("candidates %d %+v", c, cand)
	}
	if c := call(admin, "POST", fmt.Sprintf("/media/groups/%d/plan", groupID), map[string]any{}, nil); c != 422 {
		t.Fatalf("a plan needs a final: %d", c)
	}
	if c := call(admin, "POST", fmt.Sprintf("/media/groups/%d/plan", groupID), map[string]any{"final_match_id": matchID}, nil); c != 201 {
		t.Fatalf("create plan: %d", c)
	}
	if c := call(admin, "POST", fmt.Sprintf("/media/groups/%d/plan", groupID), map[string]any{"final_date": "2026-12-05"}, nil); c != 409 {
		t.Fatalf("second plan: %d", c)
	}
	g := load()
	if g.Plan == nil || g.Plan.FinalDate != "2026-12-05" || g.Plan.Total != 21 || len(g.Tasks) != 21 {
		t.Fatalf("plan %+v tasks %d", g.Plan, len(g.Tasks))
	}
	planID := g.Plan.ID
	// the sheet: 1-jamoa from D−10, 2-jamoa a day later, 3-jamoa two days later; TV on the final day for all
	for _, c := range []struct {
		team             int64
		title, due, targ string
	}{
		{alf, "Chaqiruv — guruhga", "2026-11-25", ""}, {ben, "Chaqiruv — guruhga", "2026-11-26", ""}, {pxi, "Chaqiruv — guruhga", "2026-11-27", ""},
		{alf, "Javob — 1-raqibga", "2026-11-28", "Benom"}, {alf, "Javob — 2-raqibga", "2026-11-29", "Prime XI"},
		{ben, "Javob — 1-raqibga", "2026-11-29", "Alfraganus"}, {pxi, "Javob — 2-raqibga", "2026-12-01", "Benom"},
		{pxi, "Homiy post", "", ""}, {alf, "TVda tomoshaga taklif", "2026-12-05", ""}, {pxi, "TVda tomoshaga taklif", "2026-12-05", ""},
	} {
		if c.due == "" {
			continue
		}
		x := find(g, c.team, c.title)
		if x.DueDate != c.due || x.TargetName != c.targ {
			t.Errorf("%s of %d: %s → %q, want %s → %q", c.title, c.team, x.DueDate, x.TargetName, c.due, c.targ)
		}
	}
	if x := find(g, alf, "Javob — 1-raqibga"); x.State != "today" || x.Label != "Javob → Benom" {
		t.Errorf("today's task: %+v", x)
	}
	if x := find(g, alf, "Chaqiruv — guruhga"); x.State != "overdue" {
		t.Errorf("past task: %s", x.State)
	}

	// --- manager of Prime XI ---
	var mt mediaTeam
	if c := call(admin, "PUT", fmt.Sprintf("/media/teams/%d/manager", pxi), map[string]string{"name": "Aziz R.", "phone": "+998 97 111 33 10"}, &mt); c != 200 || mt.ManagerPhone != "998971113310" {
		t.Fatalf("manager %d %+v", c, mt)
	}
	if c := call(admin, "PUT", fmt.Sprintf("/media/teams/%d/manager", pxi), map[string]string{"name": "x", "phone": "12"}, nil); c != 422 {
		t.Fatalf("bad phone: %d", c)
	}

	// --- the admin pastes a link for Prime XI: account checked from the team card ---
	chaq := find(g, pxi, "Chaqiruv — guruhga")
	var tk media.Task
	if c := call(admin, "POST", fmt.Sprintf("/media/tasks/%d/submit", chaq.ID), map[string]string{"link": "salom"}, nil); c != 400 {
		t.Fatalf("not a link: %d", c)
	}
	if c := call(admin, "POST", fmt.Sprintf("/media/tasks/%d/submit", chaq.ID), map[string]string{"link": "https://www.instagram.com/primexi.uz/reel/DCx7Lq2abc/"}, &tk); c != 200 ||
		tk.Status != "review" || tk.Checks.Account != "match" || tk.Checks.OnTime {
		t.Fatalf("submit %d %+v", c, tk)
	}
	var outbox int
	_ = conn.QueryRow(`SELECT count(*) FROM media_outbox WHERE to_moderators AND sent_at IS NULL AND text LIKE '%Prime XI%'`).Scan(&outbox)
	if outbox == 0 {
		t.Fatal("moderators must get the new link")
	}
	var rv struct {
		Items  []media.Task `json:"items"`
		Counts struct {
			Review int `json:"review"`
		} `json:"counts"`
	}
	if c := call(admin, "GET", "/media/review", nil, &rv); c != 200 || rv.Counts.Review < 1 {
		t.Fatalf("review queue %d %+v", c, rv.Counts)
	}
	// return needs a comment, then reaches the manager
	if c := call(admin, "POST", fmt.Sprintf("/media/tasks/%d/return", chaq.ID), map[string]string{"comment": " "}, nil); c != 400 {
		t.Fatalf("return without comment: %d", c)
	}
	if c := call(admin, "POST", fmt.Sprintf("/media/tasks/%d/return", chaq.ID), map[string]string{"comment": "Benom belgilanmagan"}, &tk); c != 200 || tk.Status != "returned" || tk.Comment == "" {
		t.Fatalf("return %d %+v", c, tk)
	}
	_ = conn.QueryRow(`SELECT count(*) FROM media_outbox WHERE team_id = $1 AND text LIKE '%Benom belgilanmagan%'`, pxi).Scan(&outbox)
	if outbox != 1 {
		t.Fatalf("manager must get the comment: %d", outbox)
	}
	if c := call(admin, "POST", fmt.Sprintf("/media/tasks/%d/approve", chaq.ID), nil, &tk); c != 200 || tk.Status != "done" || tk.ReviewedBy != "Media Admin" {
		t.Fatalf("approve %d %+v", c, tk)
	}
	if c := call(admin, "POST", fmt.Sprintf("/media/tasks/%d/approve", chaq.ID), nil, nil); c != 400 {
		t.Fatalf("approve twice: %d", c)
	}

	// --- one task dated by hand stays when the final moves ---
	oflayn := find(g, alf, "Oflayn tomoshaga taklif") // 01.12
	if c := call(admin, "PATCH", fmt.Sprintf("/media/tasks/%d", oflayn.ID), map[string]string{"due_date": "2026-12-02"}, &tk); c != 200 || !tk.Locked || tk.DueDate != "2026-12-02" {
		t.Fatalf("hand date %d %+v", c, tk)
	}

	// --- the final match moves two days: the plan waits for the admin ---
	must(`UPDATE matches SET kickoff_at = '2026-12-07 19:00:00+05' WHERE id = $1`, matchID)
	g = load()
	if g.Plan.PendingDate != "2026-12-07" || g.Plan.FinalDate != "2026-12-05" {
		t.Fatalf("pending %+v", g.Plan)
	}
	var pv media.MovePreview
	if c := call(admin, "POST", fmt.Sprintf("/media/plans/%d/preview", planID), map[string]any{"final_match_id": matchID}, &pv); c != 200 || pv.Days != 2 || pv.Locked != 1 || pv.Kept != 1 {
		t.Fatalf("preview %d %+v", c, pv)
	}
	// today's task and everything after move; done, hand-dated and overdue stay
	wantMoved := 0
	for _, x := range g.Tasks {
		if x.Status != "done" && !x.Locked && x.DueDate >= "2026-11-28" {
			wantMoved++
		}
	}
	if pv.Moved != wantMoved || len(pv.Rows) != wantMoved {
		t.Fatalf("preview moved %d rows %d, want %d", pv.Moved, len(pv.Rows), wantMoved)
	}
	var mv struct {
		Moved int `json:"moved"`
	}
	if c := call(admin, "POST", fmt.Sprintf("/media/plans/%d/move", planID), map[string]any{"final_match_id": matchID, "notify": true}, &mv); c != 200 || mv.Moved != wantMoved {
		t.Fatalf("move %d %+v", c, mv)
	}
	g = load()
	if g.Plan.FinalDate != "2026-12-07" || g.Plan.PendingDate != "" {
		t.Fatalf("after move %+v", g.Plan)
	}
	if x := find(g, alf, "Javob — 1-raqibga"); x.DueDate != "2026-11-30" {
		t.Errorf("moved task: %s", x.DueDate)
	}
	if x := find(g, alf, "Oflayn tomoshaga taklif"); x.DueDate != "2026-12-02" {
		t.Errorf("hand-dated task moved: %s", x.DueDate)
	}
	if x := find(g, ben, "Homiy post"); x.Sponsor == "CLICK" && x.DueDate != "2026-11-27" {
		t.Errorf("overdue task moved: %s", x.DueDate)
	}
	if x := find(g, pxi, "TVda tomoshaga taklif"); x.DueDate != "2026-12-07" {
		t.Errorf("TV: %s", x.DueDate)
	}

	// --- keeping the plan when the match moves again ---
	must(`UPDATE matches SET kickoff_at = '2026-12-08 19:00:00+05' WHERE id = $1`, matchID)
	if c := call(admin, "POST", fmt.Sprintf("/media/plans/%d/keep", planID), nil, nil); c != 204 {
		t.Fatalf("keep %d", c)
	}
	if g = load(); g.Plan.PendingDate != "" || g.Plan.FinalDate != "2026-12-07" {
		t.Fatalf("after keep %+v", g.Plan)
	}

	// --- template change applied to running plans touches only the future ---
	var tpl struct {
		Items    []media.Item   `json:"items"`
		Settings media.Settings `json:"settings"`
	}
	if c := call(admin, "GET", "/media/template", nil, &tpl); c != 200 || len(tpl.Items) != 7 || tpl.Settings.EveningTime != "20:00" {
		t.Fatalf("template %d %+v", c, tpl)
	}
	orig := tpl.Items
	defer func() { // the template is shared by every test run
		call(admin, "PUT", "/media/template", map[string]any{"items": orig, "settings": tpl.Settings, "apply": "new"}, nil)
	}()
	items := append([]media.Item(nil), tpl.Items...)
	items[6].Description = "Final kuni TV-efirga chaqiruv (yangi matn)"
	bad := append([]media.Item(nil), items...)
	bad[0].Title = ""
	if c := call(admin, "PUT", "/media/template", map[string]any{"items": bad, "settings": tpl.Settings, "apply": "running"}, nil); c != 422 {
		t.Fatalf("empty title: %d", c)
	}
	var saved struct {
		PlansUpdated int `json:"plans_updated"`
	}
	if c := call(admin, "PUT", "/media/template", map[string]any{"items": items, "settings": tpl.Settings, "apply": "running"}, &saved); c != 200 || saved.PlansUpdated < 1 {
		t.Fatalf("save template %d %+v", c, saved)
	}
	g = load()
	if x := find(g, pxi, "TVda tomoshaga taklif"); x.Description != items[6].Description {
		t.Errorf("future task not updated: %q", x.Description)
	}
	if x := find(g, pxi, "Chaqiruv — guruhga"); x.Status != "done" {
		t.Errorf("done task touched: %+v", x)
	}

	// --- team order: Prime XI becomes the first team, only the future follows ---
	if c := call(admin, "PUT", fmt.Sprintf("/media/plans/%d/teams", planID), map[string]any{"team_ids": []int64{pxi, alf, ben}}, nil); c != 204 {
		t.Fatalf("order %d", c)
	}
	g = load()
	if x := find(g, pxi, "Javob — 1-raqibga"); x.TargetName != "Alfraganus" || x.DueDate != "2026-11-30" {
		t.Errorf("Prime XI as the 1st team: %+v", x)
	}

	// --- reminders need the bot ---
	if c := call(admin, "POST", fmt.Sprintf("/media/plans/%d/remind", planID), nil, nil); c != 400 {
		t.Fatalf("remind without a bot: %d", c)
	}
	var ov struct {
		Groups []struct {
			ID   int64 `json:"id"`
			Plan *struct {
				Total int `json:"total"`
			} `json:"plan"`
		} `json:"groups"`
	}
	if c := call(admin, "GET", "/media/overview", nil, &ov); c != 200 {
		t.Fatalf("overview %d", c)
	}
	if c := call(admin, "DELETE", fmt.Sprintf("/media/plans/%d", planID), nil, nil); c != 204 {
		t.Fatalf("delete %d", c)
	}
	must(`DELETE FROM matches WHERE id = $1`, matchID)
	must(`DELETE FROM teams WHERE id IN ($1,$2,$3)`, alf, ben, pxi)
	must(`DELETE FROM team_groups WHERE id = $1`, groupID)
}
