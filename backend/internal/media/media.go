// Package media is the «Media reja»: every group gets an Instagram plan counted
// back from its final match (D−10 … D). Each team of the group gets the template
// tasks shifted by its position (1-, 2-, 3-jamoa). Team managers receive the
// tasks in the Telegram bot and send the post links back; moderators approve
// them in the admin or in the bot.
//
// The package holds the shared logic for the admin API (internal/api) and the
// bot (internal/tgbot); both talk to the database directly.
package media

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"html"
	"regexp"
	"strings"
	"time"
)

// TZ is the league's time zone; Tashkent has no daylight saving time.
var TZ = time.FixedZone("Asia/Tashkent", 5*3600)

const dayLayout = "2006-01-02"

// Q is what both *sql.DB and *sql.Tx provide.
type Q interface {
	ExecContext(ctx context.Context, query string, args ...any) (sql.Result, error)
	QueryContext(ctx context.Context, query string, args ...any) (*sql.Rows, error)
	QueryRowContext(ctx context.Context, query string, args ...any) *sql.Row
}

// Today is the Tashkent calendar day of now as "YYYY-MM-DD".
func Today(now time.Time) string { return now.In(TZ).Format(dayLayout) }

// AddDays shifts a "YYYY-MM-DD" day.
func AddDays(day string, n int) string {
	t, err := time.Parse(dayLayout, day)
	if err != nil {
		return day
	}
	return t.AddDate(0, 0, n).Format(dayLayout)
}

// DaysBetween is b − a in days.
func DaysBetween(a, b string) int {
	ta, e1 := time.Parse(dayLayout, a)
	tb, e2 := time.Parse(dayLayout, b)
	if e1 != nil || e2 != nil {
		return 0
	}
	return int(tb.Sub(ta).Hours() / 24)
}

// ValidDay reports whether s is a "YYYY-MM-DD" date.
func ValidDay(s string) bool {
	_, err := time.Parse(dayLayout, s)
	return err == nil
}

var weekdays = [...]string{"yakshanba", "dushanba", "seshanba", "chorshanba", "payshanba", "juma", "shanba"}
var months = [...]string{"", "yanvar", "fevral", "mart", "aprel", "may", "iyun", "iyul", "avgust", "sentabr", "oktabr", "noyabr", "dekabr"}

// HumanDay: "5-dekabr, shanba".
func HumanDay(day string) string {
	t, err := time.Parse(dayLayout, day)
	if err != nil {
		return day
	}
	return fmt.Sprintf("%d-%s, %s", t.Day(), months[t.Month()], weekdays[t.Weekday()])
}

// ShortDay: "05.12".
func ShortDay(day string) string {
	t, err := time.Parse(dayLayout, day)
	if err != nil {
		return day
	}
	return t.Format("02.01")
}

// ---------- settings ----------

// Settings are the reminder times ("HH:MM", Tashkent) and checks.
type Settings struct {
	EveningOn     bool   `json:"evening_on"`
	EveningTime   string `json:"evening_time"`
	MorningOn     bool   `json:"morning_on"`
	MorningTime   string `json:"morning_time"`
	DeadlineTime  string `json:"deadline_time"`
	OverdueOn     bool   `json:"overdue_on"`
	OverdueTime   string `json:"overdue_time"`
	EscalateTime  string `json:"escalate_time"`
	ReportOn      bool   `json:"report_on"`
	ReportTime    string `json:"report_time"`
	AutoCheck     bool   `json:"auto_check"`
	RequireReview bool   `json:"require_review"`
	LastReportOn  string `json:"-"`
}

func LoadSettings(ctx context.Context, q Q) (Settings, error) {
	var s Settings
	err := q.QueryRowContext(ctx, `SELECT evening_on, to_char(evening_time,'HH24:MI'), morning_on, to_char(morning_time,'HH24:MI'),
		to_char(deadline_time,'HH24:MI'), overdue_on, to_char(overdue_time,'HH24:MI'), to_char(escalate_time,'HH24:MI'),
		report_on, to_char(report_time,'HH24:MI'), auto_check, require_review, coalesce(to_char(last_report_on,'YYYY-MM-DD'),'')
		FROM media_settings WHERE id = 1`).Scan(&s.EveningOn, &s.EveningTime, &s.MorningOn, &s.MorningTime, &s.DeadlineTime,
		&s.OverdueOn, &s.OverdueTime, &s.EscalateTime, &s.ReportOn, &s.ReportTime, &s.AutoCheck, &s.RequireReview, &s.LastReportOn)
	if err == sql.ErrNoRows {
		_, _ = q.ExecContext(ctx, `INSERT INTO media_settings (id) VALUES (1) ON CONFLICT DO NOTHING`)
		return LoadSettings(ctx, q)
	}
	return s, err
}

var hhmm = regexp.MustCompile(`^([01]\d|2[0-3]):[0-5]\d$`)

// ValidTime reports whether s is "HH:MM".
func ValidTime(s string) bool { return hhmm.MatchString(s) }

func SaveSettings(ctx context.Context, q Q, s Settings) error {
	_, err := q.ExecContext(ctx, `UPDATE media_settings SET evening_on=$1, evening_time=$2::time, morning_on=$3, morning_time=$4::time,
		deadline_time=$5::time, overdue_on=$6, overdue_time=$7::time, escalate_time=$8::time, report_on=$9, report_time=$10::time,
		auto_check=$11, require_review=$12, updated_at=now() WHERE id = 1`,
		s.EveningOn, s.EveningTime, s.MorningOn, s.MorningTime, s.DeadlineTime, s.OverdueOn, s.OverdueTime, s.EscalateTime,
		s.ReportOn, s.ReportTime, s.AutoCheck, s.RequireReview)
	return err
}

// ---------- template ----------

// Item is one template task.
type Item struct {
	ID           int64  `json:"id"`
	Ord          int    `json:"ord"`
	Title        string `json:"title"`
	Short        string `json:"short"`
	Description  string `json:"description"`
	Stage        int    `json:"stage"`
	WithBloggers bool   `json:"with_bloggers"`
	Sponsor      string `json:"sponsor"`
	Rival        int    `json:"rival"`
	Offsets      []int  `json:"offsets"`
}

func LoadTemplate(ctx context.Context, q Q) ([]Item, error) {
	rows, err := q.QueryContext(ctx, `SELECT id, ord, title, short, description, stage, with_bloggers, sponsor, rival, array_to_json(offsets)
		FROM media_template_items ORDER BY ord, id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Item{}
	for rows.Next() {
		var it Item
		var offs []byte
		if err := rows.Scan(&it.ID, &it.Ord, &it.Title, &it.Short, &it.Description, &it.Stage, &it.WithBloggers, &it.Sponsor, &it.Rival, &offs); err != nil {
			return nil, err
		}
		_ = json.Unmarshal(offs, &it.Offsets)
		out = append(out, it)
	}
	return out, rows.Err()
}

func intArray(v []int) string {
	parts := make([]string, len(v))
	for i, x := range v {
		parts[i] = fmt.Sprint(x)
	}
	return "{" + strings.Join(parts, ",") + "}"
}

// SaveTemplate makes items the whole template: known ids are updated, new ones
// inserted, missing ones deleted. Items get their order from the slice. It
// returns the saved items with ids.
func SaveTemplate(ctx context.Context, q Q, items []Item) ([]Item, error) {
	keep := []int64{}
	for i := range items {
		it := &items[i]
		it.Ord = i + 1
		if it.ID > 0 {
			res, err := q.ExecContext(ctx, `UPDATE media_template_items SET ord=$2, title=$3, short=$4, description=$5, stage=$6,
				with_bloggers=$7, sponsor=$8, rival=$9, offsets=$10::int[], updated_at=now() WHERE id=$1`,
				it.ID, it.Ord, it.Title, it.Short, it.Description, it.Stage, it.WithBloggers, it.Sponsor, it.Rival, intArray(it.Offsets))
			if err != nil {
				return nil, err
			}
			if n, _ := res.RowsAffected(); n == 1 {
				keep = append(keep, it.ID)
				continue
			}
		}
		if err := q.QueryRowContext(ctx, `INSERT INTO media_template_items (ord, title, short, description, stage, with_bloggers, sponsor, rival, offsets)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::int[]) RETURNING id`,
			it.Ord, it.Title, it.Short, it.Description, it.Stage, it.WithBloggers, it.Sponsor, it.Rival, intArray(it.Offsets)).Scan(&it.ID); err != nil {
			return nil, err
		}
		keep = append(keep, it.ID)
	}
	if _, err := q.ExecContext(ctx, `DELETE FROM media_template_items WHERE NOT (id = ANY($1::bigint[]))`, int64Array(keep)); err != nil {
		return nil, err
	}
	return items, nil
}

func int64Array(v []int64) string {
	parts := make([]string, len(v))
	for i, x := range v {
		parts[i] = fmt.Sprint(x)
	}
	return "{" + strings.Join(parts, ",") + "}"
}

// OffsetFor is the day of the team at position pos (0-based). A group with more
// teams than the template has columns continues with the last step.
func OffsetFor(offsets []int, pos int) int {
	if len(offsets) == 0 {
		return 0
	}
	if pos < len(offsets) {
		return offsets[pos]
	}
	last := offsets[len(offsets)-1]
	step := 0
	if len(offsets) > 1 {
		step = last - offsets[len(offsets)-2]
	}
	return last + step*(pos-len(offsets)+1)
}

// Rivals are the other teams of the group, in group order.
func Rivals(teams []int64, pos int) []int64 {
	out := make([]int64, 0, len(teams))
	for i, t := range teams {
		if i != pos {
			out = append(out, t)
		}
	}
	return out
}

// ---------- Instagram links ----------

var (
	igPostRe  = regexp.MustCompile(`(?i)^(?:https?://)?(?:www\.|m\.)?instagram\.com/(?:([a-z0-9._]{1,30})/)?(p|reel|reels|tv)/([a-z0-9_-]{5,60})`)
	igStoryRe = regexp.MustCompile(`(?i)^(?:https?://)?(?:www\.|m\.)?instagram\.com/stories/([a-z0-9._]{1,30})/(\d{5,30})`)
	igHandle  = regexp.MustCompile(`(?i)^[a-z0-9._]{1,30}$`)
)

// Checks is what the bot could verify about a link.
type Checks struct {
	Kind    string `json:"kind"`              // post, reel, story
	Account string `json:"account"`           // match, mismatch, unknown
	Handle  string `json:"handle,omitempty"`  // the account in the link, when the link names one
	Team    string `json:"team,omitempty"`    // the team's account from its card
	OnTime  bool   `json:"on_time"`           // sent before the deadline of the due day
	Checked bool   `json:"checked,omitempty"` // auto checks were on
}

// TeamHandle turns the Instagram field of a team ("@primexi.uz", a profile URL)
// into a bare lower-case handle.
func TeamHandle(v string) string {
	v = strings.TrimSpace(v)
	if i := strings.Index(strings.ToLower(v), "instagram.com/"); i >= 0 {
		v = v[i+len("instagram.com/"):]
	}
	v = strings.TrimPrefix(v, "@")
	if i := strings.IndexAny(v, "/?#"); i >= 0 {
		v = v[:i]
	}
	v = strings.ToLower(v)
	if !igHandle.MatchString(v) {
		return ""
	}
	return v
}

// ParseLink finds an Instagram post, Reels or story link in text and returns it
// in a canonical form. ok=false when there is none.
func ParseLink(text, teamInstagram string) (link string, c Checks, ok bool) {
	team := TeamHandle(teamInstagram)
	c.Team = team
	for _, w := range strings.Fields(text) {
		w = strings.Trim(w, "<>()[]\"'«»,")
		if m := igPostRe.FindStringSubmatch(w); m != nil {
			kind := strings.ToLower(m[2])
			switch kind {
			case "reel", "reels":
				c.Kind, kind = "reel", "reel"
			case "tv":
				c.Kind = "reel"
			default:
				c.Kind = "post"
			}
			c.Handle = strings.ToLower(m[1])
			link = "https://www.instagram.com/" + kind + "/" + m[3] + "/"
		} else if m := igStoryRe.FindStringSubmatch(w); m != nil {
			c.Kind, c.Handle = "story", strings.ToLower(m[1])
			link = "https://www.instagram.com/stories/" + m[1] + "/" + m[2] + "/"
		} else {
			continue
		}
		switch {
		case c.Handle == "" || team == "":
			c.Account = "unknown"
		case c.Handle == team:
			c.Account = "match"
		default:
			c.Account = "mismatch"
		}
		return link, c, true
	}
	return "", Checks{}, false
}

// ---------- labels and messages ----------

// Task is a task with what the screens and messages need.
type Task struct {
	ID           int64      `json:"id"`
	PlanID       int64      `json:"plan_id"`
	GroupID      int64      `json:"group_id"`
	GroupCode    string     `json:"group_code"`
	TeamID       int64      `json:"team_id"`
	TeamName     string     `json:"team_name"`
	ItemID       *int64     `json:"item_id"`
	Ord          int        `json:"ord"`
	Title        string     `json:"title"`
	Short        string     `json:"short"`
	Description  string     `json:"description"`
	Stage        int        `json:"stage"`
	WithBloggers bool       `json:"with_bloggers"`
	Sponsor      string     `json:"sponsor"`
	TargetID     *int64     `json:"target_team_id"`
	TargetName   string     `json:"target_name"`
	DayOffset    int        `json:"day_offset"`
	DueDate      string     `json:"due_date"`
	Locked       bool       `json:"locked"`
	Status       string     `json:"status"`
	Link         string     `json:"link"`
	Checks       Checks     `json:"checks"`
	SubmittedAt  *time.Time `json:"submitted_at"`
	SubmittedBy  string     `json:"submitted_by"`
	ReviewedAt   *time.Time `json:"reviewed_at"`
	ReviewedBy   string     `json:"reviewed_by"`
	Comment      string     `json:"comment"`
	Note         string     `json:"note"`
	FinalDate    string     `json:"final_date"`
	// computed
	State string `json:"state"` // done, review, returned, overdue, today, upcoming
	Label string `json:"label"` // «Javob → Benom»
}

// Label is the short name of a task: «Javob → Benom», «Homiy post (CLICK)».
func Label(t *Task) string {
	switch {
	case t.TargetName != "":
		s := t.Short
		if s == "" {
			s = t.Title
		}
		return s + " → " + t.TargetName
	case t.Sponsor != "":
		return t.Title + " (" + t.Sponsor + ")"
	}
	return t.Title
}

// State is what the screens show: done, review, returned, overdue, today, upcoming.
func State(status, due, today string) string {
	switch status {
	case "done", "review":
		return status
	}
	switch {
	case due < today:
		return "overdue"
	case due == today:
		return "today"
	case status == "returned":
		return "returned"
	}
	return "upcoming"
}

func (t *Task) fill(today string) {
	t.Label = Label(t)
	t.State = State(t.Status, t.DueDate, today)
	if t.Status == "returned" && t.State != "overdue" {
		t.State = "returned"
	}
}

// Esc escapes text for Telegram HTML.
func Esc(s string) string { return html.EscapeString(s) }
