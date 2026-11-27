package tickets

import (
	"fmt"
	"strings"
	"testing"
	"time"
)

const sample = `{
 "zones":[{"key":"oddiy","name":"Oddiy zona"},{"key":"vip","name":"VIP zona","kind":"vip"}],
 "stands":[{"key":"s","name":"Janubiy","sections":[
   {"key":"D1","zone":"oddiy","seat_mode":"free","rows":[{"label":"1","seats":12},{"label":"2","seats":12,"removed":[1,12,40],"blocked":[5,5,1]}]},
   {"key":"VIP","zone":"vip","rows":[{"label":"1","seats":4},{"label":"2","seats":4,"blocked":[2]}]}
 ]}]}`

func TestLayoutStats(t *testing.T) {
	l, err := Parse([]byte(sample))
	if err != nil {
		t.Fatal(err)
	}
	st := l.Stats()
	// D1: 12 + 10 seats, 1 blocked (5; 1 is removed) → 21 sellable; VIP 8 seats, 1 blocked → 7
	if st.Seats != 30 || st.Sellable != 28 || st.ByZone["oddiy"] != 21 || st.ByZone["vip"] != 7 {
		t.Fatalf("stats %+v", st)
	}
	r := l.Stands[0].Sections[0].Rows[1]
	if len(r.Removed) != 2 || len(r.Blocked) != 1 || r.Blocked[0] != 5 {
		t.Fatalf("row clean %+v", r)
	}
	if l.FreeCapacity("oddiy") != 21 || l.ZoneMode("vip") != "numbered" || l.ZoneMode("oddiy") != "free" {
		t.Fatal("capacity/mode")
	}
}

func TestSellableSeatsOrder(t *testing.T) {
	l, _ := Parse([]byte(sample))
	s := l.SellableSeats("vip")
	if len(s) != 7 {
		t.Fatalf("got %d", len(s))
	}
	// row 1 first, middle seats first
	if s[0].ID != "VIP:1:2" || s[1].ID != "VIP:1:3" || s[4].Row != "2" {
		t.Fatalf("order %+v", s)
	}
	if l.IsSellable("VIP:2:2") || !l.IsSellable("VIP:2:3") || l.IsSellable("D1:1:1") {
		t.Fatal("sellable")
	}
}

func TestLayoutValidation(t *testing.T) {
	bad := []string{
		`{"stands":[{"sections":[{"key":"A"},{"key":"a"}]}]}`,
		`{"stands":[{"sections":[{"key":"A","zone":"x"}]}]}`,
		`{"stands":[{"sections":[{"key":"A B"}]}]}`,
		`{"stands":[{"sections":[{"key":"A","rows":[{"label":"1","seats":1000}]}]}]}`,
		`{"pitch":{"w":20,"h":190},"stands":[]}`,
		`{"pitch":{"w":300,"h":9000},"stands":[]}`,
	}
	for _, b := range bad {
		if _, err := Parse([]byte(b)); err == nil {
			t.Errorf("expected error: %s", b)
		}
	}
}

func TestDiff(t *testing.T) {
	a, _ := Parse([]byte(sample))
	b, _ := Parse([]byte(strings.Replace(sample, `"removed":[1,12,40]`, `"removed":[1,2,12]`, 1)))
	b.Stands[0].Sections[1].Gate = "V"
	d := Diff(a, b)
	if len(d) != 2 || d[0].Key != "D1" || d[0].Seats != -1 || d[1].Note != "kirish" {
		t.Fatalf("%+v", d)
	}
}

func TestQR(t *testing.T) {
	sec := NewSecret()
	now := time.Unix(1_800_000_000, 0)
	code := Code(sec, "UMFL-0619-VIP-00014", true, now)
	p, ok := ParseCode(code)
	if !ok || p.Number != "UMFL-0619-VIP-00014" {
		t.Fatal("parse")
	}
	if Verify(sec, p, true, now.Add(45*time.Second)) != Valid {
		t.Fatal("skew")
	}
	if Verify(sec, p, true, now.Add(5*time.Minute)) != Stale {
		t.Fatal("stale")
	}
	if Verify(NewSecret(), p, true, now) != BadSignature {
		t.Fatal("forged")
	}
	st := Code(sec, "N1", false, now)
	ps, _ := ParseCode(st)
	if Verify(sec, ps, false, now.Add(48*time.Hour)) != Valid || Verify(sec, ps, true, now) != Static {
		t.Fatal("static")
	}
	if q, ok := ParseCode(" umfl-1 "); !ok || q.Window != -1 || q.Number != "UMFL-1" {
		t.Fatal("manual number")
	}
}

func TestSeatZones(t *testing.T) {
	doc := `{"zones":[{"key":"oddiy","name":"Oddiy"},{"key":"mk","name":"Markaziy"},{"key":"vip","name":"VIP","kind":"vip"}],
	 "stands":[{"key":"s","sections":[
	   {"key":"D1","zone":"oddiy","seat_mode":"free","rows":[
	     {"label":"1","seats":10,"blocked":[5],"zone_seats":{"mk":[4,5,6,7,99],"oddiy":[1],"nope":[2]}},
	     {"label":"2","seats":10,"removed":[5],"zone_seats":{"mk":[5,6],"vip":[6]}}]}]}]}`
	l, err := Parse([]byte(doc))
	if err != nil {
		t.Fatal(err)
	}
	sec := l.Section("D1")
	if sec.SeatMode != "numbered" {
		t.Fatal("price categories must switch the section to numbered seats")
	}
	r1, r2 := sec.Rows[0], sec.Rows[1]
	if fmt.Sprint(r1.ZoneSeats) != "map[mk:[4 5 6 7]]" {
		t.Fatalf("row 1 zones cleaned wrong: %v", r1.ZoneSeats)
	}
	// removed seat 5 dropped, seat 6 claimed by mk first (sorted keys), vip gets nothing
	if fmt.Sprint(r2.ZoneSeats) != "map[mk:[6]]" {
		t.Fatalf("row 2 zones cleaned wrong: %v", r2.ZoneSeats)
	}
	st := l.Stats()
	// row1: 10 seats, 1 blocked (5, in mk) → mk 3, oddiy 6; row2: 9 seats → mk 1, oddiy 8
	if st.ByZone["mk"] != 4 || st.ByZone["oddiy"] != 14 {
		t.Fatalf("by zone: %v", st.ByZone)
	}
	mk := l.SellableSeats("mk")
	if len(mk) != 4 || mk[0].ID != "D1:1:6" {
		t.Fatalf("mk seats: %v", mk)
	}
	for _, s := range l.SellableSeats("oddiy") {
		if l.SeatZone(s.ID) != "oddiy" {
			t.Fatal("oddiy list has a category seat", s.ID)
		}
	}
	if l.SeatZone("D1:1:4") != "mk" || l.SeatZone("D1:1:1") != "oddiy" || l.SeatZone("D1:2:5") != "" {
		t.Fatal("SeatZone")
	}
	if got := l.ZoneSections("mk"); len(got) != 1 || l.ZoneMode("mk") != "numbered" || len(l.ZoneSections("vip")) != 0 {
		t.Fatal("zone sections", got)
	}
	old, _ := Parse([]byte(doc))
	old.Section("D1").Rows[0].ZoneSeats = nil
	if d := Diff(old, l); len(d) != 1 || !strings.Contains(d[0].Note, "narx toifalari") {
		t.Fatalf("diff: %+v", d)
	}
}
