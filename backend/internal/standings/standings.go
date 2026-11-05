// Package standings computes league tables from finished match results.
package standings

import (
	"sort"
	"strings"
)

// Result is one finished match.
type Result struct {
	HomeID, AwayID       int64
	HomeGoals, AwayGoals int
	Order                int64 // chronological key (kickoff unix) for form
}

// Team is a participant with its group.
type Team struct {
	ID          int64
	Name        string
	Slug        string
	Group       string
	Provisional bool
}

// Rules are the points per outcome.
type Rules struct{ Win, Draw, Loss int }

// Row is one table row.
type Row struct {
	Position     int      `json:"position"`
	TeamID       int64    `json:"team_id"`
	Team         string   `json:"team"`
	Slug         string   `json:"slug"`
	Group        string   `json:"group"`
	Played       int      `json:"played"`
	Won          int      `json:"won"`
	Drawn        int      `json:"drawn"`
	Lost         int      `json:"lost"`
	GoalsFor     int      `json:"goals_for"`
	GoalsAgainst int      `json:"goals_against"`
	GoalDiff     int      `json:"goal_diff"`
	Adjustment   int      `json:"adjustment"`
	Points       int      `json:"points"`
	Form         []string `json:"form"` // last 5, newest last: W/D/L
}

// Compute builds rows per group. Adjustments map team id → points delta.
// Ordering: points, goal difference, goals for, name (head-to-head is not applied
// until the league confirms its tie-break rules).
func Compute(teams []Team, results []Result, adj map[int64]int, rules Rules) map[string][]Row {
	rows := map[int64]*Row{}
	for _, t := range teams {
		rows[t.ID] = &Row{TeamID: t.ID, Team: t.Name, Slug: t.Slug, Group: t.Group}
	}
	sorted := append([]Result(nil), results...)
	sort.SliceStable(sorted, func(i, j int) bool { return sorted[i].Order < sorted[j].Order })
	for _, r := range sorted {
		h, a := rows[r.HomeID], rows[r.AwayID]
		if h == nil || a == nil {
			continue
		}
		h.Played++
		a.Played++
		h.GoalsFor += r.HomeGoals
		h.GoalsAgainst += r.AwayGoals
		a.GoalsFor += r.AwayGoals
		a.GoalsAgainst += r.HomeGoals
		switch {
		case r.HomeGoals > r.AwayGoals:
			h.Won++
			a.Lost++
			h.Form = append(h.Form, "W")
			a.Form = append(a.Form, "L")
		case r.HomeGoals < r.AwayGoals:
			a.Won++
			h.Lost++
			h.Form = append(h.Form, "L")
			a.Form = append(a.Form, "W")
		default:
			h.Drawn++
			a.Drawn++
			h.Form = append(h.Form, "D")
			a.Form = append(a.Form, "D")
		}
	}
	out := map[string][]Row{}
	for _, row := range rows {
		row.GoalDiff = row.GoalsFor - row.GoalsAgainst
		row.Adjustment = adj[row.TeamID]
		row.Points = row.Won*rules.Win + row.Drawn*rules.Draw + row.Lost*rules.Loss + row.Adjustment
		if len(row.Form) > 5 {
			row.Form = row.Form[len(row.Form)-5:]
		}
		if row.Form == nil {
			row.Form = []string{}
		}
		out[row.Group] = append(out[row.Group], *row)
	}
	for g, list := range out {
		sort.SliceStable(list, func(i, j int) bool {
			a, b := list[i], list[j]
			if a.Points != b.Points {
				return a.Points > b.Points
			}
			if a.GoalDiff != b.GoalDiff {
				return a.GoalDiff > b.GoalDiff
			}
			if a.GoalsFor != b.GoalsFor {
				return a.GoalsFor > b.GoalsFor
			}
			return strings.ToLower(a.Team) < strings.ToLower(b.Team)
		})
		for i := range list {
			list[i].Position = i + 1
		}
		out[g] = list
	}
	return out
}
