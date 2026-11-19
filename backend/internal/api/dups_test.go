package api

import (
	"testing"

	"github.com/sanedidi/unitedmfl/backend/internal/roster"
)

// Same name after transliteration, different birth dates: two people.
func TestDupsForBirthDate(t *testing.T) {
	idx := map[string][]dupMatch{
		roster.NameKey("Ismoil Bohodirov"): {{PlayerID: 44, FullName: "Ismoil Bohodirov", BirthDate: "2005-04-27"}},
	}
	cases := []struct {
		birth string
		want  int
	}{
		{"27.04.2006", 0}, // different person
		{"2006-04-27", 0},
		{"27.04.2005", 1}, // same person, other spelling
		{"", 1},           // unknown — still worth a warning
	}
	for _, c := range cases {
		p := roster.Player{FirstName: "Ismoil", LastName: "Boxodirov", BirthDate: c.birth}
		if got := len(dupsFor(idx, p)); got != c.want {
			t.Errorf("birth %q: %d matches, want %d", c.birth, got, c.want)
		}
	}
	// a league player without a birth date still matches by name
	idx[roster.NameKey("Ismoil Bohodirov")][0].BirthDate = ""
	if got := len(dupsFor(idx, roster.Player{FirstName: "Ismoil", LastName: "Boxodirov", BirthDate: "27.04.2006"})); got != 1 {
		t.Errorf("unknown league birth date: %d matches, want 1", got)
	}
}
