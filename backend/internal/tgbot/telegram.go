package tgbot

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"
)

// Minimal Telegram Bot API client: only what the Live-pult needs, standard library only.

type tgUser struct {
	ID        int64  `json:"id"`
	Username  string `json:"username"`
	FirstName string `json:"first_name"`
}

type tgChat struct {
	ID   int64  `json:"id"`
	Type string `json:"type"`
}

type tgContact struct {
	PhoneNumber string `json:"phone_number"`
	UserID      int64  `json:"user_id"`
}

type tgMessage struct {
	MessageID int        `json:"message_id"`
	From      *tgUser    `json:"from"`
	Chat      tgChat     `json:"chat"`
	Text      string     `json:"text"`
	Contact   *tgContact `json:"contact"`
}

type tgCallback struct {
	ID      string     `json:"id"`
	From    tgUser     `json:"from"`
	Message *tgMessage `json:"message"`
	Data    string     `json:"data"`
}

type tgUpdate struct {
	UpdateID      int64       `json:"update_id"`
	Message       *tgMessage  `json:"message"`
	CallbackQuery *tgCallback `json:"callback_query"`
}

type button struct {
	Text string `json:"text"`
	Data string `json:"callback_data"`
}

type inlineKeyboard struct {
	Rows [][]button `json:"inline_keyboard"`
}

type keyButton struct {
	Text           string `json:"text"`
	RequestContact bool   `json:"request_contact,omitempty"`
}

type replyKeyboard struct {
	Keyboard       [][]keyButton `json:"keyboard"`
	ResizeKeyboard bool          `json:"resize_keyboard"`
	IsPersistent   bool          `json:"is_persistent,omitempty"`
	OneTime        bool          `json:"one_time_keyboard,omitempty"`
}

type apiError struct {
	Code        int
	Description string
}

func (e *apiError) Error() string { return fmt.Sprintf("telegram %d: %s", e.Code, e.Description) }

func isNotModified(err error) bool {
	e, ok := err.(*apiError)
	return ok && strings.Contains(e.Description, "message is not modified")
}

type client struct {
	base string // https://api.telegram.org/bot<token>/
	http *http.Client
}

func newClient(apiURL, token string) *client {
	return &client{base: strings.TrimRight(apiURL, "/") + "/bot" + token + "/", http: &http.Client{Timeout: 70 * time.Second}}
}

func (c *client) call(ctx context.Context, method string, params any, out any) error {
	body, err := json.Marshal(params)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.base+method, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := c.http.Do(req)
	if err != nil {
		// never leak the token: the URL is in *url.Error
		return fmt.Errorf("telegram %s: request failed", method)
	}
	defer resp.Body.Close()
	var r struct {
		OK          bool            `json:"ok"`
		Result      json.RawMessage `json:"result"`
		ErrorCode   int             `json:"error_code"`
		Description string          `json:"description"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&r); err != nil {
		return fmt.Errorf("telegram %s: bad response (HTTP %d)", method, resp.StatusCode)
	}
	if !r.OK {
		return &apiError{Code: r.ErrorCode, Description: r.Description}
	}
	if out != nil {
		return json.Unmarshal(r.Result, out)
	}
	return nil
}

func (c *client) getUpdates(ctx context.Context, offset int64) ([]tgUpdate, error) {
	var out []tgUpdate
	err := c.call(ctx, "getUpdates", map[string]any{
		"offset": offset, "timeout": 50, "allowed_updates": []string{"message", "callback_query"},
	}, &out)
	return out, err
}

// send posts a new message and returns its id.
func (c *client) send(ctx context.Context, chatID int64, text string, markup any) (int, error) {
	p := map[string]any{"chat_id": chatID, "text": text, "parse_mode": "HTML", "link_preview_options": map[string]bool{"is_disabled": true}}
	if markup != nil {
		p["reply_markup"] = markup
	}
	var m tgMessage
	err := c.call(ctx, "sendMessage", p, &m)
	return m.MessageID, err
}

func (c *client) edit(ctx context.Context, chatID int64, msgID int, text string, kb *inlineKeyboard) error {
	p := map[string]any{"chat_id": chatID, "message_id": msgID, "text": text, "parse_mode": "HTML", "link_preview_options": map[string]bool{"is_disabled": true}}
	if kb != nil {
		p["reply_markup"] = kb
	}
	err := c.call(ctx, "editMessageText", p, nil)
	if isNotModified(err) {
		return nil
	}
	return err
}

func (c *client) answer(ctx context.Context, callbackID, text string, alert bool) error {
	return c.call(ctx, "answerCallbackQuery", map[string]any{"callback_query_id": callbackID, "text": text, "show_alert": alert}, nil)
}

func (c *client) deleteMessage(ctx context.Context, chatID int64, msgID int) error {
	return c.call(ctx, "deleteMessage", map[string]any{"chat_id": chatID, "message_id": msgID}, nil)
}
