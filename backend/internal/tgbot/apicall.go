package tgbot

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sort"
	"strings"
)

// callError is an admin API error shown to the operator as is (messages are in Uzbek).
type callError struct {
	Status  int
	Message string
}

func (e *callError) Error() string { return e.Message }

// call runs an admin API request in-process, authenticated as the operator.
func (b *Bot) call(ctx context.Context, op *operator, method, path string, body any, idemKey string, out any) error {
	var rd *bytes.Reader
	if body != nil {
		raw, err := json.Marshal(body)
		if err != nil {
			return err
		}
		rd = bytes.NewReader(raw)
	} else {
		rd = bytes.NewReader(nil)
	}
	req, err := http.NewRequestWithContext(ctx, method, path, rd)
	if err != nil {
		return err
	}
	tok, _, err := b.tokens.Sign(op.UserID, op.Role, op.Name)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+tok)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", "unitedmfl-telegram-bot")
	if idemKey != "" {
		req.Header.Set("Idempotency-Key", idemKey)
	}
	req.RemoteAddr = "127.0.0.1:0"
	rec := httptest.NewRecorder()
	b.api.ServeHTTP(rec, req)
	if rec.Code >= 400 {
		return decodeAPIError(rec.Code, rec.Body.Bytes())
	}
	if out != nil && rec.Body.Len() > 0 {
		return json.Unmarshal(rec.Body.Bytes(), out)
	}
	return nil
}

func decodeAPIError(status int, raw []byte) error {
	var e struct {
		Error struct {
			Message string         `json:"message"`
			Fields  map[string]any `json:"fields"`
		} `json:"error"`
	}
	_ = json.Unmarshal(raw, &e)
	msg := e.Error.Message
	if msg == "" {
		msg = fmt.Sprintf("Xato (HTTP %d)", status)
	}
	if len(e.Error.Fields) > 0 {
		keys := make([]string, 0, len(e.Error.Fields))
		for k := range e.Error.Fields {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		parts := make([]string, 0, len(keys))
		for _, k := range keys {
			parts = append(parts, fmt.Sprintf("%s: %v", k, e.Error.Fields[k]))
		}
		msg += " — " + strings.Join(parts, "; ")
	}
	return &callError{Status: status, Message: msg}
}

func (b *Bot) loadMatch(ctx context.Context, op *operator, id int64) (*matchDetail, error) {
	var d matchDetail
	if err := b.call(ctx, op, http.MethodGet, fmt.Sprintf("/api/v1/admin/matches/%d", id), nil, "", &d); err != nil {
		return nil, err
	}
	return &d, nil
}

// activeMatches mirrors the web picker: not finished/cancelled, live first, then by kickoff.
func (b *Bot) activeMatches(ctx context.Context, op *operator) ([]match, error) {
	var page struct {
		Items []match `json:"items"`
	}
	if err := b.call(ctx, op, http.MethodGet, "/api/v1/admin/matches?limit=200", nil, "", &page); err != nil {
		return nil, err
	}
	out := page.Items[:0]
	for _, m := range page.Items {
		if m.Status != "finished" && m.Status != "cancelled" && m.Home != nil && m.Away != nil {
			out = append(out, m)
		}
	}
	rank := func(m match) int {
		if isLive(&m) {
			return 0
		}
		return 1
	}
	sort.SliceStable(out, func(i, j int) bool {
		a, c := out[i], out[j]
		if rank(a) != rank(c) {
			return rank(a) < rank(c)
		}
		if a.KickoffAt == nil || c.KickoffAt == nil {
			return a.KickoffAt != nil
		}
		return a.KickoffAt.Before(*c.KickoffAt)
	})
	return out, nil
}

// squad is the team roster, used when no matchday lineup has been entered.
// Read directly: the operator role has no access to the players admin section.
func (b *Bot) squad(ctx context.Context, teamID int64) []person {
	rows, err := b.db.QueryContext(ctx, `SELECT id, full_name, number FROM players WHERE team_id = $1 AND is_active
		ORDER BY number NULLS LAST, full_name LIMIT 60`, teamID)
	if err != nil {
		return nil
	}
	defer rows.Close()
	var out []person
	for rows.Next() {
		var p squadPlayer
		if rows.Scan(&p.ID, &p.FullName, &p.Number) == nil {
			id := p.ID
			out = append(out, person{ID: &id, Name: p.FullName, Number: p.Number})
		}
	}
	return out
}
