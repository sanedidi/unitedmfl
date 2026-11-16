package api

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/sanedidi/unitedmfl/backend/internal/config"
	"github.com/sanedidi/unitedmfl/backend/internal/db"
)

func TestHpLayoutValidation(t *testing.T) {
	if _, err := parseHpLayout(defaultHpLayout()); err != nil {
		t.Fatalf("default layout invalid: %v", err)
	}
	cases := map[string]string{
		"unknown field":   `{"v":1,"rows":[{"id":"r","blocks":[{"id":"b","type":"news","variant":"wide","span":8,"oops":1}]}]}`,
		"unknown type":    `{"v":1,"rows":[{"id":"r","blocks":[{"id":"b","type":"nope","variant":"wide","span":8}]}]}`,
		"too wide":        `{"v":1,"rows":[{"id":"r","blocks":[{"id":"a","type":"news","variant":"wide","span":8},{"id":"b","type":"news","variant":"wide","span":8}]}]}`,
		"dup id":          `{"v":1,"rows":[{"id":"r","blocks":[{"id":"r","type":"news","variant":"wide","span":8}]}]}`,
		"empty row":       `{"v":1,"rows":[{"id":"r","blocks":[]}]}`,
		"hero narrow":     `{"v":1,"rows":[{"id":"r","blocks":[{"id":"b","type":"hero","variant":"wide","span":8}]}]}`,
		"range backwards": `{"v":1,"rows":[{"id":"r","blocks":[{"id":"b","type":"banner","variant":"featured","span":12,"schedule":{"mode":"range","start":"2026-12-01T10:00","end":"2026-11-01T10:00"}}]}]}`,
		"weekly no days":  `{"v":1,"rows":[{"id":"r","blocks":[{"id":"b","type":"banner","variant":"featured","span":12,"schedule":{"mode":"weekly","from":"18:00","to":"23:00"}}]}]}`,
		"replace no alt":  `{"v":1,"rows":[{"id":"r","blocks":[{"id":"b","type":"banner","variant":"featured","span":12,"schedule":{"mode":"range","end":"2026-12-01T10:00","onEnd":"replace"}}]}]}`,
		"bad href":        `{"v":1,"rows":[{"id":"r","blocks":[{"id":"b","type":"news","variant":"wide","span":8,"linkHref":"javascript:alert(1)"}]}]}`,
		"props not obj":   `{"v":1,"rows":[{"id":"r","blocks":[{"id":"b","type":"news","variant":"wide","span":8,"props":[1]}]}]}`,
	}
	for name, raw := range cases {
		if _, err := parseHpLayout([]byte(raw)); err == nil {
			t.Errorf("%s: expected an error", name)
		}
	}
	ok := `{"v":1,"rows":[{"id":"r","gap":24,"bg":"subtle","blocks":[
		{"id":"b","type":"banner","variant":"featured","span":8,"devices":{"desktop":true,"tablet":true,"mobile":false},
		 "schedule":{"mode":"range","start":"2026-11-16T18:00","end":"2026-11-30T23:59","onEnd":"replace"},
		 "alt":{"id":"b2","type":"partners","variant":"featured","span":8,"props":{"items":[{"name":"X"}]}}},
		{"id":"c","type":"live","variant":"compact","span":4,"schedule":{"mode":"match","before":60,"after":120}}]}]}`
	l, err := parseHpLayout([]byte(ok))
	if err != nil {
		t.Fatalf("valid layout rejected: %v", err)
	}
	if l.Rows[0].Blocks[0].Alt.Span != 0 {
		t.Fatalf("alt span should follow the replaced block")
	}
}

func TestHomepageFlow(t *testing.T) {
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
	conn.Exec(`DELETE FROM homepage_versions`)
	conn.Exec(`DELETE FROM homepage_draft`)
	var uid int64
	if err := conn.QueryRow(`INSERT INTO users (name, email, password_hash, role) VALUES ('Muharrir', 'hp-test-'||floor(random()*1e9)::text||'@x.uz', 'x', 'editor') RETURNING id`).Scan(&uid); err != nil {
		t.Fatal(err)
	}
	s := New(conn, &config.Config{UploadDir: t.TempDir(), JWTSecret: []byte("test-secret-test-secret-test-secret!!"), AccessTTL: time.Hour})
	h := s.Routes()
	tok, _, _ := s.Tokens.Sign(uid, "editor", "Muharrir")
	call := func(method, path string, body any, out any) int {
		var rd *bytes.Reader
		if body != nil {
			b, _ := json.Marshal(body)
			rd = bytes.NewReader(b)
		} else {
			rd = bytes.NewReader(nil)
		}
		req := httptest.NewRequest(method, "/api/v1"+path, rd)
		if strings.HasPrefix(path, "/admin") {
			req.Header.Set("Authorization", "Bearer "+tok)
		}
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
	type state struct {
		Draft struct {
			Config    hpLayout  `json:"config"`
			UpdatedAt time.Time `json:"updated_at"`
			Exists    bool      `json:"exists"`
		} `json:"draft"`
		Dirty     bool `json:"dirty"`
		Published *struct {
			Version int `json:"version"`
		} `json:"published"`
		Scheduled []struct {
			Version int `json:"version"`
		} `json:"scheduled"`
	}

	// nothing published: the site gets the default layout
	var pub struct {
		Version int      `json:"version"`
		Config  hpLayout `json:"config"`
	}
	if c := call("GET", "/homepage", nil, &pub); c != 200 || pub.Version != 0 || len(pub.Config.Rows) < 5 {
		t.Fatalf("default public layout: %d %+v", c, pub)
	}
	var st state
	if c := call("GET", "/admin/homepage", nil, &st); c != 200 || st.Draft.Exists || st.Dirty || st.Published != nil {
		t.Fatalf("initial state: %d %+v", c, st)
	}

	// edit: news above the table
	l := st.Draft.Config
	l.Rows[3], l.Rows[4] = l.Rows[4], l.Rows[3]
	var saved struct {
		UpdatedAt time.Time `json:"updated_at"`
	}
	if c := call("PUT", "/admin/homepage/draft", map[string]any{"config": l}, &saved); c != 200 {
		t.Fatalf("save draft: %d", c)
	}
	// a stale editor is refused
	if c := call("PUT", "/admin/homepage/draft", map[string]any{"config": l, "updated_at": saved.UpdatedAt.Add(-time.Minute)}, nil); c != 409 {
		t.Fatalf("stale save should conflict, got %d", c)
	}
	if c := call("PUT", "/admin/homepage/draft", map[string]any{"config": l, "updated_at": saved.UpdatedAt}, &saved); c != 200 {
		t.Fatalf("save with current stamp: %d", c)
	}
	// invalid layouts never reach the draft
	bad := l
	bad.Rows = append([]hpRow{{ID: "x", Blocks: []hpBlock{{ID: "y", Type: "hero", Variant: "wide", Span: 6}}}}, l.Rows...)
	if c := call("PUT", "/admin/homepage/draft", map[string]any{"config": bad}, nil); c != 422 {
		t.Fatalf("invalid draft: %d", c)
	}
	call("GET", "/admin/homepage", nil, &st)
	if !st.Dirty || st.Draft.Config.Rows[3].ID != "r_news" {
		t.Fatalf("draft not stored: %+v", st)
	}
	// the site still shows the old layout
	call("GET", "/homepage", nil, &pub)
	if pub.Config.Rows[3].ID != "r_table" {
		t.Fatalf("draft leaked to the site")
	}

	// preview token shows the draft
	var pv struct {
		Token string `json:"token"`
	}
	call("POST", "/admin/homepage/preview", nil, &pv)
	if c := call("GET", "/homepage/preview?token="+pv.Token, nil, &pub); c != 200 || pub.Config.Rows[3].ID != "r_news" {
		t.Fatalf("preview: %d", c)
	}
	if c := call("GET", "/homepage/preview?token=x"+pv.Token, nil, nil); c != 403 {
		t.Fatalf("forged token: %d", c)
	}

	// publish → v1 live
	var p struct {
		Version int `json:"version"`
	}
	if c := call("POST", "/admin/homepage/publish", map[string]any{"summary": "Yangiliklar yuqoriga", "changes": []string{"Latest News ko‘chirildi"}}, &p); c != 201 || p.Version != 1 {
		t.Fatalf("publish: %d %+v", c, p)
	}
	call("GET", "/homepage", nil, &pub)
	if pub.Version != 1 || pub.Config.Rows[3].ID != "r_news" {
		t.Fatalf("published layout not live: %+v", pub)
	}
	call("GET", "/admin/homepage", nil, &st)
	if st.Dirty || st.Published == nil || st.Published.Version != 1 {
		t.Fatalf("after publish: %+v", st)
	}

	// schedule v2 for tomorrow: v1 stays live until then
	l.Rows = l.Rows[:len(l.Rows)-1]
	call("PUT", "/admin/homepage/draft", map[string]any{"config": l}, nil)
	if c := call("POST", "/admin/homepage/publish", map[string]any{"summary": "Ertaga", "publish_at": time.Now().Add(24 * time.Hour)}, &p); c != 201 || p.Version != 2 {
		t.Fatalf("schedule: %d", c)
	}
	call("GET", "/homepage", nil, &pub)
	if pub.Version != 1 {
		t.Fatalf("scheduled version went live early: %d", pub.Version)
	}
	call("GET", "/admin/homepage", nil, &st)
	if len(st.Scheduled) != 1 || st.Scheduled[0].Version != 2 {
		t.Fatalf("scheduled list: %+v", st.Scheduled)
	}
	if c := call("DELETE", "/admin/homepage/versions/2", nil, nil); c != 204 {
		t.Fatalf("cancel scheduled: %d", c)
	}
	if c := call("DELETE", "/admin/homepage/versions/1", nil, nil); c != 409 {
		t.Fatalf("live version must not be deletable: %d", c)
	}

	// restore v1 into the draft
	if c := call("POST", "/admin/homepage/versions/1/restore", nil, &st); c != 200 || len(st.Draft.Config.Rows) != 8 || st.Dirty {
		t.Fatalf("restore: %d %+v", c, st)
	}
	var versions []map[string]any
	call("GET", "/admin/homepage/versions", nil, &versions)
	if len(versions) != 1 || versions[0]["live"] != true {
		t.Fatalf("versions: %+v", versions)
	}

	// public visitors cannot touch the admin side
	req := httptest.NewRequest("GET", "/api/v1/admin/homepage", nil)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != 401 {
		t.Fatalf("anonymous admin access: %d", rec.Code)
	}
	conn.Exec(`DELETE FROM homepage_versions`)
	conn.Exec(`DELETE FROM homepage_draft`)
	conn.Exec(`DELETE FROM users WHERE id=$1`, uid)
}
