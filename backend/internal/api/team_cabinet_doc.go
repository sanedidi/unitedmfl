package api

import (
	"context"
	"database/sql"
	"fmt"
	"strconv"
	"strings"

	"github.com/lib/pq"

	"github.com/sanedidi/unitedmfl/backend/internal/jersey"
	"github.com/sanedidi/unitedmfl/backend/internal/roster"
)

// The team cabinet works on a «document»: the team's info, players and staff.
// The live document is read from teams/players/team_staff; the team edits a
// copy (the draft) and the difference between the two is the list of change
// items the admin approves one by one.

type cabTeam struct {
	Name      string   `json:"name"` // read-only: only the league renames a team
	ShortName string   `json:"short_name"`
	CrestURL  string   `json:"crest_url"`
	Colors    []string `json:"colors"`
	Leader    string   `json:"leader"`
	Instagram string   `json:"instagram"`
	Telegram  string   `json:"telegram"`
	KitURL    string   `json:"kit_url"`
}

type cabPlayer struct {
	ID         int64         `json:"id,omitempty"` // players.id; 0 — a new player
	FirstName  string        `json:"first_name"`
	LastName   string        `json:"last_name"`
	JerseyName string        `json:"jersey_name"`
	BirthDate  string        `json:"birth_date"`
	Number     jersey.Number `json:"number"`
	KitSize    string        `json:"kit_size"`
	Workplace  string        `json:"workplace"`
	Role       string        `json:"role"` // player | goalkeeper | media
	PhotoURL   string        `json:"photo_url"`
	Medical    *roster.File  `json:"medical"`     // a file uploaded in the cabinet
	HasMedical bool          `json:"has_medical"` // the live player already has one
	Removed    bool          `json:"removed,omitempty"`
}

type cabStaff struct {
	ID        int64  `json:"id,omitempty"`
	FirstName string `json:"first_name"`
	LastName  string `json:"last_name"`
	BirthDate string `json:"birth_date"`
	KitSize   string `json:"kit_size"`
	Role      string `json:"role"`
	Removed   bool   `json:"removed,omitempty"`
}

type cabDoc struct {
	Team    cabTeam     `json:"team"`
	Players []cabPlayer `json:"players"`
	Staff   []cabStaff  `json:"staff"`
}

func (p cabPlayer) fullName() string {
	return strings.Join(strings.Fields(p.FirstName+" "+p.LastName), " ")
}
func (s cabStaff) fullName() string {
	return strings.Join(strings.Fields(s.FirstName+" "+s.LastName), " ")
}

// splitName: players keep one full_name; the cabinet edits first and last name.
func splitName(full string) (first, last string) {
	w := strings.Fields(full)
	if len(w) == 0 {
		return "", ""
	}
	return w[0], strings.Join(w[1:], " ")
}

func (p cabPlayer) asRoster() roster.Player {
	return roster.Player{FirstName: p.FirstName, LastName: p.LastName, BirthDate: p.BirthDate, Number: p.Number, Role: p.Role}
}

// ---------- live document ----------

type rowQuerierCtx interface {
	QueryRowContext(ctx context.Context, query string, args ...any) *sql.Row
	QueryContext(ctx context.Context, query string, args ...any) (*sql.Rows, error)
}

func loadLiveDoc(ctx context.Context, q rowQuerierCtx, teamID int64) (*cabDoc, error) {
	d := &cabDoc{Players: []cabPlayer{}, Staff: []cabStaff{}}
	var colors pq.StringArray
	if err := q.QueryRowContext(ctx, `SELECT name, short_name, crest_url, colors, leader, instagram, telegram, kit_url FROM teams WHERE id = $1`, teamID).
		Scan(&d.Team.Name, &d.Team.ShortName, &d.Team.CrestURL, &colors, &d.Team.Leader, &d.Team.Instagram, &d.Team.Telegram, &d.Team.KitURL); err != nil {
		return nil, err
	}
	d.Team.Colors = append([]string{}, colors...)
	rows, err := q.QueryContext(ctx, `SELECT id, full_name, coalesce(number, ''), position, is_media, photo_url, coalesce(to_char(birth_date, 'YYYY-MM-DD'), ''),
		jersey_name, kit_size, workplace, medical_url <> ''
		FROM players WHERE team_id = $1 ORDER BY is_media, jersey_ord(number) NULLS LAST, number NULLS LAST, full_name`, teamID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var p cabPlayer
		var full, number, pos string
		var media bool
		if err := rows.Scan(&p.ID, &full, &number, &pos, &media, &p.PhotoURL, &p.BirthDate, &p.JerseyName, &p.KitSize, &p.Workplace, &p.HasMedical); err != nil {
			return nil, err
		}
		p.FirstName, p.LastName = splitName(full)
		p.Number = jersey.Number(number)
		switch {
		case media:
			p.Role = roster.RoleMedia
		case pos == "GK":
			p.Role = roster.RoleGoalkeeper
		default:
			p.Role = roster.RolePlayer
		}
		d.Players = append(d.Players, p)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	srows, err := q.QueryContext(ctx, `SELECT id, full_name, role, coalesce(to_char(birth_date, 'YYYY-MM-DD'), ''), kit_size
		FROM team_staff WHERE team_id = $1 ORDER BY ord, id`, teamID)
	if err != nil {
		return nil, err
	}
	defer srows.Close()
	for srows.Next() {
		var st cabStaff
		var full string
		if err := srows.Scan(&st.ID, &full, &st.Role, &st.BirthDate, &st.KitSize); err != nil {
			return nil, err
		}
		st.FirstName, st.LastName = splitName(full)
		d.Staff = append(d.Staff, st)
	}
	return d, srows.Err()
}

// ---------- sanitising the team's draft ----------

func ownURL(base, u string) string {
	u = strings.TrimSpace(u)
	if ownImage(strings.TrimPrefix(u, base)) != "" {
		return u
	}
	return ""
}

func cleanHandle(s string, n int) string {
	return clip(strings.TrimSpace(s), n)
}

// sanitizeDoc keeps only what the team may change; the live document fills
// what the team cannot (the name) and decides which ids are real.
func (s *Server) sanitizeDoc(in cabDoc, live *cabDoc, fileOK func(string) bool) (cabDoc, error) {
	base := s.Cfg.PublicBaseURL
	out := cabDoc{Players: []cabPlayer{}, Staff: []cabStaff{}}
	t := in.Team
	out.Team = cabTeam{Name: live.Team.Name, ShortName: strings.ToUpper(clip(t.ShortName, 4)), Leader: clip(t.Leader, 120),
		Instagram: cleanHandle(t.Instagram, 200), Telegram: cleanHandle(t.Telegram, 200), Colors: []string{}}
	// an image keeps its value when it is the live one (it may come from the admin) or our upload
	keepImg := func(v, cur string) string {
		if strings.TrimSpace(v) == cur {
			return cur
		}
		return ownURL(base, v)
	}
	out.Team.CrestURL = keepImg(t.CrestURL, live.Team.CrestURL)
	out.Team.KitURL = keepImg(t.KitURL, live.Team.KitURL)
	for _, c := range t.Colors {
		if reHexColor.MatchString(c) && len(out.Team.Colors) < 3 {
			out.Team.Colors = append(out.Team.Colors, strings.ToUpper(c))
		}
	}
	if len(in.Players) > 80 {
		return out, fmt.Errorf("Tarkibda 80 tadan ortiq odam bo‘lishi mumkin emas")
	}
	if len(in.Staff) > 12 {
		return out, fmt.Errorf("Shtabda 12 tadan ortiq odam bo‘lishi mumkin emas")
	}
	livePlayers := map[int64]cabPlayer{}
	for _, p := range live.Players {
		livePlayers[p.ID] = p
	}
	seen := map[int64]bool{}
	for _, p := range in.Players {
		q := cabPlayer{FirstName: clip(p.FirstName, 60), LastName: clip(p.LastName, 60), JerseyName: roster.JerseyName(clip(p.JerseyName, 20)),
			KitSize: roster.NormalizeSize(p.KitSize), Workplace: clip(p.Workplace, 120), Role: p.Role, Removed: p.Removed}
		if p.ID != 0 {
			lp, ok := livePlayers[p.ID]
			if !ok || seen[p.ID] {
				continue // not this team's player (any more), or a duplicate row
			}
			seen[p.ID] = true
			q.ID = p.ID
			q.HasMedical = lp.HasMedical
			q.PhotoURL = keepImg(p.PhotoURL, lp.PhotoURL)
		} else {
			if p.Removed {
				continue // a new player removed again is simply gone
			}
			q.PhotoURL = ownURL(base, p.PhotoURL)
		}
		if d, ok := roster.ParseDate(p.BirthDate); ok {
			q.BirthDate = d
		}
		if n, ok := jersey.Parse(p.Number.String()); ok {
			q.Number = n
		}
		switch q.Role {
		case roster.RolePlayer, roster.RoleGoalkeeper, roster.RoleMedia:
		default:
			q.Role = roster.RolePlayer
		}
		if p.Medical != nil && reMedicalFile.MatchString(p.Medical.File) && fileOK(p.Medical.File) {
			q.Medical = &roster.File{File: p.Medical.File, Name: clip(p.Medical.Name, 120)}
		}
		out.Players = append(out.Players, q)
	}
	// live players the draft does not mention stay as they are
	for _, lp := range live.Players {
		if !seen[lp.ID] {
			out.Players = append(out.Players, lp)
		}
	}
	liveStaff := map[int64]bool{}
	for _, st := range live.Staff {
		liveStaff[st.ID] = true
	}
	seenStaff := map[int64]bool{}
	for _, st := range in.Staff {
		q := cabStaff{FirstName: clip(st.FirstName, 60), LastName: clip(st.LastName, 60), KitSize: roster.NormalizeSize(st.KitSize), Role: st.Role, Removed: st.Removed}
		if st.ID != 0 {
			if !liveStaff[st.ID] || seenStaff[st.ID] {
				continue
			}
			seenStaff[st.ID] = true
			q.ID = st.ID
		} else if st.Removed {
			continue
		}
		if d, ok := roster.ParseDate(st.BirthDate); ok {
			q.BirthDate = d
		}
		if !contains(roster.StaffRoles, q.Role) {
			q.Role = "head_coach"
		}
		out.Staff = append(out.Staff, q)
	}
	for _, st := range live.Staff {
		if !seenStaff[st.ID] {
			out.Staff = append(out.Staff, st)
		}
	}
	return out, nil
}

// ---------- diff ----------

type fieldChange struct {
	Field  string `json:"field"`
	Label  string `json:"label"`
	Before string `json:"before"`
	After  string `json:"after"`
}

type changeItem struct {
	Key      string        `json:"key"`  // team.crest_url · player:12 · player:new:3 · staff:5 · staff:new:0
	Kind     string        `json:"kind"` // team | player | staff
	Op       string        `json:"op"`   // update | add | remove
	Title    string        `json:"title"`
	Fields   []fieldChange `json:"fields"`
	Player   *cabPlayer    `json:"player,omitempty"` // the desired player (add / update / remove)
	Staff    *cabStaff     `json:"staff,omitempty"`
	Decision string        `json:"decision,omitempty"` // approved | rejected | fix — set by the admin
}

var teamFieldLabels = []struct{ Field, Label string }{
	{"crest_url", "Logotip"}, {"short_name", "Qisqa nomi"}, {"colors", "Forma ranglari"}, {"kit_url", "Forma rasmi"},
	{"leader", "Jamoa lideri"}, {"instagram", "Instagram"}, {"telegram", "Telegram"},
}

func teamField(t cabTeam, f string) string {
	switch f {
	case "crest_url":
		return t.CrestURL
	case "short_name":
		return t.ShortName
	case "colors":
		return strings.Join(t.Colors, " ")
	case "kit_url":
		return t.KitURL
	case "leader":
		return t.Leader
	case "instagram":
		return t.Instagram
	case "telegram":
		return t.Telegram
	}
	return ""
}

var roleLabels = map[string]string{roster.RolePlayer: "O‘yinchi", roster.RoleGoalkeeper: "Darvozabon", roster.RoleMedia: "Media shaxs"}

var staffRoleLabels = map[string]string{"head_coach": "Bosh murabbiy", "assistant": "Murabbiy yordamchisi", "gk_coach": "Darvozabonlar murabbiyi",
	"fitness": "Jismoniy tayyorgarlik", "doctor": "Shifokor", "manager": "Menejer", "other": "Boshqa"}

func playerTitle(p cabPlayer) string {
	t := p.fullName()
	if t == "" {
		t = "Ismsiz"
	}
	if p.Number != "" {
		t += " · №" + p.Number.String()
	}
	return t
}

func medicalLabel(p cabPlayer) string {
	switch {
	case p.Medical != nil:
		return "Yangi fayl"
	case p.HasMedical:
		return "Bor"
	}
	return "Yo‘q"
}

func playerFields(a, b cabPlayer) []fieldChange {
	out := []fieldChange{}
	add := func(field, label, x, y string) {
		if x != y {
			out = append(out, fieldChange{Field: field, Label: label, Before: x, After: y})
		}
	}
	add("full_name", "Ism familiya", a.fullName(), b.fullName())
	add("number", "Raqam", a.Number.String(), b.Number.String())
	add("role", "Roli", roleLabels[a.Role], roleLabels[b.Role])
	add("jersey_name", "Futbolkada", a.JerseyName, b.JerseyName)
	add("birth_date", "Tug‘ilgan sana", a.BirthDate, b.BirthDate)
	add("kit_size", "O‘lcham", a.KitSize, b.KitSize)
	add("workplace", "Ish joyi", a.Workplace, b.Workplace)
	add("photo_url", "Foto", a.PhotoURL, b.PhotoURL)
	if b.Medical != nil {
		add("medical", "Tibbiy ruxsatnoma", medicalLabel(a), "Yangi fayl")
	}
	return out
}

func staffFields(a, b cabStaff) []fieldChange {
	out := []fieldChange{}
	add := func(field, label, x, y string) {
		if x != y {
			out = append(out, fieldChange{Field: field, Label: label, Before: x, After: y})
		}
	}
	add("full_name", "Ism familiya", a.fullName(), b.fullName())
	add("role", "Lavozimi", staffRoleLabels[a.Role], staffRoleLabels[b.Role])
	add("birth_date", "Tug‘ilgan sana", a.BirthDate, b.BirthDate)
	add("kit_size", "O‘lcham", a.KitSize, b.KitSize)
	return out
}

// diffDoc lists what the draft changes in the live document.
func diffDoc(live, draft *cabDoc) []changeItem {
	out := []changeItem{}
	for _, f := range teamFieldLabels {
		x, y := teamField(live.Team, f.Field), teamField(draft.Team, f.Field)
		if x != y {
			out = append(out, changeItem{Key: "team." + f.Field, Kind: "team", Op: "update", Title: f.Label,
				Fields: []fieldChange{{Field: f.Field, Label: f.Label, Before: x, After: y}}})
		}
	}
	livePlayers := map[int64]cabPlayer{}
	for _, p := range live.Players {
		livePlayers[p.ID] = p
	}
	for i, p := range draft.Players {
		p := p
		if p.ID == 0 {
			if p.Removed {
				continue
			}
			out = append(out, changeItem{Key: "player:new:" + strconv.Itoa(i), Kind: "player", Op: "add", Title: playerTitle(p), Player: &p,
				Fields: playerFields(cabPlayer{}, p)})
			continue
		}
		lp, ok := livePlayers[p.ID]
		if !ok {
			continue
		}
		key := "player:" + strconv.FormatInt(p.ID, 10)
		if p.Removed {
			out = append(out, changeItem{Key: key, Kind: "player", Op: "remove", Title: playerTitle(lp), Player: &lp, Fields: []fieldChange{}})
			continue
		}
		if fs := playerFields(lp, p); len(fs) > 0 {
			out = append(out, changeItem{Key: key, Kind: "player", Op: "update", Title: playerTitle(lp), Player: &p, Fields: fs})
		}
	}
	liveStaff := map[int64]cabStaff{}
	for _, st := range live.Staff {
		liveStaff[st.ID] = st
	}
	for i, st := range draft.Staff {
		st := st
		name := st.fullName()
		if st.ID == 0 {
			if st.Removed {
				continue
			}
			out = append(out, changeItem{Key: "staff:new:" + strconv.Itoa(i), Kind: "staff", Op: "add", Title: name, Staff: &st, Fields: staffFields(cabStaff{}, st)})
			continue
		}
		ls, ok := liveStaff[st.ID]
		if !ok {
			continue
		}
		key := "staff:" + strconv.FormatInt(st.ID, 10)
		if st.Removed {
			out = append(out, changeItem{Key: key, Kind: "staff", Op: "remove", Title: ls.fullName(), Staff: &ls, Fields: []fieldChange{}})
			continue
		}
		if fs := staffFields(ls, st); len(fs) > 0 {
			out = append(out, changeItem{Key: key, Kind: "staff", Op: "update", Title: ls.fullName(), Staff: &st, Fields: fs})
		}
	}
	return out
}

// ---------- checks ----------

type cabCheck struct {
	Level string `json:"level"` // error | warn
	Key   string `json:"key,omitempty"`
	Text  string `json:"text"`
}

const (
	cabMinPlayers = 8
	cabMaxPeople  = 20
)

// checkDoc validates the draft before it is sent; errors block sending.
// players (may be nil) is the league player index for «already in another team».
func checkDoc(teamID int64, draft *cabDoc, items []changeItem, players map[string][]dupMatch) []cabCheck {
	out := []cabCheck{}
	if len(items) == 0 {
		out = append(out, cabCheck{Level: "error", Text: "O‘zgarish yo‘q — avval nimanidir o‘zgartiring"})
	}
	for _, it := range items {
		if it.Key == "team.short_name" && draft.Team.ShortName != "" && !reShort.MatchString(draft.Team.ShortName) {
			out = append(out, cabCheck{Level: "error", Key: it.Key, Text: "Qisqa nom — 2–4 ta lotin harfi"})
		}
	}
	numbers := map[string][]string{}
	field, people := 0, 0
	for i, p := range draft.Players {
		if p.Removed {
			continue
		}
		key := "player:" + strconv.FormatInt(p.ID, 10)
		if p.ID == 0 {
			key = "player:new:" + strconv.Itoa(i)
		}
		people++
		if p.Role != roster.RoleMedia {
			field++
		}
		if strings.TrimSpace(p.FirstName) == "" || strings.TrimSpace(p.LastName) == "" {
			out = append(out, cabCheck{Level: "error", Key: key, Text: fmt.Sprintf("%d-qator: ism va familiyani yozing", i+1)})
		}
		if p.Number == "" {
			out = append(out, cabCheck{Level: "error", Key: key, Text: playerTitle(p) + ": raqamni kiriting"})
		} else {
			numbers[p.Number.String()] = append(numbers[p.Number.String()], p.fullName())
		}
		if p.ID == 0 && players != nil {
			for _, m := range dupsFor(players, p.asRoster()) {
				if m.TeamID != nil && *m.TeamID != teamID {
					out = append(out, cabCheck{Level: "warn", Key: key, Text: fmt.Sprintf("%s — «%s» tarkibida bor (№%s). O‘tkazish faqat liga ruxsati bilan", p.fullName(), m.TeamName, m.Number)})
				}
			}
		}
		if p.ID == 0 && p.Medical == nil && p.Role != roster.RoleMedia {
			out = append(out, cabCheck{Level: "warn", Key: key, Text: p.fullName() + ": tibbiy ruxsatnoma yuklanmagan"})
		}
	}
	for n, names := range numbers {
		if len(names) > 1 {
			out = append(out, cabCheck{Level: "error", Text: fmt.Sprintf("%s-raqam takrorlangan: %s", n, strings.Join(names, ", "))})
		}
	}
	if field < cabMinPlayers {
		out = append(out, cabCheck{Level: "warn", Text: fmt.Sprintf("Tarkibda %d ta o‘yinchi — kamida %d ta kerak", field, cabMinPlayers)})
	}
	if people > cabMaxPeople {
		out = append(out, cabCheck{Level: "warn", Text: fmt.Sprintf("Tarkibda %d kishi — ko‘pi bilan %d", people, cabMaxPeople)})
	}
	for i, st := range draft.Staff {
		if st.Removed {
			continue
		}
		if strings.TrimSpace(st.FirstName) == "" {
			out = append(out, cabCheck{Level: "error", Text: fmt.Sprintf("Shtab, %d-qator: ismni yozing", i+1)})
		}
	}
	return out
}

func cabHasErrors(cs []cabCheck) bool {
	for _, c := range cs {
		if c.Level == "error" {
			return true
		}
	}
	return false
}
