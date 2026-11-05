package protocol

import (
	"fmt"
	"strconv"
)

func val(p *int) int {
	if p == nil {
		return 0
	}
	return *p
}

// Validate checks internal consistency of an extracted protocol.
func Validate(ex *Extracted) []Issue {
	issues := []Issue{}
	add := func(sev, code, msg, ref string) {
		issues = append(issues, Issue{Severity: sev, Code: code, Message: msg, Ref: ref})
	}
	if !ex.HasReportSheet {
		add("warning", "no_report_sheet", "«O‘yin qaydnomasi» sahifasi topilmadi — hisob va voqealar qo‘lda kiritilishi kerak", "")
	}
	if ex.Home.Name == "" || ex.Away.Name == "" {
		add("error", "teams_missing", "Jamoa nomlari aniqlanmadi", "teams")
	}
	if ex.Date == "" {
		add("warning", "date_missing", "Match sanasi aniqlanmadi", "date")
	}
	if ex.Home.Total == nil || ex.Away.Total == nil {
		add("error", "score_missing", "Yakuniy hisob aniqlanmadi", "score")
	} else {
		for _, t := range []struct {
			ts   TeamScore
			name string
		}{{ex.Home, "home"}, {ex.Away, "away"}} {
			if t.ts.Half1 != nil && t.ts.Half2 != nil {
				sum := val(t.ts.Half1) + val(t.ts.Half2) + val(t.ts.Extra)
				if sum != val(t.ts.Total) {
					add("error", "score_mismatch", fmt.Sprintf("%s: bo‘limlar yig‘indisi (%d) yakuniy hisobga (%d) teng emas", t.ts.Name, sum, val(t.ts.Total)), "score."+t.name)
				}
			}
		}
	}
	// Goals vs score.
	goals := map[string]int{}
	for _, e := range ex.Events {
		if e.Type == "goal" {
			goals[e.Side]++
		}
	}
	if ex.Home.Total != nil && ex.Away.Total != nil && len(ex.Players) > 0 {
		if goals[Home] != val(ex.Home.Total) || goals[Away] != val(ex.Away.Total) {
			add("warning", "goals_mismatch", fmt.Sprintf("Gollar soni (%d:%d) hisobga (%d:%d) mos emas — avtogollarni tekshiring", goals[Home], goals[Away], val(ex.Home.Total), val(ex.Away.Total)), "events")
		}
	}
	// Lineup sizes.
	starters := map[string]int{}
	for _, p := range ex.Players {
		if p.Starter {
			starters[p.Side]++
		}
	}
	for _, side := range []string{Home, Away} {
		if len(ex.Players) > 0 && starters[side] != 11 {
			add("warning", "starters_count", fmt.Sprintf("%s: boshlang‘ich tarkibda %d ta o‘yinchi (11 kutilgan)", sideName(ex, side), starters[side]), "players."+side)
		}
	}
	// Events.
	for i, e := range ex.Events {
		ref := "events[" + strconv.Itoa(i) + "]"
		if _, _, ok := ParseMinute(e.Raw); !ok && e.Raw != "" {
			add("warning", "bad_minute", fmt.Sprintf("%s · %s: daqiqa noto‘g‘ri («%s»)", typeName(e.Type), nameOr(e.Player, e.Related), e.Raw), ref)
			continue
		}
		if e.Type == "sub" {
			switch {
			case e.Player == "":
				add("warning", "sub_no_in", fmt.Sprintf("%s %s′: %s almashtirildi, lekin kirgan o‘yinchi topilmadi", sideName(ex, e.Side), e.Raw, e.Related), ref)
			case e.Related == "":
				add("warning", "sub_no_out", fmt.Sprintf("%s %s′: %s maydonga tushdi, lekin chiqqan o‘yinchi topilmadi", sideName(ex, e.Side), e.Raw, e.Player), ref)
			case e.Uncertain:
				add("warning", "sub_ambiguous", fmt.Sprintf("%s %s′: bir daqiqada bir nechta almashtirish — juftlikni tasdiqlang", sideName(ex, e.Side), e.Raw), ref)
			}
		}
	}
	if len(ex.ShootoutMarks) > 0 {
		add("info", "shootout_marks", fmt.Sprintf("«A» ustunida %d ta «T» belgisi — penalti seriyasida tepganlar deb taxmin qilindi (tasdiqlash kerak)", len(ex.ShootoutMarks)), "shootout")
	}
	if len(ex.Officials) == 0 {
		add("info", "officials_missing", "Uchrashuv rasmiylari aniqlanmadi", "officials")
	}
	return issues
}

func sideName(ex *Extracted, side string) string {
	if side == Home && ex.Home.Name != "" {
		return ex.Home.Name
	}
	if side == Away && ex.Away.Name != "" {
		return ex.Away.Name
	}
	return side
}

func nameOr(a, b string) string {
	if a != "" {
		return a
	}
	return b
}

func typeName(t string) string {
	switch t {
	case "goal":
		return "Gol"
	case "yellow":
		return "Sariq kartochka"
	case "red":
		return "Qizil kartochka"
	case "sub":
		return "Almashtirish"
	}
	return t
}
