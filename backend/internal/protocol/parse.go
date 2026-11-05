package protocol

import (
	"math"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

// line is a group of words sharing a baseline.
type line struct {
	Y     float64
	Words []Word
}

func (l line) text() string {
	parts := make([]string, len(l.Words))
	for i, w := range l.Words {
		parts[i] = w.Text
	}
	return strings.Join(parts, " ")
}

func (l line) has(tokens ...string) bool {
	t := " " + norm(l.text()) + " "
	for _, tok := range tokens {
		if !strings.Contains(t, tok) {
			return false
		}
	}
	return true
}

func (l line) find(tok string) (Word, bool) {
	for _, w := range l.Words {
		if norm(w.Text) == tok {
			return w, true
		}
	}
	return Word{}, false
}

func (l line) findAll(tok string) []Word {
	var out []Word
	for _, w := range l.Words {
		if norm(w.Text) == tok {
			out = append(out, w)
		}
	}
	return out
}

var apostrophes = strings.NewReplacer("‘", "'", "’", "'", "ʻ", "'", "ʼ", "'", "`", "'", "´", "'", "‛", "'")

// norm upper-cases and unifies apostrophes so O‘ZBEKISTON == O'ZBEKISTON.
func norm(s string) string { return strings.ToUpper(apostrophes.Replace(strings.TrimSpace(s))) }

// cleanName produces "Title Case" names with a unified apostrophe.
func cleanName(s string) string {
	s = apostrophes.Replace(strings.Join(strings.Fields(s), " "))
	words := strings.Fields(strings.ToLower(s))
	for i, w := range words {
		parts := strings.Split(w, "-")
		for j, p := range parts {
			if p == "" {
				continue
			}
			r := []rune(p)
			r[0] = []rune(strings.ToUpper(string(r[0])))[0]
			// keep O' / G' style letters capitalised after apostrophe-free start
			parts[j] = string(r)
		}
		words[i] = strings.Join(parts, "-")
	}
	return strings.ReplaceAll(strings.Join(words, " "), "'", "‘")
}

func groupLines(words []Word, page int) []line {
	var ws []Word
	for _, w := range words {
		if w.Page == page {
			ws = append(ws, w)
		}
	}
	sort.Slice(ws, func(i, j int) bool { return ws[i].CY() < ws[j].CY() })
	var lines []line
	const tol = 3.2
	for _, w := range ws {
		if n := len(lines); n > 0 && math.Abs(w.CY()-lines[n-1].Y) <= tol {
			l := &lines[n-1]
			l.Words = append(l.Words, w)
			l.Y = (l.Y*float64(len(l.Words)-1) + w.CY()) / float64(len(l.Words))
			continue
		}
		lines = append(lines, line{Y: w.CY(), Words: []Word{w}})
	}
	for i := range lines {
		sort.Slice(lines[i].Words, func(a, b int) bool { return lines[i].Words[a].X0 < lines[i].Words[b].X0 })
	}
	return lines
}

var (
	reDate   = regexp.MustCompile(`\b(\d{2}\.\d{2}\.\d{4})\b`)
	reTime   = regexp.MustCompile(`\b(\d{1,2}:\d{2})\b`)
	reInt    = regexp.MustCompile(`^\d{1,6}$`)
	reValue  = regexp.MustCompile(`^(\d{1,3}\+?\d{0,2}|T)$`)
	reMinute = regexp.MustCompile(`^(\d{1,3})(?:\+(\d{1,2}))?$`)
)

// headerWords are table-header fragments that wrap onto value rows.
var headerWords = map[string]bool{"VAQTI": true, "HOLATI": true, "SONI": true, "№": true, "SHAHAR": true, "BOSQICHI": true}

var positions = map[string]bool{"DR": true, "HM": true, "YH": true, "HJ": true}

func atoiPtr(s string) *int {
	if n, err := strconv.Atoi(strings.TrimSpace(s)); err == nil {
		return &n
	}
	return nil
}

// Parse turns positioned words into an Extracted protocol.
func Parse(words []Word) *Extracted {
	ex := &Extracted{Players: []PlayerRow{}, Events: []Event{}, ShootoutMarks: []string{}, Officials: []Official{}, TeamOfficials: []Official{}}
	maxPage := 0
	for _, w := range words {
		if w.Page > maxPage {
			maxPage = w.Page
		}
	}
	var lineupPage, reportPage []line
	for p := 1; p <= maxPage; p++ {
		ls := groupLines(words, p)
		isReport, isLineup := false, false
		for _, l := range ls {
			if l.has("QAYDNOMASI") {
				isReport = true
			}
			if l.has("AMP") && l.has("I.F.") {
				isLineup = true
			}
		}
		if isReport && reportPage == nil {
			reportPage = ls
		} else if isLineup && lineupPage == nil {
			lineupPage = ls
		}
	}
	ex.HasLineupSheet = lineupPage != nil
	ex.HasReportSheet = reportPage != nil

	all := append(append([]line{}, lineupPage...), reportPage...)
	for _, l := range all {
		t := l.text()
		if ex.Date == "" {
			if m := reDate.FindStringSubmatch(t); m != nil {
				ex.Date = m[1]
			}
		}
		if ex.Time == "" {
			if m := reTime.FindStringSubmatch(t); m != nil {
				ex.Time = m[1]
			}
		}
	}
	ex.Tournament = findTournament(reportPage, lineupPage)
	parseHeaderValues(ex, reportPage, lineupPage)
	if reportPage != nil {
		parseScore(ex, reportPage)
	}
	if lineupPage != nil {
		parseLineupSheet(ex, lineupPage)
	}
	if reportPage != nil {
		rows := parseReportRows(reportPage)
		mergeReportRows(ex, rows)
		parseTeamOfficials(ex, reportPage)
		ex.Officials = parseMatchOfficials(reportPage)
	}
	if len(ex.Officials) == 0 && lineupPage != nil {
		ex.Officials = parseMatchOfficials(lineupPage)
	}
	deriveEvents(ex)
	return ex
}

func findTournament(report, lineup []line) string {
	for _, ls := range [][]line{report, lineup} {
		for _, l := range ls {
			t := norm(l.text())
			if strings.Contains(t, "KUBOGI") || strings.Contains(t, "CHEMPIONATI") || strings.Contains(t, "SUPERLIGA") || strings.Contains(t, "MFL") {
				// on the lineup sheet the tournament sits between team names: take the central words
				if strings.Contains(t, "KUBOGI") || strings.Contains(t, "CHEMPIONATI") {
					var parts []string
					for _, w := range l.Words {
						if w.X0 > 150 && w.X1 < 450 {
							parts = append(parts, w.Text)
						}
					}
					if len(parts) > 0 {
						return apostrophes.Replace(strings.Join(parts, " "))
					}
				}
				return apostrophes.Replace(l.text())
			}
		}
	}
	return ""
}

// valuesBelow returns words below a header word (within maxDY) whose centre lies in [xmin,xmax].
func valuesBelow(ls []line, headerY, maxDY, xmin, xmax float64) []Word {
	var out []Word
	for _, l := range ls {
		if l.Y <= headerY+2 || l.Y > headerY+maxDY {
			continue
		}
		for _, w := range l.Words {
			if w.CX() >= xmin && w.CX() <= xmax {
				out = append(out, w)
			}
		}
	}
	return out
}

func joinWords(ws []Word) string {
	sort.SliceStable(ws, func(i, j int) bool {
		if math.Abs(ws[i].CY()-ws[j].CY()) > 3 {
			return ws[i].CY() < ws[j].CY()
		}
		return ws[i].X0 < ws[j].X0
	})
	parts := make([]string, len(ws))
	for i, w := range ws {
		parts[i] = w.Text
	}
	return apostrophes.Replace(strings.Join(parts, " "))
}

func parseHeaderValues(ex *Extracted, report, lineup []line) {
	// Venue + attendance from the report header row.
	for _, l := range report {
		st, ok1 := l.find("STADION,")
		if !ok1 {
			continue
		}
		maxX := 470.0
		if mx, ok := findInLines(report, l.Y, 12, "MAYDON"); ok {
			maxX = mx.X0 - 8
		}
		minX := st.X0 - 90
		var venue []Word
		for _, w := range valuesBelow(report, l.Y, 40, minX, maxX) {
			if reDate.MatchString(w.Text) || reTime.MatchString(w.Text) || strings.HasSuffix(w.Text, "’") || strings.HasSuffix(w.Text, "'") || headerWords[norm(w.Text)] {
				continue
			}
			venue = append(venue, w)
		}
		if len(venue) > 0 {
			ex.Venue = joinWords(venue)
		}
		if mx, ok := findInLines(report, l.Y, 12, "MUXLISLAR"); ok {
			for _, w := range valuesBelow(report, l.Y, 40, mx.X0-30, mx.X1+60) {
				if reInt.MatchString(w.Text) {
					ex.Attendance = atoiPtr(w.Text)
				}
			}
		}
		break
	}
	// Stage (and venue fallback) from the lineup sheet.
	for _, l := range lineup {
		ms, ok := l.find("MUSOBAQA")
		if !ok {
			continue
		}
		var stage []Word
		for _, w := range valuesBelow(lineup, l.Y, 40, ms.X0-30, 600) {
			if !headerWords[norm(w.Text)] {
				stage = append(stage, w)
			}
		}
		if len(stage) > 0 {
			ex.Stage = joinWords(stage)
		}
		if ex.Venue == "" {
			if st, ok := l.find("STADION,"); ok {
				ex.Venue = joinWords(valuesBelow(lineup, l.Y, 40, st.X0-90, ms.X0-30))
			}
		}
		break
	}
}

func isAlpha(s string) bool {
	for _, r := range s {
		if r >= '0' && r <= '9' {
			return false
		}
	}
	return true
}

func findInLines(ls []line, y, dy float64, tok string) (Word, bool) {
	for _, l := range ls {
		if math.Abs(l.Y-y) <= dy {
			if w, ok := l.find(tok); ok {
				return w, true
			}
		}
	}
	return Word{}, false
}

func parseScore(ex *Extracted, ls []line) {
	type scoreLine struct {
		y           float64
		left, right Word
		labelX      float64
	}
	labels := map[string]*scoreLine{}
	for _, l := range ls {
		var key string
		switch {
		case l.has("1-BO'LIM", "NATIJASI"):
			key = "h1"
		case l.has("2-BO'LIM", "NATIJASI"):
			key = "h2"
		case l.has("QO'SHIMCHA", "NATIJASI"):
			key = "et"
		case l.has("PENALTILAR"):
			key = "pen"
		case l.has("DAQIQALAR"):
			var after string
			for _, w := range l.Words {
				n := norm(w.Text)
				if n == "1-BO'LIM" || n == "2-BO'LIM" {
					after = n
					continue
				}
				if reInt.MatchString(w.Text) && after != "" {
					if after == "1-BO'LIM" && ex.AddedTime1 == nil {
						ex.AddedTime1 = atoiPtr(w.Text)
					} else if after == "2-BO'LIM" && ex.AddedTime2 == nil {
						ex.AddedTime2 = atoiPtr(w.Text)
					}
				}
			}
			continue
		default:
			continue
		}
		var label Word
		for _, w := range l.Words {
			n := norm(w.Text)
			if strings.Contains(n, "BO'LIM") || n == "QO'SHIMCHA" || n == "PENALTILAR" {
				label = w
				break
			}
		}
		sl := &scoreLine{y: l.Y, labelX: label.X0}
		for _, w := range l.Words {
			if !reInt.MatchString(w.Text) {
				continue
			}
			if w.X1 <= label.X0 {
				sl.left = w // closest number on the left wins (last one)
			} else if sl.right.Text == "" && w.X0 > label.X1 {
				sl.right = w
			}
		}
		labels[key] = sl
	}
	set := func(key string, home, away **int) {
		if sl, ok := labels[key]; ok {
			*home = atoiPtr(sl.left.Text)
			*away = atoiPtr(sl.right.Text)
		}
	}
	set("h1", &ex.Home.Half1, &ex.Away.Half1)
	set("h2", &ex.Home.Half2, &ex.Away.Half2)
	set("et", &ex.Home.Extra, &ex.Away.Extra)
	set("pen", &ex.Home.Penalty, &ex.Away.Penalty)

	h1, ok := labels["h1"]
	if !ok {
		return
	}
	bottom := h1.y + 45
	if p, ok := labels["pen"]; ok {
		bottom = p.y + 4
	}
	var homeName, awayName []Word
	for _, l := range ls {
		if l.Y < h1.y-14 || l.Y > bottom {
			continue
		}
		for _, w := range l.Words {
			n := norm(w.Text)
			if strings.Contains(n, "BO'LIM") || strings.Contains(n, "NATIJASI") || n == "QO'SHIMCHA" || n == "PENALTILAR" || n == "SERIYASI" || n == "BO'LIMLAR" {
				continue
			}
			if reTime.MatchString(w.Text) || reDate.MatchString(w.Text) || strings.ContainsAny(w.Text, ":’'") && !isAlpha(w.Text) {
				continue
			}
			switch {
			case reInt.MatchString(w.Text) && w.X1 < h1.left.X0-4:
				ex.Home.Total = atoiPtr(w.Text)
			case reInt.MatchString(w.Text) && h1.right.Text != "" && w.X0 > h1.right.X1+4:
				ex.Away.Total = atoiPtr(w.Text)
			case !reInt.MatchString(w.Text) && w.X1 < h1.left.X0-4:
				homeName = append(homeName, w)
			case !reInt.MatchString(w.Text) && h1.right.Text != "" && w.X0 > h1.right.X1+4:
				awayName = append(awayName, w)
			}
		}
	}
	ex.Home.Name = cleanName(joinWords(homeName))
	ex.Away.Name = cleanName(joinWords(awayName))
}

func parseLineupSheet(ex *Extracted, ls []line) {
	var header line
	hi := -1
	for i, l := range ls {
		if l.has("AMP") && len(l.findAll("№")) >= 2 {
			header, hi = l, i
			break
		}
	}
	if hi < 0 {
		return
	}
	nos := header.findAll("№")
	split := nos[1].X0 - 8
	starter := true
	for _, l := range ls[hi+1:] {
		if l.has("JAMOA", "RASMIYLARI") {
			break
		}
		if l.has("ZAXIRA") {
			starter = false
			continue
		}
		var left, right []Word
		for _, w := range l.Words {
			if w.X0 < split {
				left = append(left, w)
			} else {
				right = append(right, w)
			}
		}
		for side, ws := range map[string][]Word{Home: left, Away: right} {
			if len(ws) < 3 || !reInt.MatchString(ws[0].Text) || !positions[norm(ws[1].Text)] {
				continue
			}
			num, _ := strconv.Atoi(ws[0].Text)
			row := PlayerRow{Side: side, Number: num, Position: norm(ws[1].Text), Starter: starter}
			var name []string
			for _, w := range ws[2:] {
				if norm(w.Text) == "(S)" {
					row.Captain = true
					continue
				}
				name = append(name, w.Text)
			}
			row.Name = cleanName(strings.Join(name, " "))
			ex.Players = append(ex.Players, row)
		}
	}
}

type reportRow struct {
	PlayerRow
	y float64
}

// parseReportRows reads the G/S/Q/A grid of the "O‘yin qaydnomasi" sheet using header column positions.
func parseReportRows(ls []line) []reportRow {
	hi := -1
	var header line
	for i, l := range ls {
		if len(l.findAll("№")) >= 2 && len(l.findAll("G")) >= 2 && len(l.findAll("A")) >= 2 {
			header, hi = l, i
			break
		}
	}
	if hi < 0 {
		return nil
	}
	nos := header.findAll("№")
	type sideCols struct {
		noX   float64
		cols  map[string]float64
		split float64
	}
	cols := func(idx int) map[string]float64 {
		m := map[string]float64{}
		for _, c := range []string{"G", "S", "Q", "A"} {
			ws := header.findAll(c)
			if len(ws) > idx {
				m[c] = ws[idx].CX()
			}
		}
		return m
	}
	sides := map[string]sideCols{
		Home: {noX: nos[0].CX(), cols: cols(0)},
		Away: {noX: nos[1].CX(), cols: cols(1)},
	}
	split := nos[1].X0 - 8

	var rows []reportRow
	type tok struct {
		w       Word
		side    string
		starter bool
	}
	var toks []tok
	starter := true
	for _, l := range ls[hi+1:] {
		if l.has("JAMOA", "RASMIYLARI") {
			break
		}
		if l.has("ZAXIRA") {
			starter = false
			continue
		}
		for _, w := range l.Words {
			side := Home
			if w.X0 >= split {
				side = Away
			}
			sc := sides[side]
			if reInt.MatchString(w.Text) && math.Abs(w.CX()-sc.noX) < 14 {
				n, _ := strconv.Atoi(w.Text)
				rows = append(rows, reportRow{PlayerRow: PlayerRow{Side: side, Number: n, Starter: starter}, y: w.CY()})
				continue
			}
			toks = append(toks, tok{w, side, starter})
		}
	}
	type cell struct {
		y    float64
		text string
	}
	vals := make([]map[string][]cell, len(rows))
	names := make([][]Word, len(rows))
	for i := range vals {
		vals[i] = map[string][]cell{}
	}
	for _, t := range toks {
		best, bestDY := -1, 17.0
		for i, r := range rows {
			if r.Side != t.side || r.Starter != t.starter {
				continue
			}
			if dy := math.Abs(r.y - t.w.CY()); dy < bestDY {
				best, bestDY = i, dy
			}
		}
		if best < 0 {
			continue
		}
		txt := norm(t.w.Text)
		if txt == "(S)" {
			rows[best].Captain = true
			continue
		}
		sc := sides[t.side]
		firstCol := math.MaxFloat64
		for _, x := range sc.cols {
			firstCol = math.Min(firstCol, x)
		}
		if reValue.MatchString(txt) && t.w.CX() > firstCol-14 {
			col, cd := "", math.MaxFloat64
			for c, x := range sc.cols {
				if d := math.Abs(t.w.CX() - x); d < cd {
					col, cd = c, d
				}
			}
			vals[best][col] = append(vals[best][col], cell{t.w.CY(), txt})
			continue
		}
		names[best] = append(names[best], t.w)
	}
	for i := range rows {
		rows[i].Name = cleanName(joinWords(names[i]))
		for c, cells := range vals[i] {
			sort.Slice(cells, func(a, b int) bool { return cells[a].y < cells[b].y })
			var sb strings.Builder
			for k, ce := range cells {
				if k > 0 && !strings.HasSuffix(sb.String(), "+") {
					sb.WriteString(",")
				}
				sb.WriteString(ce.text)
			}
			switch c {
			case "G":
				rows[i].G = sb.String()
			case "S":
				rows[i].S = sb.String()
			case "Q":
				rows[i].Q = sb.String()
			case "A":
				rows[i].A = sb.String()
			}
		}
	}
	return rows
}

// mergeReportRows attaches G/S/Q/A cells to lineup rows (matched by side + number + section);
// when the lineup sheet is missing the report rows become the lineup.
func mergeReportRows(ex *Extracted, rows []reportRow) {
	if len(ex.Players) == 0 {
		for _, r := range rows {
			ex.Players = append(ex.Players, r.PlayerRow)
		}
		return
	}
	for _, r := range rows {
		matched := false
		for i := range ex.Players {
			p := &ex.Players[i]
			if p.Side == r.Side && p.Number == r.Number && p.Starter == r.Starter {
				p.G, p.S, p.Q, p.A = r.G, r.S, r.Q, r.A
				p.Captain = p.Captain || r.Captain
				matched = true
				break
			}
		}
		if !matched {
			ex.Players = append(ex.Players, r.PlayerRow)
		}
	}
}

var teamRoleWords = map[string]bool{"BOSH": true, "MURABBIY": true, "YORD.MURABBIY": true, "J.T.MURABBIY": true, "DAR.MURABBIY": true,
	"RASMIY": true, "SHIFOKOR": true, "MASSAJCHI": true, "MA'MUR": true, "TEX": true, "DIREKTOR": true, "ADMINISTRATOR": true}

func parseTeamOfficials(ex *Extracted, ls []line) {
	start := -1
	for i, l := range ls {
		if l.has("JAMOA", "RASMIYLARI") {
			start = i
			break
		}
	}
	if start < 0 {
		return
	}
	for _, l := range ls[start+1:] {
		if l.has("JAROHAT") || l.has("UCHRASHUV") || l.has("E'TIROZ") {
			break
		}
		if l.has("LAVOZIMI") {
			continue
		}
		var left, right []Word
		for _, w := range l.Words {
			if w.X0 < 300 {
				left = append(left, w)
			} else {
				right = append(right, w)
			}
		}
		for side, ws := range map[string][]Word{Home: left, Away: right} {
			var name, role []string
			for _, w := range ws {
				if teamRoleWords[norm(w.Text)] {
					role = append(role, norm(w.Text))
				} else if !reValue.MatchString(w.Text) {
					name = append(name, w.Text)
				}
			}
			if len(name) > 0 && len(role) > 0 {
				ex.TeamOfficials = append(ex.TeamOfficials, Official{Side: side, Role: strings.Join(role, " "), Name: cleanName(strings.Join(name, " "))})
			}
		}
	}
	sort.SliceStable(ex.TeamOfficials, func(i, j int) bool { return ex.TeamOfficials[i].Side < ex.TeamOfficials[j].Side })
}

var matchRoles = [][]string{
	{"YORDAMCHI", "HAKAM", "1"}, {"YORDAMCHI", "HAKAM", "2"}, {"O'ZPFL", "KOMISSARI"}, {"ZAXIRA", "HAKAMI"},
	{"BOSH", "HAKAM"}, {"VAR", "HAKAMI"}, {"AVAR", "HAKAM"}, {"NAZORATCHI"}, {"KOMISSAR"}, {"HAKAM", "INSPEKTORI"},
}

func parseMatchOfficials(ls []line) []Official {
	out := []Official{}
	start := -1
	for i, l := range ls {
		if l.has("UCHRASHUV", "RASMIYLARI") {
			start = i
			break
		}
	}
	scan := ls
	if start >= 0 {
		scan = ls[start+1:]
	}
	for _, l := range scan {
		if l.has("IMZOSI") {
			break
		}
		toks := make([]string, len(l.Words))
		for i, w := range l.Words {
			toks[i] = norm(w.Text)
		}
		var cur *Official
		var collected []Official
		for i := 0; i < len(toks); {
			matched := false
			for _, r := range matchRoles {
				if i+len(r) <= len(toks) && equalSeq(toks[i:i+len(r)], r) {
					if cur != nil {
						collected = append(collected, *cur)
					}
					cur = &Official{Role: strings.Join(r, " ")}
					i += len(r)
					matched = true
					break
				}
			}
			if matched {
				continue
			}
			if cur != nil {
				if cur.Name != "" {
					cur.Name += " "
				}
				cur.Name += l.Words[i].Text
			}
			i++
		}
		if cur != nil {
			collected = append(collected, *cur)
		}
		for _, o := range collected {
			if strings.TrimSpace(o.Name) == "" {
				continue
			}
			o.Name = cleanName(o.Name)
			out = append(out, o)
		}
		if start < 0 && len(out) >= 8 {
			break
		}
	}
	return out
}

func equalSeq(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

// ParseMinute parses "67", "90+13" into minute and stoppage time.
func ParseMinute(s string) (int, int, bool) {
	m := reMinute.FindStringSubmatch(strings.TrimSpace(s))
	if m == nil {
		return 0, 0, false
	}
	min, _ := strconv.Atoi(m[1])
	extra := 0
	if m[2] != "" {
		extra, _ = strconv.Atoi(m[2])
	}
	if min < 1 || min > 130 || extra > 30 {
		return min, extra, false
	}
	return min, extra, true
}

// deriveEvents builds goals, cards and substitutions from the G/S/Q/A cells.
func deriveEvents(ex *Extracted) {
	ex.Events = []Event{}
	ex.ShootoutMarks = []string{}
	type subKey struct {
		side   string
		minute string
	}
	outs := map[subKey][]PlayerRow{}
	ins := map[subKey][]PlayerRow{}
	var subOrder []subKey
	for _, p := range ex.Players {
		add := func(typ, raw string) {
			for _, part := range strings.Split(raw, ",") {
				part = strings.TrimSpace(part)
				if part == "" {
					continue
				}
				min, extra, ok := ParseMinute(part)
				ex.Events = append(ex.Events, Event{Side: p.Side, Type: typ, Minute: min, Extra: extra, Raw: part, Player: p.Name, Number: p.Number, Uncertain: !ok})
			}
		}
		add("goal", p.G)
		add("yellow", p.S)
		add("red", p.Q)
		for _, a := range strings.Split(p.A, ",") {
			a = strings.TrimSpace(a)
			switch {
			case a == "":
			case a == "T":
				ex.ShootoutMarks = append(ex.ShootoutMarks, p.Side+" #"+strconv.Itoa(p.Number)+" "+p.Name)
			default:
				k := subKey{p.Side, a}
				if _, seen := outs[k]; !seen {
					if _, seen2 := ins[k]; !seen2 {
						subOrder = append(subOrder, k)
					}
				}
				if p.Starter {
					outs[k] = append(outs[k], p)
				} else {
					ins[k] = append(ins[k], p)
				}
			}
		}
	}
	for _, k := range subOrder {
		o, in := outs[k], ins[k]
		n := len(o)
		if len(in) > n {
			n = len(in)
		}
		ambiguous := len(o) > 1 || len(in) > 1 || len(o) != len(in)
		for i := 0; i < n; i++ {
			min, extra, ok := ParseMinute(k.minute)
			e := Event{Side: k.side, Type: "sub", Minute: min, Extra: extra, Raw: k.minute, Uncertain: ambiguous || !ok}
			if i < len(in) {
				e.Player, e.Number = in[i].Name, in[i].Number
			}
			if i < len(o) {
				e.Related, e.RelatedNumber = o[i].Name, o[i].Number
			}
			ex.Events = append(ex.Events, e)
		}
	}
	sort.SliceStable(ex.Events, func(i, j int) bool {
		a, b := ex.Events[i], ex.Events[j]
		if a.Minute != b.Minute {
			return a.Minute < b.Minute
		}
		return a.Extra < b.Extra
	})
}

// Rederive rebuilds Events and ShootoutMarks from the player G/S/Q/A cells (after manual edits).
func Rederive(ex *Extracted) { deriveEvents(ex) }
