package protocol

import (
	"os"
	"testing"
)

// The fixture is the bbox output of a real UFA/PFL protocol with every personal
// name replaced by a fictional token (coordinates untouched).
func loadFixture(t *testing.T) *Extracted {
	t.Helper()
	b, err := os.ReadFile("testdata/protocol_fictional.bbox.html")
	if err != nil {
		t.Fatal(err)
	}
	words, pages, err := ParseBBoxHTML(string(b))
	if err != nil {
		t.Fatal(err)
	}
	if pages != 2 {
		t.Fatalf("pages=%d", pages)
	}
	return Parse(words)
}

func TestParseHeaderAndScore(t *testing.T) {
	ex := loadFixture(t)
	if ex.Date != "15.09.2026" || ex.Time != "19:00" || ex.Stage != "1/8 FINAL" {
		t.Errorf("header: %q %q %q", ex.Date, ex.Time, ex.Stage)
	}
	if ex.Home.Name != "Sherlar" || ex.Away.Name != "Burgutlar" {
		t.Errorf("teams: %q vs %q", ex.Home.Name, ex.Away.Name)
	}
	chk := func(name string, p *int, want int) {
		if p == nil || *p != want {
			t.Errorf("%s = %v, want %d", name, p, want)
		}
	}
	chk("home total", ex.Home.Total, 2)
	chk("away total", ex.Away.Total, 2)
	chk("home h1", ex.Home.Half1, 1)
	chk("away h2", ex.Away.Half2, 2)
	chk("home pen", ex.Home.Penalty, 5)
	chk("away pen", ex.Away.Penalty, 4)
	chk("attendance", ex.Attendance, 5747)
	chk("added 2h", ex.AddedTime2, 13)
}

func TestParseLineupsAndEvents(t *testing.T) {
	ex := loadFixture(t)
	if len(ex.Players) != 40 {
		t.Fatalf("players=%d", len(ex.Players))
	}
	counts := map[string]int{}
	for _, e := range ex.Events {
		counts[e.Type]++
	}
	if counts["goal"] != 4 || counts["yellow"] != 7 || counts["sub"] != 7 {
		t.Errorf("event counts %v", counts)
	}
	// "90+" and "13" are on separate text lines in the PDF and must be joined.
	found := false
	for _, e := range ex.Events {
		if e.Minute == 90 && e.Extra == 13 && e.Type == "yellow" {
			found = true
		}
	}
	if !found {
		t.Error("90+13 yellow card not reconstructed")
	}
	if len(ex.Officials) != 8 || len(ex.TeamOfficials) != 14 {
		t.Errorf("officials %d / team officials %d", len(ex.Officials), len(ex.TeamOfficials))
	}
}

func TestValidateFlagsSuspiciousCells(t *testing.T) {
	issues := Validate(loadFixture(t))
	codes := map[string]int{}
	for _, i := range issues {
		codes[i.Code]++
	}
	if codes["bad_minute"] != 1 || codes["sub_ambiguous"] != 4 || codes["shootout_marks"] != 1 {
		t.Errorf("issues %v", codes)
	}
	if Blocking(issues) {
		t.Error("warnings must not block applying")
	}
}

func TestParseMinute(t *testing.T) {
	for in, want := range map[string][3]int{"67": {67, 0, 1}, "90+13": {90, 13, 1}, "0": {0, 0, 0}, "140": {140, 0, 0}} {
		m, e, ok := ParseMinute(in)
		if m != want[0] || e != want[1] || ok != (want[2] == 1) {
			t.Errorf("%s → %d %d %v", in, m, e, ok)
		}
	}
}
