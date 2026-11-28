package media

import (
	"testing"
	"time"
)

func TestParseLink(t *testing.T) {
	cases := []struct {
		in, team, link, kind, account string
		ok                            bool
	}{
		{"https://www.instagram.com/reel/DCx7Lq2abc/?igsh=xyz", "@primexi.uz", "https://www.instagram.com/reel/DCx7Lq2abc/", "reel", "unknown", true},
		{"tayyor: instagram.com/p/C9xK2abcd/", "primexi.uz", "https://www.instagram.com/p/C9xK2abcd/", "post", "unknown", true},
		{"https://instagram.com/primexi.uz/p/C9xK2abcd", "https://www.instagram.com/PrimeXI.uz/", "https://www.instagram.com/p/C9xK2abcd/", "post", "match", true},
		{"https://instagram.com/bydfans_uz/reel/C9xK2abcd", "@byd.uz", "https://www.instagram.com/reel/C9xK2abcd/", "reel", "mismatch", true},
		{"https://www.instagram.com/stories/lions.uz/3412345678901234567", "lions.uz", "https://www.instagram.com/stories/lions.uz/3412345678901234567/", "story", "match", true},
		{"https://m.instagram.com/reels/AbCdEf123/", "", "https://www.instagram.com/reel/AbCdEf123/", "reel", "unknown", true},
		{"https://t.me/unitedmfl/12", "", "", "", "", false},
		{"instagram.com/primexi.uz", "", "", "", "", false},
		{"salom", "", "", "", "", false},
	}
	for _, c := range cases {
		link, ch, ok := ParseLink(c.in, c.team)
		if ok != c.ok || link != c.link || ch.Kind != c.kind || ch.Account != c.account {
			t.Errorf("%q: got %q %+v %v; want %q %s %s %v", c.in, link, ch, ok, c.link, c.kind, c.account, c.ok)
		}
	}
}

func TestOffsetsAndRivals(t *testing.T) {
	offs := []int{-10, -9, -8}
	for pos, want := range []int{-10, -9, -8, -7, -6} {
		if got := OffsetFor(offs, pos); got != want {
			t.Errorf("pos %d: %d, want %d", pos, got, want)
		}
	}
	if got := OffsetFor([]int{0, 0, 0}, 4); got != 0 {
		t.Errorf("same day for every team: %d", got)
	}
	r := Rivals([]int64{11, 22, 33}, 1)
	if len(r) != 2 || r[0] != 11 || r[1] != 33 {
		t.Errorf("rivals of the 2nd team: %v", r)
	}
}

func TestStateAndDays(t *testing.T) {
	for _, c := range []struct{ status, due, want string }{
		{"done", "2026-11-01", "done"}, {"review", "2026-11-01", "review"},
		{"todo", "2026-11-27", "overdue"}, {"todo", "2026-11-28", "today"}, {"todo", "2026-11-29", "upcoming"},
		{"returned", "2026-11-29", "returned"}, {"returned", "2026-11-27", "overdue"},
	} {
		if got := State(c.status, c.due, "2026-11-28"); got != c.want {
			t.Errorf("%s %s: %s, want %s", c.status, c.due, got, c.want)
		}
	}
	if d := AddDays("2026-12-05", -10); d != "2026-11-25" {
		t.Errorf("AddDays: %s", d)
	}
	if n := DaysBetween("2026-12-05", "2026-12-07"); n != 2 {
		t.Errorf("DaysBetween: %d", n)
	}
	// 19:30 UTC is already 00:30 of the next day in Tashkent
	if d := Today(time.Date(2026, 11, 28, 19, 30, 0, 0, time.UTC)); d != "2026-11-29" {
		t.Errorf("Today in Tashkent: %s", d)
	}
	if HumanDay("2026-12-05") != "5-dekabr, shanba" {
		t.Errorf("HumanDay: %s", HumanDay("2026-12-05"))
	}
	if TeamHandle("https://www.instagram.com/PrimeXI.uz/?hl=ru") != "primexi.uz" || TeamHandle("@lions") != "lions" || TeamHandle("") != "" {
		t.Error("TeamHandle")
	}
}
