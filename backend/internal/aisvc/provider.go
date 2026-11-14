package aisvc

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"net/http"
	"sort"
	"strings"
)

// Models available to a connected account.
type Models struct {
	Image []string
	Text  []string
}

// Improved is the text model's rewrite of the user's description.
type Improved struct {
	Prompt string   `json:"prompt"`
	Added  []string `json:"added"`
}

// Ref is a reference image (asset or an earlier variant) sent with the prompt.
type Ref struct {
	Label string
	Mime  string
	Data  []byte
}

// ImageJob is one provider call: n pictures of roughly w×h.
type ImageJob struct {
	Model      string
	Prompt     string
	W, H       int
	N          int
	Quality    string // low | medium | high
	Refs       []Ref
	Moderation string
	People     string
}

// Provider is an image/text AI vendor.
type Provider interface {
	Name() string
	Models(ctx context.Context, c Credentials) (Models, error)
	Improve(ctx context.Context, c Credentials, model, system, user string) (Improved, error)
	Images(ctx context.Context, c Credentials, job ImageJob) ([][]byte, error)
}

// ProviderError is a provider-side failure with a message safe to show in the admin.
type ProviderError struct {
	Status  int
	Message string
}

func (e *ProviderError) Error() string { return e.Message }

// doJSON sends a request and decodes a JSON response, turning API errors into ProviderError.
func doJSON(ctx context.Context, hc *http.Client, req *http.Request, out any) error {
	res, err := hc.Do(req.WithContext(ctx))
	if err != nil {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		return &ProviderError{Status: http.StatusBadGateway, Message: "Provayderga ulanib bo‘lmadi: " + err.Error()}
	}
	defer res.Body.Close()
	body, err := io.ReadAll(io.LimitReader(res.Body, 200<<20))
	if err != nil {
		return err
	}
	if res.StatusCode >= 300 {
		return &ProviderError{Status: res.StatusCode, Message: apiErrorMessage(res.StatusCode, body)}
	}
	if out == nil {
		return nil
	}
	if err := json.Unmarshal(body, out); err != nil {
		return &ProviderError{Status: http.StatusBadGateway, Message: "Provayder javobini o‘qib bo‘lmadi"}
	}
	return nil
}

func jsonRequest(method, url string, body any) (*http.Request, error) {
	var r io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return nil, err
		}
		r = bytes.NewReader(b)
	}
	req, err := http.NewRequest(method, url, r)
	if err != nil {
		return nil, err
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	return req, nil
}

// apiErrorMessage pulls the human message out of OpenAI / Gemini error bodies.
func apiErrorMessage(status int, body []byte) string {
	var e struct {
		Error struct {
			Message string `json:"message"`
			Status  string `json:"status"`
		} `json:"error"`
	}
	msg := ""
	if json.Unmarshal(body, &e) == nil {
		msg = e.Error.Message
	}
	if msg == "" {
		msg = strings.TrimSpace(string(body))
		if len(msg) > 300 {
			msg = msg[:300]
		}
	}
	switch status {
	case http.StatusUnauthorized, http.StatusForbidden:
		return "API kalit noto‘g‘ri yoki ruxsat yo‘q: " + msg
	case http.StatusTooManyRequests:
		return "Provayder limiti yoki balans tugagan: " + msg
	}
	return fmt.Sprintf("Provayder xatosi (%d): %s", status, msg)
}

func sortModels(list []string, prefer ...string) []string {
	sort.Slice(list, func(i, j int) bool {
		pi, pj := rank(list[i], prefer), rank(list[j], prefer)
		if pi != pj {
			return pi < pj
		}
		return list[i] > list[j] // newer versions first
	})
	return list
}

func rank(m string, prefer []string) int {
	for i, p := range prefer {
		if m == p {
			return i
		}
	}
	return len(prefer)
}

// aspectClosest picks the supported ratio nearest to w:h (log distance).
func aspectClosest(w, h int, ratios []string) string {
	target := math.Log(float64(w) / float64(h))
	best, bestD := ratios[0], math.MaxFloat64
	for _, r := range ratios {
		var a, b float64
		fmt.Sscanf(r, "%f:%f", &a, &b)
		if d := math.Abs(math.Log(a/b) - target); d < bestD {
			best, bestD = r, d
		}
	}
	return best
}
