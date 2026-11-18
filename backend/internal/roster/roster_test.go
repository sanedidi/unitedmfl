package roster

import (
	"bytes"
	"strings"
	"testing"
	"time"

	"github.com/sanedidi/unitedmfl/backend/internal/jersey"
	"github.com/sanedidi/unitedmfl/backend/internal/xlsx"
)

// The layout of the league's TARKIB.xlsx: a title, a header row, players with
// «No-N» numbers and GK/Media marks in unnamed columns, then the coach and the
// media section. Names here are made up.
var tarkib = [][]string{
	{},
	{"", "O'yinchilar"},
	{"№", "ISM", "FAMILIYA", "FUTBOLKADA YOZILISHI", "TUG'ULGAN SANASI", "FORMA O'LCHAMI", "TIBBIY RUHSATNOMA", "ISH JOYI"},
	{"1", "Akmal", "Toshev", "AKMAL", "20.07.2001", "S", "", "-", "No-1", "GK"},
	{"2", "Bobur", "Xamidov", "Khamidov B", "14.08.1999", "2Xl", "", "Atlas Parfum", "No-12", "GK"},
	{"3", "Rahimov", "Sardor", "SARDOR", "04.12.1992", "M", "", "Kelme distribyutor", "No-92"},
	{"4", "Doston", "Karimov", "DOSTON", "36892", "L", "", "Makler", "No-12"},
	{"5", "Eldor", "Yusupov", "Dior Production", "04.08.1989", "XXL", "", "ooo Stedi", "No-50", "Media"},
	{"MURABBIY"},
	{"№", "ISM", "FAMILIYA", "TUG'ULGAN SANASI", "FORMA O'LCHAMI"},
	{"6", "Farhod", "Safarov", "16.01.1991", "L", "", "", "", "", "Coach"},
	{},
	{"MEDIA SHAXSLAR"},
	{"№", "ISM", "FAMILIYA", "FUTBOLKADA YOZILISHI", "TUG'ULGAN SANASI", "FORMA O'LCHAMI"},
	{"7", "Gulom", "Nazarov", "gulom_cw", "17.09.2001", "S", "", "", "No-8", "Media"},
}

func TestParseTarkib(t *testing.T) {
	imp := ParseTarkib(tarkib)
	if len(imp.Players) != 6 || len(imp.Staff) != 1 || imp.Rows != 7 {
		t.Fatalf("counts: players %d staff %d rows %d", len(imp.Players), len(imp.Staff), imp.Rows)
	}
	p := imp.Players[0]
	if p.FirstName != "Akmal" || p.Role != RoleGoalkeeper || p.Number != "1" || p.BirthDate != "2001-07-20" || p.KitSize != "S" || p.Workplace != "" {
		t.Fatalf("first player: %+v", p)
	}
	if b := imp.Players[1]; b.KitSize != "2XL" || b.JerseyName != "KHAMIDOV B" || b.Workplace != "Atlas Parfum" {
		t.Fatalf("second player: %+v", b)
	}
	if d := imp.Players[3]; d.BirthDate != "2001-01-01" {
		t.Fatalf("excel serial date: %q", d.BirthDate)
	}
	if e := imp.Players[4]; e.Role != RoleMedia || e.KitSize != "2XL" {
		t.Fatalf("media mark in the players section: %+v", e)
	}
	if g := imp.Players[5]; g.Role != RoleMedia || g.JerseyName != "GULOM_CW" || g.Number != "8" {
		t.Fatalf("media section: %+v", g)
	}
	if s := imp.Staff[0]; s.FirstName != "Farhod" || s.BirthDate != "1991-01-16" || s.KitSize != "L" || s.Role != "head_coach" {
		t.Fatalf("coach: %+v", s)
	}
	issues := strings.Join(imp.Issues, "\n")
	if !strings.Contains(issues, "12-raqam") || !strings.Contains(issues, "«Rahimov Sardor»") {
		t.Fatalf("issues: %v", imp.Issues)
	}
	if fixes := strings.Join(imp.Fixes, "\n"); !strings.Contains(fixes, "«2Xl» → 2XL") || !strings.Contains(fixes, "raqamlar") {
		t.Fatalf("fixes: %v", imp.Fixes)
	}
}

func TestExportRoundTrip(t *testing.T) {
	imp := ParseTarkib(tarkib)
	b, err := xlsx.Write(ExportTarkib("Test FC", imp.Players, imp.Staff))
	if err != nil {
		t.Fatal(err)
	}
	wb, err := xlsx.Read(bytes.NewReader(b), int64(len(b)))
	if err != nil {
		t.Fatal(err)
	}
	back := ParseTarkib(wb.Rows)
	if len(back.Players) != len(imp.Players) || len(back.Staff) != 1 {
		t.Fatalf("round trip: %d players %d staff", len(back.Players), len(back.Staff))
	}
	for i := range imp.Players {
		a, b := imp.Players[i], back.Players[i]
		if a.FullName() != b.FullName() || a.Role != b.Role || a.BirthDate != b.BirthDate || a.KitSize != b.KitSize || a.Number != b.Number || a.JerseyName != b.JerseyName {
			t.Fatalf("player %d: %+v vs %+v", i, a, b)
		}
	}
	if len(back.Fixes) != 0 {
		t.Fatalf("an exported file needs no fixes: %v", back.Fixes)
	}
}

func TestHelpers(t *testing.T) {
	for in, want := range map[string]string{"2Xl": "2XL", "xxl": "2XL", " m ": "M", "XXXL": "3XL", "huge": ""} {
		if got := NormalizeSize(in); got != want {
			t.Errorf("NormalizeSize(%q) = %q", in, got)
		}
	}
	for in, want := range map[string]string{"20.07.2001": "2001-07-20", "2001-07-20": "2001-07-20", "4.8.1989": "1989-08-04", "1899": "", "31.02.2001": "", "abc": ""} {
		if got, _ := ParseDate(in); got != want {
			t.Errorf("ParseDate(%q) = %q", in, got)
		}
	}
	for in, want := range map[string]jersey.Number{"No-12": "12", "12": "12", "№ 7": "7", "no.9": "9", "z 10": "Z10", "Z10": "Z10", "7a": "7A"} {
		if got, ok := ParseNumber(in); !ok || got != want {
			t.Errorf("ParseNumber(%q) = %q %v", in, got, ok)
		}
	}
	for _, in := range []string{"", "-", "12345", "1/2"} {
		if got, ok := ParseNumber(in); ok {
			t.Errorf("ParseNumber(%q) = %q, must fail", in, got)
		}
	}
	// unnamed columns: a role or a kit size is never taken for a number
	for in, want := range map[string]bool{"No-12": true, "Z10": true, "GK": false, "2XL": false, "Media": false, "S": false} {
		if looseNumber(in) != want {
			t.Errorf("looseNumber(%q) != %v", in, want)
		}
	}
	if NameKey("Nodir", "Xamidov") != NameKey("Khamidov", "Nodir") {
		t.Error("NameKey should ignore order and x/kh spelling")
	}
	if !LooksSwapped("Tillavoldiyev", "Shoxrux") || LooksSwapped("Shoxrux", "Tillavoldiyev") {
		t.Error("LooksSwapped")
	}
	if age, _ := Age("2001-07-20", time.Date(2026, 7, 19, 0, 0, 0, 0, time.UTC)); age != 24 {
		t.Errorf("Age = %d", age)
	}
}
