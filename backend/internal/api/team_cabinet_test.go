package api

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http/httptest"
	"os"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/sanedidi/unitedmfl/backend/internal/config"
	"github.com/sanedidi/unitedmfl/backend/internal/db"
)

// The whole cabinet path: the admin creates a login, the team signs in (with a
// lock after wrong passwords), edits a draft, sends it, takes it back, sends it
// again; the admin approves a part and returns the rest, the team fixes and
// sends again, the admin approves everything; password reset and disabling
// sign everybody out.
func TestTeamCabinet(t *testing.T) {
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
	sfx := strconv.FormatInt(time.Now().UnixNano()%1e9, 36)
	var uid int64
	conn.QueryRow(`INSERT INTO users (name, email, password_hash, role) VALUES ('Admin', 'cab-'||$1||'@x.uz', 'x', 'admin') RETURNING id`, sfx).Scan(&uid)
	s := New(conn, &config.Config{UploadDir: t.TempDir(), JWTSecret: []byte("test-secret-test-secret-test-secret!!"), AccessTTL: time.Hour,
		RegisterURL: "https://ariza.test"})
	h := s.Routes()
	adminTok, _, _ := s.Tokens.Sign(uid, "admin", "Admin")
	editorTok, _, _ := s.Tokens.Sign(uid, "editor", "Editor")
	operatorTok, _, _ := s.Tokens.Sign(uid, "operator", "Operator")
	call := func(method, path, tok string, body, out any) int {
		t.Helper()
		var rd *bytes.Reader
		if body == nil {
			rd = bytes.NewReader(nil)
		} else {
			j, _ := json.Marshal(body)
			rd = bytes.NewReader(j)
		}
		req := httptest.NewRequest(method, path, rd)
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("User-Agent", "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) Safari/604.1")
		if tok != "" {
			req.Header.Set("Authorization", "Bearer "+tok)
		}
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		if out != nil {
			json.Unmarshal(rec.Body.Bytes(), out)
		}
		if rec.Code >= 300 {
			t.Logf("%s %s → %d %s", method, path, rec.Code, strings.TrimSpace(rec.Body.String()))
		}
		return rec.Code
	}
	admin := func(method, path string, body, out any) int { return call(method, path, adminTok, body, out) }

	// a team with three players and a coach; another team owns «Sardor Aliyev»
	var team, other, p1, p2, p3, coach, foreign int64
	conn.QueryRow(`INSERT INTO teams (slug, name, short_name, colors) VALUES ($1, $2, 'CHL', '{"#1F4FD6","#FFFFFF"}') RETURNING id`, "chilonzor-lions-"+sfx, "Chilonzor "+sfx).Scan(&team)
	conn.QueryRow(`INSERT INTO teams (slug, name, short_name) VALUES ($1, $2, 'OTH') RETURNING id`, "other-"+sfx, "Other "+sfx).Scan(&other)
	defer conn.Exec(`DELETE FROM teams WHERE id IN ($1, $2)`, team, other)
	conn.QueryRow(`INSERT INTO players (team_id, full_name, number, birth_date) VALUES ($1, 'Javohir Hamidov', '7', '1993-08-25') RETURNING id`, team).Scan(&p1)
	conn.QueryRow(`INSERT INTO players (team_id, full_name, number) VALUES ($1, 'Toxir Maksudov', '4') RETURNING id`, team).Scan(&p2)
	conn.QueryRow(`INSERT INTO players (team_id, full_name, number, position) VALUES ($1, 'Izzat Abduraimov', '1', 'GK') RETURNING id`, team).Scan(&p3)
	conn.QueryRow(`INSERT INTO team_staff (team_id, full_name, role) VALUES ($1, 'Jan Safarov', 'head_coach') RETURNING id`, team).Scan(&coach)
	conn.QueryRow(`INSERT INTO players (team_id, full_name, number, birth_date) VALUES ($1, 'Sardor Aliyev', '9', '2000-03-03') RETURNING id`, other).Scan(&foreign)
	defer conn.Exec(`DELETE FROM players WHERE team_id IS NULL AND id IN ($1, $2, $3)`, p1, p2, p3)

	// 1. the admin creates the cabinet: the login comes from the slug, the password is shown once
	var cab map[string]any
	if c := admin("GET", fmt.Sprintf("/api/v1/admin/teams/%d/cabinet", team), nil, &cab); c != 200 || cab["account"] != nil {
		t.Fatalf("cabinet before: %d %+v", c, cab)
	}
	if c := call("POST", fmt.Sprintf("/api/v1/admin/teams/%d/cabinet", team), operatorTok, map[string]any{}, nil); c != 403 {
		t.Fatalf("operator creates a cabinet: %d", c) // passwords need the «teams» permission
	}
	var cred struct{ Login, Password, URL, Message string }
	if c := admin("POST", fmt.Sprintf("/api/v1/admin/teams/%d/cabinet", team), map[string]any{}, &cred); c != 201 {
		t.Fatalf("create: %d", c)
	}
	if cred.Login != "chilonzor-lions-"+sfx || len(cred.Password) != 11 || cred.URL != "https://ariza.test/jamoa/"+cred.Login || !strings.Contains(cred.Message, cred.Password) {
		t.Fatalf("credentials: %+v", cred)
	}
	if c := admin("POST", fmt.Sprintf("/api/v1/admin/teams/%d/cabinet", team), map[string]any{}, nil); c != 409 {
		t.Fatalf("second cabinet: %d", c)
	}
	var info map[string]any
	if c := call("GET", "/api/v1/team/accounts/"+strings.ToUpper(cred.Login), "", nil, &info); c != 200 || info["name"] != "Chilonzor "+sfx {
		t.Fatalf("account info: %d %+v", c, info)
	}

	// 2. wrong passwords count down; the right one signs in
	var bad map[string]any
	if c := call("POST", "/api/v1/team/login", "", map[string]any{"login": cred.Login, "password": "nope"}, &bad); c != 401 || bad["attempts_left"].(float64) != 4 {
		t.Fatalf("wrong password: %d %+v", c, bad)
	}
	var login struct {
		Token string `json:"token"`
	}
	if c := call("POST", "/api/v1/team/login", "", map[string]any{"login": " " + cred.Login + " ", "password": cred.Password, "remember": true}, &login); c != 200 || !strings.HasPrefix(login.Token, "tc_") {
		t.Fatalf("login: %d %+v", c, login)
	}
	tok := login.Token
	if c := call("GET", "/api/v1/team/me", adminTok, nil, nil); c != 401 {
		t.Fatalf("admin token in the cabinet: %d", c)
	}

	type view struct {
		Live      cabDoc         `json:"live"`
		Draft     cabDoc         `json:"draft"`
		Items     []changeItem   `json:"items"`
		Checks    []cabCheck     `json:"checks"`
		Request   map[string]any `json:"request"`
		Last      map[string]any `json:"last"`
		Editable  bool           `json:"editable"`
		CanSubmit bool           `json:"can_submit"`
	}
	var v view
	if c := call("GET", "/api/v1/team/me", tok, nil, &v); c != 200 || len(v.Live.Players) != 3 || len(v.Live.Staff) != 1 || v.Request != nil || len(v.Items) != 0 {
		t.Fatalf("me: %d %+v", c, v)
	}
	if v.Live.Players[0].FirstName == "" || v.Live.Team.ShortName != "CHL" {
		t.Fatalf("live doc: %+v", v.Live)
	}

	// 3. a draft: new player (plays for another team), new number, a player out, a new short name, a new assistant
	d := v.Live
	for i := range d.Players {
		switch d.Players[i].ID {
		case p1:
			d.Players[i].Number = "17"
		case p2:
			d.Players[i].Removed = true
		}
	}
	d.Players = append(d.Players, cabPlayer{FirstName: "Sardor", LastName: "Aliyev", BirthDate: "03.03.2000", Number: "23", Role: "player", KitSize: "l"})
	d.Team.ShortName = "chl2"
	d.Team.Name = "Hacked"
	d.Staff = append(d.Staff, cabStaff{FirstName: "Bek", LastName: "Ergashev", Role: "assistant"})
	if c := call("PUT", "/api/v1/team/draft", tok, map[string]any{"draft": d}, &v); c != 200 || v.Request == nil || v.Request["status"] != "draft" {
		t.Fatalf("save draft: %d %+v", c, v.Request)
	}
	if v.Draft.Team.Name != "Chilonzor "+sfx {
		t.Fatalf("name must stay: %q", v.Draft.Team.Name)
	}
	keys := map[string]string{}
	for _, it := range v.Items {
		keys[it.Key] = it.Op
	}
	if len(v.Items) != 5 || keys["player:"+strconv.FormatInt(p1, 10)] != "update" || keys["player:"+strconv.FormatInt(p2, 10)] != "remove" || keys["player:new:3"] != "add" ||
		keys["team.short_name"] != "update" || keys["staff:new:1"] != "add" {
		t.Fatalf("items: %+v", v.Items)
	}
	// «CHL2» is not 2–4 letters → an error; «Sardor» is in another team → a warning
	var hasErr, hasDup bool
	for _, c := range v.Checks {
		hasErr = hasErr || (c.Level == "error" && c.Key == "team.short_name")
		hasDup = hasDup || (c.Level == "warn" && strings.Contains(c.Text, "Other "+sfx))
	}
	if !hasErr || !hasDup || v.CanSubmit {
		t.Fatalf("checks: %+v", v.Checks)
	}
	if c := call("POST", "/api/v1/team/submit", tok, nil, nil); c != 422 {
		t.Fatalf("submit with errors: %d", c)
	}
	d = v.Draft
	d.Team.ShortName = "CHLN"
	if c := call("PUT", "/api/v1/team/draft", tok, map[string]any{"draft": d}, &v); c != 200 || !v.CanSubmit {
		t.Fatalf("fixed draft: %d %+v", c, v.Checks)
	}

	// 4. send, take back, send again
	if c := call("POST", "/api/v1/team/submit", tok, nil, &v); c != 200 || v.Request["status"] != "submitted" || v.Editable {
		t.Fatalf("submit: %d %+v", c, v.Request)
	}
	if c := call("PUT", "/api/v1/team/draft", tok, map[string]any{"draft": d}, nil); c != 409 {
		t.Fatalf("edit while submitted: %d", c)
	}
	if c := call("POST", "/api/v1/team/withdraw", tok, nil, &v); c != 200 || v.Request["status"] != "draft" {
		t.Fatalf("withdraw: %d %+v", c, v.Request)
	}
	if c := call("POST", "/api/v1/team/submit", tok, nil, &v); c != 200 {
		t.Fatalf("submit again: %d", c)
	}
	reqID := int64(v.Request["id"].(float64))

	// 5. the admin sees it, approves the number and the short name, returns the rest
	var list struct {
		Items  []map[string]any `json:"items"`
		Counts map[string]int   `json:"counts"`
	}
	if c := call("GET", "/api/v1/admin/team-changes?status=submitted", editorTok, nil, &list); c != 200 || list.Counts["submitted"] < 1 {
		t.Fatalf("list: %d %+v", c, list)
	}
	var one map[string]any
	if c := call("GET", fmt.Sprintf("/api/v1/admin/team-changes/%d", reqID), editorTok, nil, &one); c != 200 || len(one["request"].(map[string]any)["items"].([]any)) != 5 {
		t.Fatalf("get: %d %+v", c, one)
	}
	if c := admin("POST", fmt.Sprintf("/api/v1/admin/team-changes/%d/decide", reqID), map[string]any{"action": "return", "approve": []string{"team.short_name"}}, nil); c != 422 {
		t.Fatalf("return without a comment: %d", c)
	}
	p1Key := "player:" + strconv.FormatInt(p1, 10)
	p2Key := "player:" + strconv.FormatInt(p2, 10)
	var dec map[string]any
	if c := call("POST", fmt.Sprintf("/api/v1/admin/team-changes/%d/decide", reqID), editorTok, map[string]any{"action": "return",
		"approve": []string{"team.short_name", p1Key, "player:new:3"}, "comment": "Toxirni hozircha chiqarmang"}, &dec); c != 200 || dec["status"] != "changes" {
		t.Fatalf("return: %d %+v", c, dec)
	}
	var short, number string
	conn.QueryRow(`SELECT short_name FROM teams WHERE id = $1`, team).Scan(&short)
	conn.QueryRow(`SELECT number FROM players WHERE id = $1`, p1).Scan(&number)
	var added int64
	var addedSize string
	conn.QueryRow(`SELECT id, kit_size FROM players WHERE team_id = $1 AND full_name = 'Sardor Aliyev'`, team).Scan(&added, &addedSize)
	if short != "CHLN" || number != "17" || added == 0 || addedSize != "L" {
		t.Fatalf("applied: short=%q number=%q added=%d size=%q", short, number, added, addedSize)
	}
	defer conn.Exec(`DELETE FROM players WHERE id = $1`, added)

	// 6. the team sees the decision; only the returned items are left in its draft
	if c := call("GET", "/api/v1/team/me", tok, nil, &v); c != 200 || v.Request["status"] != "changes" || v.Request["comment"] != "Toxirni hozircha chiqarmang" || !v.Editable {
		t.Fatalf("returned: %d %+v", c, v.Request)
	}
	keys = map[string]string{}
	for _, it := range v.Items {
		keys[it.Key] = it.Op
	}
	if len(v.Items) != 2 || keys[p2Key] != "remove" || keys["staff:new:1"] != "add" {
		t.Fatalf("items after return: %+v", v.Items)
	}
	// the team keeps Toxir and sends the assistant only
	d = v.Draft
	for i := range d.Players {
		if d.Players[i].ID == p2 {
			d.Players[i].Removed = false
		}
	}
	if c := call("PUT", "/api/v1/team/draft", tok, map[string]any{"draft": d}, &v); c != 200 || len(v.Items) != 1 {
		t.Fatalf("draft after return: %d %+v", c, v.Items)
	}
	if c := call("POST", "/api/v1/team/submit", tok, nil, &v); c != 200 || v.Request["status"] != "submitted" {
		t.Fatalf("resubmit: %d", c)
	}

	// 7. approve everything: the request is closed, the cabinet is clean again
	if c := admin("POST", fmt.Sprintf("/api/v1/admin/team-changes/%d/decide", reqID), map[string]any{"action": "approve", "approve": []string{"staff:new:1"}}, &dec); c != 200 || dec["status"] != "approved" {
		t.Fatalf("approve: %d %+v", c, dec)
	}
	var staffN int
	conn.QueryRow(`SELECT count(*) FROM team_staff WHERE team_id = $1`, team).Scan(&staffN)
	if staffN != 2 {
		t.Fatalf("staff: %d", staffN)
	}
	if c := call("GET", "/api/v1/team/me", tok, nil, &v); c != 200 || v.Request != nil || v.Last == nil || v.Last["status"] != "approved" || len(v.Live.Players) != 4 {
		t.Fatalf("after approval: %d req=%+v last=%+v players=%d", c, v.Request, v.Last, len(v.Live.Players))
	}

	// 8. a second round: removing a player and rejecting it changes nothing
	d = v.Live
	for i := range d.Players {
		if d.Players[i].ID == p2 {
			d.Players[i].Removed = true
		}
	}
	call("PUT", "/api/v1/team/draft", tok, map[string]any{"draft": d}, &v)
	call("POST", "/api/v1/team/submit", tok, nil, &v)
	req2 := int64(v.Request["id"].(float64))
	if c := admin("POST", fmt.Sprintf("/api/v1/admin/team-changes/%d/decide", req2), map[string]any{"action": "reject", "comment": "Yo‘q"}, &dec); c != 200 || dec["status"] != "rejected" {
		t.Fatalf("reject: %d", c)
	}
	var p2team *int64
	conn.QueryRow(`SELECT team_id FROM players WHERE id = $1`, p2).Scan(&p2team)
	if p2team == nil || *p2team != team {
		t.Fatalf("rejected removal applied")
	}

	// 9. a new password signs every device out; a disabled cabinet does not open
	var reset struct{ Password string }
	if c := admin("POST", fmt.Sprintf("/api/v1/admin/teams/%d/cabinet/password", team), nil, &reset); c != 200 || reset.Password == cred.Password {
		t.Fatalf("reset: %d", c)
	}
	if c := call("GET", "/api/v1/team/me", tok, nil, nil); c != 401 {
		t.Fatalf("old session after reset: %d", c)
	}
	if c := call("POST", "/api/v1/team/login", "", map[string]any{"login": cred.Login, "password": cred.Password}, nil); c != 401 {
		t.Fatalf("old password: %d", c)
	}
	if c := admin("PATCH", fmt.Sprintf("/api/v1/admin/teams/%d/cabinet", team), map[string]any{"enabled": false}, nil); c != 200 {
		t.Fatalf("disable: %d", c)
	}
	if c := call("POST", "/api/v1/team/login", "", map[string]any{"login": cred.Login, "password": reset.Password}, nil); c != 403 {
		t.Fatalf("disabled login: %d", c)
	}
	admin("PATCH", fmt.Sprintf("/api/v1/admin/teams/%d/cabinet", team), map[string]any{"enabled": true}, nil)

	// 10. five wrong passwords lock the cabinet for a while, even for the right password
	for i := 0; i < 4; i++ {
		call("POST", "/api/v1/team/login", "", map[string]any{"login": cred.Login, "password": "x"}, nil)
	}
	if c := call("POST", "/api/v1/team/login", "", map[string]any{"login": cred.Login, "password": reset.Password}, nil); c != 429 {
		t.Fatalf("locked: %d", c)
	}

	// 11. history in the admin
	if c := admin("GET", fmt.Sprintf("/api/v1/admin/teams/%d/cabinet", team), nil, &cab); c != 200 || cab["account"] == nil || len(cab["events"].([]any)) < 6 {
		t.Fatalf("cabinet after: %d %+v", c, cab)
	}
	var cabs map[string]any
	if c := admin("GET", "/api/v1/admin/team-cabinets", nil, &cabs); c != 200 {
		t.Fatalf("cabinets: %d", c)
	}
}
