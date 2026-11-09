package tgbot

import (
	"fmt"
	"html"
	"sort"
	"strings"
	"time"
)

// Shapes of GET /api/v1/admin/matches and /admin/matches/{id}.

type team struct {
	ID        int64  `json:"id"`
	Name      string `json:"name"`
	ShortName string `json:"short_name"`
}

type match struct {
	ID             int64      `json:"id"`
	Round          string     `json:"round"`
	KickoffAt      *time.Time `json:"kickoff_at"`
	Venue          string     `json:"venue"`
	Status         string     `json:"status"`
	Period         string     `json:"period"`
	ClockStartedAt *time.Time `json:"clock_started_at"`
	ClockOffsetSec int        `json:"clock_offset_sec"`
	HomeScore      *int       `json:"home_score"`
	AwayScore      *int       `json:"away_score"`
	HomePen        *int       `json:"home_pen"`
	AwayPen        *int       `json:"away_pen"`
	Stage          *struct {
		Name string `json:"name"`
	} `json:"stage"`
	Home *team `json:"home"`
	Away *team `json:"away"`
}

type event struct {
	ID                int64  `json:"id"`
	Side              string `json:"side"`
	Type              string `json:"type"`
	Minute            int    `json:"minute"`
	ExtraMinute       int    `json:"extra_minute"`
	PlayerID          *int64 `json:"player_id"`
	PlayerName        string `json:"player_name"`
	RelatedPlayerID   *int64 `json:"related_player_id"`
	RelatedPlayerName string `json:"related_player_name"`
	Note              string `json:"note"`
}

type lineupRow struct {
	Side       string `json:"side"`
	PlayerID   *int64 `json:"player_id"`
	PlayerName string `json:"player_name"`
	Number     *int   `json:"number"`
	IsStarter  bool   `json:"is_starter"`
}

type matchDetail struct {
	Match   match       `json:"match"`
	Events  []event     `json:"events"`
	Lineups []lineupRow `json:"lineups"`
}

type squadPlayer struct {
	ID       int64  `json:"id"`
	FullName string `json:"full_name"`
	Number   *int   `json:"number"`
}

// person is one choice in the player picker.
type person struct {
	ID     *int64
	Name   string
	Number *int
	Bench  bool
}

func (p person) same(id *int64, name string) bool {
	if id != nil && p.ID != nil {
		return *p.ID == *id
	}
	return name != "" && p.Name == name
}

func (p person) label() string {
	n := surname(p.Name)
	if p.Number != nil {
		n = fmt.Sprintf("%d · %s", *p.Number, n)
	}
	if p.Bench {
		n = "🪑 " + n
	}
	return n
}

// surname shortens «Ali Valiyev» to «A. Valiyev» so two buttons fit a row.
func surname(full string) string {
	w := strings.Fields(full)
	if len(w) < 2 {
		return full
	}
	r := []rune(w[0])
	return string(r[0]) + ". " + strings.Join(w[1:], " ")
}

// currentLineup replays substitutions and send-offs over the matchday squad
// (same rules as the admin Live-pult, lib/lineup.ts).
func currentLineup(d *matchDetail, side string) (on, bench []person) {
	type slot struct {
		person
		sentOff bool
	}
	var onS []slot
	for _, l := range d.Lineups {
		if l.Side != side {
			continue
		}
		p := person{ID: l.PlayerID, Name: l.PlayerName, Number: l.Number}
		if l.IsStarter {
			onS = append(onS, slot{person: p})
		} else {
			p.Bench = true
			bench = append(bench, p)
		}
	}
	evs := append([]event(nil), d.Events...)
	sort.SliceStable(evs, func(i, j int) bool {
		a, b := evs[i], evs[j]
		if a.Minute != b.Minute {
			return a.Minute < b.Minute
		}
		if a.ExtraMinute != b.ExtraMinute {
			return a.ExtraMinute < b.ExtraMinute
		}
		return a.ID < b.ID
	})
	for _, e := range evs {
		if e.Side != side {
			continue
		}
		switch e.Type {
		case "sub":
			out := -1
			for i, p := range onS {
				if p.same(e.RelatedPlayerID, e.RelatedPlayerName) {
					out = i
					break
				}
			}
			if out < 0 {
				continue
			}
			in := person{ID: e.PlayerID, Name: e.PlayerName}
			for i, p := range bench {
				if p.same(e.PlayerID, e.PlayerName) {
					in = p
					bench = append(bench[:i:i], bench[i+1:]...)
					break
				}
			}
			in.Bench = false
			onS[out] = slot{person: in}
		case "red", "second_yellow":
			for i := range onS {
				if onS[i].same(e.PlayerID, e.PlayerName) {
					onS[i].sentOff = true
				}
			}
		}
	}
	for _, s := range onS {
		if !s.sentOff {
			on = append(on, s.person)
		}
	}
	byNumber := func(ps []person) {
		sort.SliceStable(ps, func(i, j int) bool { return num(ps[i].Number) < num(ps[j].Number) })
	}
	byNumber(on)
	byNumber(bench)
	return on, bench
}

func num(n *int) int {
	if n == nil {
		return 999
	}
	return *n
}

// clock mirrors clockMinute() of the admin Live-pult.
func clock(m *match, now time.Time) (minute, extra int, label string) {
	if m.ClockStartedAt == nil {
		base := m.ClockOffsetSec / 60
		switch m.Period {
		case "HT":
			return base, 0, "Tanaffus"
		case "PEN":
			return 120, 0, "Penaltilar"
		case "FT":
			return base, 0, "Yakunlandi"
		}
		return base, 0, ""
	}
	total := float64(m.ClockOffsetSec) + now.Sub(*m.ClockStartedAt).Seconds()
	if total < float64(m.ClockOffsetSec) {
		total = float64(m.ClockOffsetSec)
	}
	minute = int(total/60) + 1
	limit := 120
	switch m.Period {
	case "1H":
		limit = 45
	case "2H":
		limit = 90
	}
	if minute > limit {
		return limit, minute - limit, fmt.Sprintf("%d+%d′", limit, minute-limit)
	}
	return minute, 0, fmt.Sprintf("%d′", minute)
}

func isLive(m *match) bool { return m.Status == "live" || m.Status == "halftime" }

func (m *match) teamName(side string) string {
	t := m.Home
	if side == "away" {
		t = m.Away
	}
	if t == nil {
		return "Aniqlanmagan"
	}
	return t.Name
}

func score(p *int) int {
	if p == nil {
		return 0
	}
	return *p
}

var tashkent = time.FixedZone("UZT", 5*3600)

func fmtKickoff(t *time.Time) string {
	if t == nil {
		return "sana belgilanmagan"
	}
	return t.In(tashkent).Format("02.01 15:04")
}

var statusLabel = map[string]string{
	"scheduled": "⏳ Boshlanmagan", "live": "🔴 LIVE", "halftime": "⏸ Tanaffus",
	"finished": "🏁 Yakunlandi", "postponed": "Qoldirilgan", "cancelled": "Bekor qilingan",
}

var periodLabel = map[string]string{"1H": "1-taym", "HT": "tanaffus", "2H": "2-taym", "ET": "qo‘shimcha vaqt", "PEN": "penaltilar seriyasi", "FT": "yakunlandi"}

// Event kinds offered by the bot. code is what travels in callback data.
type kind struct {
	code, typ, label, prompt string
}

var kinds = []kind{
	{"g", "goal", "⚽ Gol", "Kim gol urdi?"},
	{"y", "yellow", "🟨 Sariq", "Kimga sariq kartochka?"},
	{"r", "red", "🟥 Qizil", "Kimga qizil kartochka?"},
	{"s", "sub", "🔁 Almashtirish", "↓ Kim maydonni tark etadi?"},
	{"pg", "penalty_goal", "🎯 Penalti gol", "Kim penaltidan gol urdi?"},
	{"og", "own_goal", "🙈 Avtogol", "Qaysi o‘yinchi o‘z darvozasiga urdi?"},
	{"2y", "second_yellow", "🟨🟥 2-sariq", "Kimga ikkinchi sariq?"},
	{"pm", "penalty_missed", "❌ Penalti o‘tmadi", "Kim penaltini o‘tkazib yubordi?"},
}

var shootoutKinds = []kind{
	{"ss", "shootout_scored", "✅ Urdi", "Kim urdi?"},
	{"sm", "shootout_missed", "❌ O‘tkazdi", "Kim o‘tkazib yubordi?"},
}

func kindByCode(code string) (kind, bool) {
	for _, k := range append(append([]kind(nil), kinds...), shootoutKinds...) {
		if k.code == code {
			return k, true
		}
	}
	return kind{}, false
}

var eventIcon = map[string]string{
	"goal": "⚽", "own_goal": "🙈", "penalty_goal": "🎯", "penalty_missed": "❌", "yellow": "🟨",
	"second_yellow": "🟨🟥", "red": "🟥", "sub": "🔁", "shootout_scored": "✅", "shootout_missed": "❌",
	"note": "📝", "formation": "📐",
}

var eventLabel = map[string]string{
	"goal": "Gol", "own_goal": "Avtogol", "penalty_goal": "Penalti (gol)", "penalty_missed": "Penalti (o‘tmadi)",
	"yellow": "Sariq", "second_yellow": "Ikkinchi sariq", "red": "Qizil", "sub": "Almashtirish",
	"shootout_scored": "Seriya: gol", "shootout_missed": "Seriya: o‘tmadi", "note": "Izoh", "formation": "Sxema",
}

func minuteLabel(min, extra int) string {
	if extra > 0 {
		return fmt.Sprintf("%d+%d′", min, extra)
	}
	return fmt.Sprintf("%d′", min)
}

// eventLine renders one event, HTML-escaped.
func eventLine(m *match, e event) string {
	who := e.PlayerName
	switch {
	case e.Type == "formation":
		who = e.Note
	case e.Type == "sub":
		who = "↑ " + e.PlayerName + "  ↓ " + e.RelatedPlayerName
	case who == "":
		who = "—"
	}
	icon := eventIcon[e.Type]
	if icon == "" {
		icon = "•"
	}
	return fmt.Sprintf("%s %s %s · %s", minuteLabel(e.Minute, e.ExtraMinute), icon, html.EscapeString(m.teamName(e.Side)), html.EscapeString(who))
}

// Period transitions offered in the console (same as the admin Live-pult).
type step struct{ period, label string }

var nextPeriods = map[string][]step{
	"":    {{"1H", "▶️ Matchni boshlash"}},
	"1H":  {{"HT", "⏸ Tanaffus"}},
	"HT":  {{"2H", "▶️ 2-taymni boshlash"}},
	"2H":  {{"FT", "🏁 Matchni yakunlash"}, {"ET", "⏱ Qo‘shimcha vaqt"}, {"PEN", "🥅 Penaltilar seriyasi"}},
	"ET":  {{"FT", "🏁 Matchni yakunlash"}, {"PEN", "🥅 Penaltilar seriyasi"}},
	"PEN": {{"FT", "🏁 Matchni yakunlash"}},
}

var periodDone = map[string]string{
	"1H": "Match boshlandi", "HT": "Tanaffus", "2H": "2-taym boshlandi", "ET": "Qo‘shimcha vaqt boshlandi",
	"PEN": "Penaltilar seriyasi", "FT": "Match yakunlandi",
}
