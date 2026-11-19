package api

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"mime/multipart"
	"net/http"
	"strconv"
	"strings"
	"time"
)

// Telegram Bot API calls for the sticker sets (standard library only).

type tgStkError struct {
	Code        int
	Description string
	RetryAfter  int
}

func (e *tgStkError) Error() string { return fmt.Sprintf("Telegram %d: %s", e.Code, e.Description) }

// has reports whether the Telegram error description contains any of the markers.
func tgErrHas(err error, markers ...string) bool {
	var e *tgStkError
	if !errors.As(err, &e) {
		return false
	}
	d := strings.ToUpper(e.Description)
	for _, m := range markers {
		if strings.Contains(d, strings.ToUpper(m)) {
			return true
		}
	}
	return false
}

func tgErrCode(err error) int {
	var e *tgStkError
	if errors.As(err, &e) {
		return e.Code
	}
	return 0
}

type tgStkUser struct {
	ID        int64  `json:"id"`
	IsBot     bool   `json:"is_bot"`
	Username  string `json:"username"`
	FirstName string `json:"first_name"`
	LastName  string `json:"last_name"`
}

type tgStkSticker struct {
	FileID       string `json:"file_id"`
	FileUniqueID string `json:"file_unique_id"`
}

type tgStkSet struct {
	Name     string         `json:"name"`
	Title    string         `json:"title"`
	Stickers []tgStkSticker `json:"stickers"`
}

type tgStkUpdate struct {
	UpdateID int64 `json:"update_id"`
	Message  *struct {
		From *tgStkUser `json:"from"`
		Chat struct {
			ID   int64  `json:"id"`
			Type string `json:"type"`
		} `json:"chat"`
		Text string `json:"text"`
	} `json:"message"`
}

// inputSticker is InputSticker; the file goes as the multipart part "sticker".
type inputSticker struct {
	Sticker   string   `json:"sticker"`
	Format    string   `json:"format"`
	EmojiList []string `json:"emoji_list"`
	Keywords  []string `json:"keywords,omitempty"`
}

type tgStkClient struct {
	base string // https://api.telegram.org/bot<token>/
	http *http.Client
}

func newTGStkClient(apiURL, token string) *tgStkClient {
	return &tgStkClient{base: strings.TrimRight(apiURL, "/") + "/bot" + token + "/", http: &http.Client{Timeout: 60 * time.Second}}
}

// botIDFromToken returns the numeric bot id that starts every token ("123:abc").
func botIDFromToken(token string) int64 {
	i := strings.IndexByte(token, ':')
	if i <= 0 {
		return 0
	}
	id, _ := strconv.ParseInt(token[:i], 10, 64)
	return id
}

func (c *tgStkClient) do(req *http.Request, method string, out any) error {
	resp, err := c.http.Do(req)
	if err != nil {
		// never leak the token: it is in the URL inside *url.Error
		return fmt.Errorf("Telegram %s: ulanib bo‘lmadi", method)
	}
	defer resp.Body.Close()
	var r struct {
		OK          bool            `json:"ok"`
		Result      json.RawMessage `json:"result"`
		ErrorCode   int             `json:"error_code"`
		Description string          `json:"description"`
		Parameters  struct {
			RetryAfter int `json:"retry_after"`
		} `json:"parameters"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&r); err != nil {
		return fmt.Errorf("Telegram %s: javob noto‘g‘ri (HTTP %d)", method, resp.StatusCode)
	}
	if !r.OK {
		return &tgStkError{Code: r.ErrorCode, Description: r.Description, RetryAfter: r.Parameters.RetryAfter}
	}
	if out != nil {
		return json.Unmarshal(r.Result, out)
	}
	return nil
}

func (c *tgStkClient) call(ctx context.Context, method string, params any, out any) error {
	body, err := json.Marshal(params)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.base+method, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	return c.do(req, method, out)
}

// upload sends fields plus one PNG as the part "sticker".
func (c *tgStkClient) upload(ctx context.Context, method string, fields map[string]string, png []byte) error {
	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)
	for k, v := range fields {
		if err := mw.WriteField(k, v); err != nil {
			return err
		}
	}
	fw, err := mw.CreateFormFile("sticker", "sticker.png")
	if err != nil {
		return err
	}
	if _, err := fw.Write(png); err != nil {
		return err
	}
	if err := mw.Close(); err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.base+method, &buf)
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", mw.FormDataContentType())
	return c.do(req, method, nil)
}

func (c *tgStkClient) getMe(ctx context.Context) (tgStkUser, error) {
	var u tgStkUser
	err := c.call(ctx, "getMe", map[string]any{}, &u)
	return u, err
}

func (c *tgStkClient) getStickerSet(ctx context.Context, name string) (*tgStkSet, error) {
	var s tgStkSet
	if err := c.call(ctx, "getStickerSet", map[string]any{"name": name}, &s); err != nil {
		return nil, err
	}
	return &s, nil
}

func stickerInput(keywords []string) string {
	b, _ := json.Marshal(inputSticker{Sticker: "attach://sticker", Format: "static", EmojiList: []string{"⚽"}, Keywords: keywords})
	return string(b)
}

// createSet opens a set; stickerType is "regular" or "custom_emoji".
func (c *tgStkClient) createSet(ctx context.Context, owner int64, name, title, stickerType string, png []byte, keywords []string) error {
	return c.upload(ctx, "createNewStickerSet", map[string]string{
		"user_id": strconv.FormatInt(owner, 10), "name": name, "title": title,
		"sticker_type": stickerType, "stickers": "[" + stickerInput(keywords) + "]",
	}, png)
}

func (c *tgStkClient) addSticker(ctx context.Context, owner int64, name string, png []byte, keywords []string) error {
	return c.upload(ctx, "addStickerToSet", map[string]string{
		"user_id": strconv.FormatInt(owner, 10), "name": name, "sticker": stickerInput(keywords),
	}, png)
}

func (c *tgStkClient) replaceSticker(ctx context.Context, owner int64, name, old string, png []byte, keywords []string) error {
	return c.upload(ctx, "replaceStickerInSet", map[string]string{
		"user_id": strconv.FormatInt(owner, 10), "name": name, "old_sticker": old, "sticker": stickerInput(keywords),
	}, png)
}

func (c *tgStkClient) deleteSticker(ctx context.Context, fileID string) error {
	return c.call(ctx, "deleteStickerFromSet", map[string]any{"sticker": fileID}, nil)
}

func (c *tgStkClient) setTitle(ctx context.Context, name, title string) error {
	return c.call(ctx, "setStickerSetTitle", map[string]any{"name": name, "title": title}, nil)
}

func (c *tgStkClient) getUpdates(ctx context.Context, offset int64, timeout int) ([]tgStkUpdate, error) {
	var out []tgStkUpdate
	err := c.call(ctx, "getUpdates", map[string]any{"offset": offset, "timeout": timeout, "allowed_updates": []string{"message"}}, &out)
	return out, err
}

func (c *tgStkClient) send(ctx context.Context, chatID int64, text string) error {
	return c.call(ctx, "sendMessage", map[string]any{"chat_id": chatID, "text": text, "parse_mode": "HTML"}, nil)
}
