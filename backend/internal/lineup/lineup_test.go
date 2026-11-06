package lineup

import (
	"strings"
	"testing"
)

func roles(f Formation) string {
	var r []string
	for _, s := range f.Slots {
		r = append(r, s.Role)
	}
	return strings.Join(r, ",")
}

func TestParse(t *testing.T) {
	cases := map[string]string{
		"4-3-3":   "GK,LB,CB,CB,RB,CM,CM,CM,LW,ST,RW",
		"4-2-3-1": "GK,LB,CB,CB,RB,DM,DM,LW,AM,RW,ST",
		"3-5-2":   "GK,CB,CB,CB,LM,CM,CM,CM,RM,ST,ST",
		"3-3-1":   "GK,CB,CB,CB,CM,CM,CM,ST",
	}
	for code, want := range cases {
		f, err := Parse(code)
		if err != nil {
			t.Fatalf("%s: %v", code, err)
		}
		if got := roles(f); got != want {
			t.Errorf("%s: roles %s, want %s", code, got, want)
		}
	}
	for _, bad := range []string{"", "4", "4-x-3", "7-7", "1-1-1", "4-3-3-1-1-1"} {
		if _, err := Parse(bad); err == nil {
			t.Errorf("%q: expected error", bad)
		}
	}
	for _, f := range CatalogFormations() {
		if len(f.Slots) != f.Size {
			t.Errorf("%s: %d slots for size %d", f.Code, len(f.Slots), f.Size)
		}
	}
}

func ip(v int) *int      { return &v }
func i64(v int64) *int64 { return &v }

func xi() []Player {
	f, _ := Parse("4-3-3")
	var ps []Player
	for i, s := range f.Slots {
		ps = append(ps, Player{PlayerID: i64(int64(i + 1)), Name: "P " + s.Role, Number: ip(i + 1), Role: s.Role, Slot: ip(i), Starter: true, Captain: i == 4})
	}
	ps = append(ps, Player{PlayerID: i64(50), Name: "Bench A", Number: ip(12)})
	return ps
}

func TestValidateOK(t *testing.T) {
	cs := Validate("4-3-3", xi(), Options{BenchMax: 9})
	if HasErrors(cs) {
		t.Fatalf("unexpected errors: %+v", cs)
	}
}

func TestValidateErrors(t *testing.T) {
	ps := xi()
	ps[10].Starter = false // only 10 on the pitch
	*ps[9].Number = 7      // duplicate with slot 7's number? slot index 6 has number 7
	ps[1].Role = "GK"      // two goalkeepers
	ps[4].Captain = false  // no captain → warning
	cs := Validate("4-3-3", ps, Options{BenchMax: 9})
	want := map[string]bool{"count": false, "number": false, "gk": false, "captain": false}
	for _, c := range cs {
		if _, ok := want[c.Code]; ok {
			want[c.Code] = true
		}
	}
	for k, seen := range want {
		if !seen {
			t.Errorf("expected check %q in %+v", k, cs)
		}
	}
	if !HasErrors(cs) {
		t.Fatal("expected errors")
	}
	if got := Validate("", nil, Options{}); len(got) != 1 || got[0].Code != "empty" {
		t.Errorf("empty lineup: %+v", got)
	}
}
