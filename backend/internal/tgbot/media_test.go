package tgbot

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http/httptest"
	"os"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/sanedidi/unitedmfl/backend/internal/api"
	"github.com/sanedidi/unitedmfl/backend/internal/auth"
	"github.com/sanedidi/unitedmfl/backend/internal/config"
	"github.com/sanedidi/unitedmfl/backend/internal/db"
	"github.com/sanedidi/unitedmfl/backend/internal/media"
)

// sentTo returns the texts and keyboards of messages sent to a chat.
func sentTo(calls []tgCall, chat int64) (texts []string, kbs []string) {
	for _, c := range calls {
		if c.Method != "sendMessage" && c.Method != "editMessageText" {
			continue
		}
		if id, _ := c.Params["chat_id"].(float64); int64(id) != chat {
			continue
		}
		txt, _ := c.Params["text"].(string)
		kb, _ := json.Marshal(c.Params["reply_markup"])
		texts = append(texts, txt)
		kbs = append(kbs, string(kb))
	}
	return
}

func has(list []string, sub string) bool {
	for _, s := range list {
		if strings.Contains(s, sub) {
			return true
		}
	}
	return false
}

// The whole Media reja flow in the bot against a real database:
//
//	TEST_DATABASE_URL=postgres://... go test -mod=vendor -run TestMediaBot ./internal/tgbot/
func TestMediaBot(t *testing.T) {
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("TEST_DATABASE_URL not set")
	}
	ctx := context.Background()
	conn, err := db.Open(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	if err := db.Migrate(ctx, conn); err != nil {
		t.Fatal(err)
	}
	must := func(q string, args ...any) {
		t.Helper()
		if _, err := conn.ExecContext(ctx, q, args...); err != nil {
			t.Fatalf("%s: %v", q, err)
		}
	}
	must(`DELETE FROM media_outbox`)
	must(`DELETE FROM telegram_links`)
	must(`DELETE FROM media_manager_links`)
	must(`DELETE FROM users WHERE email LIKE '%@media-bot.test'`)
	must(`UPDATE media_settings SET last_report_on = NULL`)

	sfx := strconv.FormatInt(time.Now().UnixNano()%1e9, 36)
	var groupID int64
	if err := conn.QueryRowContext(ctx, `INSERT INTO team_groups (season_id, name, code, ord) VALUES (NULL, 'Bot '||$1, upper(substr($1,1,4)), 98) RETURNING id`, sfx).Scan(&groupID); err != nil {
		t.Fatal(err)
	}
	team := func(name, insta string) int64 {
		var id int64
		if err := conn.QueryRowContext(ctx, `INSERT INTO teams (slug, name, instagram, group_id) VALUES ($1,$2,$3,$4) RETURNING id`,
			"mb-"+strings.ToLower(strings.ReplaceAll(name, " ", "-"))+"-"+sfx, name, insta, groupID).Scan(&id); err != nil {
			t.Fatal(err)
		}
		return id
	}
	alf, ben, pxi := team("Alfraganus", ""), team("Benom", ""), team("Prime XI", "@primexi.uz")
	defer func() {
		conn.ExecContext(ctx, `DELETE FROM teams WHERE id IN ($1,$2,$3)`, alf, ben, pxi)
		conn.ExecContext(ctx, `DELETE FROM team_groups WHERE id = $1`, groupID)
	}()
	_ = ben
	must(`UPDATE teams SET manager_name = 'Aziz', manager_phone = '998971113310' WHERE id = $1`, pxi)

	// a moderator role: Media reja only
	var roleSlug string
	if err := conn.QueryRowContext(ctx, `INSERT INTO roles (name, description) VALUES ('Media moderator '||$1, '') RETURNING slug`, sfx).Scan(&roleSlug); err != nil {
		t.Fatal(err)
	}
	defer conn.ExecContext(ctx, `DELETE FROM roles WHERE slug = $1`, roleSlug)
	must(`INSERT INTO role_permissions (role_id, perm) SELECT id, p FROM roles, unnest(ARRAY['media:view','media:edit']) p WHERE slug = $1`, roleSlug)
	hash, _ := auth.HashPassword("password-123")
	must(`INSERT INTO users (name, email, password_hash, role, phone) VALUES ('Moder Bot','mod@media-bot.test',$1,$2,'998909998877')`, hash, roleSlug)

	// the plan, made before the cycle started (so every task may be reminded)
	start := time.Date(2026, 11, 20, 10, 0, 0, 0, media.TZ)
	planID, err := media.CreatePlan(ctx, conn, groupID, nil, "2026-12-05", "test", start)
	if err != nil {
		t.Fatal(err)
	}
	must(`UPDATE media_tasks SET created_at = $2 WHERE plan_id = $1`, planID, start)
	taskID := func(teamID int64, title string) int64 {
		var id int64
		if err := conn.QueryRowContext(ctx, `SELECT id FROM media_tasks WHERE plan_id=$1 AND team_id=$2 AND title=$3`, planID, teamID, title).Scan(&id); err != nil {
			t.Fatalf("task %s: %v", title, err)
		}
		return id
	}
	chaq := taskID(pxi, "Chaqiruv — guruhga") // 27.11
	var click int64
	_ = conn.QueryRowContext(ctx, `SELECT id FROM media_tasks WHERE plan_id=$1 AND team_id=$2 AND sponsor='CLICK'`, planID, pxi).Scan(&click) // 28.11

	cfg, _ := config.Load()
	server := api.New(conn, cfg)
	fake := &fakeTelegram{}
	tgSrv := httptest.NewServer(fake)
	defer tgSrv.Close()
	b := New(Options{Token: "TEST", APIURL: tgSrv.URL, DB: conn, Tokens: server.Tokens, API: server.Routes()})
	clock := time.Date(2026, 11, 28, 8, 0, 0, 0, media.TZ)
	b.now = func() time.Time { return clock }

	const mgrTG, mgrChat, modTG, modChat = 701, 7001, 702, 7002
	msg := func(from, chat int64, text string, contact *tgContact) []tgCall {
		b.safeHandle(ctx, tgUpdate{Message: &tgMessage{MessageID: 1, From: &tgUser{ID: from, Username: "u" + strconv.FormatInt(from, 10), FirstName: "Test"},
			Chat: tgChat{ID: chat, Type: "private"}, Text: text, Contact: contact}})
		return fake.take()
	}
	cb := func(from, chat int64, data string) []tgCall {
		b.safeHandle(ctx, tgUpdate{CallbackQuery: &tgCallback{ID: "q", From: tgUser{ID: from}, Data: data,
			Message: &tgMessage{MessageID: 77, Chat: tgChat{ID: chat, Type: "private"}}}})
		return fake.take()
	}
	deliver := func() []tgCall {
		b.deliverOutbox(ctx)
		return fake.take()
	}

	// --- the manager links with the phone from the Media reja page ---
	texts, kbs := sentTo(msg(mgrTG, mgrChat, "", &tgContact{PhoneNumber: "+998 97 111 33 10", UserID: mgrTG}), mgrChat)
	if !has(texts, "Prime XI</b> jamoasi menejerisiz") || !has(texts, "Prime XI — Guruh") || !has(kbs, "QL:"+fmt.Sprint(click)) {
		t.Fatalf("manager welcome: %v %v", texts, kbs)
	}
	// a manager is not a Live-pult operator
	if a := answers(cb(mgrTG, mgrChat, "L")); !strings.Contains(a, "Ruxsat yo‘q") {
		t.Fatalf("manager in the Live-pult: %s", a)
	}
	// the moderator links too
	texts, _ = sentTo(msg(modTG, modChat, "", &tgContact{PhoneNumber: "998909998877", UserID: modTG}), modChat)
	if !has(texts, "Xush kelibsiz") || !has(texts, "/tekshiruv") {
		t.Fatalf("moderator welcome: %v", texts)
	}

	// --- 08:00: nothing yet; 09:05: the morning reminder of today's task ---
	b.mediaTick(ctx)
	if texts, _ = sentTo(fake.take(), mgrChat); len(texts) != 0 {
		t.Fatalf("no reminder before 09:00: %v", texts)
	}
	clock = time.Date(2026, 11, 28, 9, 5, 0, 0, media.TZ)
	b.mediaTick(ctx)
	texts, kbs = sentTo(fake.take(), mgrChat)
	if len(texts) != 1 || !strings.Contains(texts[0], "Bugun: <b>Homiy post (CLICK)</b>") || !has(kbs, "QL:"+fmt.Sprint(click)) {
		t.Fatalf("morning reminder: %v %v", texts, kbs)
	}
	b.mediaTick(ctx) // once per task
	if texts, _ = sentTo(fake.take(), mgrChat); len(texts) != 0 {
		t.Fatalf("reminder repeated: %v", texts)
	}

	// --- the manager presses «Joyladim» and sends the link ---
	cb(mgrTG, mgrChat, fmt.Sprintf("QL:%d", click))
	texts, _ = sentTo(msg(mgrTG, mgrChat, "salom", nil), mgrChat)
	if !has(texts, "o‘xshamaydi") {
		t.Fatalf("not a link: %v", texts)
	}
	texts, _ = sentTo(msg(mgrTG, mgrChat, "https://www.instagram.com/primexi.uz/reel/DCz4Pq123/", nil), mgrChat)
	if !has(texts, "Qabul qilindi") || !has(texts, "✓ Akkaunt @primexi.uz") {
		t.Fatalf("received: %v", texts)
	}
	texts, kbs = sentTo(deliver(), modChat)
	if !has(texts, "Tekshiruv: Prime XI") || !has(kbs, fmt.Sprintf("QA:%d", click)) {
		t.Fatalf("moderator card: %v %v", texts, kbs)
	}

	// --- the moderator returns it with a comment ---
	cb(modTG, modChat, fmt.Sprintf("QR:%d", click))
	texts, _ = sentTo(msg(modTG, modChat, "Click logotipi yo‘q", nil), modChat)
	if !has(texts, "Qaytarildi") {
		t.Fatalf("return: %v", texts)
	}
	texts, kbs = sentTo(deliver(), mgrChat)
	if !has(texts, "Click logotipi yo‘q") || !has(kbs, fmt.Sprintf("QL:%d", click)) {
		t.Fatalf("manager gets the comment: %v %v", texts, kbs)
	}

	// --- a bare link with two open tasks: the manager picks one ---
	texts, kbs = sentTo(msg(mgrTG, mgrChat, "instagram.com/p/NewPost123/", nil), mgrChat)
	if !has(texts, "qaysi topshiriq") || !has(kbs, fmt.Sprintf("QS:%d", click)) || !has(kbs, fmt.Sprintf("QS:%d", chaq)) {
		t.Fatalf("pick a task: %v %v", texts, kbs)
	}
	texts, _ = sentTo(cb(mgrTG, mgrChat, fmt.Sprintf("QS:%d", click)), mgrChat)
	if !has(texts, "Qabul qilindi") || !has(texts, "havolada ko‘rinmaydi") {
		t.Fatalf("picked: %v", texts)
	}
	deliver()
	// a manager cannot approve
	if a := answers(cb(mgrTG, mgrChat, fmt.Sprintf("QA:%d", click))); !strings.Contains(a, "Ruxsat yo‘q") {
		t.Fatalf("manager approves: %s", a)
	}
	c := cb(modTG, modChat, fmt.Sprintf("QA:%d", click))
	if !strings.Contains(answers(c), "Tasdiqlandi") {
		t.Fatalf("approve: %v", c)
	}
	texts, _ = sentTo(deliver(), mgrChat)
	if !has(texts, "Tasdiqlandi") || !has(texts, "1 / 7") {
		t.Fatalf("manager gets the approval: %v", texts)
	}

	// --- next day 10:05: the overdue reminder; 12:05: moderators get the list ---
	clock = time.Date(2026, 11, 29, 10, 5, 0, 0, media.TZ)
	b.mediaTick(ctx)
	calls := fake.take()
	texts, kbs = sentTo(calls, mgrChat)
	if !has(texts, "Muddat o‘tdi: Chaqiruv — guruhga") || !has(kbs, fmt.Sprintf("QN:%d", chaq)) {
		t.Fatalf("overdue: %v %v", texts, kbs)
	}
	cb(mgrTG, mgrChat, fmt.Sprintf("QN:%d", chaq))
	msg(mgrTG, mgrChat, "Bloger kasal bo‘lib qoldi", nil)
	texts, _ = sentTo(deliver(), modChat)
	if !has(texts, "Qila olmaydi") || !has(texts, "Bloger kasal") {
		t.Fatalf("note to moderators: %v", texts)
	}
	clock = time.Date(2026, 11, 29, 12, 5, 0, 0, media.TZ)
	b.mediaTick(ctx)
	texts, _ = sentTo(fake.take(), modChat)
	if !has(texts, "muddati o‘tgan") || !has(texts, "Prime XI") || !has(texts, "Benom") || !has(texts, "bot ulanmagan") {
		t.Fatalf("escalation: %v", texts)
	}

	// --- /reja and the daily report ---
	texts, _ = sentTo(msg(mgrTG, mgrChat, "/reja", nil), mgrChat)
	if !has(texts, "✅ 28.11") || !has(texts, "Bajarildi: 1 / 7") {
		t.Fatalf("/reja: %v", texts)
	}
	clock = time.Date(2026, 11, 29, 23, 5, 0, 0, media.TZ)
	b.mediaTick(ctx)
	texts, _ = sentTo(fake.take(), modChat)
	if !has(texts, "kunlik hisobot, 29.11") {
		t.Fatalf("daily report: %v", texts)
	}
	b.mediaTick(ctx)
	if texts, _ = sentTo(fake.take(), modChat); has(texts, "kunlik hisobot") {
		t.Fatal("report twice")
	}

	// --- the admin changes the manager's phone: the old link stops working ---
	must(`UPDATE teams SET manager_phone = '998900000000' WHERE id = $1`, pxi)
	if a := answers(cb(mgrTG, mgrChat, "QP")); !strings.Contains(a, "Ruxsat yo‘q") {
		t.Fatalf("after phone change: %s", a)
	}
}
