// Package lineup knows football formations (pitch slots and roles) and
// validates a team's matchday lineup before it is published on the site.
package lineup

import (
	"fmt"
	"strconv"
	"strings"
)

// Slot is one position in a formation. Line 0 is the goalkeeper; lines grow
// towards the opponent's goal. Index runs left→right from the team's own view
// (attacking up), Count is the number of slots in that line.
type Slot struct {
	Role  string `json:"role"`
	Line  int    `json:"line"`
	Index int    `json:"index"`
	Count int    `json:"count"`
}

// Formation is a parsed formation code such as "4-3-3".
type Formation struct {
	Code  string `json:"code"`
	Size  int    `json:"size"` // players on the pitch, goalkeeper included
	Slots []Slot `json:"slots"`
}

// Catalog lists the formations offered in the admin, 11-a-side first, then
// the small-sided ones (8×8) used by some media-football formats. Any other
// valid code can still be typed in.
var Catalog = []string{
	"4-3-3", "4-4-2", "4-2-3-1", "4-1-4-1", "4-5-1", "3-5-2", "3-4-3", "5-3-2", "5-4-1",
	"3-3-1", "3-2-2", "2-3-2", "2-4-1", "3-1-3",
}

// CatalogFormations returns every catalog formation parsed.
func CatalogFormations() []Formation {
	out := make([]Formation, 0, len(Catalog))
	for _, c := range Catalog {
		f, _ := Parse(c)
		out = append(out, f)
	}
	return out
}

// Parse turns "4-2-3-1" into slots with roles.
func Parse(code string) (Formation, error) {
	code = strings.TrimSpace(code)
	parts := strings.Split(code, "-")
	if len(parts) < 2 || len(parts) > 5 {
		return Formation{}, fmt.Errorf("sxema 2–5 qatordan iborat bo‘lishi kerak, masalan 4-3-3")
	}
	lines := make([]int, len(parts))
	total := 0
	for i, p := range parts {
		n, err := strconv.Atoi(p)
		if err != nil || n < 1 || n > 6 {
			return Formation{}, fmt.Errorf("sxema noto‘g‘ri: %q", code)
		}
		lines[i] = n
		total += n
	}
	if total < 4 || total > 10 {
		return Formation{}, fmt.Errorf("maydonda 5 dan 11 gacha o‘yinchi bo‘lishi mumkin")
	}
	f := Formation{Code: code, Size: total + 1}
	f.Slots = append(f.Slots, Slot{Role: "GK", Line: 0, Index: 0, Count: 1})
	for li, n := range lines {
		roles := lineRoles(li, len(lines), n)
		for i := 0; i < n; i++ {
			f.Slots = append(f.Slots, Slot{Role: roles[i], Line: li + 1, Index: i, Count: n})
		}
	}
	return f, nil
}

func lineRoles(li, lines, n int) []string {
	switch {
	case li == 0: // defence
		switch n {
		case 1:
			return []string{"CB"}
		case 2:
			return []string{"CB", "CB"}
		case 3:
			return []string{"CB", "CB", "CB"}
		case 4:
			return []string{"LB", "CB", "CB", "RB"}
		case 5:
			return []string{"LWB", "CB", "CB", "CB", "RWB"}
		}
	case li == lines-1: // attack
		switch n {
		case 1:
			return []string{"ST"}
		case 2:
			return []string{"ST", "ST"}
		case 3:
			return []string{"LW", "ST", "RW"}
		case 4:
			return []string{"LW", "ST", "ST", "RW"}
		}
	default: // midfield: first of several is defensive, last of several is attacking
		mids := lines - 2
		pos := li - 1
		base := "CM"
		if mids > 1 && pos == 0 {
			base = "DM"
		} else if mids > 1 && pos == mids-1 {
			base = "AM"
		}
		switch n {
		case 1:
			return []string{base}
		case 2:
			return []string{base, base}
		case 3:
			if base == "AM" {
				return []string{"LW", "AM", "RW"}
			}
			return []string{base, base, base}
		case 4:
			return []string{"LM", base, base, "RM"}
		case 5:
			return []string{"LM", base, base, base, "RM"}
		}
	}
	out := make([]string, n)
	for i := range out {
		out[i] = "MF"
	}
	return out
}

// Player is one lineup row as stored in the database.
type Player struct {
	PlayerID  *int64 `json:"player_id"`
	Name      string `json:"player_name"`
	Number    *int   `json:"number"`
	Position  string `json:"position"` // squad position GK/DF/MF/FW
	Role      string `json:"role"`
	Slot      *int   `json:"slot"`
	Starter   bool   `json:"is_starter"`
	Captain   bool   `json:"is_captain"`
	Suspended bool   `json:"-"`
}

// Check is one validation result. Errors block publishing, warnings don't.
type Check struct {
	Level string `json:"level"` // error | warning
	Code  string `json:"code"`
	Text  string `json:"text"`
}

// Options tune validation for a league.
type Options struct {
	BenchMax int // 0 = no limit
}

// HasErrors reports whether any check is an error.
func HasErrors(cs []Check) bool {
	for _, c := range cs {
		if c.Level == "error" {
			return true
		}
	}
	return false
}

// Validate checks a lineup. An empty lineup returns a single error.
func Validate(formation string, players []Player, opt Options) []Check {
	cs := []Check{}
	add := func(level, code, text string) { cs = append(cs, Check{level, code, text}) }
	if len(players) == 0 {
		add("error", "empty", "Tarkib kiritilmagan")
		return cs
	}
	var starters, bench []Player
	for _, p := range players {
		if p.Starter {
			starters = append(starters, p)
		} else {
			bench = append(bench, p)
		}
	}
	size := 0
	if formation != "" {
		f, err := Parse(formation)
		if err != nil {
			add("error", "formation", err.Error())
		} else {
			size = f.Size
			used := map[int]bool{}
			for _, p := range starters {
				if p.Slot == nil {
					add("error", "unplaced", fmt.Sprintf("%s maydonga joylashtirilmagan", label(p)))
					continue
				}
				if *p.Slot < 0 || *p.Slot >= len(f.Slots) {
					add("error", "slot", fmt.Sprintf("%s: %s sxemasida bunday o‘rin yo‘q", label(p), formation))
					continue
				}
				if used[*p.Slot] {
					add("error", "slot_taken", fmt.Sprintf("%s o‘rni band (%s)", label(p), f.Slots[*p.Slot].Role))
				}
				used[*p.Slot] = true
			}
		}
	}
	if size > 0 && len(starters) != size {
		add("error", "count", fmt.Sprintf("Maydonda %d o‘yinchi — %d kerak", len(starters), size))
	} else if size == 0 && (len(starters) < 5 || len(starters) > 11) {
		add("error", "count", fmt.Sprintf("Asosiy tarkibda %d o‘yinchi", len(starters)))
	}
	gk := 0
	for _, p := range starters {
		if p.Role == "GK" || (p.Role == "" && p.Position == "GK") {
			gk++
		}
	}
	switch {
	case gk == 0:
		add("error", "gk", "Darvozabon belgilanmagan")
	case gk > 1:
		add("error", "gk", "Maydonda bittadan ortiq darvozabon")
	}
	nums := map[int][]string{}
	ids := map[int64]bool{}
	for _, p := range players {
		if p.Number != nil {
			nums[*p.Number] = append(nums[*p.Number], surname(p.Name))
		}
		if p.PlayerID != nil {
			if ids[*p.PlayerID] {
				add("error", "duplicate", fmt.Sprintf("%s ikki marta kiritilgan", label(p)))
			}
			ids[*p.PlayerID] = true
		}
		if p.Suspended {
			add("warning", "suspended", fmt.Sprintf("%s diskvalifikatsiyada bo‘lishi mumkin", label(p)))
		}
	}
	for n, who := range nums {
		if len(who) > 1 {
			add("error", "number", fmt.Sprintf("Raqam %d ikki marta: %s", n, strings.Join(who, " va ")))
		}
	}
	caps := 0
	for _, p := range starters {
		if p.Captain {
			caps++
		}
	}
	if caps == 0 {
		add("warning", "captain", "Kapitan belgilanmagan")
	} else if caps > 1 {
		add("error", "captain", "Kapitan faqat bitta bo‘ladi")
	}
	if opt.BenchMax > 0 && len(bench) > opt.BenchMax {
		add("error", "bench", fmt.Sprintf("Zaxirada %d ta — ko‘pi bilan %d", len(bench), opt.BenchMax))
	} else if len(bench) == 0 {
		add("warning", "bench", "Zaxira kiritilmagan")
	}
	if formation == "" {
		add("warning", "no_formation", "Sxema tanlanmagan — saytda ro‘yxat ko‘rinishida chiqadi")
	}
	return cs
}

func label(p Player) string {
	if p.Number != nil {
		return fmt.Sprintf("%d · %s", *p.Number, p.Name)
	}
	return p.Name
}

func surname(name string) string {
	f := strings.Fields(name)
	if len(f) == 0 {
		return name
	}
	return f[len(f)-1]
}
