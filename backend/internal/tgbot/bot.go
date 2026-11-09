// Package tgbot is the Telegram Live-pult: match operators record a match from
// Telegram instead of the web console.
//
// Access: an administrator writes the operator's phone number on the user card
// (Foydalanuvchilar). The bot asks for the Telegram contact and lets in only an
// account whose own number matches an active user with the «live» permission;
// everybody else gets «Ruxsat yo‘q».
//
// Every action goes through the regular admin API handlers in-process, signed as
// that user, so validation, audit log, SSE broadcast and site revalidation behave
// exactly as in the web Live-pult.
package tgbot

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"errors"
	"log/slog"
	"net/http"
	"runtime/debug"
	"sync"
	"time"

	"github.com/sanedidi/unitedmfl/backend/internal/auth"
)

type Options struct {
	Token  string
	APIURL string // https://api.telegram.org
	DB     *sql.DB
	Tokens *auth.Issuer
	API    http.Handler // the API router (server.Routes())
}

type Bot struct {
	tg     *client
	db     *sql.DB
	tokens *auth.Issuer
	api    http.Handler
	now    func() time.Time

	mu       sync.Mutex
	sessions map[int64]*session // by chat id; lost on restart, which only resets the picker
}

// session is the per-chat console state.
type session struct {
	side    map[int64]string // match id → selected side
	pending *pending
}

// pending is an event being assembled in the player picker.
type pending struct {
	matchID       int64
	side          string
	kind          kind
	minute, extra int
	people        []person
	out           *person // substitution: the player leaving, chosen first
	key           string  // Idempotency-Key: a double tap records the event once
	msgID         int     // the picker message
	awaitMinute   bool
}

type operator struct {
	UserID int64
	Name   string
	Role   string
}

func New(o Options) *Bot {
	return &Bot{
		tg: newClient(o.APIURL, o.Token), db: o.DB, tokens: o.Tokens, api: o.API,
		now: time.Now, sessions: map[int64]*session{},
	}
}

// Run long-polls Telegram until ctx is cancelled. Updates are handled one by one,
// so two taps never race each other.
func (b *Bot) Run(ctx context.Context) {
	// polling does not work while a webhook is set
	if err := b.tg.call(ctx, "deleteWebhook", map[string]any{}, nil); err != nil {
		slog.Warn("telegram deleteWebhook", "err", err)
	}
	_ = b.tg.call(ctx, "setMyCommands", map[string]any{"commands": []map[string]string{
		{"command": "matches", "description": "Faol matchlar"},
		{"command": "start", "description": "Boshlash"},
		{"command": "logout", "description": "Botdan chiqish"},
	}}, nil)
	var me tgUser
	if err := b.tg.call(ctx, "getMe", map[string]any{}, &me); err != nil {
		slog.Error("telegram bot: getMe failed, check TELEGRAM_BOT_TOKEN", "err", err)
	} else {
		slog.Info("telegram bot started", "username", me.Username)
	}

	var offset int64
	backoff := time.Second
	for ctx.Err() == nil {
		updates, err := b.tg.getUpdates(ctx, offset)
		if err != nil {
			if ctx.Err() != nil {
				return
			}
			slog.Warn("telegram getUpdates", "err", err)
			select {
			case <-time.After(backoff):
			case <-ctx.Done():
				return
			}
			backoff = min(backoff*2, time.Minute)
			continue
		}
		backoff = time.Second
		for _, u := range updates {
			offset = u.UpdateID + 1
			b.safeHandle(ctx, u)
		}
	}
}

func (b *Bot) safeHandle(ctx context.Context, u tgUpdate) {
	defer func() {
		if r := recover(); r != nil {
			slog.Error("telegram bot panic", "panic", r, "stack", string(debug.Stack()))
		}
	}()
	hctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	switch {
	case u.CallbackQuery != nil:
		b.onCallback(hctx, u.CallbackQuery)
	case u.Message != nil:
		b.onMessage(hctx, u.Message)
	}
}

func (b *Bot) sess(chatID int64) *session {
	b.mu.Lock()
	defer b.mu.Unlock()
	s := b.sessions[chatID]
	if s == nil {
		s = &session{side: map[int64]string{}}
		b.sessions[chatID] = s
	}
	return s
}

func (b *Bot) dropSession(chatID int64) {
	b.mu.Lock()
	delete(b.sessions, chatID)
	b.mu.Unlock()
}

// ---------- access ----------

// operatorFor returns the linked user, or nil when the Telegram account has no
// access (never linked, user blocked, phone changed or removed, role without «live»).
func (b *Bot) operatorFor(ctx context.Context, tgUserID int64) (*operator, error) {
	var op operator
	err := b.db.QueryRowContext(ctx, `SELECT u.id, u.name, u.role FROM telegram_links t JOIN users u ON u.id = t.user_id
		WHERE t.tg_user_id = $1 AND u.status = 'active' AND u.phone = t.phone`, tgUserID).Scan(&op.UserID, &op.Name, &op.Role)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if !auth.Can(op.Role, auth.PermLive) {
		return nil, nil
	}
	return &op, nil
}

// link connects a Telegram account to the user whose phone matches the shared contact.
func (b *Bot) link(ctx context.Context, from *tgUser, chatID int64, rawPhone string) (*operator, error) {
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
	if !auth.Can(op.Role, auth.PermLive) {
		return nil, nil
	}
	if _, err := b.db.ExecContext(ctx, `INSERT INTO telegram_links (tg_user_id, user_id, phone, chat_id, username) VALUES ($1, $2, $3, $4, $5)
		ON CONFLICT (tg_user_id) DO UPDATE SET user_id = EXCLUDED.user_id, phone = EXCLUDED.phone, chat_id = EXCLUDED.chat_id,
		username = EXCLUDED.username, created_at = now()`, from.ID, op.UserID, phone, chatID, from.Username); err != nil {
		return nil, err
	}
	_, _ = b.db.ExecContext(ctx, `INSERT INTO audit_log (user_id, action, entity, entity_id, data) VALUES ($1, 'telegram_link', 'user', $1,
		jsonb_build_object('tg_user_id', $2::bigint, 'username', $3::text))`, op.UserID, from.ID, from.Username)
	return &op, nil
}

func (b *Bot) unlink(ctx context.Context, tgUserID int64) {
	_, _ = b.db.ExecContext(ctx, `DELETE FROM telegram_links WHERE tg_user_id = $1`, tgUserID)
}

func newKey() string {
	var x [12]byte
	_, _ = rand.Read(x[:])
	return "tg-" + hex.EncodeToString(x[:])
}
