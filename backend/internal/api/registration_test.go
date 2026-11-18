package api

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"image"
	"image/png"
	"mime/multipart"
	"net/http/httptest"
	"os"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/sanedidi/unitedmfl/backend/internal/config"
	"github.com/sanedidi/unitedmfl/backend/internal/db"
	"github.com/sanedidi/unitedmfl/backend/internal/roster"
	"github.com/sanedidi/unitedmfl/backend/internal/xlsx"
)

// The whole self-registration path: a closed link, opening it in the admin, a
// draft with SMS verification, sending, a correction round, approval that
// creates the team (moving one existing player) and the status afterwards.
func TestTeamRegistration(t *testing.T) {
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
	conn.QueryRow(`INSERT INTO users (name, email, password_hash, role) VALUES ('Admin', 'reg-'||$1||'@x.uz', 'x', 'admin') RETURNING id`, sfx).Scan(&uid)
	s := New(conn, &config.Config{UploadDir: t.TempDir(), JWTSecret: []byte("test-secret-test-secret-test-secret!!"), AccessTTL: time.Hour,
		RegisterURL: "https://ariza.test", SMSCodeText: "kod %s"})
	h := s.Routes()
	tok, _, _ := s.Tokens.Sign(uid, "admin", "Admin")
	do := func(method, path string, body any, out any, admin bool) int {
		t.Helper()
		var rd *bytes.Reader
		ct := "application/json"
		switch b := body.(type) {
		case *multipart.Writer:
			t.Fatal("use upload()")
		case []byte:
			rd = bytes.NewReader(b)
		default:
			j, _ := json.Marshal(body)
			rd = bytes.NewReader(j)
		}
		req := httptest.NewRequest(method, path, rd)
		req.Header.Set("Content-Type", ct)
		if admin {
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
	admin := func(method, path string, body, out any) int { return do(method, path, body, out, true) }
	pub := func(method, path string, body, out any) int { return do(method, path, body, out, false) }

	// an existing league player who will move to the new team
	var oldTeam, oldPlayer int64
	conn.QueryRow(`INSERT INTO teams (slug, name, short_name) VALUES ($1, $2, 'OLD') RETURNING id`, "old-"+sfx, "Old "+sfx).Scan(&oldTeam)
	conn.QueryRow(`INSERT INTO players (team_id, full_name, number) VALUES ($1, $2, 7) RETURNING id`, oldTeam, "Qodir Tursun"+sfx).Scan(&oldPlayer)
	defer conn.Exec(`DELETE FROM players WHERE id = $1`, oldPlayer)
	defer conn.Exec(`DELETE FROM teams WHERE id = $1`, oldTeam)

	// 1. the link starts closed
	var link map[string]any
	if c := admin("POST", "/api/v1/admin/registration/links", map[string]any{"title": "Test qabul " + sfx, "min_players": 2, "max_players": 5, "max_teams": 1}, &link); c != 201 {
		t.Fatalf("create link: %d", c)
	}
	linkID := int64(link["id"].(float64))
	code := link["code"].(string)
	defer conn.Exec(`DELETE FROM team_applications WHERE link_id = $1`, linkID)
	defer conn.Exec(`DELETE FROM registration_links WHERE id = $1`, linkID)
	if len(code) != 6 || link["is_active"] != false {
		t.Fatalf("new link: %+v", link)
	}
	var pl map[string]any
	if c := pub("GET", "/api/v1/register/links/"+strings.ToLower(code), nil, &pl); c != 200 || pl["state"] != "paused" || pl["title"] != nil {
		t.Fatalf("closed link: %d %+v", c, pl)
	}
	if c := pub("POST", "/api/v1/register/links/"+code+"/applications", map[string]any{}, nil); c != 409 {
		t.Fatalf("draft on a closed link: %d", c)
	}
	var home map[string]any
	pub("GET", "/api/v1/register/home", nil, &home)
	if home["link"] != nil {
		t.Fatalf("home without a default link: %+v", home)
	}

	// 2. the admin opens it and puts it on the root page
	if c := admin("PATCH", fmt.Sprintf("/api/v1/admin/registration/links/%d", linkID), map[string]any{"is_active": true, "is_default": true}, nil); c != 200 {
		t.Fatalf("open link: %d", c)
	}
	pub("GET", "/api/v1/register/home", nil, &home)
	if hl, _ := home["link"].(map[string]any); hl == nil || hl["code"] != code || hl["state"] != "open" {
		t.Fatalf("home: %+v", home)
	}
	defer conn.Exec(`UPDATE registration_links SET is_default = false WHERE id = $1`, linkID)

	// 3. a draft
	type view struct {
		Token         string            `json:"token"`
		Status        string            `json:"status"`
		PhoneVerified bool              `json:"phone_verified"`
		OTPRequired   bool              `json:"otp_required"`
		Editable      map[string]bool   `json:"editable"`
		Checks        []appCheck        `json:"checks"`
		Team          teamInfo          `json:"team"`
		Players       []roster.Player   `json:"players"`
		Comments      []appComment      `json:"comments"`
		Error         map[string]any    `json:"error"`
		Extra         map[string]string `json:"-"`
	}
	var v view
	if c := pub("POST", "/api/v1/register/links/"+code+"/applications", map[string]any{}, &v); c != 201 || v.Token == "" || v.Status != "draft" || !v.OTPRequired {
		t.Fatalf("draft: %d %+v", c, v)
	}
	base := "/api/v1/register/applications/" + v.Token
	upload := func(path, kind, name string, data []byte, out any) int {
		var buf bytes.Buffer
		mw := multipart.NewWriter(&buf)
		if kind != "" {
			mw.WriteField("kind", kind)
		}
		fw, _ := mw.CreateFormFile("file", name)
		fw.Write(data)
		mw.Close()
		req := httptest.NewRequest("POST", path, &buf)
		req.Header.Set("Content-Type", mw.FormDataContentType())
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		if out != nil {
			json.Unmarshal(rec.Body.Bytes(), out)
		}
		if rec.Code >= 300 {
			t.Logf("upload %s → %d %s", path, rec.Code, rec.Body.String())
		}
		return rec.Code
	}
	var pngBuf bytes.Buffer
	png.Encode(&pngBuf, image.NewRGBA(image.Rect(0, 0, 256, 256)))
	var logo struct {
		URL           string `json:"url"`
		Width, Height int
	}
	if c := upload(base+"/files", "logo", "logo.png", pngBuf.Bytes(), &logo); c != 201 || !strings.HasPrefix(logo.URL, "/uploads/images/") || logo.Width != 256 {
		t.Fatalf("logo: %d %+v", c, logo)
	}
	var med roster.File
	if c := upload(base+"/files", "medical", "spravka.pdf", []byte("%PDF-1.4 test"), &med); c != 201 || med.File == "" {
		t.Fatalf("medical: %d %+v", c, med)
	}

	// import a TARKIB.xlsx roster
	sheet := xlsx.Sheet{Rows: [][]xlsx.Cell{{{Text: "ISM"}, {Text: "FAMILIYA"}, {Text: "FORMA O'LCHAMI"}}, {{Text: "Ali"}, {Text: "Valiyev"}, {Text: "2Xl"}}}}
	xb, _ := xlsx.Write(sheet)
	var imp struct {
		Import roster.Import `json:"import"`
	}
	if c := upload(base+"/import", "", "TARKIB.xlsx", xb, &imp); c != 200 || len(imp.Import.Players) != 1 || imp.Import.Players[0].KitSize != "2XL" {
		t.Fatalf("import: %d %+v", c, imp)
	}

	players := []roster.Player{
		{FirstName: "Ali", LastName: "Valiyev", JerseyName: "ali", BirthDate: "20.07.2001", Number: "1", KitSize: "m", Role: "goalkeeper", Medical: &med},
		{FirstName: "Tursun" + sfx, LastName: "Qodir", JerseyName: "QODIR", BirthDate: "2000-01-01", Number: "1", KitSize: "L", Role: "player"},
		{FirstName: "Blogger", LastName: "Media", JerseyName: "BLOG", BirthDate: "1999-05-05", Number: "99", KitSize: "S", Role: "media", Medical: &roster.File{File: "../../etc/passwd"}},
	}
	team := map[string]any{"name": "Reg FC " + sfx, "short_name": "rgf", "colors": []string{"#1d4ed8", "red", "#ffffff"}, "crest_url": logo.URL, "crest_w": 256, "crest_h": 256, "instagram": "@regfc"}
	if c := pub("PUT", base, map[string]any{"team": team, "rep": map[string]any{"name": "Jasur", "phone": "+998 90 123 45 67", "telegram": "@jasur", "role": "captain", "authorized": true},
		"players": players, "staff": []roster.Staff{{FirstName: "Jan", LastName: "Safarov", Role: "head_coach", KitSize: "L"}}}, &v); c != 200 {
		t.Fatalf("save: %d", c)
	}
	if v.Team.ShortName != "RGF" || len(v.Team.Colors) != 2 || v.Players[0].JerseyName != "ALI" || v.Players[0].BirthDate != "2001-07-20" || v.Players[0].KitSize != "M" || v.Players[2].Medical != nil {
		t.Fatalf("sanitised: %+v %+v", v.Team, v.Players)
	}
	has := func(code string) bool {
		for _, c := range v.Checks {
			if c.Code == code {
				return true
			}
		}
		return false
	}
	for _, want := range []string{"player.number_dup", "rep.phone", "consents", "player.duplicate", "team.crest_url", "roster.medical"} {
		if !has(want) {
			t.Errorf("missing check %s: %+v", want, v.Checks)
		}
	}
	if c := pub("POST", base+"/submit", map[string]any{}, &v); c != 422 {
		t.Fatalf("submit with errors: %d", c)
	}

	// SMS code (development sender returns it)
	var otp map[string]any
	if c := pub("POST", base+"/otp/send", map[string]any{"phone": "+998 90 123 45 67"}, &otp); c != 200 || otp["dev_code"] == nil {
		t.Fatalf("otp send: %d %+v", c, otp)
	}
	if c := pub("POST", base+"/otp/send", map[string]any{}, nil); c != 429 {
		t.Fatalf("resend too early: %d", c)
	}
	if c := pub("POST", base+"/otp/verify", map[string]any{"code": "000000"}, nil); c != 422 && otp["dev_code"] != "000000" {
		t.Fatalf("wrong code: %d", c)
	}
	if c := pub("POST", base+"/otp/verify", map[string]any{"code": otp["dev_code"]}, &v); c != 200 || !v.PhoneVerified {
		t.Fatalf("verify: %d %+v", c, v)
	}

	players[1].Number = "z 10" // a number with a letter is stored the way it is printed: Z10
	if c := pub("PUT", base, map[string]any{"players": players, "consents": map[string]bool{"rules": true, "players": true, "personal": true}}, &v); c != 200 {
		t.Fatalf("save 2: %d", c)
	}
	if c := pub("POST", base+"/submit", map[string]any{}, &v); c != 200 || v.Status != "submitted" || v.Editable["team"] {
		t.Fatalf("submit: %d %+v", c, v)
	}
	if c := pub("PUT", base, map[string]any{"team": team}, nil); c != 409 {
		t.Fatalf("edit after sending: %d", c)
	}

	// 4. admin: list, review, ask for a correction of the roster only
	var list struct {
		Items []map[string]any `json:"items"`
	}
	admin("GET", fmt.Sprintf("/api/v1/admin/applications?link_id=%d", linkID), nil, &list)
	if len(list.Items) != 1 || list.Items[0]["status"] != "submitted" {
		t.Fatalf("admin list: %+v", list.Items)
	}
	appID := int64(list.Items[0]["id"].(float64))
	admin("POST", fmt.Sprintf("/api/v1/admin/applications/%d/review", appID), nil, nil)
	var detail struct {
		Status     string           `json:"status"`
		Duplicates []map[string]any `json:"duplicates"`
		RepURL     string           `json:"rep_url"`
	}
	admin("GET", fmt.Sprintf("/api/v1/admin/applications/%d", appID), nil, &detail)
	if detail.Status != "review" || len(detail.Duplicates) != 1 || detail.RepURL != "https://ariza.test/a/"+v.Token {
		t.Fatalf("detail: %+v", detail)
	}
	if c := admin("POST", fmt.Sprintf("/api/v1/admin/applications/%d/request-changes", appID), map[string]any{"comments": []appComment{{Section: "roster", Text: "Medya shaxsga tibbiy ruxsatnoma"}}, "days": 3}, nil); c != 204 {
		t.Fatalf("request changes: %d", c)
	}
	pub("GET", base, nil, &v)
	if v.Status != "changes" || !v.Editable["roster"] || v.Editable["team"] || len(v.Comments) != 1 {
		t.Fatalf("changes view: %+v", v)
	}
	team["name"] = "Hacked " + sfx
	players[2].Medical = &med
	pub("PUT", base, map[string]any{"team": team, "players": players}, &v)
	if v.Team.Name != "Reg FC "+sfx || v.Players[2].Medical == nil {
		t.Fatalf("only the roster may change: %+v", v.Team)
	}
	if c := pub("POST", base+"/submit", map[string]any{}, &v); c != 200 || v.Status != "submitted" || len(v.Comments) != 0 {
		t.Fatalf("resubmit: %d %+v", c, v)
	}

	// 5. approve: the duplicate moves from the old team, the rest is created
	var res map[string]any
	if c := admin("POST", fmt.Sprintf("/api/v1/admin/applications/%d/approve", appID), map[string]any{"players": map[string]int64{"1": oldPlayer}}, &res); c != 200 {
		t.Fatalf("approve: %d %+v", c, res)
	}
	teamID := int64(res["team_id"].(float64))
	defer conn.Exec(`DELETE FROM teams WHERE id = $1`, teamID)
	defer conn.Exec(`DELETE FROM players WHERE team_id = $1`, teamID)
	var cnt, media, staff int
	var short, crest string
	conn.QueryRow(`SELECT count(*), count(*) FILTER (WHERE is_media) FROM players WHERE team_id = $1`, teamID).Scan(&cnt, &media)
	conn.QueryRow(`SELECT count(*) FROM team_staff WHERE team_id = $1`, teamID).Scan(&staff)
	conn.QueryRow(`SELECT short_name, crest_url FROM teams WHERE id = $1`, teamID).Scan(&short, &crest)
	var moved int64
	conn.QueryRow(`SELECT team_id FROM players WHERE id = $1`, oldPlayer).Scan(&moved)
	if cnt != 3 || media != 1 || staff != 1 || short != "RGF" || crest != logo.URL || moved != teamID || res["players_moved"].(float64) != 1 {
		t.Fatalf("created: players %d media %d staff %d short %s moved %d %+v", cnt, media, staff, short, moved, res)
	}
	var movedNumber string
	conn.QueryRow(`SELECT number FROM players WHERE id = $1`, oldPlayer).Scan(&movedNumber)
	if movedNumber != "Z10" {
		t.Fatalf("number with a letter: %q", movedNumber)
	}
	var kit, medURL string
	conn.QueryRow(`SELECT kit_size, medical_url FROM players WHERE team_id = $1 AND number = '1'`, teamID).Scan(&kit, &medURL)
	if kit != "M" || !strings.Contains(medURL, med.File) {
		t.Fatalf("player fields: %q %q", kit, medURL)
	}
	pub("GET", base, nil, &v)
	if v.Status != "approved" {
		t.Fatalf("status after approval: %+v", v)
	}
	// the single place is taken now
	pub("GET", "/api/v1/register/links/"+code, nil, &pl)
	if pl["state"] != "full" {
		t.Fatalf("link after approval: %+v", pl)
	}

	// 6. export, link cannot be deleted, regenerate kills the old code
	req := httptest.NewRequest("GET", fmt.Sprintf("/api/v1/admin/applications/%d/export.xlsx", appID), nil)
	req.Header.Set("Authorization", "Bearer "+tok)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if wb, err := xlsx.Read(bytes.NewReader(rec.Body.Bytes()), int64(rec.Body.Len())); err != nil || len(roster.ParseTarkib(wb.Rows).Players) != 3 {
		t.Fatalf("export: %d %v", rec.Code, err)
	}
	if c := admin("DELETE", fmt.Sprintf("/api/v1/admin/registration/links/%d", linkID), nil, nil); c != 409 {
		t.Fatalf("delete used link: %d", c)
	}
	var re map[string]any
	admin("POST", fmt.Sprintf("/api/v1/admin/registration/links/%d/regenerate", linkID), nil, &re)
	if re["code"] == code || pub("GET", "/api/v1/register/links/"+code, nil, nil) != 404 {
		t.Fatalf("regenerate: %+v", re)
	}

	// 7. deleting the approved application together with its team: an editor
	// may not, the admin has to type the number, the moved player stays
	delPath := fmt.Sprintf("/api/v1/admin/applications/%d", appID)
	var info struct {
		Number        string       `json:"number"`
		ConfirmNumber bool         `json:"confirm_number"`
		CanDeleteTeam bool         `json:"can_delete_team"`
		Team          *appTeamInfo `json:"team"`
	}
	if c := admin("GET", delPath+"/delete-info", nil, &info); c != 200 || info.Team == nil {
		t.Fatalf("delete-info: %d %+v", c, info)
	}
	if !info.ConfirmNumber || !info.CanDeleteTeam || info.Team.ID != teamID || info.Team.Players+info.Team.Media != 2 ||
		info.Team.Kept != 1 || info.Team.Staff != 1 || info.Team.Played != 0 {
		t.Fatalf("delete-info: %+v %+v", info, info.Team)
	}
	edTok, _, _ := s.Tokens.Sign(uid, "editor", "Editor")
	req = httptest.NewRequest("DELETE", delPath+"?team=1&confirm="+info.Number, nil)
	req.Header.Set("Authorization", "Bearer "+edTok)
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != 403 {
		t.Fatalf("editor deletes approved: %d", rec.Code)
	}
	if c := admin("DELETE", delPath+"?team=1", nil, nil); c != 400 {
		t.Fatalf("delete without number: %d", c)
	}
	var del map[string]any
	if c := admin("DELETE", delPath+"?team=1&confirm="+strings.ToLower(info.Number), nil, &del); c != 200 || del["team_deleted"] != true || del["players_detached"].(float64) != 1 {
		t.Fatalf("delete: %d %+v", c, del)
	}
	var left, events int
	var oldTeamOf *int64
	conn.QueryRow(`SELECT count(*) FROM teams WHERE id = $1`, teamID).Scan(&left)
	conn.QueryRow(`SELECT count(*) FROM application_events WHERE application_id = $1`, appID).Scan(&events)
	if err := conn.QueryRow(`SELECT team_id FROM players WHERE id = $1`, oldPlayer).Scan(&oldTeamOf); err != nil || oldTeamOf != nil {
		t.Fatalf("moved player after delete: %v %v", err, oldTeamOf)
	}
	if left != 0 || events != 0 || admin("GET", delPath, nil, nil) != 404 || pub("GET", base, nil, nil) != 404 {
		t.Fatalf("after delete: team %d events %d", left, events)
	}

	// a team that has played keeps living: only the application can go
	var season, played, app2, m int64
	conn.QueryRow(`INSERT INTO seasons (name, slug) VALUES ($1, $1) RETURNING id`, "del-"+sfx).Scan(&season)
	defer conn.Exec(`DELETE FROM seasons WHERE id = $1`, season)
	conn.QueryRow(`INSERT INTO teams (slug, name) VALUES ($1, $1) RETURNING id`, "played-"+sfx).Scan(&played)
	defer conn.Exec(`DELETE FROM teams WHERE id = $1`, played)
	conn.QueryRow(`INSERT INTO matches (season_id, home_team_id, status) VALUES ($1, $2, 'finished') RETURNING id`, season, played).Scan(&m)
	conn.QueryRow(`INSERT INTO team_applications (token, status, team_id, decided_at) VALUES ($1, 'approved', $2, now()) RETURNING id`, "del-"+sfx, played).Scan(&app2)
	defer conn.Exec(`DELETE FROM team_applications WHERE id = $1`, app2)
	p2 := fmt.Sprintf("/api/v1/admin/applications/%d", app2)
	num := fmt.Sprintf("UMF-%04d", app2)
	admin("GET", p2+"/delete-info", nil, &info)
	if info.CanDeleteTeam || info.Team == nil || info.Team.Played != 1 {
		t.Fatalf("played delete-info: %+v", info)
	}
	if c := admin("DELETE", p2+"?team=1&confirm="+num, nil, nil); c != 409 {
		t.Fatalf("delete played team: %d", c)
	}
	if c := admin("DELETE", p2+"?confirm="+num, nil, &del); c != 200 || del["team_deleted"] != false {
		t.Fatalf("delete application only: %d %+v", c, del)
	}
	conn.QueryRow(`SELECT count(*) FROM teams WHERE id = $1`, played).Scan(&left)
	if left != 1 {
		t.Fatal("played team was deleted")
	}
}
