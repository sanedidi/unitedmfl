package tickets

import (
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
