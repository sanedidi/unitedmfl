package tgbot

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"strconv"
	"strings"
	"time"

	"github.com/sanedidi/unitedmfl/backend/internal/auth"
	"github.com/sanedidi/unitedmfl/backend/internal/media"
)

// The Media reja bot (Mode: ModeMedia) — a separate bot from the Live-pult.
//
// Team managers: the admin writes the manager's phone on the Media reja page;
// the manager shares the contact and gets the team's plan, reminders the
// evening before and the morning of each task, and sends the post links back.
//
// Moderators: admin users with «Media reja — tahrirlash» and a phone on their
// user card get every new link with «Tasdiqlash / Qaytarish», overdue
// escalations, a daily report and a note when a group's final moves.
//
// Callback data of this part starts with Q.

const (
	btnPlan = "📋 Mening rejam"

	mediaGreeting = "Assalomu alaykum! Bu <b>United MFL Media</b> boti — jamoa menejerlari va media moderatorlari uchun.\n\nKirish uchun pastdagi tugma orqali telefon raqamingizni yuboring."
	mediaNoAccess = "⛔ <b>Ruxsat yo‘q.</b>\n\nBu bot faqat United MFL jamoa menejerlari va media moderatorlari uchun. Raqamingiz ro‘yxatda bo‘lmasa, administratorga murojaat qiling."
)

var managerKeyboard = replyKeyboard{Keyboard: [][]keyButton{{{Text: btnPlan}}}, ResizeKeyboard: true, IsPersistent: true}

// awaiting is free text the chat is expected to send next.
type awaiting struct {
	kind   string // link, late, cannot, return
	taskID int64
}

type managerTeam struct {
	TeamID int64
	Name   string
}

// managerTeams are the teams whose manager this Telegram account is (the link is
// valid while the team card keeps the same phone).
func (b *Bot) managerTeams(ctx context.Context, tgUserID int64) ([]managerTeam, error) {
	rows, err := b.db.QueryContext(ctx, `SELECT t.id, t.name FROM media_manager_links l JOIN teams t ON t.id = l.team_id
		WHERE l.tg_user_id = $1 AND t.is_active AND t.manager_phone <> '' AND t.manager_phone = l.phone ORDER BY t.name`, tgUserID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []managerTeam
	for rows.Next() {
		var m managerTeam
		if err := rows.Scan(&m.TeamID, &m.Name); err != nil {
			return nil, err
		}
		out = append(out, m)
	}
	return out, rows.Err()
}

// linkManager connects a Telegram account to every team that has this manager phone.
func (b *Bot) linkManager(ctx context.Context, from *tgUser, chatID int64, rawPhone string) ([]managerTeam, error) {
	phone, ok := auth.NormalizePhone(rawPhone)
	if !ok || phone == "" {
		return nil, nil
	}
	rows, err := b.db.QueryContext(ctx, `SELECT id, name FROM teams WHERE manager_phone = $1 AND is_active ORDER BY name`, phone)
	if err != nil {
		return nil, err
	}
	var teams []managerTeam
	for rows.Next() {
		var m managerTeam
		if err := rows.Scan(&m.TeamID, &m.Name); err != nil {
			rows.Close()
			return nil, err
		}
		teams = append(teams, m)
	}
	rows.Close()
	name := strings.TrimSpace(from.FirstName)
	for _, t := range teams {
		if _, err := b.db.ExecContext(ctx, `INSERT INTO media_manager_links (tg_user_id, team_id, phone, chat_id, username, name) VALUES ($1,$2,$3,$4,$5,$6)
			ON CONFLICT (tg_user_id, team_id) DO UPDATE SET phone = EXCLUDED.phone, chat_id = EXCLUDED.chat_id, username = EXCLUDED.username,
			name = EXCLUDED.name, created_at = now()`, from.ID, t.TeamID, phone, chatID, from.Username, name); err != nil {
			return nil, err
		}
	}
	return teams, nil
}

// moderatorFor returns the linked admin user who may approve posts, or nil.
func (b *Bot) moderatorFor(ctx context.Context, tgUserID int64) (*operator, error) {
	var op operator
	err := b.db.QueryRowContext(ctx, `SELECT u.id, u.name, u.role FROM media_moderator_links t JOIN users u ON u.id = t.user_id
		WHERE t.tg_user_id = $1 AND u.status = 'active' AND u.phone = t.phone`, tgUserID).Scan(&op.UserID, &op.Name, &op.Role)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if !b.roles.Can(ctx, op.Role, auth.Key(auth.PermMedia, auth.ActEdit)) {
		return nil, nil
	}
	return &op, nil
}

// linkModerator connects a Telegram account to the admin user with this phone
// when the user may approve Media reja posts.
func (b *Bot) linkModerator(ctx context.Context, from *tgUser, chatID int64, rawPhone string) (*operator, error) {
	phone, ok := auth.NormalizePhone(rawPhone)
	if !ok || phone == "" {
		return nil, nil
	}
	var op operator
	err := b.db.QueryRowContext(ctx, `SELECT id, name, role FROM users WHERE phone = $1 AND status = 'active'`, phone).Scan(&op.UserID, &op.Name, &op.Role)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if !b.roles.Can(ctx, op.Role, auth.Key(auth.PermMedia, auth.ActEdit)) {
		return nil, nil
	}
	if _, err := b.db.ExecContext(ctx, `INSERT INTO media_moderator_links (tg_user_id, user_id, phone, chat_id, username) VALUES ($1,$2,$3,$4,$5)
		ON CONFLICT (tg_user_id) DO UPDATE SET user_id = EXCLUDED.user_id, phone = EXCLUDED.phone, chat_id = EXCLUDED.chat_id,
		username = EXCLUDED.username, created_at = now()`, from.ID, op.UserID, phone, chatID, from.Username); err != nil {
		return nil, err
	}
	return &op, nil
}

// onMediaBotMessage is every message of the Media reja bot.
func (b *Bot) onMediaBotMessage(ctx context.Context, m *tgMessage) {
	chatID := m.Chat.ID
	if m.Contact != nil {
		b.onMediaContact(ctx, m)
		return
	}
	text := strings.TrimSpace(m.Text)
	if text == "/logout" {
		_, _ = b.db.ExecContext(ctx, `DELETE FROM media_manager_links WHERE tg_user_id = $1`, m.From.ID)
		_, _ = b.db.ExecContext(ctx, `DELETE FROM media_moderator_links WHERE tg_user_id = $1`, m.From.ID)
		b.dropSession(chatID)
		b.sendText(ctx, chatID, "Siz botdan chiqdingiz. Qayta kirish uchun /start ni bosing.", removeKeyboard)
		return
	}
	if b.onMediaMessage(ctx, m) {
		return
	}
	if strings.HasPrefix(text, "/start") {
		b.sendText(ctx, chatID, mediaGreeting, askPhoneKeyboard)
		return
	}
	b.sendText(ctx, chatID, mediaNoAccess+"\n\nRaqamingiz qo‘shilgan bo‘lsa, uni pastdagi tugma orqali yuboring.", askPhoneKeyboard)
}

func (b *Bot) onMediaContact(ctx context.Context, m *tgMessage) {
	chatID := m.Chat.ID
	if m.Contact.UserID != m.From.ID {
		b.sendText(ctx, chatID, textNotOwn, askPhoneKeyboard)
		return
	}
	mod, err := b.linkModerator(ctx, m.From, chatID, m.Contact.PhoneNumber)
	if err != nil {
		slog.Error("media bot: link moderator", "err", err)
		b.sendText(ctx, chatID, "Ichki xato. Birozdan so‘ng urinib ko‘ring.", nil)
		return
	}
	teams, err := b.linkManager(ctx, m.From, chatID, m.Contact.PhoneNumber)
	if err != nil {
		slog.Error("media bot: link manager", "err", err)
		b.sendText(ctx, chatID, "Ichki xato. Birozdan so‘ng urinib ko‘ring.", nil)
		return
	}
	if mod == nil && len(teams) == 0 {
		slog.Info("media bot: access denied", "tg_user_id", m.From.ID, "username", m.From.Username)
		b.sendText(ctx, chatID, mediaNoAccess, removeKeyboard)
		return
	}
	if mod != nil {
		slog.Info("media bot: moderator linked", "user_id", mod.UserID, "tg_user_id", m.From.ID)
		var kb any = removeKeyboard
		if len(teams) > 0 {
			kb = nil
		}
		b.sendText(ctx, chatID, fmt.Sprintf("✅ Xush kelibsiz, <b>%s</b>!\n\nMenejerlar yuborgan Instagram havolalari shu yerga keladi — «Tasdiqlash» yoki «Qaytarish» ni bosing. Ro‘yxat: /tekshiruv", media.Esc(mod.Name)), kb)
	}
	if len(teams) > 0 {
		names := make([]string, len(teams))
		for i, t := range teams {
			names[i] = "<b>" + media.Esc(t.Name) + "</b>"
		}
		slog.Info("media bot: manager linked", "tg_user_id", m.From.ID, "teams", len(teams))
		b.sendText(ctx, chatID, "✅ Siz "+strings.Join(names, ", ")+" jamoasi menejerisiz.\n\nMedia reja topshiriqlarini oldingi kuni kechqurun va o‘sha kuni ertalab shu yerga yuboraman. Post chiqqach, havolasini shu yerga yuboring.", managerKeyboard)
		b.showManagerPlan(ctx, chatID, teams)
	}
}

func (b *Bot) ownsTask(teams []managerTeam, t *media.Task) bool {
	for _, m := range teams {
		if m.TeamID == t.TeamID {
			return true
		}
	}
	return false
}

// onMediaMessage handles a text message of a manager or a moderator. It
// returns false when the sender is neither.
func (b *Bot) onMediaMessage(ctx context.Context, m *tgMessage) bool {
	chatID := m.Chat.ID
	text := strings.TrimSpace(m.Text)
	s := b.sess(chatID)
	teams, err := b.managerTeams(ctx, m.From.ID)
	if err != nil {
		slog.Error("telegram bot: manager check", "err", err)
		return false
	}
	mod, err := b.moderatorFor(ctx, m.From.ID)
	if err != nil {
		slog.Error("telegram bot: moderator check", "err", err)
		return false
	}
	if len(teams) == 0 && mod == nil {
		s.await = nil
		return false
	}

	if s.await != nil {
		if strings.HasPrefix(text, "/") || text == btnPlan {
			s.await = nil // a command cancels the question
		} else {
			b.answerAwait(ctx, m, s, teams, mod)
			return true
		}
	}

	switch {
	case text == "/tekshiruv" && mod != nil:
		b.showQueue(ctx, chatID)
		return true
	case (text == "/reja" || text == btnPlan) && len(teams) > 0:
		b.showManagerPlan(ctx, chatID, teams)
		return true
	}
	if len(teams) > 0 {
		if _, _, ok := media.ParseLink(text, ""); ok {
			b.linkWithoutTask(ctx, m, s, teams)
			return true
		}
	}
	if len(teams) > 0 {
		b.showManagerPlan(ctx, chatID, teams)
		return true
	}
	b.showQueue(ctx, chatID)
	return true
}

func (b *Bot) answerAwait(ctx context.Context, m *tgMessage, s *session, teams []managerTeam, mod *operator) {
	chatID := m.Chat.ID
	text := strings.TrimSpace(m.Text)
	a := s.await
	now := b.now()
	switch a.kind {
	case "link":
		t, err := media.GetTask(ctx, b.db, a.taskID, now)
		if err != nil || t == nil || !b.ownsTask(teams, t) {
			s.await = nil
			b.sendText(ctx, chatID, "Topshiriq topilmadi. /reja", nil)
			return
		}
		t, err = media.Submit(ctx, b.db, a.taskID, text, managerName(m.From), now)
		switch {
		case errors.Is(err, media.ErrNoLink):
			b.sendText(ctx, chatID, "Bu Instagram havolasiga o‘xshamaydi. Post yoki Reels havolasini yuboring: instagram.com/p/… yoki instagram.com/reel/…", nil)
			return
		case errors.Is(err, media.ErrDone):
			s.await = nil
			b.sendText(ctx, chatID, "Bu topshiriq allaqachon tasdiqlangan ✅", nil)
			return
		case err != nil:
			slog.Error("media: submit", "err", err)
			b.sendText(ctx, chatID, "Ichki xato. Birozdan so‘ng urinib ko‘ring.", nil)
			return
		}
		s.await = nil
		b.sendText(ctx, chatID, media.ReceivedText(t), nil)
	case "late", "cannot":
		t, err := media.GetTask(ctx, b.db, a.taskID, now)
		s.await = nil
		if err != nil || t == nil || !b.ownsTask(teams, t) {
			b.sendText(ctx, chatID, "Topshiriq topilmadi. /reja", nil)
			return
		}
		if _, err := media.Note(ctx, b.db, a.taskID, managerName(m.From), a.kind, text, now); err != nil {
			slog.Error("media: note", "err", err)
		}
		b.sendText(ctx, chatID, "Rahmat, adminga yetkazildi.", nil)
	case "return":
		s.await = nil
		if mod == nil {
			b.sendText(ctx, chatID, mediaNoAccess, nil)
			return
		}
		uid := mod.UserID
		if _, err := media.Return(ctx, b.db, a.taskID, &uid, mod.Name, text, now); err != nil {
			b.sendText(ctx, chatID, "⚠️ "+media.Esc(err.Error()), nil)
			return
		}
		b.sendText(ctx, chatID, "↩️ Qaytarildi — menejerga yuborildi.", nil)
	}
}

func managerName(u *tgUser) string {
	n := strings.TrimSpace(u.FirstName)
	if u.Username != "" {
		if n != "" {
			n += " "
		}
		n += "@" + u.Username
	}
	if n == "" {
		n = "menejer"
	}
	return n + " (bot)"
}

// linkWithoutTask: the manager sent a link without pressing a task button. One
// open task due today or earlier takes it; several — the manager picks.
func (b *Bot) linkWithoutTask(ctx context.Context, m *tgMessage, s *session, teams []managerTeam) {
	now := b.now()
	ids := make([]int64, len(teams))
	for i, t := range teams {
		ids[i] = t.TeamID
	}
	open, err := media.Tasks(ctx, b.db, `t.team_id = ANY($1::bigint[]) AND t.status IN ('todo','returned') AND t.due_date <= $2::date
		AND p.final_date >= $2::date - 14 ORDER BY t.due_date DESC, t.ord LIMIT 6`, now, int64List(ids), media.Today(now))
	if err != nil {
		slog.Error("media: open tasks", "err", err)
		return
	}
	if len(open) == 0 {
		next, err := media.Tasks(ctx, b.db, `t.team_id = ANY($1::bigint[]) AND t.status IN ('todo','returned') AND t.due_date > $2::date
			ORDER BY t.due_date, t.ord LIMIT 1`, now, int64List(ids), media.Today(now))
		if err == nil {
			open = next
		}
	}
	switch len(open) {
	case 0:
		b.sendText(ctx, m.Chat.ID, "Ochiq topshiriq yo‘q — hammasi bajarilgan yoki yuborilgan. /reja", nil)
	case 1:
		s.await = &awaiting{kind: "link", taskID: open[0].ID}
		b.answerAwait(ctx, m, s, teams, nil)
	default:
		s.pendingLink = strings.TrimSpace(m.Text)
		rows := [][]button{}
		for _, t := range open {
			rows = append(rows, []button{{Text: fmt.Sprintf("%s · %s", media.ShortDay(t.DueDate), t.Label), Data: fmt.Sprintf("QS:%d", t.ID)}})
		}
		_, _ = b.tg.send(ctx, m.Chat.ID, "Bu havola qaysi topshiriq uchun?", &inlineKeyboard{Rows: rows})
	}
}

func int64List(v []int64) string {
	parts := make([]string, len(v))
	for i, x := range v {
		parts[i] = strconv.FormatInt(x, 10)
	}
	return "{" + strings.Join(parts, ",") + "}"
}

// teamPlan is the team's tasks in its latest plan.
func (b *Bot) teamPlan(ctx context.Context, teamID int64) (code, final string, tasks []*media.Task, err error) {
	var planID int64
	err = b.db.QueryRowContext(ctx, `SELECT t.plan_id FROM media_tasks t JOIN media_plans p ON p.id = t.plan_id WHERE t.team_id = $1
		ORDER BY p.final_date DESC LIMIT 1`, teamID).Scan(&planID)
	if errors.Is(err, sql.ErrNoRows) {
		return "", "", nil, nil
	}
	if err != nil {
		return
	}
	tasks, err = media.Tasks(ctx, b.db, `t.plan_id = $1 AND t.team_id = $2 ORDER BY t.due_date, t.ord`, b.now(), planID, teamID)
	if err != nil || len(tasks) == 0 {
		return
	}
	return tasks[0].GroupCode, tasks[0].FinalDate, tasks, nil
}

func (b *Bot) showManagerPlan(ctx context.Context, chatID int64, teams []managerTeam) {
	for _, mt := range teams {
		code, final, tasks, err := b.teamPlan(ctx, mt.TeamID)
		if err != nil {
			slog.Error("media: plan", "err", err)
			b.sendText(ctx, chatID, "Ichki xato. Birozdan so‘ng urinib ko‘ring.", nil)
			return
		}
		if len(tasks) == 0 {
			b.sendText(ctx, chatID, fmt.Sprintf("📋 <b>%s</b>\n\nMedia reja hali tuzilmagan. Reja tuzilgach, har bir topshiriqni shu yerga yuboraman.", media.Esc(mt.Name)), managerKeyboard)
			continue
		}
		rows := [][]button{}
		for _, t := range tasks {
			if (t.Status == "todo" || t.Status == "returned") && t.State != "upcoming" {
				rows = append(rows, []button{{Text: "🔗 Havola: " + t.Label, Data: fmt.Sprintf("QL:%d", t.ID)}})
				if len(rows) == 3 {
					break
				}
			}
		}
		rows = append(rows, []button{{Text: "📄 Brieflar", Data: fmt.Sprintf("QF:%d", mt.TeamID)}, {Text: "🔄 Yangilash", Data: "QP"}})
		_, err = b.tg.send(ctx, chatID, media.PlanText(mt.Name, code, final, tasks), &inlineKeyboard{Rows: rows})
		if err != nil {
			slog.Warn("telegram send", "err", err)
		}
	}
}

// showQueue lists the links waiting for a moderator.
func (b *Bot) showQueue(ctx context.Context, chatID int64) {
	tasks, err := media.Tasks(ctx, b.db, `t.status = 'review' ORDER BY t.submitted_at NULLS LAST LIMIT 20`, b.now())
	if err != nil {
		slog.Error("media: queue", "err", err)
		return
	}
	if len(tasks) == 0 {
		b.sendText(ctx, chatID, "🗂 <b>Media reja — tekshiruv</b>\n\nTekshiruvda havola yo‘q.", nil)
		return
	}
	rows := [][]button{}
	for _, t := range tasks {
		rows = append(rows, []button{{Text: fmt.Sprintf("%s · %s", t.TeamName, t.Label), Data: fmt.Sprintf("QV:%d", t.ID)}})
	}
	_, _ = b.tg.send(ctx, chatID, fmt.Sprintf("🗂 <b>Media reja — tekshiruv</b>\n\nTekshiruvda: %d ta havola. Ochish uchun tanlang:", len(tasks)), &inlineKeyboard{Rows: rows})
}

// onMediaCallback handles buttons whose data starts with Q.
func (b *Bot) onMediaCallback(ctx context.Context, q *tgCallback) {
	chatID, msgID := q.Message.Chat.ID, q.Message.MessageID
	parts := strings.Split(q.Data, ":")
	id, _ := strconv.ParseInt(func() string {
		if len(parts) > 1 {
			return parts[1]
		}
		return ""
	}(), 10, 64)
	now := b.now()
	s := b.sess(chatID)
	answer := func(text string, alert bool) { _ = b.tg.answer(ctx, q.ID, text, alert) }

	switch parts[0] {
	case "QA", "QR", "QQ", "QV": // moderator
		mod, err := b.moderatorFor(ctx, q.From.ID)
		if err != nil || mod == nil {
			answer("⛔ Ruxsat yo‘q", true)
			return
		}
		switch parts[0] {
		case "QQ":
			answer("", false)
			b.showQueue(ctx, chatID)
		case "QV":
			t, err := media.GetTask(ctx, b.db, id, now)
			if err != nil || t == nil {
				answer("Topshiriq topilmadi", true)
				return
			}
			answer("", false)
			var kb *inlineKeyboard
			if t.Status == "review" {
				kb = keyboardOf(media.ReviewButtons(t))
			}
			_, _ = b.tg.send(ctx, chatID, media.ReviewText(t), kb)
		case "QA":
			uid := mod.UserID
			t, err := media.Approve(ctx, b.db, id, &uid, mod.Name, now)
			if errors.Is(err, media.ErrDone) {
				answer("Allaqachon tasdiqlangan", false)
				_ = b.tg.edit(ctx, chatID, msgID, media.ReviewText(t)+"\n\n✅ <b>Tasdiqlangan</b>", &inlineKeyboard{Rows: [][]button{}})
				return
			}
			if err != nil || t == nil {
				answer("⚠️ Topshiriq topilmadi", true)
				return
			}
			answer("✅ Tasdiqlandi", false)
			_ = b.tg.edit(ctx, chatID, msgID, media.ReviewText(t)+"\n\n✅ <b>Tasdiqlandi</b> — "+media.Esc(mod.Name), &inlineKeyboard{Rows: [][]button{}})
		case "QR":
			t, err := media.GetTask(ctx, b.db, id, now)
			if err != nil || t == nil {
				answer("Topshiriq topilmadi", true)
				return
			}
			if t.Status == "done" {
				answer("Allaqachon tasdiqlangan", true)
				return
			}
			s.await = &awaiting{kind: "return", taskID: id}
			answer("", false)
			b.sendText(ctx, chatID, fmt.Sprintf("↩️ <b>%s · %s</b>\nMenejerga izoh yozing — nimani tuzatish kerak:", media.Esc(t.TeamName), media.Esc(t.Label)), nil)
		}
		return
	}

	teams, err := b.managerTeams(ctx, q.From.ID)
	if err != nil || len(teams) == 0 {
		answer("⛔ Ruxsat yo‘q", true)
		return
	}
	if parts[0] == "QP" {
		answer("", false)
		b.showManagerPlan(ctx, chatID, teams)
		return
	}
	if parts[0] == "QF" { // all briefs of the team
		answer("", false)
		for _, mt := range teams {
			if mt.TeamID != id {
				continue
			}
			_, _, tasks, err := b.teamPlan(ctx, id)
			if err != nil {
				return
			}
			var sb strings.Builder
			sb.WriteString("📄 <b>Brieflar — " + media.Esc(mt.Name) + "</b>\n")
			for _, t := range tasks {
				fmt.Fprintf(&sb, "\n<b>%s · %s</b>\n%s\n", media.ShortDay(t.DueDate), media.Esc(t.Label), media.Esc(t.Description))
			}
			b.sendText(ctx, chatID, sb.String(), nil)
		}
		return
	}
	t, err := media.GetTask(ctx, b.db, id, now)
	if err != nil || t == nil || !b.ownsTask(teams, t) {
		answer("Topshiriq topilmadi", true)
		return
	}
	switch parts[0] {
	case "QL":
		if t.Status == "done" {
			answer("Bu topshiriq allaqachon tasdiqlangan ✅", true)
			return
		}
		s.await = &awaiting{kind: "link", taskID: id}
		answer("", false)
		b.sendText(ctx, chatID, fmt.Sprintf("🔗 <b>%s</b>\nInstagram post yoki Reels havolasini yuboring.", media.Esc(t.Label)), nil)
	case "QS":
		link := s.pendingLink
		s.pendingLink = ""
		if link == "" {
			answer("Havolani qayta yuboring", true)
			return
		}
		answer("", false)
		s.await = &awaiting{kind: "link", taskID: id}
		b.answerAwait(ctx, &tgMessage{From: &q.From, Chat: q.Message.Chat, Text: link}, s, teams, nil)
	case "QK", "QN":
		kind, ask := "late", "⏰ Qachon joylaysiz va nima sababdan kechikadi? Bitta xabar bilan yozing — admin ko‘radi."
		if parts[0] == "QN" {
			kind, ask = "cannot", "❌ Sababini yozing — admin ko‘radi."
		}
		s.await = &awaiting{kind: kind, taskID: id}
		answer("", false)
		b.sendText(ctx, chatID, ask, nil)
	case "QB":
		answer("", false)
		settings, _ := media.LoadSettings(ctx, b.db)
		text := fmt.Sprintf("📄 <b>%s</b>\n%s\n\n%s", media.Esc(t.Label), media.HumanDay(t.DueDate), media.Esc(t.Description))
		if t.WithBloggers {
			text += "\nBlogerlar bilan."
		}
		text += fmt.Sprintf("\n\nMuddat: %s, %s.", media.ShortDay(t.DueDate), settings.DeadlineTime)
		b.sendText(ctx, chatID, text, keyboardOf([][]media.Button{{{Text: "✅ Joyladim — havola yuborish", Data: fmt.Sprintf("QL:%d", t.ID)}}}))
	default:
		answer("Noma’lum tugma", false)
	}
}

func keyboardOf(rows [][]media.Button) *inlineKeyboard {
	kb := &inlineKeyboard{Rows: [][]button{}}
	for _, r := range rows {
		row := []button{}
		for _, x := range r {
			row = append(row, button{Text: x.Text, Data: x.Data})
		}
		kb.Rows = append(kb.Rows, row)
	}
	return kb
}

// ---------- delivery and schedule ----------

// managerChats are the chats of a team's linked managers.
func (b *Bot) managerChats(ctx context.Context, teamID int64) []int64 {
	rows, err := b.db.QueryContext(ctx, `SELECT DISTINCT l.chat_id FROM media_manager_links l JOIN teams t ON t.id = l.team_id
		WHERE l.team_id = $1 AND t.manager_phone <> '' AND l.phone = t.manager_phone`, teamID)
	if err != nil {
		return nil
	}
	defer rows.Close()
	var out []int64
	for rows.Next() {
		var c int64
		if rows.Scan(&c) == nil {
			out = append(out, c)
		}
	}
	return out
}

// moderatorChats are the chats of linked users who may approve posts.
func (b *Bot) moderatorChats(ctx context.Context) []int64 {
	rows, err := b.db.QueryContext(ctx, `SELECT DISTINCT t.chat_id, u.role FROM media_moderator_links t JOIN users u ON u.id = t.user_id
		WHERE u.status = 'active' AND u.phone = t.phone`)
	if err != nil {
		return nil
	}
	defer rows.Close()
	var out []int64
	for rows.Next() {
		var c int64
		var role string
		if rows.Scan(&c, &role) == nil && b.roles.Can(ctx, role, auth.Key(auth.PermMedia, auth.ActEdit)) {
			out = append(out, c)
		}
	}
	return out
}

func (b *Bot) sendTo(ctx context.Context, chats []int64, text string, kb *inlineKeyboard) error {
	var last error
	for _, c := range chats {
		var markup any
		if kb != nil && len(kb.Rows) > 0 {
			markup = kb
		}
		if _, err := b.tg.send(ctx, c, text, markup); err != nil {
			slog.Warn("telegram send", "err", err, "chat", c)
			last = err
		}
	}
	return last
}

// runMedia delivers the outbox every few seconds and runs the reminders.
func (b *Bot) runMedia(ctx context.Context) {
	tick := time.NewTicker(4 * time.Second)
	defer tick.Stop()
	n := 0
	for {
		b.deliverOutbox(ctx)
		if n%8 == 0 {
			b.mediaTick(ctx)
		}
		n++
		select {
		case <-ctx.Done():
			return
		case <-tick.C:
		}
	}
}

func (b *Bot) deliverOutbox(ctx context.Context) {
	defer func() {
		if r := recover(); r != nil {
			slog.Error("media outbox panic", "panic", r)
		}
	}()
	rows, err := b.db.QueryContext(ctx, `SELECT id, team_id, to_moderators, text, buttons FROM media_outbox WHERE sent_at IS NULL AND attempts < 5 ORDER BY id LIMIT 50`)
	if err != nil {
		if ctx.Err() == nil {
			slog.Warn("media outbox", "err", err)
		}
		return
	}
	type msg struct {
		id     int64
		team   sql.NullInt64
		mods   bool
		text   string
		button []byte
	}
	var list []msg
	for rows.Next() {
		var m msg
		if rows.Scan(&m.id, &m.team, &m.mods, &m.text, &m.button) == nil {
			list = append(list, m)
		}
	}
	rows.Close()
	for _, m := range list {
		var mb [][]media.Button
		_ = json.Unmarshal(m.button, &mb)
		var chats []int64
		if m.mods {
			chats = b.moderatorChats(ctx)
		}
		if m.team.Valid {
			chats = append(chats, b.managerChats(ctx, m.team.Int64)...)
		}
		if err := b.sendTo(ctx, chats, m.text, keyboardOf(mb)); err != nil {
			_, _ = b.db.ExecContext(ctx, `UPDATE media_outbox SET attempts = attempts + 1 WHERE id = $1`, m.id)
			continue
		}
		_, _ = b.db.ExecContext(ctx, `UPDATE media_outbox SET sent_at = now() WHERE id = $1`, m.id)
	}
}

// open tasks whose reminder of this kind is due; created before their deadline,
// so a plan made late never floods the managers with old tasks
const remindable = `t.status IN ('todo','returned') AND t.created_at <= (t.due_date + $2::time) AT TIME ZONE 'Asia/Tashkent'`

// mediaTick sends the reminders whose time has come (each task once per kind).
func (b *Bot) mediaTick(ctx context.Context) {
	defer func() {
		if r := recover(); r != nil {
			slog.Error("media tick panic", "panic", r)
		}
	}()
	now := b.now()
	s, err := media.LoadSettings(ctx, b.db)
	if err != nil {
		if ctx.Err() == nil {
			slog.Warn("media settings", "err", err)
		}
		return
	}
	today := media.Today(now)
	hm := now.In(media.TZ).Format("15:04")

	remind := func(kind, col, where string, args ...any) {
		tasks, err := media.Tasks(ctx, b.db, where+` AND t.`+col+` IS NULL ORDER BY t.due_date, t.ord LIMIT 200`, now, args...)
		if err != nil {
			slog.Warn("media reminders", "kind", kind, "err", err)
			return
		}
		for _, t := range tasks {
			if chats := b.managerChats(ctx, t.TeamID); len(chats) > 0 {
				_ = b.sendTo(ctx, chats, media.ReminderText(t, s, kind), keyboardOf(media.ReminderButtons(t, kind)))
				media.Event(ctx, b.db, t.PlanID, &t.ID, "reminder", "bot", fmt.Sprintf("Bot eslatma yubordi: %s — «%s»", t.TeamName, t.Label))
			}
			_, _ = b.db.ExecContext(ctx, `UPDATE media_tasks SET `+col+` = now() WHERE id = $1`, t.ID)
		}
	}
	if s.EveningOn && hm >= s.EveningTime {
		remind("evening", "evening_sent_at", `t.due_date = $1::date + 1 AND `+remindable, today, s.DeadlineTime)
	}
	if s.MorningOn && hm >= s.MorningTime {
		remind("morning", "morning_sent_at", `t.due_date = $1::date AND `+remindable, today, s.DeadlineTime)
	}
	if s.OverdueOn && hm >= s.OverdueTime {
		remind("overdue", "overdue_sent_at", `t.due_date < $1::date AND t.due_date >= $1::date - 3 AND `+remindable, today, s.DeadlineTime)
	}
	if hm >= s.EscalateTime {
		b.escalate(ctx, now, today, s)
	}
	if s.ReportOn && hm >= s.ReportTime && s.LastReportOn != today {
		b.dailyReport(ctx, now, today)
	}
	b.notifyMovedFinals(ctx)
}

// escalate tells moderators about tasks still open the day after their deadline.
func (b *Bot) escalate(ctx context.Context, now time.Time, today string, s media.Settings) {
	tasks, err := media.Tasks(ctx, b.db, `t.due_date < $1::date AND t.due_date >= $1::date - 3 AND `+remindable+` AND t.escalated_at IS NULL
		ORDER BY t.due_date, g.code, t.team_id LIMIT 100`, now, today, s.DeadlineTime)
	if err != nil || len(tasks) == 0 {
		return
	}
	var sb strings.Builder
	sb.WriteString("⚠️ <b>Media reja — muddati o‘tgan topshiriqlar</b>\n")
	for _, t := range tasks {
		bot := ""
		if len(b.managerChats(ctx, t.TeamID)) == 0 {
			bot = " · bot ulanmagan"
		}
		note := ""
		if t.Note != "" {
			note = "\n   " + media.Esc(t.Note)
		}
		fmt.Fprintf(&sb, "\n• Guruh %s · <b>%s</b> — %s (%s)%s%s", media.Esc(t.GroupCode), media.Esc(t.TeamName), media.Esc(t.Label), media.ShortDay(t.DueDate), bot, note)
	}
	if err := b.sendTo(ctx, b.moderatorChats(ctx), sb.String(), nil); err != nil {
		return
	}
	for _, t := range tasks {
		_, _ = b.db.ExecContext(ctx, `UPDATE media_tasks SET escalated_at = now() WHERE id = $1`, t.ID)
	}
}

func (b *Bot) dailyReport(ctx context.Context, now time.Time, today string) {
	// mark first: a failed send must not repeat the report every tick
	if _, err := b.db.ExecContext(ctx, `UPDATE media_settings SET last_report_on = $1::date WHERE id = 1`, today); err != nil {
		return
	}
	var total, done, review, overdue int
	if err := b.db.QueryRowContext(ctx, `SELECT count(*) FILTER (WHERE due_date = $1::date), count(*) FILTER (WHERE due_date = $1::date AND status = 'done'),
		count(*) FILTER (WHERE status = 'review'), count(*) FILTER (WHERE status IN ('todo','returned') AND due_date <= $1::date AND due_date >= $1::date - 3)
		FROM media_tasks`, today).Scan(&total, &done, &review, &overdue); err != nil {
		return
	}
	if total == 0 && review == 0 && overdue == 0 {
		return
	}
	open, _ := media.Tasks(ctx, b.db, `t.status IN ('todo','returned') AND t.due_date <= $1::date AND t.due_date >= $1::date - 3
		ORDER BY t.due_date, g.code LIMIT 10`, now, today)
	var sb strings.Builder
	fmt.Fprintf(&sb, "📊 <b>Media reja — kunlik hisobot, %s</b>\n\nBugungi topshiriqlar: %d / %d bajarildi\nTekshiruvda: %d", media.ShortDay(today), done, total, review)
	if len(open) > 0 {
		sb.WriteString("\n\nBajarilmagan:")
		for _, t := range open {
			fmt.Fprintf(&sb, "\n• %s — %s (%s)", media.Esc(t.TeamName), media.Esc(t.Label), media.ShortDay(t.DueDate))
		}
	}
	kb := &inlineKeyboard{Rows: [][]button{}}
	if review > 0 {
		kb.Rows = append(kb.Rows, []button{{Text: "🗂 Tekshiruv", Data: "QQ"}})
	}
	_ = b.sendTo(ctx, b.moderatorChats(ctx), sb.String(), kb)
}

// notifyMovedFinals tells moderators once when a group's final match moved and
// the plan waits for a decision in the admin.
func (b *Bot) notifyMovedFinals(ctx context.Context) {
	plans, err := media.Plans(ctx, b.db)
	if err != nil {
		return
	}
	for _, p := range plans {
		if p.PendingDate == "" || p.PendingNotif == p.PendingDate {
			continue
		}
		var code string
		_ = b.db.QueryRowContext(ctx, `SELECT code FROM team_groups WHERE id = $1`, p.GroupID).Scan(&code)
		text := fmt.Sprintf("📅 <b>Guruh %s finali ko‘chirildi:</b> %s → %s\n\nMedia rejani surish yoki o‘zgartirmaslikni admin paneldagi «Media reja» bo‘limida tanlang.",
			media.Esc(code), media.ShortDay(p.FinalDate), media.ShortDay(p.PendingDate))
		_ = b.sendTo(ctx, b.moderatorChats(ctx), text, nil)
		_, _ = b.db.ExecContext(ctx, `UPDATE media_plans SET pending_notified = $2::date WHERE id = $1`, p.ID, p.PendingDate)
	}
}
