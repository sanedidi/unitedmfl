package tgbot

import (
	"context"
	"errors"
	"fmt"
	"html"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
)

const (
	btnMatches = "📋 Matchlar"
	btnPhone   = "📱 Telefon raqamni yuborish"
)

var (
	askPhoneKeyboard = replyKeyboard{Keyboard: [][]keyButton{{{Text: btnPhone, RequestContact: true}}}, ResizeKeyboard: true, OneTime: true}
	menuKeyboard     = replyKeyboard{Keyboard: [][]keyButton{{{Text: btnMatches}}}, ResizeKeyboard: true, IsPersistent: true}
	removeKeyboard   = map[string]bool{"remove_keyboard": true}
)

const (
	textGreeting = "Assalomu alaykum! Bu <b>United MFL Live-pult</b> boti — faqat match operatorlari uchun.\n\nKirish uchun pastdagi tugma orqali telefon raqamingizni yuboring."
	textNoAccess = "⛔ <b>Ruxsat yo‘q.</b>\n\nBu bot faqat United MFL match operatorlari uchun. Raqamingiz ro‘yxatda bo‘lmasa, administratorga murojaat qiling."
	textNotOwn   = "Iltimos, pastdagi tugma orqali <b>o‘z</b> raqamingizni yuboring."
)

// ---------- messages ----------

func (b *Bot) onMessage(ctx context.Context, m *tgMessage) {
	if m.From == nil || m.Chat.Type != "private" {
		return
	}
	chatID := m.Chat.ID

	if m.Contact != nil {
		b.onContact(ctx, m)
		return
	}

	op, err := b.operatorFor(ctx, m.From.ID)
	if err != nil {
		slog.Error("telegram bot: access check", "err", err)
		b.sendText(ctx, chatID, "Ichki xato. Birozdan so‘ng urinib ko‘ring.", nil)
		return
	}
	text := strings.TrimSpace(m.Text)
	if op == nil {
		b.unlink(ctx, m.From.ID) // stale link: blocked, phone changed, role changed
		b.dropSession(chatID)
		if strings.HasPrefix(text, "/start") {
			b.sendText(ctx, chatID, textGreeting, askPhoneKeyboard)
		} else {
			b.sendText(ctx, chatID, textNoAccess+"\n\nRaqamingiz qo‘shilgan bo‘lsa, uni pastdagi tugma orqali yuboring.", askPhoneKeyboard)
		}
		return
	}

	s := b.sess(chatID)
	switch {
	case text == "/logout":
		b.unlink(ctx, m.From.ID)
		b.dropSession(chatID)
		b.sendText(ctx, chatID, "Siz botdan chiqdingiz. Qayta kirish uchun /start ni bosing.", removeKeyboard)
	default: // /start, /matches, «📋 Matchlar» or anything else: the match list
		if s.pending != nil {
			s.pending = nil
		}
		b.showList(ctx, op, chatID, 0)
	}
}

func (b *Bot) onContact(ctx context.Context, m *tgMessage) {
	chatID := m.Chat.ID
	if m.Contact.UserID != m.From.ID {
		// a forwarded or picked contact of someone else proves nothing
		b.sendText(ctx, chatID, textNotOwn, askPhoneKeyboard)
		return
	}
	op, err := b.link(ctx, m.From, chatID, m.Contact.PhoneNumber)
	if err != nil {
		slog.Error("telegram bot: link", "err", err)
		b.sendText(ctx, chatID, "Ichki xato. Birozdan so‘ng urinib ko‘ring.", nil)
		return
	}
	if op == nil {
		slog.Info("telegram bot: access denied", "tg_user_id", m.From.ID, "username", m.From.Username)
		b.sendText(ctx, chatID, textNoAccess, removeKeyboard)
		return
	}
	slog.Info("telegram bot: operator linked", "user_id", op.UserID, "tg_user_id", m.From.ID)
	b.sendText(ctx, chatID, fmt.Sprintf("✅ Xush kelibsiz, <b>%s</b>!\n\nMatchni tanlang — hisob, voqealar va taymlar shu yerdan boshqariladi. Sayt darhol yangilanadi.", html.EscapeString(op.Name)), menuKeyboard)
	b.showList(ctx, op, chatID, 0)
}

// ---------- callbacks ----------

func (b *Bot) onCallback(ctx context.Context, q *tgCallback) {
	if q.Message == nil || q.Message.Chat.Type != "private" {
		_ = b.tg.answer(ctx, q.ID, "", false)
		return
	}
	chatID, msgID := q.Message.Chat.ID, q.Message.MessageID
	op, err := b.operatorFor(ctx, q.From.ID)
	if err != nil {
		slog.Error("telegram bot: access check", "err", err)
		_ = b.tg.answer(ctx, q.ID, "Ichki xato", true)
		return
	}
	if op == nil {
		b.unlink(ctx, q.From.ID)
		b.dropSession(chatID)
		_ = b.tg.answer(ctx, q.ID, "⛔ Ruxsat yo‘q", true)
		_ = b.tg.edit(ctx, chatID, msgID, textNoAccess, &inlineKeyboard{Rows: [][]button{}})
		return
	}
	toast, alert, err := b.dispatch(ctx, op, chatID, msgID, q.Data)
	if err != nil {
		var ce *callError
		if !errors.As(err, &ce) {
			slog.Warn("telegram bot: action failed", "data", q.Data, "err", err)
		}
		toast, alert = "⚠️ "+err.Error(), true
	}
	if len([]rune(toast)) > 190 {
		toast = string([]rune(toast)[:190]) + "…"
	}
	_ = b.tg.answer(ctx, q.ID, toast, alert)
}

func (b *Bot) dispatch(ctx context.Context, op *operator, chatID int64, msgID int, data string) (toast string, alert bool, err error) {
	parts := strings.Split(data, ":")
	arg := func(i int) string {
		if i < len(parts) {
			return parts[i]
		}
		return ""
	}
	id, _ := strconv.ParseInt(arg(1), 10, 64)
	s := b.sess(chatID)

	switch parts[0] {
	case "L":
		s.pending = nil
		return "", false, b.showList(ctx, op, chatID, msgID)

	case "M":
		s.pending = nil
		return "", false, b.showConsole(ctx, op, chatID, msgID, id, nil)

	case "S":
		s.pending = nil
		if arg(2) == "a" {
			s.side[id] = "away"
		} else {
			s.side[id] = "home"
		}
		return "", false, b.showConsole(ctx, op, chatID, msgID, id, nil)

	case "E":
		return b.startEvent(ctx, op, chatID, msgID, s, id, arg(2))

	case "P":
		return b.pickPlayer(ctx, op, chatID, msgID, s, arg(1))

	case "T": // minute button of older bot versions: the minute is automatic now
		return "Daqiqa avtomatik — match soati bo‘yicha", false, nil

	case "R":
		return b.period(ctx, op, chatID, msgID, s, id, arg(2))

	case "G":
		s.pending = nil
		d, err := b.loadMatch(ctx, op, id)
		if err != nil {
			return "", false, err
		}
		text, kb := logScreen(d)
		return "", false, b.tg.edit(ctx, chatID, msgID, text, kb)

	case "D":
		eid, _ := strconv.ParseInt(arg(2), 10, 64)
		d, err := b.loadMatch(ctx, op, id)
		if err != nil {
			return "", false, err
		}
		for _, e := range d.Events {
			if e.ID == eid {
				text := "🗑 <b>Voqeani o‘chirish?</b>\n\n" + eventLine(&d.Match, e) + "\n\nHisob va saytdagi lenta avtomatik yangilanadi."
				kb := &inlineKeyboard{Rows: [][]button{
					{{Text: "✅ Ha, o‘chirish", Data: fmt.Sprintf("X:%d:%d", id, eid)}},
					{{Text: "⬅️ Orqaga", Data: fmt.Sprintf("G:%d", id)}},
				}}
				return "", false, b.tg.edit(ctx, chatID, msgID, text, kb)
			}
		}
		text, kb := logScreen(d)
		return "Voqea allaqachon o‘chirilgan", false, b.tg.edit(ctx, chatID, msgID, text, kb)

	case "X":
		eid, _ := strconv.ParseInt(arg(2), 10, 64)
		err := b.call(ctx, op, http.MethodDelete, fmt.Sprintf("/api/v1/admin/matches/%d/events/%d", id, eid), nil, "", nil)
		var ce *callError
		if err != nil && !(errors.As(err, &ce) && ce.Status == http.StatusNotFound) {
			return "", false, err
		}
		d, err := b.loadMatch(ctx, op, id)
		if err != nil {
			return "", false, err
		}
		text, kb := logScreen(d)
		return "🗑 O‘chirildi", false, b.tg.edit(ctx, chatID, msgID, text, kb)
	}
	return "Noma’lum tugma", false, nil
}

func (b *Bot) startEvent(ctx context.Context, op *operator, chatID int64, msgID int, s *session, id int64, code string) (string, bool, error) {
	k, ok := kindByCode(code)
	if !ok {
		return "Noma’lum hodisa", true, nil
	}
	d, err := b.loadMatch(ctx, op, id)
	if err != nil {
		return "", false, err
	}
	m := &d.Match
	shootout := k.typ == "shootout_scored" || k.typ == "shootout_missed"
	if !isLive(m) || m.Period == "HT" || shootout != (m.Period == "PEN") {
		_ = b.showConsole(ctx, op, chatID, msgID, id, d)
		return "Hozir bu hodisani kiritib bo‘lmaydi — pult yangilandi", true, nil
	}
	side := s.side[id]
	if side == "" {
		side = "home"
	}
	p := &pending{matchID: id, side: side, kind: k, key: newKey(), msgID: msgID}
	on, bench := currentLineup(d, side)
	if len(on)+len(bench) == 0 {
		t := m.Home
		if side == "away" {
			t = m.Away
		}
		if t != nil {
			on = b.squad(ctx, t.ID)
		}
	}
	if k.typ == "sub" {
		p.people = on
	} else {
		p.people = append(append([]person(nil), on...), bench...)
	}
	s.pending = p
	text, kb := pickerScreen(d, p, b.now())
	return "", false, b.tg.edit(ctx, chatID, msgID, text, kb)
}

func (b *Bot) pickPlayer(ctx context.Context, op *operator, chatID int64, msgID int, s *session, raw string) (string, bool, error) {
	p := s.pending
	if p == nil || p.msgID != msgID {
		return "Bu tugma eskirgan — pultni qayta oching", true, nil
	}
	idx, err := strconv.Atoi(raw)
	if err != nil || idx < -1 || idx >= len(p.people) {
		return "Bu tugma eskirgan", true, nil
	}
	var chosen *person
	if idx >= 0 {
		c := p.people[idx]
		chosen = &c
	}
	d, err := b.loadMatch(ctx, op, p.matchID)
	if err != nil {
		return "", false, err
	}

	if p.kind.typ == "sub" && p.out == nil {
		if chosen == nil {
			return "Kim chiqishini tanlang", true, nil
		}
		// step 2: who comes on — the bench, or the rest of the roster without a lineup
		p.out = chosen
		on, bench := currentLineup(d, p.side)
		if len(on)+len(bench) == 0 {
			var rest []person
			for _, x := range p.people {
				if !x.same(chosen.ID, chosen.Name) {
					rest = append(rest, x)
				}
			}
			bench = rest
		}
		p.people = bench
		text, kb := pickerScreen(d, p, b.now())
		return "", false, b.tg.edit(ctx, chatID, msgID, text, kb)
	}
	if p.kind.typ == "sub" && chosen == nil {
		return "Kim kirishini tanlang", true, nil
	}

	// the minute comes from the match clock at the moment the event is recorded
	m := &d.Match
	shootout := p.kind.typ == "shootout_scored" || p.kind.typ == "shootout_missed"
	if !isLive(m) || m.Period == "HT" || shootout != (m.Period == "PEN") {
		s.pending = nil
		_ = b.showConsole(ctx, op, chatID, msgID, p.matchID, d)
		return "Hozir bu hodisani kiritib bo‘lmaydi — pult yangilandi", true, nil
	}
	minute, extra, _ := clock(m, b.now())
	if shootout {
		minute, extra = 120, 0
	}
	body := map[string]any{
		"side": p.side, "type": p.kind.typ, "minute": minute, "extra_minute": extra,
		"player_id": nil, "player_name": "", "related_player_id": nil, "related_player_name": "", "source": "live",
	}
	if chosen != nil {
		body["player_id"], body["player_name"] = chosen.ID, chosen.Name
	}
	if p.out != nil { // substitution: player = coming on, related = going off
		body["related_player_id"], body["related_player_name"] = p.out.ID, p.out.Name
	}
	if err := b.call(ctx, op, http.MethodPost, fmt.Sprintf("/api/v1/admin/matches/%d/events", p.matchID), body, p.key, nil); err != nil {
		return "", false, err
	}
	s.pending = nil
	toast := fmt.Sprintf("✅ %s · %s · %s", minuteLabel(minute, extra), eventLabel[p.kind.typ], d.Match.teamName(p.side))
	if chosen != nil {
		toast += " · " + chosen.Name
	}
	return toast, false, b.showConsole(ctx, op, chatID, msgID, p.matchID, nil)
}

func (b *Bot) period(ctx context.Context, op *operator, chatID int64, msgID int, s *session, id int64, to string) (string, bool, error) {
	s.pending = nil
	if to == "FT" { // finishing is final for the standings: ask first
		d, err := b.loadMatch(ctx, op, id)
		if err != nil {
			return "", false, err
		}
		m := &d.Match
		text := fmt.Sprintf("🏁 <b>Matchni yakunlash?</b>\n\nYakuniy hisob: <b>%s %d:%d %s</b>", html.EscapeString(m.teamName("home")),
			score(m.HomeScore), score(m.AwayScore), html.EscapeString(m.teamName("away")))
		if m.HomePen != nil && m.AwayPen != nil {
			text += fmt.Sprintf("\nPenaltilar: %d:%d", *m.HomePen, *m.AwayPen)
		}
		text += "\n\nYakunlangach, natija turnir jadvaliga tushadi."
		kb := &inlineKeyboard{Rows: [][]button{
			{{Text: "🏁 Ha, yakunlash", Data: fmt.Sprintf("R:%d:FT!", id)}},
			{{Text: "⬅️ Orqaga", Data: fmt.Sprintf("M:%d", id)}},
		}}
		return "", false, b.tg.edit(ctx, chatID, msgID, text, kb)
	}
	to = strings.TrimSuffix(to, "!")
	if _, ok := periodDone[to]; !ok {
		return "Noma’lum davr", true, nil
	}
	var d matchDetail
	if err := b.call(ctx, op, http.MethodPost, fmt.Sprintf("/api/v1/admin/matches/%d/period", id), map[string]string{"period": to}, "", &d); err != nil {
		return "", false, err
	}
	return "✅ " + periodDone[to], false, b.showConsole(ctx, op, chatID, msgID, id, &d)
}

// ---------- screens ----------

func (b *Bot) sendText(ctx context.Context, chatID int64, text string, markup any) {
	if _, err := b.tg.send(ctx, chatID, text, markup); err != nil {
		slog.Warn("telegram send", "err", err)
	}
}

// show edits msgID, or sends a new message when msgID is 0.
func (b *Bot) show(ctx context.Context, chatID int64, msgID int, text string, kb *inlineKeyboard) error {
	if msgID == 0 {
		_, err := b.tg.send(ctx, chatID, text, kb)
		return err
	}
	return b.tg.edit(ctx, chatID, msgID, text, kb)
}

func (b *Bot) showList(ctx context.Context, op *operator, chatID int64, msgID int) error {
	list, err := b.activeMatches(ctx, op)
	if err != nil {
		if msgID == 0 {
			b.sendText(ctx, chatID, "⚠️ "+html.EscapeString(err.Error()), nil)
			return nil
		}
		return err
	}
	text := "📋 <b>Faol matchlar</b>\nMatchni tanlang:"
	rows := [][]button{}
	if len(list) == 0 {
		text = "📋 <b>Faol matchlar yo‘q</b>\n\nMatch admin panelning «Matchlar» bo‘limida yaratiladi."
	}
	for i, m := range list {
		if i == 20 {
			break
		}
		var label string
		if isLive(&m) {
			_, _, c := clock(&m, b.now())
			if m.Period == "HT" {
				c = "tanaffus"
			}
			label = fmt.Sprintf("🔴 %s %d:%d %s · %s", m.teamName("home"), score(m.HomeScore), score(m.AwayScore), m.teamName("away"), c)
		} else {
			label = fmt.Sprintf("%s · %s — %s", fmtKickoff(m.KickoffAt), m.teamName("home"), m.teamName("away"))
		}
		rows = append(rows, []button{{Text: label, Data: fmt.Sprintf("M:%d", m.ID)}})
	}
	rows = append(rows, []button{{Text: "🔄 Yangilash", Data: "L"}})
	return b.show(ctx, chatID, msgID, text, &inlineKeyboard{Rows: rows})
}

func (b *Bot) showConsole(ctx context.Context, op *operator, chatID int64, msgID int, id int64, d *matchDetail) error {
	if d == nil {
		var err error
		if d, err = b.loadMatch(ctx, op, id); err != nil {
			return err
		}
	}
	side := b.sess(chatID).side[id]
	if side == "" {
		side = "home"
	}
	text, kb := consoleScreen(d, side, b.now)
	return b.show(ctx, chatID, msgID, text, kb)
}
