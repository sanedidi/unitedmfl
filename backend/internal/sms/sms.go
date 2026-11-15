// Package sms sends one-time codes and short notices by SMS through Eskiz
// (notify.eskiz.uz). Without credentials the sender is disabled and phone
// verification on the registration site is switched off.
package sms

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
)

// Sender delivers a text to an international number without «+» (998901234567).
type Sender interface {
	Enabled() bool
	Send(ctx context.Context, phone, text string) error
}

// Disabled never sends.
type Disabled struct{}

func (Disabled) Enabled() bool                              { return false }
func (Disabled) Send(context.Context, string, string) error { return errors.New("sms disabled") }

// Eskiz is the notify.eskiz.uz client. The account email/password are traded
// for a bearer token that is refreshed when it expires.
type Eskiz struct {
	BaseURL  string
	Email    string
	Password string
	From     string
	HTTP     *http.Client

	mu    sync.Mutex
	token string
}

// NewEskiz returns a sender, or Disabled when email/password are empty.
func NewEskiz(baseURL, email, password, from string) Sender {
	if email == "" || password == "" {
		return Disabled{}
	}
	if baseURL == "" {
		baseURL = "https://notify.eskiz.uz"
	}
	if from == "" {
		from = "4546"
	}
	return &Eskiz{BaseURL: strings.TrimRight(baseURL, "/"), Email: email, Password: password, From: from, HTTP: &http.Client{Timeout: 15 * time.Second}}
}

func (e *Eskiz) Enabled() bool { return true }

func (e *Eskiz) login(ctx context.Context) (string, error) {
	form := url.Values{"email": {e.Email}, "password": {e.Password}}
	req, _ := http.NewRequestWithContext(ctx, http.MethodPost, e.BaseURL+"/api/auth/login", strings.NewReader(form.Encode()))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	res, err := e.HTTP.Do(req)
	if err != nil {
		return "", err
	}
	defer res.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(res.Body, 1<<16))
	if res.StatusCode != http.StatusOK {
		return "", fmt.Errorf("eskiz login: %d %s", res.StatusCode, strings.TrimSpace(string(body)))
	}
	var d struct {
		Data struct {
			Token string `json:"token"`
		} `json:"data"`
	}
	if err := json.Unmarshal(body, &d); err != nil || d.Data.Token == "" {
		return "", fmt.Errorf("eskiz login: no token")
	}
	return d.Data.Token, nil
}

func (e *Eskiz) Send(ctx context.Context, phone, text string) error {
	e.mu.Lock()
	defer e.mu.Unlock()
	for attempt := 0; attempt < 2; attempt++ {
		if e.token == "" {
			t, err := e.login(ctx)
			if err != nil {
				return err
			}
			e.token = t
		}
		form := url.Values{"mobile_phone": {phone}, "message": {text}, "from": {e.From}}
		req, _ := http.NewRequestWithContext(ctx, http.MethodPost, e.BaseURL+"/api/message/sms/send", strings.NewReader(form.Encode()))
		req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
		req.Header.Set("Authorization", "Bearer "+e.token)
		res, err := e.HTTP.Do(req)
		if err != nil {
			return err
		}
		body, _ := io.ReadAll(io.LimitReader(res.Body, 1<<16))
		res.Body.Close()
		if res.StatusCode == http.StatusUnauthorized {
			e.token = "" // expired: log in again once
			continue
		}
		if res.StatusCode >= 300 {
			return fmt.Errorf("eskiz send: %d %s", res.StatusCode, strings.TrimSpace(string(body)))
		}
		return nil
	}
	return errors.New("eskiz send: unauthorized")
}
