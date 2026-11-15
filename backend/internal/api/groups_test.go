package api

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http/httptest"
	"os"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/sanedidi/unitedmfl/backend/internal/config"
	"github.com/sanedidi/unitedmfl/backend/internal/db"
)

// Create a group, fill it, rename it, confirm it, delete it — the team mirror
// columns (group_label / group_is_provisional) follow every step.
func TestGroups(t *testing.T) {
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
	var uid int64
	conn.QueryRow(`INSERT INTO users (name, email, password_hash, role) VALUES ('Admin', 'grp-'||floor(random()*1e9)::text||'@x.uz', 'x', 'admin') RETURNING id`).Scan(&uid)
	s := New(conn, &config.Config{UploadDir: t.TempDir(), JWTSecret: []byte("test-secret-test-secret-test-secret!!"), AccessTTL: time.Hour, PointsWin: 3, PointsDraw: 1})
	h := s.Routes()
	tok, _, _ := s.Tokens.Sign(uid, "admin", "Admin")
	call := func(method, path string, body any, out any) int {
		b, _ := json.Marshal(body)
		req := httptest.NewRequest(method, path, bytes.NewReader(b))
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
	sfx := strconv.FormatInt(time.Now().UnixNano()%1e6, 36)
	var g struct {
		ID        int64  `json:"id"`
		Code      string `json:"code"`
		Name      string `json:"name"`
		SeasonID  *int64 `json:"season_id"`
		Confirmed bool   `json:"confirmed"`
	}
	code := "Q" + strings.ToUpper(sfx[:2])
	if c := call("POST", "/api/v1/admin/groups", map[string]any{"name": " Media terma jamoalar ", "code": " " + strings.ToLower(code) + " "}, &g); c != 201 || g.Code != code || g.Name != "Media terma jamoalar" || g.SeasonID == nil {
		t.Fatalf("create: %d %+v", c, g)
	}
	defer conn.Exec(`DELETE FROM team_groups WHERE id=$1`, g.ID)
	if c := call("POST", "/api/v1/admin/groups", map[string]any{"name": "Dup", "code": code}, nil); c != 422 {
		t.Fatalf("duplicate code accepted: %d", c)
	}
	team := func(name string) int64 {
		var id int64
		conn.QueryRow(`INSERT INTO teams (slug, name) VALUES ($1, $2) RETURNING id`, "grp-"+sfx+"-"+name, name).Scan(&id)
		return id
	}
	a, b, c3 := team("a"), team("b"), team("c")
	defer conn.Exec(`DELETE FROM teams WHERE id IN ($1, $2, $3)`, a, b, c3)
	mirror := func(id int64) (string, bool, int) {
		var l string
		var p bool
		var o int
		conn.QueryRow(`SELECT group_label, group_is_provisional, group_ord FROM teams WHERE id=$1`, id).Scan(&l, &p, &o)
		return l, p, o
	}
	gid := strconv.FormatInt(g.ID, 10)
	if c := call("PUT", "/api/v1/admin/groups/"+gid+"/teams", []int64{b, a}, nil); c != 204 {
		t.Fatalf("set teams: %d", c)
	}
	if l, p, o := mirror(b); l != code || !p || o != 1 {
		t.Fatalf("team b: %q %v %d", l, p, o)
	}
	// confirm + new code → teams follow
	code2 := "R" + strings.ToUpper(sfx[:2])
	call("PATCH", "/api/v1/admin/groups/"+gid, map[string]any{"confirmed": true, "code": code2}, nil)
	if l, p, _ := mirror(a); l != code2 || p {
		t.Fatalf("after rename: %q %v", l, p)
	}
	// replace membership: a leaves, c joins
	call("PUT", "/api/v1/admin/groups/"+gid+"/teams", []int64{c3, b}, nil)
	if l, _, _ := mirror(a); l != "" {
		t.Fatalf("a should have left: %q", l)
	}
	// order follows the PUT list
	if _, _, o := mirror(c3); o != 1 {
		t.Fatalf("c3 ord: %d", o)
	}
	// team form: group_id
	var tm struct {
		GroupLabel string `json:"group_label"`
	}
	if c := call("PATCH", "/api/v1/admin/teams/"+strconv.FormatInt(a, 10), map[string]any{"group_id": g.ID}, &tm); c != 200 || tm.GroupLabel != code2 {
		t.Fatalf("team patch: %d %+v", c, tm)
	}
	if _, _, o := mirror(a); o != 3 {
		t.Fatalf("joined team should go last: %d", o)
	}
	// standings carry the group name
	var st struct {
		GroupInfo map[string]struct {
			Name string `json:"name"`
		} `json:"group_info"`
	}
	call("GET", "/api/v1/standings", nil, &st)
	if st.GroupInfo[code2].Name != "Media terma jamoalar" {
		t.Fatalf("group_info: %+v", st.GroupInfo)
	}
	// delete → teams keep nothing
	if c := call("DELETE", "/api/v1/admin/groups/"+gid, nil, nil); c != 204 {
		t.Fatalf("delete: %d", c)
	}
	if l, p, _ := mirror(b); l != "" || p {
		t.Fatalf("after delete: %q %v", l, p)
	}
}
