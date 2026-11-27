package api

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/sanedidi/unitedmfl/backend/internal/config"
	"github.com/sanedidi/unitedmfl/backend/internal/db"
	"github.com/sanedidi/unitedmfl/backend/internal/tickets"
)

// Seat price categories: the centre of a row sold as its own zone ("Markaziy").
func TestSeatPriceCategories(t *testing.T) {
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
	var uid, matchID, season int64
	conn.QueryRow(`INSERT INTO users (name, email, password_hash, role) VALUES ('Admin', 'sz-'||floor(random()*1e9)::text||'@x.uz', 'x', 'admin') RETURNING id`).Scan(&uid)
	if err := conn.QueryRow(`INSERT INTO seasons (name, year) VALUES ('T', 2026) RETURNING id`).Scan(&season); err != nil {
		conn.QueryRow(`SELECT id FROM seasons LIMIT 1`).Scan(&season)
	}
	if err := conn.QueryRow(`INSERT INTO matches (season_id, kickoff_at) VALUES ($1, now() + interval '5 days') RETURNING id`, season).Scan(&matchID); err != nil {
		t.Fatal(err)
	}
	s := New(conn, &config.Config{UploadDir: t.TempDir(), JWTSecret: []byte("test-secret-test-secret-test-secret!!"), AccessTTL: time.Hour, TestPayments: true, SiteURL: "https://unitedmfl.uz"})
	h := s.Routes()
	tok, _, _ := s.Tokens.Sign(uid, "admin", "Admin")
	call := func(method, path string, body any, out any) int {
		b, _ := json.Marshal(body)
		req := httptest.NewRequest(method, "/api/v1"+path, bytes.NewReader(b))
		req.Header.Set("Content-Type", "application/json")
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
	// free-seating section with a centre category: the server makes it numbered
	doc := func(mk string) json.RawMessage {
		return json.RawMessage(`{"pitch":{"x":0,"y":0,"w":300,"h":190},
		 "zones":[{"key":"oddiy","name":"Oddiy zona"},{"key":"markaziy","name":"Markaziy","color":"#E8833A"}],
		 "stands":[{"key":"s","name":"Janubiy","sections":[{"key":"N1","zone":"oddiy","gate":"1","seat_mode":"free",
		   "rows":[{"label":"1","seats":9,"zone_seats":{"markaziy":` + mk + `}}]}]}]}`)
	}
	var venue venueView
	call("POST", "/admin/venues", map[string]any{"name": "Toifa"}, &venue)
	var lv layoutView
	if c := call("PUT", fmt.Sprintf("/admin/venues/%d/draft", venue.ID), map[string]any{"doc": doc("[4,5,6]")}, &lv); c != 200 {
		t.Fatal("draft", c)
	}
	var saved tickets.Layout
	json.Unmarshal(lv.Doc, &saved)
	if saved.Stands[0].Sections[0].SeatMode != "numbered" || lv.Stats.ByZone["markaziy"] != 3 || lv.Stats.ByZone["oddiy"] != 6 {
		t.Fatalf("categories not applied: %+v %s", lv.Stats, saved.Stands[0].Sections[0].SeatMode)
	}
	call("POST", fmt.Sprintf("/admin/venues/%d/publish", venue.ID), map[string]any{}, &venue)
	call("PUT", fmt.Sprintf("/admin/matches/%d/ticket-sale", matchID), map[string]any{"layout_id": venue.Published.ID, "max_per_order": 10}, nil)
	call("PUT", fmt.Sprintf("/admin/matches/%d/ticket-sale/zones/oddiy", matchID), map[string]any{"price": 50000}, nil)
	var sv saleView
	call("PUT", fmt.Sprintf("/admin/matches/%d/ticket-sale/zones/markaziy", matchID), map[string]any{"price": 80000}, &sv)
	caps := map[string]int{}
	for _, z := range sv.Zones {
		caps[z.ZoneKey] = z.Capacity
	}
	if caps["markaziy"] != 3 || caps["oddiy"] != 6 {
		t.Fatalf("capacities %v", caps)
	}
	if c := call("POST", fmt.Sprintf("/admin/matches/%d/ticket-sale/status", matchID), map[string]any{"status": "open"}, nil); c != 200 {
		t.Fatal("open", c)
	}
	order := func(zone string, qty int) (string, int) {
		var co struct {
			AccessToken string `json:"access_token"`
		}
		c := call("POST", "/ticket-orders", map[string]any{"match_id": matchID, "buyer_name": "Aziz Karimov", "phone": "+998901234567", "agree": true,
			"items": []map[string]any{{"zone": zone, "qty": qty}}}, &co)
		return co.AccessToken, c
	}
	seats := func(token string) []string {
		rows, _ := conn.Query(`SELECT t.seat_id FROM tickets t JOIN ticket_orders o ON o.id=t.order_id WHERE o.access_token=$1 ORDER BY t.seat_id`, token)
		defer rows.Close()
		var out []string
		for rows.Next() {
			var id string
			rows.Scan(&id)
			out = append(out, id)
		}
		return out
	}
	t1, c := order("markaziy", 2)
	if c != 201 {
		t.Fatal("markaziy order", c)
	}
	if got := strings.Join(seats(t1), ","); got != "N1:1:4,N1:1:5" && got != "N1:1:5,N1:1:6" {
		t.Fatalf("markaziy seats: %s", got)
	}
	if _, c := order("markaziy", 2); c != 409 {
		t.Fatal("only one centre seat left", c)
	}
	t2, c := order("oddiy", 6)
	if c != 201 {
		t.Fatal("oddiy order", c)
	}
	for _, id := range seats(t2) {
		if id == "N1:1:4" || id == "N1:1:5" || id == "N1:1:6" {
			t.Fatal("oddiy ticket on a centre seat", id)
		}
	}
	// a sold centre seat cannot leave its category
	sold := seats(t1)[0]
	n := sold[strings.LastIndex(sold, ":")+1:]
	rest := []string{}
	for _, x := range []string{"4", "5", "6"} {
		if x != n {
			rest = append(rest, x)
		}
	}
	if c := call("PUT", fmt.Sprintf("/admin/venues/%d/draft", venue.ID), map[string]any{"doc": doc("[" + strings.Join(rest, ",") + "]")}, nil); c != 409 {
		t.Fatal("zone of a sold seat changed", c)
	}
	// seat 3 was sold as Oddiy — it cannot become Markaziy either
	if c := call("PUT", fmt.Sprintf("/admin/venues/%d/draft", venue.ID), map[string]any{"doc": doc("[3,4,5,6]")}, nil); c != 409 {
		t.Fatal("sold oddiy seat moved into the category", c)
	}
	// the unsold centre seat may go back to Oddiy
	keep := []string{}
	for _, id := range seats(t1) {
		keep = append(keep, id[strings.LastIndex(id, ":")+1:])
	}
	if c := call("PUT", fmt.Sprintf("/admin/venues/%d/draft", venue.ID), map[string]any{"doc": doc("[" + strings.Join(keep, ",") + "]")}, nil); c != 200 {
		t.Fatal("unsold centre seat back to oddiy", c)
	}
}
