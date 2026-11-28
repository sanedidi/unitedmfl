package media

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"time"
)

// ErrNoTeams: a plan needs a group with teams.
var ErrNoTeams = errors.New("guruhda jamoa yo‘q")

// Plan is a group's media plan.
type Plan struct {
	ID             int64   `json:"id"`
	GroupID        int64   `json:"group_id"`
	FinalMatchID   *int64  `json:"final_match_id"`
	FinalDate      string  `json:"final_date"`
	TeamIDs        []int64 `json:"team_ids"`
	PendingIgnored string  `json:"-"`
	PendingNotif   string  `json:"-"`
	// the date of the linked final match when it differs from final_date and the
	// admin has not decided yet (empty otherwise)
	MatchDate   string `json:"match_date"`
	PendingDate string `json:"pending_date"`
}

const planCols = `p.id, p.group_id, p.final_match_id, to_char(p.final_date,'YYYY-MM-DD'), array_to_json(p.team_ids),
	coalesce(to_char(p.pending_ignored,'YYYY-MM-DD'),''), coalesce(to_char(p.pending_notified,'YYYY-MM-DD'),''),
	coalesce(to_char(m.kickoff_at AT TIME ZONE 'Asia/Tashkent','YYYY-MM-DD'),'')`

func scanPlan(sc interface{ Scan(...any) error }) (*Plan, error) {
	var p Plan
	var ids []byte
	if err := sc.Scan(&p.ID, &p.GroupID, &p.FinalMatchID, &p.FinalDate, &ids, &p.PendingIgnored, &p.PendingNotif, &p.MatchDate); err != nil {
		return nil, err
	}
	_ = json.Unmarshal(ids, &p.TeamIDs)
	if p.FinalMatchID != nil && p.MatchDate != "" && p.MatchDate != p.FinalDate && p.MatchDate != p.PendingIgnored {
		p.PendingDate = p.MatchDate
	}
	return &p, nil
}

// LoadPlan returns the plan by id, or nil.
func LoadPlan(ctx context.Context, q Q, id int64) (*Plan, error) {
	p, err := scanPlan(q.QueryRowContext(ctx, `SELECT `+planCols+` FROM media_plans p LEFT JOIN matches m ON m.id = p.final_match_id WHERE p.id = $1`, id))
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	return p, err
}

// PlanForGroup returns the group's plan, or nil.
func PlanForGroup(ctx context.Context, q Q, groupID int64) (*Plan, error) {
	p, err := scanPlan(q.QueryRowContext(ctx, `SELECT `+planCols+` FROM media_plans p LEFT JOIN matches m ON m.id = p.final_match_id WHERE p.group_id = $1`, groupID))
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	return p, err
}

// Plans returns every plan.
func Plans(ctx context.Context, q Q) ([]*Plan, error) {
	rows, err := q.QueryContext(ctx, `SELECT `+planCols+` FROM media_plans p LEFT JOIN matches m ON m.id = p.final_match_id ORDER BY p.final_date, p.id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*Plan
	for rows.Next() {
		p, err := scanPlan(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	return out, rows.Err()
}

// GroupTeams are the active teams of a group in group order.
func GroupTeams(ctx context.Context, q Q, groupID int64) ([]int64, error) {
	rows, err := q.QueryContext(ctx, `SELECT id FROM teams WHERE group_id = $1 AND is_active ORDER BY group_ord, id`, groupID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []int64
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		out = append(out, id)
	}
	return out, rows.Err()
}

// MatchDay is the Tashkent day of a match kickoff ("" when it has none).
func MatchDay(ctx context.Context, q Q, matchID int64) (string, error) {
	var d sql.NullString
	err := q.QueryRowContext(ctx, `SELECT to_char(kickoff_at AT TIME ZONE 'Asia/Tashkent','YYYY-MM-DD') FROM matches WHERE id = $1`, matchID).Scan(&d)
	if errors.Is(err, sql.ErrNoRows) {
		return "", fmt.Errorf("match topilmadi")
	}
	return d.String, err
}

// CreatePlan makes the group's plan from the template. Tasks whose day has
// already passed are created too (the admin sees the whole plan), but the bot
// never reminds about them: see the scheduler.
func CreatePlan(ctx context.Context, q Q, groupID int64, matchID *int64, finalDate, actor string, now time.Time) (int64, error) {
	teams, err := GroupTeams(ctx, q, groupID)
	if err != nil {
		return 0, err
	}
	if len(teams) == 0 {
		return 0, ErrNoTeams
	}
	var id int64
	if err := q.QueryRowContext(ctx, `INSERT INTO media_plans (group_id, final_match_id, final_date, team_ids) VALUES ($1, $2, $3::date, $4::bigint[]) RETURNING id`,
		groupID, matchID, finalDate, int64Array(teams)).Scan(&id); err != nil {
		return 0, err
	}
	items, err := LoadTemplate(ctx, q)
	if err != nil {
		return 0, err
	}
	if err := Sync(ctx, q, id, items, false, now); err != nil {
		return 0, err
	}
	Event(ctx, q, id, nil, "plan", actor, "Reja shablondan yaratildi (final "+ShortDay(finalDate)+")")
	return id, nil
}

type existing struct {
	id     int64
	status string
	locked bool
	due    string
	link   string
}

// Sync brings a plan's tasks in line with the template and the plan's teams.
// Done, sent and hand-dated tasks are never touched. futureOnly keeps
// everything due today or earlier as it is (a running plan).
func Sync(ctx context.Context, q Q, planID int64, items []Item, futureOnly bool, now time.Time) error {
	p, err := LoadPlan(ctx, q, planID)
	if err != nil || p == nil {
		return err
	}
	today := Today(now)
	rows, err := q.QueryContext(ctx, `SELECT id, team_id, coalesce(item_id, 0), status, locked, to_char(due_date,'YYYY-MM-DD'), link FROM media_tasks WHERE plan_id = $1`, planID)
	if err != nil {
		return err
	}
	have := map[[2]int64]existing{}
	var all []existing
	for rows.Next() {
		var e existing
		var team, item int64
		if err := rows.Scan(&e.id, &team, &item, &e.status, &e.locked, &e.due, &e.link); err != nil {
			rows.Close()
			return err
		}
		have[[2]int64{team, item}] = e
		all = append(all, e)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}

	keep := map[int64]bool{}
	for pos, team := range p.TeamIDs {
		rivals := Rivals(p.TeamIDs, pos)
		for _, it := range items {
			var target *int64
			if it.Rival > 0 {
				if it.Rival > len(rivals) {
					continue // the group has no such rival
				}
				t := rivals[it.Rival-1]
				target = &t
			}
			off := OffsetFor(it.Offsets, pos)
			due := AddDays(p.FinalDate, off)
			e, ok := have[[2]int64{team, it.ID}]
			if ok {
				keep[e.id] = true
				if e.status == "review" || e.status == "done" || e.locked {
					continue
				}
				if futureOnly && (e.due <= today || due <= today) {
					continue
				}
				if _, err := q.ExecContext(ctx, `UPDATE media_tasks SET ord=$2, title=$3, short=$4, description=$5, stage=$6, with_bloggers=$7,
					sponsor=$8, target_team_id=$9, day_offset=$10, due_date=$11::date,
					evening_sent_at = CASE WHEN due_date = $11::date THEN evening_sent_at END,
					morning_sent_at = CASE WHEN due_date = $11::date THEN morning_sent_at END, updated_at=now() WHERE id=$1`,
					e.id, it.Ord, it.Title, it.Short, it.Description, it.Stage, it.WithBloggers, it.Sponsor, target, off, due); err != nil {
					return err
				}
				continue
			}
			if futureOnly && due <= today {
				continue
			}
			var id int64
			if err := q.QueryRowContext(ctx, `INSERT INTO media_tasks (plan_id, team_id, item_id, ord, title, short, description, stage, with_bloggers,
				sponsor, target_team_id, day_offset, due_date) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::date) RETURNING id`,
				planID, team, it.ID, it.Ord, it.Title, it.Short, it.Description, it.Stage, it.WithBloggers, it.Sponsor, target, off, due).Scan(&id); err != nil {
				return err
			}
			keep[id] = true
		}
	}
	// tasks of removed template items or teams that have not been started
	for _, e := range all {
		if keep[e.id] || e.status != "todo" || e.link != "" || e.locked {
			continue
		}
		if futureOnly && e.due <= today {
			continue
		}
		if _, err := q.ExecContext(ctx, `DELETE FROM media_tasks WHERE id = $1`, e.id); err != nil {
			return err
		}
	}
	return nil
}

// SetTeams changes the order (and membership) of the plan's teams and re-syncs.
func SetTeams(ctx context.Context, q Q, planID int64, teams []int64, actor string, now time.Time) error {
	if len(teams) == 0 {
		return ErrNoTeams
	}
	if _, err := q.ExecContext(ctx, `UPDATE media_plans SET team_ids=$2::bigint[], updated_at=now() WHERE id=$1`, planID, int64Array(teams)); err != nil {
		return err
	}
	items, err := LoadTemplate(ctx, q)
	if err != nil {
		return err
	}
	if err := Sync(ctx, q, planID, items, true, now); err != nil {
		return err
	}
	Event(ctx, q, planID, nil, "plan", actor, "Jamoalar tartibi o‘zgardi — kelgusi topshiriqlar qayta hisoblandi")
	return nil
}

// Movable are the tasks that follow the final when it moves: not sent, not
// done, not dated by hand, and not already overdue.
const movable = `status IN ('todo','returned') AND NOT locked AND due_date >= $2::date`

// movableT is movable for queries where the task table is aliased t.
const movableT = `t.status IN ('todo','returned') AND NOT t.locked AND t.due_date >= $2::date`

// MoveRow is one line of the move preview.
type MoveRow struct {
	TaskID int64  `json:"task_id"`
	TeamID int64  `json:"team_id"`
	Team   string `json:"team"`
	Label  string `json:"label"`
	From   string `json:"from"`
	To     string `json:"to"`
}

// MovePreview tells what moving the final to newDate would do.
type MovePreview struct {
	From    string    `json:"from"`
	To      string    `json:"to"`
	Days    int       `json:"days"`
	Moved   int       `json:"moved"`
	Kept    int       `json:"kept"`    // done or sent: stay
	Overdue int       `json:"overdue"` // already overdue: stay overdue
	Locked  int       `json:"locked"`
	Rows    []MoveRow `json:"rows"`
}

func Preview(ctx context.Context, q Q, p *Plan, newDate string, now time.Time) (*MovePreview, error) {
	today := Today(now)
	out := &MovePreview{From: p.FinalDate, To: newDate, Days: DaysBetween(p.FinalDate, newDate), Rows: []MoveRow{}}
	if err := q.QueryRowContext(ctx, `SELECT
		count(*) FILTER (WHERE `+movable+`),
		count(*) FILTER (WHERE status IN ('done','review')),
		count(*) FILTER (WHERE status IN ('todo','returned') AND NOT locked AND due_date < $2::date),
		count(*) FILTER (WHERE status IN ('todo','returned') AND locked)
		FROM media_tasks WHERE plan_id = $1`, p.ID, today).Scan(&out.Moved, &out.Kept, &out.Overdue, &out.Locked); err != nil {
		return nil, err
	}
	tasks, err := Tasks(ctx, q, "t.plan_id = $1 AND "+movableT+" ORDER BY t.due_date, t.ord, t.team_id", now, p.ID, today)
	if err != nil {
		return nil, err
	}
	for _, t := range tasks {
		to := AddDays(newDate, t.DayOffset)
		if to < today {
			to = today
		}
		out.Rows = append(out.Rows, MoveRow{TaskID: t.ID, TeamID: t.TeamID, Team: t.TeamName, Label: t.Label, From: t.DueDate, To: to})
	}
	return out, nil
}

// Move sets a new final date (and match) and moves the movable tasks after it.
// It returns how many tasks moved.
func Move(ctx context.Context, q Q, planID int64, matchID *int64, newDate, actor string, now time.Time) (int, error) {
	p, err := LoadPlan(ctx, q, planID)
	if err != nil || p == nil {
		return 0, err
	}
	today := Today(now)
	res, err := q.ExecContext(ctx, `UPDATE media_tasks SET due_date = greatest($3::date + day_offset, $2::date),
		evening_sent_at = NULL, morning_sent_at = NULL, overdue_sent_at = NULL, escalated_at = NULL, updated_at = now()
		WHERE plan_id = $1 AND `+movable, planID, today, newDate)
	if err != nil {
		return 0, err
	}
	n, _ := res.RowsAffected()
	if _, err := q.ExecContext(ctx, `UPDATE media_plans SET final_date=$2::date, final_match_id=$3, pending_ignored=NULL, pending_notified=NULL, updated_at=now() WHERE id=$1`,
		planID, newDate, matchID); err != nil {
		return 0, err
	}
	Event(ctx, q, planID, nil, "moved", actor, fmt.Sprintf("Final %s → %s ko‘chirildi, %d ta topshiriq surildi", ShortDay(p.FinalDate), ShortDay(newDate), n))
	return int(n), nil
}

// Keep leaves the plan as it is although the final match moved.
func Keep(ctx context.Context, q Q, p *Plan, actor string) error {
	if p.PendingDate == "" {
		return nil
	}
	if _, err := q.ExecContext(ctx, `UPDATE media_plans SET pending_ignored=$2::date, updated_at=now() WHERE id=$1`, p.ID, p.PendingDate); err != nil {
		return err
	}
	Event(ctx, q, p.ID, nil, "plan", actor, "Final "+ShortDay(p.PendingDate)+" ga ko‘chdi, reja o‘zgarmadi")
	return nil
}

// ---------- reading tasks ----------

const taskCols = `t.id, t.plan_id, p.group_id, g.code, t.team_id, tm.name, t.item_id, t.ord, t.title, t.short, t.description, t.stage,
	t.with_bloggers, t.sponsor, t.target_team_id, coalesce(tt.name,''), t.day_offset, to_char(t.due_date,'YYYY-MM-DD'), t.locked, t.status,
	t.link, t.checks, t.submitted_at, t.submitted_by, t.reviewed_at, coalesce(u.name,''), t.comment, t.note, to_char(p.final_date,'YYYY-MM-DD')`

const taskFrom = ` FROM media_tasks t JOIN media_plans p ON p.id = t.plan_id JOIN team_groups g ON g.id = p.group_id
	JOIN teams tm ON tm.id = t.team_id LEFT JOIN teams tt ON tt.id = t.target_team_id LEFT JOIN users u ON u.id = t.reviewed_by`

// Tasks runs a query over tasks: where is the condition (with ORDER BY/LIMIT).
func Tasks(ctx context.Context, q Q, where string, now time.Time, args ...any) ([]*Task, error) {
	rows, err := q.QueryContext(ctx, `SELECT `+taskCols+taskFrom+` WHERE `+where, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	today := Today(now)
	out := []*Task{}
	for rows.Next() {
		var t Task
		var checks []byte
		if err := rows.Scan(&t.ID, &t.PlanID, &t.GroupID, &t.GroupCode, &t.TeamID, &t.TeamName, &t.ItemID, &t.Ord, &t.Title, &t.Short, &t.Description,
			&t.Stage, &t.WithBloggers, &t.Sponsor, &t.TargetID, &t.TargetName, &t.DayOffset, &t.DueDate, &t.Locked, &t.Status,
			&t.Link, &checks, &t.SubmittedAt, &t.SubmittedBy, &t.ReviewedAt, &t.ReviewedBy, &t.Comment, &t.Note, &t.FinalDate); err != nil {
			return nil, err
		}
		_ = json.Unmarshal(checks, &t.Checks)
		t.fill(today)
		out = append(out, &t)
	}
	return out, rows.Err()
}

// GetTask returns one task, or nil.
func GetTask(ctx context.Context, q Q, id int64, now time.Time) (*Task, error) {
	list, err := Tasks(ctx, q, "t.id = $1", now, id)
	if err != nil || len(list) == 0 {
		return nil, err
	}
	return list[0], nil
}
