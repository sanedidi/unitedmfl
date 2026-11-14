package aisvc

import (
	"context"
	"encoding/base64"
	"net/http"
	"net/url"
	"strings"
	"sync"
)

// Gemini: generateContent for both prompt improvement (JSON output) and images
// (responseModalities IMAGE + imageConfig). One image per call.
type gemini struct {
	hc   *http.Client
	base string // e.g. https://generativelanguage.googleapis.com
}

func (g *gemini) Name() string { return "gemini" }

func (g *gemini) url(c Credentials, path string) string {
	b := strings.TrimRight(c.BaseURL, "/")
	if b == "" {
		b = g.base
	}
	return b + path
}

func (g *gemini) Models(ctx context.Context, c Credentials) (Models, error) {
	req, err := jsonRequest(http.MethodGet, g.url(c, "/v1beta/models?pageSize=1000"), nil)
	if err != nil {
		return Models{}, err
	}
	req.Header.Set("x-goog-api-key", c.APIKey)
	var res struct {
		Models []struct {
			Name    string   `json:"name"`
			Methods []string `json:"supportedGenerationMethods"`
		} `json:"models"`
	}
	if err := doJSON(ctx, g.hc, req, &res); err != nil {
		return Models{}, err
	}
	var m Models
	for _, x := range res.Models {
		id := strings.TrimPrefix(x.Name, "models/")
		if !contains(x.Methods, "generateContent") || !strings.HasPrefix(id, "gemini-") {
			continue
		}
		switch {
		case strings.Contains(id, "image"):
			m.Image = append(m.Image, id)
		case !containsAny(id, "tts", "live", "embedding", "audio", "robotics", "transcribe", "translate"):
			m.Text = append(m.Text, id)
		}
	}
	m.Image = sortModels(m.Image, "gemini-3-pro-image", "gemini-3.1-flash-image", "gemini-3.1-flash-lite-image")
	m.Text = sortModels(m.Text, "gemini-3.6-flash", "gemini-3.5-flash")
	return m, nil
}

type gemPart struct {
	Text       string     `json:"text,omitempty"`
	InlineData *gemInline `json:"inlineData,omitempty"`
	InlineAlt  *gemInline `json:"inline_data,omitempty"`
}
type gemInline struct {
	MimeType string `json:"mimeType"`
	Data     string `json:"data"`
}
type gemContent struct {
	Role  string    `json:"role,omitempty"`
	Parts []gemPart `json:"parts"`
}
type gemResponse struct {
	Candidates []struct {
		Content      gemContent `json:"content"`
		FinishReason string     `json:"finishReason"`
	} `json:"candidates"`
	PromptFeedback struct {
		BlockReason string `json:"blockReason"`
	} `json:"promptFeedback"`
}

func (g *gemini) generate(ctx context.Context, c Credentials, model string, body map[string]any) (gemResponse, error) {
	var res gemResponse
	req, err := jsonRequest(http.MethodPost, g.url(c, "/v1beta/models/"+url.PathEscape(model)+":generateContent"), body)
	if err != nil {
		return res, err
	}
	req.Header.Set("x-goog-api-key", c.APIKey)
	if err := doJSON(ctx, g.hc, req, &res); err != nil {
		return res, err
	}
	if res.PromptFeedback.BlockReason != "" {
		return res, &ProviderError{Status: 422, Message: "Gemini so‘rovni blokladi: " + res.PromptFeedback.BlockReason}
	}
	return res, nil
}

func (g *gemini) Improve(ctx context.Context, c Credentials, model, system, user string) (Improved, error) {
	res, err := g.generate(ctx, c, model, map[string]any{
		"systemInstruction": gemContent{Parts: []gemPart{{Text: system}}},
		"contents":          []gemContent{{Role: "user", Parts: []gemPart{{Text: user}}}},
		"generationConfig": map[string]any{
			"responseMimeType": "application/json",
			"responseSchema": map[string]any{
				"type": "OBJECT", "required": []string{"prompt", "added"},
				"properties": map[string]any{
					"prompt": map[string]any{"type": "STRING"},
					"added":  map[string]any{"type": "ARRAY", "items": map[string]any{"type": "STRING"}},
				},
			},
		},
	})
	if err != nil {
		return Improved{}, err
	}
	for _, cand := range res.Candidates {
		for _, p := range cand.Content.Parts {
			if p.Text != "" {
				return parseImproved(p.Text)
			}
		}
	}
	return Improved{}, &ProviderError{Status: 502, Message: "Gemini javob qaytarmadi"}
}

var geminiRatios = []string{"1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"}

func geminiSize(quality string) string {
	switch quality {
	case "low":
		return "1K"
	case "medium":
		return "2K"
	}
	return "4K"
}

func (g *gemini) Images(ctx context.Context, c Credentials, job ImageJob) ([][]byte, error) {
	parts := []gemPart{{Text: job.Prompt}}
	for _, r := range job.Refs {
		parts = append(parts, gemPart{InlineData: &gemInline{MimeType: r.Mime, Data: base64.StdEncoding.EncodeToString(r.Data)}})
	}
	imgCfg := map[string]any{"aspectRatio": aspectClosest(job.W, job.H, geminiRatios), "imageSize": geminiSize(job.Quality)}
	if job.People != "" && job.People != "ALLOW_ADULT" { // the API default; send only a deliberate change
		imgCfg["personGeneration"] = job.People
	}
	body := map[string]any{
		"contents":         []gemContent{{Role: "user", Parts: parts}},
		"generationConfig": map[string]any{"responseModalities": []string{"IMAGE"}, "imageConfig": imgCfg},
	}
	out := make([][]byte, job.N)
	errs := make([]error, job.N)
	var wg sync.WaitGroup
	for i := 0; i < job.N; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			res, err := g.generate(ctx, c, job.Model, body)
			if err != nil {
				errs[i] = err
				return
			}
			for _, cand := range res.Candidates {
				for _, p := range cand.Content.Parts {
					in := p.InlineData
					if in == nil {
						in = p.InlineAlt
					}
					if in != nil && in.Data != "" {
						b, err := base64.StdEncoding.DecodeString(in.Data)
						if err == nil {
							out[i] = b
							return
						}
					}
				}
				if cand.FinishReason != "" && cand.FinishReason != "STOP" {
					errs[i] = &ProviderError{Status: 422, Message: "Gemini rasm yaratmadi: " + cand.FinishReason}
					return
				}
			}
			errs[i] = &ProviderError{Status: 502, Message: "Gemini rasm qaytarmadi"}
		}(i)
	}
	wg.Wait()
	var images [][]byte
	var firstErr error
	for i := range out {
		if out[i] != nil {
			images = append(images, out[i])
		} else if firstErr == nil {
			firstErr = errs[i]
		}
	}
	if len(images) == 0 {
		return nil, firstErr
	}
	return images, nil
}
