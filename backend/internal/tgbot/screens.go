package tgbot

import (
	"fmt"
	"html"
	"sort"
	"strings"
	"time"
)

func esc(s string) string { return html.EscapeString(s) }

func header(m *match, now time.Time) string {
	var sb strings.Builder
	var tags []string
	if m.Stage != nil && m.Stage.Name != "" {
		tags = append(tags, m.Stage.Name)
	}
	if m.Round != "" {
		tags = append(tags, m.Round)
	}
	if len(tags) > 0 {
		sb.WriteString("🏆 " + esc(strings.Join(tags, " · ")) + "\n")
	}
	status := statusLabel[m.Status]
	if status == "" {
		status = m.Status
	}
	switch {
	case isLive(m):
		_, _, c := clock(m, now)
		line := status
		if pl := periodLabel[m.Period]; pl != "" && m.Period != "HT" {
			line += " · " + pl
		}
		if c != "" && m.Period != "HT" && m.Period != "PEN" {
			line += " · <b>" + c + "</b>"
		}
		sb.WriteString(line + "\n")
	case m.Status == "scheduled":
		sb.WriteString(status + " · " + fmtKickoff(m.KickoffAt) + "\n")
	default:
		sb.WriteString(status + "\n")
	}
	sb.WriteString(fmt.Sprintf("\n<b>%s</b>   <b>%d : %d</b>   <b>%s</b>\n", esc(m.teamName("home")), score(m.HomeScore), score(m.AwayScore), esc(m.teamName("away"))))
	if m.HomePen != nil && m.AwayPen != nil {
		sb.WriteString(fmt.Sprintf("Penaltilar: <b>%d:%d</b>\n", *m.HomePen, *m.AwayPen))
	}
	if m.Venue != "" && !isLive(m) {
		sb.WriteString("📍 " + esc(m.Venue) + "\n")
	}
	return sb.String()
}

// newestFirst returns events newest first.
func newestFirst(evs []event) []event {
	out := append([]event(nil), evs...)
	sort.SliceStable(out, func(i, j int) bool {
		a, b := out[i], out[j]
		if a.Minute != b.Minute {
			return a.Minute > b.Minute
		}
		if a.ExtraMinute != b.ExtraMinute {
			return a.ExtraMinute > b.ExtraMinute
		}
		return a.ID > b.ID
	})
	return out
}

func consoleScreen(d *matchDetail, side string, now func() time.Time) (string, *inlineKeyboard) {
	m := &d.Match
	var sb strings.Builder
	sb.WriteString(header(m, now()))

	evs := newestFirst(d.Events)
	if len(evs) > 0 {
		sb.WriteString("\n<b>So‘nggi voqealar</b>\n")
		for i, e := range evs {
			if i == 6 {
				sb.WriteString(fmt.Sprintf("… yana %d ta\n", len(evs)-6))
				break
			}
			sb.WriteString(eventLine(m, e) + "\n")
		}
	}

	rows := [][]button{}
	if isLive(m) && m.Period != "HT" {
		sb.WriteString("\nHodisa qaysi jamoaga: <b>" + esc(m.teamName(side)) + "</b>")
		mark := func(s string) string {
			if s == side {
				return "✅ " + m.teamName(s)
			}
			return m.teamName(s)
		}
		rows = append(rows, []button{
			{Text: mark("home"), Data: fmt.Sprintf("S:%d:h", m.ID)},
			{Text: mark("away"), Data: fmt.Sprintf("S:%d:a", m.ID)},
		})
		list := kinds
		if m.Period == "PEN" {
			list = shootoutKinds
		}
		for i := 0; i < len(list); i += 2 {
			row := []button{{Text: list[i].label, Data: fmt.Sprintf("E:%d:%s", m.ID, list[i].code)}}
			if i+1 < len(list) {
				row = append(row, button{Text: list[i+1].label, Data: fmt.Sprintf("E:%d:%s", m.ID, list[i+1].code)})
			}
			rows = append(rows, row)
		}
	}
	if m.Status != "finished" && m.Status != "cancelled" && m.Status != "postponed" {
		for _, st := range nextPeriods[m.Period] {
			rows = append(rows, []button{{Text: st.label, Data: fmt.Sprintf("R:%d:%s", m.ID, st.period)}})
		}
	}
	rows = append(rows,
		[]button{{Text: "📜 Voqealar", Data: fmt.Sprintf("G:%d", m.ID)}, {Text: "🔄 Yangilash", Data: fmt.Sprintf("M:%d", m.ID)}},
		[]button{{Text: "⬅️ Matchlar", Data: "L"}},
	)
	return sb.String(), &inlineKeyboard{Rows: rows}
}

func pickerScreen(d *matchDetail, p *pending) (string, *inlineKeyboard) {
	m := &d.Match
	prompt := p.kind.prompt
	if p.kind.typ == "sub" && p.out != nil {
		prompt = "↑ Kim maydonga tushadi?"
	}
	var sb strings.Builder
	sb.WriteString(fmt.Sprintf("%s · <b>%s</b>", p.kind.label, esc(m.teamName(p.side))))
	if p.kind.typ != "shootout_scored" && p.kind.typ != "shootout_missed" {
		sb.WriteString(" · " + minuteLabel(p.minute, p.extra))
	}
	sb.WriteString("\n")
	if p.out != nil {
		sb.WriteString("↓ Chiqadi: <b>" + esc(p.out.Name) + "</b>\n")
	}
	if p.kind.typ == "own_goal" {
		sb.WriteString("<i>Gol raqib jamoasi hisobiga yoziladi.</i>\n")
	}
	sb.WriteString("\n" + prompt)
	if len(p.people) == 0 {
		sb.WriteString("\n\n<i>Tarkib va jamoa ro‘yxati bo‘sh.</i>")
	}

	rows := [][]button{}
	for i := 0; i < len(p.people); i += 2 {
		row := []button{{Text: p.people[i].label(), Data: fmt.Sprintf("P:%d", i)}}
		if i+1 < len(p.people) {
			row = append(row, button{Text: p.people[i+1].label(), Data: fmt.Sprintf("P:%d", i+1)})
		}
		rows = append(rows, row)
	}
	if p.kind.typ != "sub" {
		rows = append(rows, []button{{Text: "👤 O‘yinchi ko‘rsatilmasin", Data: "P:-1"}})
	}
	if p.kind.typ != "shootout_scored" && p.kind.typ != "shootout_missed" {
		rows = append(rows, []button{{Text: "⏱ Daqiqa: " + minuteLabel(p.minute, p.extra) + " — o‘zgartirish", Data: fmt.Sprintf("T:%d", p.matchID)}})
	}
	rows = append(rows, []button{{Text: "✖️ Bekor qilish", Data: fmt.Sprintf("M:%d", p.matchID)}})
	return sb.String(), &inlineKeyboard{Rows: rows}
}

func logScreen(d *matchDetail) (string, *inlineKeyboard) {
	m := &d.Match
	evs := newestFirst(d.Events)
	var sb strings.Builder
	sb.WriteString(fmt.Sprintf("📜 <b>Voqealar</b> · %s %d:%d %s\n", esc(m.teamName("home")), score(m.HomeScore), score(m.AwayScore), esc(m.teamName("away"))))
	rows := [][]button{}
	if len(evs) == 0 {
		sb.WriteString("\nHali voqealar yo‘q.")
	} else {
		sb.WriteString("\nXato kiritilgan voqeani o‘chirish uchun uni bosing.\n")
	}
	for i, e := range evs {
		if i == 25 {
			sb.WriteString(fmt.Sprintf("\nEng so‘nggi 25 tasi ko‘rsatildi (jami %d).", len(evs)))
			break
		}
		who := e.PlayerName
		if e.Type == "formation" {
			who = e.Note
		}
		if who == "" {
			who = m.teamName(e.Side)
		}
		label := fmt.Sprintf("🗑 %s %s %s", minuteLabel(e.Minute, e.ExtraMinute), eventIcon[e.Type], surname(who))
		rows = append(rows, []button{{Text: label, Data: fmt.Sprintf("D:%d:%d", m.ID, e.ID)}})
	}
	rows = append(rows, []button{{Text: "⬅️ Pultga qaytish", Data: fmt.Sprintf("M:%d", m.ID)}})
	return sb.String(), &inlineKeyboard{Rows: rows}
}
