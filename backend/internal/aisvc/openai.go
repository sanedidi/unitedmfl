package aisvc

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"mime/multipart"
	"net/http"
	"net/textproto"
	"strconv"
	"strings"
)

// OpenAI: Images API (generations without references, edits with them) and
// the Responses API for prompt improvement.
type openAI struct {
	hc   *http.Client
	base string // default API base, e.g. https://api.openai.com/v1
}

func (o *openAI) Name() string { return "openai" }

func (o *openAI) url(c Credentials, path string) string {
	b := strings.TrimRight(c.BaseURL, "/")
	if b == "" {
		b = o.base
	}
	return b + path
}

func (o *openAI) auth(req *http.Request, c Credentials) {
	req.Header.Set("Authorization", "Bearer "+c.APIKey)
	if c.OrgID != "" {
		req.Header.Set("OpenAI-Organization", c.OrgID)
	}
}

func (o *openAI) Models(ctx context.Context, c Credentials) (Models, error) {
	req, err := jsonRequest(http.MethodGet, o.url(c, "/models"), nil)
	if err != nil {
		return Models{}, err
	}
	o.auth(req, c)
	var res struct {
		Data []struct {
			ID string `json:"id"`
		} `json:"data"`
	}
	if err := doJSON(ctx, o.hc, req, &res); err != nil {
		return Models{}, err
	}
	var m Models
	for _, d := range res.Data {
		id := d.ID
		switch {
		case strings.HasPrefix(id, "gpt-image") || strings.HasPrefix(id, "chatgpt-image"):
			m.Image = append(m.Image, id)
		case strings.HasPrefix(id, "gpt-") && !containsAny(id, "image", "audio", "realtime", "transcribe", "tts", "search", "embedding", "instruct", "codex", "cyber"):
			m.Text = append(m.Text, id)
		}
	}
	m.Image = sortModels(m.Image, "gpt-image-2.5-sunburst", "gpt-image-2.5-flare", "gpt-image-2")
	m.Text = sortModels(m.Text, "gpt-5.6-luna", "gpt-5.6-terra", "gpt-5.6-sol")
	return m, nil
}

func containsAny(s string, subs ...string) bool {
	for _, x := range subs {
		if strings.Contains(s, x) {
			return true
		}
	}
	return false
}

func (o *openAI) Improve(ctx context.Context, c Credentials, model, system, user string) (Improved, error) {
	body := map[string]any{
		"model":        model,
		"instructions": system,
		"input":        user,
		"text": map[string]any{"format": map[string]any{
			"type": "json_schema", "name": "improved_prompt", "strict": true,
			"schema": map[string]any{
				"type": "object", "additionalProperties": false, "required": []string{"prompt", "added"},
				"properties": map[string]any{
					"prompt": map[string]any{"type": "string"},
					"added":  map[string]any{"type": "array", "items": map[string]any{"type": "string"}},
				},
			},
		}},
	}
	req, err := jsonRequest(http.MethodPost, o.url(c, "/responses"), body)
	if err != nil {
		return Improved{}, err
	}
	o.auth(req, c)
	var res struct {
		OutputText string `json:"output_text"`
		Output     []struct {
			Type    string `json:"type"`
			Content []struct {
				Type    string `json:"type"`
				Text    string `json:"text"`
				Refusal string `json:"refusal"`
			} `json:"content"`
		} `json:"output"`
	}
	if err := doJSON(ctx, o.hc, req, &res); err != nil {
		return Improved{}, err
	}
	text := res.OutputText
	for _, out := range res.Output {
		for _, ct := range out.Content {
			if ct.Type == "output_text" && text == "" {
				text = ct.Text
			}
			if ct.Type == "refusal" && ct.Refusal != "" {
				return Improved{}, &ProviderError{Status: 422, Message: "Model rad etdi: " + ct.Refusal}
			}
		}
	}
	return parseImproved(text)
}

func parseImproved(text string) (Improved, error) {
	text = strings.TrimSpace(text)
	text = strings.TrimPrefix(strings.TrimSuffix(strings.TrimPrefix(text, "```json"), "```"), "```")
	var out Improved
	if err := json.Unmarshal([]byte(strings.TrimSpace(text)), &out); err != nil || strings.TrimSpace(out.Prompt) == "" {
		return Improved{}, &ProviderError{Status: 502, Message: "Matn modeli kutilgan javobni qaytarmadi"}
	}
	if out.Added == nil {
		out.Added = []string{}
	}
	return out, nil
}

// openAISize maps the wanted size to one the model accepts. GPT Image 2.x
// takes arbitrary sizes (multiples of 16); older models only three presets.
func openAISize(model string, w, h int) string {
	if strings.HasPrefix(model, "gpt-image-1") || strings.HasPrefix(model, "chatgpt-image") {
		switch aspectClosest(w, h, []string{"1:1", "3:2", "2:3"}) {
		case "3:2":
			return "1536x1024"
		case "2:3":
			return "1024x1536"
		}
		return "1024x1024"
	}
	const maxEdge, maxPixels = 3840, 3840 * 2160
	fw, fh := float64(w), float64(h)
	scale := 1.0
	if m := max(fw, fh); m > maxEdge {
		scale = maxEdge / m
	}
	if px := fw * fh * scale * scale; px > maxPixels {
		scale *= sqrt(maxPixels / px)
	}
	r16 := func(v float64) int { n := int(v+15) / 16 * 16; return max(n, 256) }
	return fmt.Sprintf("%dx%d", r16(fw*scale), r16(fh*scale))
}

func (o *openAI) Images(ctx context.Context, c Credentials, job ImageJob) ([][]byte, error) {
	size := openAISize(job.Model, job.W, job.H)
	var req *http.Request
	var err error
	if len(job.Refs) == 0 {
		req, err = jsonRequest(http.MethodPost, o.url(c, "/images/generations"), map[string]any{
			"model": job.Model, "prompt": job.Prompt, "n": job.N, "size": size,
			"quality": job.Quality, "output_format": "png", "moderation": job.Moderation,
		})
	} else {
		req, err = o.editRequest(c, job, size)
	}
	if err != nil {
		return nil, err
	}
	o.auth(req, c)
	var res struct {
		Data []struct {
			B64 string `json:"b64_json"`
		} `json:"data"`
	}
	if err := doJSON(ctx, o.hc, req, &res); err != nil {
		return nil, err
	}
	out := make([][]byte, 0, len(res.Data))
	for _, d := range res.Data {
		b, err := base64.StdEncoding.DecodeString(d.B64)
		if err != nil {
			return nil, &ProviderError{Status: 502, Message: "Rasmni o‘qib bo‘lmadi"}
		}
		out = append(out, b)
	}
	if len(out) == 0 {
		return nil, &ProviderError{Status: 502, Message: "Provayder rasm qaytarmadi"}
	}
	return out, nil
}

func (o *openAI) editRequest(c Credentials, job ImageJob, size string) (*http.Request, error) {
	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)
	for k, v := range map[string]string{"model": job.Model, "prompt": job.Prompt, "n": strconv.Itoa(job.N), "size": size, "quality": job.Quality, "output_format": "png", "moderation": job.Moderation} {
		if err := mw.WriteField(k, v); err != nil {
			return nil, err
		}
	}
	for i, r := range job.Refs {
		h := textproto.MIMEHeader{}
		h.Set("Content-Disposition", fmt.Sprintf(`form-data; name="image[]"; filename="ref%d%s"`, i, extFor(r.Mime)))
		h.Set("Content-Type", r.Mime)
		part, err := mw.CreatePart(h)
		if err != nil {
			return nil, err
		}
		if _, err := part.Write(r.Data); err != nil {
			return nil, err
		}
	}
	if err := mw.Close(); err != nil {
		return nil, err
	}
	req, err := http.NewRequest(http.MethodPost, o.url(c, "/images/edits"), &buf)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", mw.FormDataContentType())
	return req, nil
}

func extFor(mime string) string {
	switch mime {
	case "image/jpeg":
		return ".jpg"
	case "image/webp":
		return ".webp"
	}
	return ".png"
}
