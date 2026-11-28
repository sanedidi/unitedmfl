package media

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"time"
)

// Button is a Telegram inline button (same JSON as the bot's).
type Button struct {
	Text string `json:"text"`
	Data string `json:"callback_data"`
}

// Event records something that happened to a plan or a task (the activity feed).
func Event(ctx context.Context, q Q, planID int64, taskID *int64, kind, actor, text string) {
	if _, err := q.ExecContext(ctx, `INSERT INTO media_task_events (plan_id, task_id, kind, actor, text) VALUES ($1,$2,$3,$4,$5)`,
		planID, taskID, kind, actor, text); err != nil {
		slog.Warn("media: event", "err", err)
	}
}

// Outbox asks the bot to deliver a message to a team's manager (teamID) or to
// every moderator.
func Outbox(ctx context.Context, q Q, teamID *int64, moderators bool, text string, rows [][]Button) error {
	if rows == nil {
		rows = [][]Button{}
	}
	b, _ := json.Marshal(rows)
	_, err := q.ExecContext(ctx, `INSERT INTO media_outbox (team_id, to_moderators, text, buttons) VALUES ($1,$2,$3,$4)`, teamID, moderators, text, b)
	return err
}

// Errors shown to the manager or the moderator as they are.
var (
	ErrDone     = errors.New("bu topshiriq allaqachon tasdiqlangan")
	ErrNoTask   = errors.New("topshiriq topilmadi")
	ErrNoLink   = errors.New("Instagram post yoki Reels havolasini yuboring")
	ErrComment  = errors.New("qaytarish uchun izoh yozing")
	ErrBadDay   = errors.New("sana noto‘g‘ri")
	ErrNotReady = errors.New("havola hali yuborilmagan")
)

// deadline is the moment a task's day ends.
func deadline(due, at string) time.Time {
	t, err := time.ParseInLocation("2006-01-02 15:04", due+" "+at, TZ)
	if err != nil {
		return time.Time{}
	}
	return t.Add(59 * time.Second)
}

// Submit stores the post link of a task. With «moderator tasdig‘i» off a link
// whose account is not wrong is approved at once. It returns the task after.
func Submit(ctx context.Context, q Q, taskID int64, text, by string, now time.Time) (*Task, error) {
	t, err := GetTask(ctx, q, taskID, now)
	if err != nil {
		return nil, err
	}
	if t == nil {
		return nil, ErrNoTask
	}
	if t.Status == "done" {
		return t, ErrDone
	}
	var insta string
	_ = q.QueryRowContext(ctx, `SELECT instagram FROM teams WHERE id = $1`, t.TeamID).Scan(&insta)
	link, checks, ok := ParseLink(text, insta)
	if !ok {
		return t, ErrNoLink
	}
	s, err := LoadSettings(ctx, q)
	if err != nil {
		return nil, err
	}
	checks.OnTime = !now.After(deadline(t.DueDate, s.DeadlineTime))
	checks.Checked = s.AutoCheck
	if !s.AutoCheck {
		checks.Account = "unknown"
	}
	status := "review"
	if !s.RequireReview && checks.Account != "mismatch" {
		status = "done"
	}
	cj, _ := json.Marshal(checks)
	if _, err := q.ExecContext(ctx, `UPDATE media_tasks SET status=$2, link=$3, checks=$4, submitted_at=$5, submitted_by=$6, comment='',
		reviewed_at = CASE WHEN $2 = 'done' THEN $5::timestamptz END, reviewed_by = NULL, updated_at=now() WHERE id=$1`,
		taskID, status, link, cj, now, by); err != nil {
		return nil, err
	}
	Event(ctx, q, t.PlanID, &t.ID, "submitted", by, fmt.Sprintf("%s «%s» havolasini yubordi", t.TeamName, t.Label))
	t, err = GetTask(ctx, q, taskID, now)
	if err != nil {
		return nil, err
	}
	if status == "review" {
		_ = Outbox(ctx, q, nil, true, ReviewText(t), ReviewButtons(t))
	}
	return t, nil
}

// Approve marks a task done (with or without a link: a moderator may check the
// post on Instagram by hand) and tells the manager.
func Approve(ctx context.Context, q Q, taskID int64, userID *int64, actor string, now time.Time) (*Task, error) {
	t, err := GetTask(ctx, q, taskID, now)
	if err != nil {
		return nil, err
	}
	if t == nil {
		return nil, ErrNoTask
	}
	if t.Status == "done" {
		return t, ErrDone
	}
	if _, err := q.ExecContext(ctx, `UPDATE media_tasks SET status='done', reviewed_at=$2, reviewed_by=$3, comment='', updated_at=now() WHERE id=$1`,
		taskID, now, userID); err != nil {
		return nil, err
	}
	Event(ctx, q, t.PlanID, &t.ID, "approved", actor, fmt.Sprintf("%s «%s» postini tasdiqladi", actor, t.Label))
	t, err = GetTask(ctx, q, taskID, now)
	if err != nil {
		return nil, err
	}
	done, total := Progress(ctx, q, t.PlanID, t.TeamID)
	text := fmt.Sprintf("🎉 <b>Tasdiqlandi:</b> %s\n\n%s: %d / %d bajarildi.", Esc(t.Label), Esc(t.TeamName), done, total)
	if next := NextTask(ctx, q, t.PlanID, t.TeamID, now); next != nil {
		text += fmt.Sprintf("\nKeyingisi: %s — %s.", ShortDay(next.DueDate), Esc(next.Label))
	}
	_ = Outbox(ctx, q, &t.TeamID, false, text, nil)
	return t, nil
}

// Return sends a task back to the manager with a comment.
func Return(ctx context.Context, q Q, taskID int64, userID *int64, actor, comment string, now time.Time) (*Task, error) {
	comment = strings.TrimSpace(comment)
	if comment == "" {
		return nil, ErrComment
	}
	t, err := GetTask(ctx, q, taskID, now)
	if err != nil {
		return nil, err
	}
	if t == nil {
		return nil, ErrNoTask
	}
	if _, err := q.ExecContext(ctx, `UPDATE media_tasks SET status='returned', reviewed_at=$2, reviewed_by=$3, comment=$4, updated_at=now() WHERE id=$1`,
		taskID, now, userID, comment); err != nil {
		return nil, err
	}
	Event(ctx, q, t.PlanID, &t.ID, "returned", actor, fmt.Sprintf("%s «%s» ni qaytardi: %s", actor, t.Label, comment))
	t, err = GetTask(ctx, q, taskID, now)
	if err != nil {
		return nil, err
	}
	text := fmt.Sprintf("↩️ <b>Qaytarildi:</b> %s\n\nModerator izohi: «%s».\nPostni tuzatib, havolani qayta yuboring.", Esc(t.Label), Esc(comment))
	_ = Outbox(ctx, q, &t.TeamID, false, text, [][]Button{{{Text: "🔗 Havolani qayta yuborish", Data: fmt.Sprintf("QL:%d", t.ID)}}})
	return t, nil
}

// Note stores what the manager wrote (late, cannot do it) and tells moderators.
func Note(ctx context.Context, q Q, taskID int64, by, kind, text string, now time.Time) (*Task, error) {
	text = strings.TrimSpace(text)
	t, err := GetTask(ctx, q, taskID, now)
	if err != nil || t == nil {
		if t == nil && err == nil {
			err = ErrNoTask
		}
		return nil, err
	}
	head := "⏰ Kechikadi"
	if kind == "cannot" {
		head = "❌ Qila olmaydi"
	}
	if _, err := q.ExecContext(ctx, `UPDATE media_tasks SET note=$2, updated_at=now() WHERE id=$1`, taskID, head+": "+text); err != nil {
		return nil, err
	}
	Event(ctx, q, t.PlanID, &t.ID, "note", by, fmt.Sprintf("%s — «%s»: %s. %s", t.TeamName, t.Label, strings.ToLower(strings.TrimPrefix(strings.TrimPrefix(head, "⏰ "), "❌ ")), text))
	_ = Outbox(ctx, q, nil, true, fmt.Sprintf("%s · <b>%s</b> · Guruh %s\n%s (%s)\n\n«%s»", head, Esc(t.TeamName), Esc(t.GroupCode),
		Esc(t.Label), ShortDay(t.DueDate), Esc(text)), nil)
	return t, nil
}

// SetDue dates a task by hand (it stops following the final) or, with day "",
// puts it back on the template day.
func SetDue(ctx context.Context, q Q, taskID int64, day, actor string, now time.Time) (*Task, error) {
	t, err := GetTask(ctx, q, taskID, now)
	if err != nil || t == nil {
		if t == nil && err == nil {
			err = ErrNoTask
		}
		return nil, err
	}
	if day == "" {
		day = AddDays(t.FinalDate, t.DayOffset)
		_, err = q.ExecContext(ctx, `UPDATE media_tasks SET due_date=$2::date, locked=false, evening_sent_at=NULL, morning_sent_at=NULL,
			overdue_sent_at=NULL, escalated_at=NULL, updated_at=now() WHERE id=$1`, taskID, day)
	} else {
		if !ValidDay(day) {
			return nil, ErrBadDay
		}
		_, err = q.ExecContext(ctx, `UPDATE media_tasks SET due_date=$2::date, locked=true, evening_sent_at=NULL, morning_sent_at=NULL,
			overdue_sent_at=NULL, escalated_at=NULL, updated_at=now() WHERE id=$1`, taskID, day)
	}
	if err != nil {
		return nil, err
	}
	Event(ctx, q, t.PlanID, &t.ID, "date", actor, fmt.Sprintf("«%s» (%s) sanasi: %s → %s", t.Label, t.TeamName, ShortDay(t.DueDate), ShortDay(day)))
	return GetTask(ctx, q, taskID, now)
}

// Progress is how many of a team's tasks in the plan are done.
func Progress(ctx context.Context, q Q, planID, teamID int64) (done, total int) {
	_ = q.QueryRowContext(ctx, `SELECT count(*) FILTER (WHERE status='done'), count(*) FROM media_tasks WHERE plan_id=$1 AND team_id=$2`, planID, teamID).Scan(&done, &total)
	return
}

// NextTask is the team's next open task after today.
func NextTask(ctx context.Context, q Q, planID, teamID int64, now time.Time) *Task {
	list, err := Tasks(ctx, q, `t.plan_id=$1 AND t.team_id=$2 AND t.status IN ('todo','returned') AND t.due_date > $3::date ORDER BY t.due_date, t.ord LIMIT 1`,
		now, planID, teamID, Today(now))
	if err != nil || len(list) == 0 {
		return nil
	}
	return list[0]
}

// ---------- texts ----------

func checksLines(t *Task) string {
	var b strings.Builder
	switch t.Checks.Kind {
	case "reel":
		b.WriteString("✓ Instagram Reels\n")
	case "story":
		b.WriteString("✓ Instagram stories\n")
	default:
		b.WriteString("✓ Instagram post\n")
	}
	switch t.Checks.Account {
	case "match":
		b.WriteString("✓ Akkaunt @" + Esc(t.Checks.Handle) + "\n")
	case "mismatch":
		b.WriteString("⚠️ Akkaunt @" + Esc(t.Checks.Handle) + " — jamoa akkaunti @" + Esc(t.Checks.Team) + " emas\n")
	default:
		b.WriteString("• Akkaunt havolada ko‘rinmaydi — moderator tekshiradi\n")
	}
	if t.Checks.OnTime {
		b.WriteString("✓ Muddatda")
	} else {
		b.WriteString("⚠️ Muddatdan keyin")
	}
	return b.String()
}

// ReceivedText answers the manager after a link.
func ReceivedText(t *Task) string {
	if t.Status == "done" {
		return fmt.Sprintf("🎉 <b>Qabul qilindi va tasdiqlandi:</b> %s\n\n%s", Esc(t.Label), checksLines(t))
	}
	return fmt.Sprintf("✅ <b>Qabul qilindi:</b> %s\n\n%s\n\nModerator tekshiradi — natijani shu yerga yozaman.", Esc(t.Label), checksLines(t))
}

// ReviewText is the card a moderator gets for a new link.
func ReviewText(t *Task) string {
	return fmt.Sprintf("🆕 <b>Tekshiruv: %s · Guruh %s</b>\n%s (%s)\n\n%s\n%s", Esc(t.TeamName), Esc(t.GroupCode), Esc(t.Label),
		ShortDay(t.DueDate), Esc(t.Link), checksLines(t))
}

func ReviewButtons(t *Task) [][]Button {
	return [][]Button{{{Text: "✅ Tasdiqlash", Data: fmt.Sprintf("QA:%d", t.ID)}, {Text: "↩️ Qaytarish", Data: fmt.Sprintf("QR:%d", t.ID)}}}
}

// ReminderText is the manager's reminder: kind evening (tomorrow), morning
// (today), overdue or remind (sent by the admin button).
func ReminderText(t *Task, s Settings, kind string) string {
	var b strings.Builder
	switch kind {
	case "evening":
		fmt.Fprintf(&b, "🔔 Ertaga, %s — <b>%s</b>\n\n", ShortDay(t.DueDate), Esc(t.Label))
	case "overdue":
		fmt.Fprintf(&b, "⚠️ <b>Muddat o‘tdi: %s</b>\n\nMuddat %s, %s edi. Postni joylang va havolasini yuboring — «kechikib bajarildi» deb belgilanadi.", Esc(t.Label), ShortDay(t.DueDate), s.DeadlineTime)
		return b.String()
	default:
		fmt.Fprintf(&b, "☀️ Bugun: <b>%s</b>\n\n", Esc(t.Label))
	}
	if t.Description != "" {
		b.WriteString(Esc(t.Description) + "\n")
	}
	if t.WithBloggers {
		b.WriteString("Blogerlar bilan.\n")
	}
	if t.Status == "returned" && t.Comment != "" {
		b.WriteString("Moderator izohi: «" + Esc(t.Comment) + "»\n")
	}
	if kind == "evening" {
		fmt.Fprintf(&b, "Muddat: %s, %s.", ShortDay(t.DueDate), s.DeadlineTime)
	} else {
		fmt.Fprintf(&b, "\nPost Instagram’da chiqqach, havolasini shu yerga yuboring. Muddat: bugun %s.", s.DeadlineTime)
	}
	return b.String()
}

func ReminderButtons(t *Task, kind string) [][]Button {
	send := Button{Text: "✅ Joyladim — havola yuborish", Data: fmt.Sprintf("QL:%d", t.ID)}
	if kind == "overdue" {
		return [][]Button{{send}, {{Text: "❌ Qila olmaymiz", Data: fmt.Sprintf("QN:%d", t.ID)}}}
	}
	if kind == "evening" {
		return [][]Button{{{Text: "📄 Brief", Data: fmt.Sprintf("QB:%d", t.ID)}}}
	}
	return [][]Button{{send}, {{Text: "⏰ Kechikadi", Data: fmt.Sprintf("QK:%d", t.ID)}, {Text: "📄 Brief", Data: fmt.Sprintf("QB:%d", t.ID)}}}
}

var stateIcon = map[string]string{"done": "✅", "review": "🟡", "returned": "↩️", "overdue": "⚠️", "today": "⏰", "upcoming": "⬜"}
var stateNote = map[string]string{"review": " — tekshiruvda", "returned": " — qaytarildi, qayta yuboring", "overdue": " — muddat o‘tdi", "today": " — bugun"}

// PlanText is the manager's /reja.
func PlanText(teamName, groupCode, finalDate string, tasks []*Task) string {
	var b strings.Builder
	fmt.Fprintf(&b, "📋 <b>%s — Guruh %s</b>\nFinal: %s\n\n", Esc(teamName), Esc(groupCode), HumanDay(finalDate))
	done := 0
	for _, t := range tasks {
		if t.Status == "done" {
			done++
		}
		line := ShortDay(t.DueDate) + "  " + Esc(t.Label)
		if t.DueDate == finalDate && t.DayOffset == 0 {
			line += " · FINAL"
		}
		fmt.Fprintf(&b, "%s %s%s\n", stateIcon[t.State], line, stateNote[t.State])
	}
	fmt.Fprintf(&b, "\n<b>Bajarildi: %d / %d</b>", done, len(tasks))
	return b.String()
}
