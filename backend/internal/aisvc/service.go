// Package aisvc is the AI service: it keeps the OpenAI / Gemini connections
// and the image-generation settings, improves prompts and generates images.
// It runs as its own container; only the API talks to it.
package aisvc

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/sanedidi/unitedmfl/backend/internal/httpx"
)

// Options configure the service.
type Options struct {
	DB        *sql.DB
	MasterKey string
	Token     string // shared secret the API sends in X-Internal-Token
	OpenAIURL string // default https://api.openai.com/v1
	GeminiURL string // default https://generativelanguage.googleapis.com
	CWebP     string // path or name of the cwebp binary ("" = no WebP output)
	Client    *http.Client
}

// Service implements the AI operations.
type Service struct {
	st    *store
	provs map[string]Provider
	token string
	cwebp string
}

// New builds the service.
func New(o Options) (*Service, error) {
	box, err := newSealer(o.MasterKey)
	if err != nil {
		return nil, err
	}
	hc := o.Client
	if hc == nil {
		hc = &http.Client{Timeout: 6 * time.Minute}
	}
	if o.OpenAIURL == "" {
		o.OpenAIURL = "https://api.openai.com/v1"
	}
	if o.GeminiURL == "" {
		o.GeminiURL = "https://generativelanguage.googleapis.com"
	}
	return &Service{
		st:    &store{db: o.DB, box: box},
		token: o.Token,
		cwebp: o.CWebP,
		provs: map[string]Provider{
			"openai": &openAI{hc: hc, base: strings.TrimRight(o.OpenAIURL, "/")},
			"gemini": &gemini{hc: hc, base: strings.TrimRight(o.GeminiURL, "/")},
		},
	}, nil
}

func (s *Service) provider(name string) (Provider, error) {
	p, ok := s.provs[name]
	if !ok {
		return nil, httpx.NewError(http.StatusNotFound, "not_found", "Noma’lum provayder")
	}
	return p, nil
}

// ProviderInput is what the admin submits when connecting a provider.
type ProviderInput struct {
	APIKey  string `json:"api_key"`
	OrgID   string `json:"org_id"`
	BaseURL string `json:"base_url"`
}

// SaveProvider stores (or updates) the credentials and checks them right away.
// An empty api_key keeps the stored one.
func (s *Service) SaveProvider(ctx context.Context, name string, in ProviderInput) (ProviderView, error) {
	if _, err := s.provider(name); err != nil {
		return ProviderView{}, err
	}
	in.APIKey, in.OrgID, in.BaseURL = strings.TrimSpace(in.APIKey), strings.TrimSpace(in.OrgID), strings.TrimSpace(in.BaseURL)
	if in.BaseURL != "" {
		u, err := url.Parse(in.BaseURL)
		if err != nil || (u.Scheme != "https" && u.Scheme != "http") || u.Host == "" {
			return ProviderView{}, httpx.Validation(map[string]any{"base_url": "To‘liq URL kiriting (https://…)"})
		}
	}
	cur, ok, err := s.st.credentials(ctx, name)
	if err != nil && in.APIKey == "" {
		return ProviderView{}, err
	}
	if in.APIKey == "" {
		if !ok {
			return ProviderView{}, httpx.Validation(map[string]any{"api_key": "API kalitni kiriting"})
		}
		in.APIKey = cur.APIKey
	}
	if len(in.APIKey) < 10 || len(in.APIKey) > 400 || strings.ContainsAny(in.APIKey, " \n\t") {
		return ProviderView{}, httpx.Validation(map[string]any{"api_key": "Kalit noto‘g‘ri ko‘rinishda"})
	}
	if err := s.st.saveCredentials(ctx, name, Credentials{APIKey: in.APIKey, OrgID: in.OrgID, BaseURL: in.BaseURL}); err != nil {
		return ProviderView{}, err
	}
	return s.TestProvider(ctx, name)
}

// TestProvider lists the models with the stored key and records the result.
func (s *Service) TestProvider(ctx context.Context, name string) (ProviderView, error) {
	p, err := s.provider(name)
	if err != nil {
		return ProviderView{}, err
	}
	c, ok, err := s.st.credentials(ctx, name)
	if err != nil {
		return ProviderView{}, err
	}
	if !ok {
		return ProviderView{}, httpx.NewError(http.StatusConflict, "not_connected", "Provayder ulanmagan")
	}
	tctx, cancel := context.WithTimeout(ctx, 25*time.Second)
	defer cancel()
	start := time.Now()
	models, checkErr := p.Models(tctx, c)
	if err := s.st.saveCheck(ctx, name, time.Since(start), models, checkErr); err != nil {
		return ProviderView{}, err
	}
	return s.st.provider(ctx, name)
}

// Providers lists both connections.
func (s *Service) Providers(ctx context.Context) ([]ProviderView, error) { return s.st.providers(ctx) }

// DeleteProvider forgets the key.
func (s *Service) DeleteProvider(ctx context.Context, name string) error {
	if _, err := s.provider(name); err != nil {
		return err
	}
	return s.st.deleteProvider(ctx, name)
}

// Settings returns the current settings (defaults merged in).
func (s *Service) Settings(ctx context.Context) (Settings, error) { return s.st.settings(ctx) }

// SaveSettings validates and stores new settings.
func (s *Service) SaveSettings(ctx context.Context, st Settings) (Settings, error) {
	st.merge()
	if e := st.validate(); len(e) > 0 {
		m := map[string]any{}
		for k, v := range e {
			m[k] = v
		}
		return Settings{}, httpx.Validation(m)
	}
	if err := s.st.saveSettings(ctx, st); err != nil {
		return Settings{}, err
	}
	return st, nil
}

// order returns the providers to try: the chosen one, then (with fallback on) the other.
func (s *Service) order(ctx context.Context, st Settings) ([]string, error) {
	list := []string{st.Provider}
	if st.Fallback {
		for _, p := range providers {
			if p != st.Provider {
				list = append(list, p)
			}
		}
	}
	var out []string
	for _, p := range list {
		if _, ok, err := s.st.credentials(ctx, p); err != nil {
			return nil, err
		} else if ok {
			out = append(out, p)
		}
	}
	if len(out) == 0 {
		return nil, httpx.NewError(http.StatusConflict, "not_connected", "AI-servis ulanmagan: AI-servis → Ulanishlar bo‘limida OpenAI yoki Gemini kalitini kiriting")
	}
	return out, nil
}

// ImproveInput is the user's description plus context for the rewrite.
type ImproveInput struct {
	Prompt string   `json:"prompt"`
	Layout string   `json:"layout"`
	Assets []string `json:"assets"` // labels only
}

// ImproveResult is shown to the user for confirmation.
type ImproveResult struct {
	Prompt   string   `json:"prompt"`
	Added    []string `json:"added"`
	Provider string   `json:"provider"`
	Model    string   `json:"model"`
	MS       int64    `json:"ms"`
}

// Improve rewrites the description with the configured text model.
func (s *Service) Improve(ctx context.Context, in ImproveInput) (ImproveResult, error) {
	in.Prompt = strings.TrimSpace(in.Prompt)
	if len([]rune(in.Prompt)) < 5 {
		return ImproveResult{}, httpx.Validation(map[string]any{"prompt": "Tavsifni yozing"})
	}
	if len([]rune(in.Prompt)) > 2000 {
		return ImproveResult{}, httpx.Validation(map[string]any{"prompt": "Tavsif 2000 belgidan oshmasin"})
	}
	st, err := s.st.settings(ctx)
	if err != nil {
		return ImproveResult{}, err
	}
	order, err := s.order(ctx, st)
	if err != nil {
		return ImproveResult{}, err
	}
	system, user := improveMessages(st, in)
	var lastErr error
	for _, name := range order {
		c, _, err := s.st.credentials(ctx, name)
		if err != nil {
			return ImproveResult{}, err
		}
		model := st.TextModel[name]
		start := time.Now()
		res, err := s.provs[name].Improve(ctx, c, model, system, user)
		if err == nil {
			return ImproveResult{Prompt: strings.TrimSpace(res.Prompt), Added: res.Added, Provider: name, Model: model, MS: time.Since(start).Milliseconds()}, nil
		}
		lastErr = err
		slog.Warn("prompt improve failed", "provider", name, "err", err)
		if ctx.Err() != nil {
			break
		}
	}
	return ImproveResult{}, lastErr
}

// AssetIn is a reference picture (logo, crest, photo) sent with the request.
type AssetIn struct {
	Label string `json:"label"`
	Mime  string `json:"mime"`
	Data  []byte `json:"data"` // base64 in JSON
}

// ImagesInput asks for pictures in one or more formats.
type ImagesInput struct {
	Prompt  string    `json:"prompt"` // the confirmed (improved) prompt
	Layout  string    `json:"layout"`
	Formats []string  `json:"formats"`
	Assets  []AssetIn `json:"assets"`
}

// Variant is one generated picture in every requested format.
type Variant struct {
	Images map[string]Output `json:"images"`
}

// ImagesResult is the whole generation.
type ImagesResult struct {
	Provider string    `json:"provider"`
	Model    string    `json:"model"`
	MS       int64     `json:"ms"`
	Variants []Variant `json:"variants"`
	Warnings []string  `json:"warnings"`
}

// Images generates the variants. The first format is generated from the
// prompt (with assets as references); the other formats recompose each
// variant's first picture so desktop and mobile show the same scene.
func (s *Service) Images(ctx context.Context, in ImagesInput) (ImagesResult, error) {
	in.Prompt = strings.TrimSpace(in.Prompt)
	if len([]rune(in.Prompt)) < 5 {
		return ImagesResult{}, httpx.Validation(map[string]any{"prompt": "Prompt bo‘sh"})
	}
	st, err := s.st.settings(ctx)
	if err != nil {
		return ImagesResult{}, err
	}
	formats, err := st.formatsFor(in.Formats)
	if err != nil {
		return ImagesResult{}, httpx.Validation(map[string]any{"formats": err.Error()})
	}
	order, err := s.order(ctx, st)
	if err != nil {
		return ImagesResult{}, err
	}
	var refs []Ref
	var labels []string
	for i, a := range in.Assets {
		if i >= st.MaxAssets {
			break
		}
		refs = append(refs, Ref{Label: a.Label, Mime: a.Mime, Data: a.Data})
		labels = append(labels, a.Label)
	}
	var lastErr error
	for _, name := range order {
		res, err := s.generate(ctx, st, name, in, formats, refs, labels)
		if err == nil {
			return res, nil
		}
		lastErr = err
		slog.Warn("image generation failed", "provider", name, "err", err)
		if ctx.Err() != nil {
			break
		}
	}
	return ImagesResult{}, lastErr
}

func (s *Service) generate(ctx context.Context, st Settings, name string, in ImagesInput, formats []string, refs []Ref, labels []string) (ImagesResult, error) {
	c, _, err := s.st.credentials(ctx, name)
	if err != nil {
		return ImagesResult{}, err
	}
	p := s.provs[name]
	model := st.ImageModel[name]
	start := time.Now()
	first := st.Formats[formats[0]]
	raw, err := p.Images(ctx, c, ImageJob{
		Model: model, Prompt: imagePrompt(st, in.Prompt, in.Layout, formats[0], first, labels, false),
		W: first.W, H: first.H, N: st.Variants, Quality: st.Quality, Refs: refs, Moderation: st.Moderation, People: st.People,
	})
	if err != nil {
		return ImagesResult{}, err
	}
	res := ImagesResult{Provider: name, Model: model, Variants: make([]Variant, len(raw)), Warnings: []string{}}
	var mu sync.Mutex
	warn := func(msg string) { mu.Lock(); res.Warnings = append(res.Warnings, msg); mu.Unlock() }
	for i, b := range raw {
		out, err := finish(b, first.W, first.H, st.FileFormat, st.Compression, s.cwebp)
		if err != nil {
			return ImagesResult{}, err
		}
		res.Variants[i] = Variant{Images: map[string]Output{formats[0]: out}}
	}
	if st.FileFormat == "webp" && len(res.Variants) > 0 && res.Variants[0].Images[formats[0]].Mime != "image/webp" {
		warn("WebP kodlovchi (cwebp) topilmadi — rasmlar JPEG formatida saqlandi")
	}
	var wg sync.WaitGroup
	for _, key := range formats[1:] {
		f := st.Formats[key]
		for i := range raw {
			wg.Add(1)
			go func(i int, key string, f Format) {
				defer wg.Done()
				vrefs := append([]Ref{{Label: "variant", Mime: "image/png", Data: raw[i]}}, refs...)
				imgs, err := p.Images(ctx, c, ImageJob{
					Model: model, Prompt: imagePrompt(st, in.Prompt, in.Layout, key, f, labels, true),
					W: f.W, H: f.H, N: 1, Quality: st.Quality, Refs: vrefs, Moderation: st.Moderation, People: st.People,
				})
				if err != nil {
					warn(fmt.Sprintf("%d-variant, %s: %v", i+1, f.Label, err))
					return
				}
				out, err := finish(imgs[0], f.W, f.H, st.FileFormat, st.Compression, s.cwebp)
				if err != nil {
					warn(fmt.Sprintf("%d-variant, %s: %v", i+1, f.Label, err))
					return
				}
				mu.Lock()
				res.Variants[i].Images[key] = out
				mu.Unlock()
			}(i, key, f)
		}
	}
	wg.Wait()
	if ctx.Err() != nil {
		return ImagesResult{}, ctx.Err()
	}
	res.MS = time.Since(start).Milliseconds()
	return res, nil
}

// asHTTP turns provider failures into admin-readable API errors.
func asHTTP(err error) error {
	var pe *ProviderError
	if errors.As(err, &pe) {
		return httpx.NewError(http.StatusBadGateway, "provider_error", pe.Message)
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return httpx.NewError(http.StatusGatewayTimeout, "timeout", "Provayder javob bermadi (vaqt tugadi)")
	}
	return err
}
