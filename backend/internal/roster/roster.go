// Package roster holds the team roster model used by self-registration and the
// conversion to and from the league's TARKIB.xlsx template (players, a coach
// section and a «media shaxslar» section).
package roster

import (
	"fmt"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode"

	"github.com/sanedidi/unitedmfl/backend/internal/xlsx"
)

// Player roles.
const (
	RolePlayer     = "player"
	RoleGoalkeeper = "goalkeeper"
	RoleMedia      = "media"
)

// StaffRoles mirror team_staff.role.
var StaffRoles = []string{"head_coach", "assistant", "gk_coach", "fitness", "doctor", "manager", "other"}

// KitSizes allowed for the kit order.
var KitSizes = []string{"XS", "S", "M", "L", "XL", "2XL", "3XL", "4XL", "5XL"}

// File is a private upload (medical certificate).
type File struct {
	File string `json:"file"`
	Name string `json:"name"`
}

// Player is one person in the kit: a field player, a goalkeeper or a media person.
type Player struct {
	FirstName  string `json:"first_name"`
	LastName   string `json:"last_name"`
	JerseyName string `json:"jersey_name"`
	BirthDate  string `json:"birth_date"` // YYYY-MM-DD
	Number     *int   `json:"number"`
	KitSize    string `json:"kit_size"`
	Workplace  string `json:"workplace"`
	Role       string `json:"role"`
	PhotoURL   string `json:"photo_url"`
	Medical    *File  `json:"medical"`
}

// Staff is a coach or another staff member.
type Staff struct {
	FirstName string `json:"first_name"`
	LastName  string `json:"last_name"`
	BirthDate string `json:"birth_date"`
	KitSize   string `json:"kit_size"`
	Role      string `json:"role"`
	Phone     string `json:"phone"`
}

// FullName is «First Last».
func (p Player) FullName() string { return strings.TrimSpace(p.FirstName + " " + p.LastName) }

// FullName is «First Last».
func (s Staff) FullName() string { return strings.TrimSpace(s.FirstName + " " + s.LastName) }

// NormalizeSize maps «2Xl», «xxl», «XXXL» to the canonical size; "" if unknown.
func NormalizeSize(s string) string {
	s = strings.ToUpper(strings.ReplaceAll(strings.TrimSpace(s), " ", ""))
	switch s {
	case "XXL":
		s = "2XL"
	case "XXXL":
		s = "3XL"
	case "XXXXL":
		s = "4XL"
	}
	for _, k := range KitSizes {
		if s == k {
			return k
		}
	}
	return ""
}

var reNumber = regexp.MustCompile(`(?i)^(?:no|№|n|#)?\s*[-.:]?\s*(\d{1,3})$`)

// ParseNumber reads «12», «No-12», «№ 7».
func ParseNumber(s string) (int, bool) {
	m := reNumber.FindStringSubmatch(strings.TrimSpace(s))
	if m == nil {
		return 0, false
	}
	n, err := strconv.Atoi(m[1])
	if err != nil || n < 0 || n > 999 {
		return 0, false
	}
	return n, true
}

var dateLayouts = []string{"02.01.2006", "2.1.2006", "02/01/2006", "2/1/2006", "2006-01-02", "02-01-2006", "02.01.06"}

// ParseDate reads «20.07.2001», «2001-07-20» or an Excel serial number and
// returns YYYY-MM-DD.
func ParseDate(s string) (string, bool) {
	s = strings.TrimSpace(s)
	if s == "" {
		return "", false
	}
	if f, err := strconv.ParseFloat(s, 64); err == nil {
		// Excel serial date (days since 1899-12-30); 10958 is 1930-01-01
		if f >= 10958 && f < 80000 {
			d := time.Date(1899, 12, 30, 0, 0, 0, 0, time.UTC).AddDate(0, 0, int(f))
			if d.Year() <= time.Now().Year() {
				return d.Format("2006-01-02"), true
			}
		}
		return "", false
	}
	if i := strings.IndexAny(s, " T"); i > 0 && strings.Count(s, ":") > 0 {
		s = s[:i]
	}
	for _, l := range dateLayouts {
		if t, err := time.Parse(l, s); err == nil {
			if t.Year() < 1930 || t.Year() > time.Now().Year() {
				return "", false
			}
			return t.Format("2006-01-02"), true
		}
	}
	return "", false
}

// Age in full years on the given day.
func Age(birth string, on time.Time) (int, bool) {
	t, err := time.Parse("2006-01-02", birth)
	if err != nil {
		return 0, false
	}
	age := on.Year() - t.Year()
	if on.YearDay() < t.YearDay() {
		age--
	}
	return age, true
}

var reSurname = regexp.MustCompile(`(?i)(ov|ev|yev|iyev|ova|eva|yeva|iyeva|in|ina|skiy|skaya|enko|dze|shvili|yan)$`)

// LooksSurname reports whether a word looks like an Uzbek/Russian surname.
func LooksSurname(s string) bool { return reSurname.MatchString(strings.TrimSpace(s)) }

// LooksSwapped: «Tillavoldiyev Shoxrux» in the first/last name columns.
func LooksSwapped(first, last string) bool { return LooksSurname(first) && !LooksSurname(last) }

var apostrophes = strings.NewReplacer("ʻ", "", "’", "", "‘", "", "'", "", "`", "", "ʼ", "")
var translit = strings.NewReplacer("kh", "h", "x", "h", "ye", "e", "yo", "o", "dj", "j", "ts", "s", "q", "k", "yu", "u", "ya", "a", "iy", "i")

// NameKey makes «Xamidov Nodir» and «Nodir Khamidov» compare equal.
func NameKey(parts ...string) string {
	s := strings.ToLower(strings.Join(parts, " "))
	s = apostrophes.Replace(s)
	s = translit.Replace(s)
	var words []string
	for _, w := range strings.FieldsFunc(s, func(r rune) bool { return !unicode.IsLetter(r) }) {
		if w != "" {
			words = append(words, w)
		}
	}
	sort.Strings(words)
	return strings.Join(words, " ")
}

// JerseyName: printed in capitals, trimmed.
func JerseyName(s string) string { return strings.ToUpper(strings.Join(strings.Fields(s), " ")) }

// ---------- TARKIB.xlsx import ----------

// Import is the result of reading a roster workbook.
type Import struct {
	Players []Player `json:"players"`
	Staff   []Staff  `json:"staff"`
	Fixes   []string `json:"fixes"`  // what was normalised automatically
	Issues  []string `json:"issues"` // what the representative should check
	Rows    int      `json:"rows"`
}

type colMap struct {
	idx, first, last, jersey, birth, size, medical, work, number, role int
	unnamed                                                            []int
	width                                                              int // header length: cells past it are unnamed too
}

func newColMap() colMap {
	return colMap{-1, -1, -1, -1, -1, -1, -1, -1, -1, -1, nil, 0}
}

func norm(s string) string {
	s = strings.ToUpper(apostrophes.Replace(strings.TrimSpace(s)))
	return strings.Join(strings.Fields(s), " ")
}

func headerMap(row []string) (colMap, bool) {
	m := newColMap()
	m.width = len(row)
	found := false
	for i, c := range row {
		h := norm(c)
		switch {
		case h == "":
			m.unnamed = append(m.unnamed, i)
		case h == "№" || h == "NO" || h == "N" || h == "#" || h == "T/R":
			m.idx = i
		case h == "ISM" || h == "ISMI":
			m.first, found = i, true
		case h == "FAMILIYA" || h == "FAMILIYASI":
			m.last = i
		case strings.Contains(h, "FUTBOLKA"):
			m.jersey = i
		case strings.Contains(h, "TUG") || strings.Contains(h, "SANA"):
			m.birth = i
		case strings.Contains(h, "OLCHAM") || strings.Contains(h, "RAZMER") || h == "SIZE":
			m.size = i
		case strings.Contains(h, "TIBBIY"):
			m.medical = i
		case strings.Contains(h, "ISH JOY"):
			m.work = i
		case h == "RAQAM" || h == "RAQAMI" || h == "NOMER" || h == "NUMBER":
			m.number = i
		case h == "ROL" || h == "ROLI" || h == "AMPLUA" || h == "POZITSIYA":
			m.role = i
		default:
			m.unnamed = append(m.unnamed, i)
		}
	}
	return m, found
}

func cell(row []string, i int) string {
	if i < 0 || i >= len(row) {
		return ""
	}
	return strings.TrimSpace(row[i])
}

func roleWord(s string) string {
	switch norm(s) {
	case "GK", "DARVOZABON", "GOALKEEPER", "VRATAR":
		return RoleGoalkeeper
	case "MEDIA", "MEDIA SHAXS", "BLOGER":
		return RoleMedia
	case "COACH", "TRENER", "MURABBIY", "BOSH MURABBIY":
		return "coach"
	}
	return ""
}

// ParseTarkib reads the rows of a TARKIB.xlsx sheet.
func ParseTarkib(rows [][]string) Import {
	out := Import{Players: []Player{}, Staff: []Staff{}, Fixes: []string{}, Issues: []string{}}
	section := "players"
	var cm colMap
	have := false
	fixSeen := map[string]bool{}
	fixOnce := func(key, s string) {
		if !fixSeen[key] {
			fixSeen[key] = true
			out.Fixes = append(out.Fixes, s)
		}
	}
	fix := func(s string) { fixOnce(s, s) }
	for ri, row := range rows {
		nonEmpty := 0
		for _, c := range row {
			if strings.TrimSpace(c) != "" {
				nonEmpty++
			}
		}
		if nonEmpty == 0 {
			continue
		}
		if m, ok := headerMap(row); ok {
			cm, have = m, true
			continue
		}
		if nonEmpty <= 2 {
			t := ""
			for _, c := range row {
				t += " " + norm(c)
			}
			switch {
			case strings.Contains(t, "MURABBIY") || strings.Contains(t, "TRENER") || strings.Contains(t, "COACH"):
				section = "staff"
				continue
			case strings.Contains(t, "MEDIA"):
				section = "media"
				continue
			case strings.Contains(t, "OYINCHI") || strings.Contains(t, "FUTBOLCHI"):
				section = "players"
				continue
			}
		}
		if !have {
			continue
		}
		first, last := cell(row, cm.first), cell(row, cm.last)
		if first == "" && last == "" {
			continue
		}
		out.Rows++
		line := fmt.Sprintf("%d-qator", ri+1)
		// unnamed columns: «No-12» → number, «GK / Media / Coach» → role
		numText, roleText := cell(row, cm.number), cell(row, cm.role)
		extra := append([]int(nil), cm.unnamed...)
		for i := cm.width; i < len(row); i++ {
			extra = append(extra, i)
		}
		for _, i := range extra {
			v := cell(row, i)
			if v == "" {
				continue
			}
			if _, ok := ParseNumber(v); ok && numText == "" && i != cm.idx {
				numText = v
			} else if roleWord(v) != "" && roleText == "" {
				roleText = v
			}
		}
		role := roleWord(roleText)
		birth := ""
		if raw := cell(row, cm.birth); raw != "" {
			if d, ok := ParseDate(raw); ok {
				birth = d
			} else {
				out.Issues = append(out.Issues, fmt.Sprintf("%s: tug‘ilgan sana tushunarsiz — «%s»", line, raw))
			}
		}
		size := ""
		if raw := cell(row, cm.size); raw != "" {
			size = NormalizeSize(raw)
			if size == "" {
				out.Issues = append(out.Issues, fmt.Sprintf("%s: forma o‘lchami noma’lum — «%s»", line, raw))
			} else if size != raw {
				fix(fmt.Sprintf("«%s» → %s", raw, size))
			}
		}
		if section == "staff" || role == "coach" {
			st := Staff{FirstName: first, LastName: last, BirthDate: birth, KitSize: size, Role: "head_coach"}
			if len(out.Staff) > 0 {
				st.Role = "assistant"
			}
			out.Staff = append(out.Staff, st)
			continue
		}
		p := Player{FirstName: first, LastName: last, BirthDate: birth, KitSize: size, Role: RolePlayer}
		if section == "media" || role == RoleMedia {
			p.Role = RoleMedia
		} else if role == RoleGoalkeeper {
			p.Role = RoleGoalkeeper
		}
		if numText != "" {
			if n, ok := ParseNumber(numText); ok {
				p.Number = &n
				if strconv.Itoa(n) != numText {
					fixOnce("number", fmt.Sprintf("raqamlar: «%s» → %d", numText, n))
				}
			} else {
				out.Issues = append(out.Issues, fmt.Sprintf("%s: raqam tushunarsiz — «%s»", line, numText))
			}
		}
		if j := cell(row, cm.jersey); j != "" {
			p.JerseyName = JerseyName(j)
			if p.JerseyName != j {
				fix("futbolkadagi yozuv bosma harflarga o‘tkazildi")
			}
		}
		if w := cell(row, cm.work); w != "" {
			if strings.Trim(w, "-–— ") == "" {
				fix("ish joyida «-» → bo‘sh")
			} else {
				p.Workplace = w
			}
		}
		if LooksSwapped(first, last) {
			out.Issues = append(out.Issues, fmt.Sprintf("%s: «%s %s» — ism va familiya almashgan bo‘lishi mumkin", line, first, last))
		}
		out.Players = append(out.Players, p)
	}
	for _, d := range DuplicateNumbers(out.Players) {
		out.Issues = append(out.Issues, d)
	}
	return out
}

// DuplicateNumbers lists numbers used by more than one person.
func DuplicateNumbers(ps []Player) []string {
	by := map[int][]string{}
	var order []int
	for _, p := range ps {
		if p.Number == nil {
			continue
		}
		if _, ok := by[*p.Number]; !ok {
			order = append(order, *p.Number)
		}
		by[*p.Number] = append(by[*p.Number], p.FullName())
	}
	var out []string
	for _, n := range order {
		if len(by[n]) > 1 {
			out = append(out, fmt.Sprintf("%d-raqam bir nechta o‘yinchida: %s", n, strings.Join(by[n], ", ")))
		}
	}
	return out
}

// ---------- TARKIB.xlsx export ----------

var playerHead = []string{"№", "ISM", "FAMILIYA", "FUTBOLKADA YOZILISHI", "TUG'ILGAN SANASI", "FORMA O'LCHAMI", "TIBBIY RUXSATNOMA", "ISH JOYI", "RAQAM", "ROLI"}

func displayDate(d string) string {
	if t, err := time.Parse("2006-01-02", d); err == nil {
		return t.Format("02.01.2006")
	}
	return d
}

func bold(ss ...string) []xlsx.Cell {
	out := make([]xlsx.Cell, len(ss))
	for i, s := range ss {
		out[i] = xlsx.Cell{Text: s, Bold: true}
	}
	return out
}

// ExportTarkib renders the roster in the TARKIB.xlsx layout. medicalOK tells
// whether a player's medical certificate is on file.
func ExportTarkib(team string, players []Player, staff []Staff) xlsx.Sheet {
	sh := xlsx.Sheet{Name: "Tarkib", Widths: []float64{6, 16, 18, 22, 18, 16, 20, 26, 10, 10}}
	add := func(cells ...xlsx.Cell) { sh.Rows = append(sh.Rows, cells) }
	text := func(ss ...string) []xlsx.Cell {
		out := make([]xlsx.Cell, len(ss))
		for i, s := range ss {
			out[i] = xlsx.Cell{Text: s}
		}
		return out
	}
	if team != "" {
		add(xlsx.Cell{Text: team, Bold: true})
	} else {
		add()
	}
	n := 0
	row := func(p Player) []xlsx.Cell {
		n++
		num, role, med := "", "", ""
		if p.Number != nil {
			num = strconv.Itoa(*p.Number)
		}
		switch p.Role {
		case RoleGoalkeeper:
			role = "GK"
		case RoleMedia:
			role = "Media"
		}
		if p.Medical != nil && p.Medical.File != "" {
			med = "bor"
		}
		return text(strconv.Itoa(n), p.FirstName, p.LastName, p.JerseyName, displayDate(p.BirthDate), p.KitSize, med, p.Workplace, num, role)
	}
	sh.Rows = append(sh.Rows, []xlsx.Cell{{}, {Text: "O'yinchilar", Bold: true}})
	sh.Rows = append(sh.Rows, bold(playerHead...))
	var media []Player
	for _, p := range players {
		if p.Role == RoleMedia {
			media = append(media, p)
			continue
		}
		sh.Rows = append(sh.Rows, row(p))
	}
	add()
	sh.Rows = append(sh.Rows, bold("MURABBIY"))
	sh.Rows = append(sh.Rows, bold("№", "ISM", "FAMILIYA", "TUG'ILGAN SANASI", "FORMA O'LCHAMI", "", "", "", "", "ROLI"))
	for _, s := range staff {
		n++
		sh.Rows = append(sh.Rows, text(strconv.Itoa(n), s.FirstName, s.LastName, displayDate(s.BirthDate), s.KitSize, "", "", "", "", "Coach"))
	}
	add()
	sh.Rows = append(sh.Rows, bold("MEDIA SHAXSLAR"))
	sh.Rows = append(sh.Rows, bold(playerHead...))
	for _, p := range media {
		sh.Rows = append(sh.Rows, row(p))
	}
	return sh
}
