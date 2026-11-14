package aisvc

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"image"
	"image/color"
	"image/png"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"

	"github.com/sanedidi/unitedmfl/backend/internal/db"
)

func pngOf(w, h int) []byte {
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			img.Set(x, y, color.RGBA{uint8(x % 256), uint8(y % 256), 90, 255})
		}
	}
	var b bytes.Buffer
	_ = png.Encode(&b, img)
	return b.Bytes()
}

type fakeLog struct {
	mu   sync.Mutex
	hits []string
	body []map[string]any
}

func (f *fakeLog) add(hit string, body map[string]any) {
	f.mu.Lock()
	f.hits = append(f.hits, hit)
	f.body = append(f.body, body)
	f.mu.Unlock()
}

func fakeOpenAI(t *testing.T, log *fakeLog, failImages *bool) *httptest.Server {
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer sk-test-openai-key-123" {
			w.WriteHeader(401)
			io.WriteString(w, `{"error":{"message":"Incorrect API key"}}`)
			return
		}
		switch r.URL.Path {
		case "/models":
			io.WriteString(w, `{"data":[{"id":"gpt-image-2"},{"id":"gpt-image-2.5-sunburst"},{"id":"gpt-5.6-luna"},{"id":"gpt-6-astra"},{"id":"gpt-6.1-sol"},{"id":"gpt-6.1-terra"},{"id":"gpt-6-luna"},{"id":"gpt-realtime-2.1"},{"id":"whisper-1"}]}`)
		case "/responses":
			var b map[string]any
			json.NewDecoder(r.Body).Decode(&b)
			log.add("responses", b)
			io.WriteString(w, `{"output":[{"type":"message","content":[{"type":"output_text","text":"{\"prompt\":\"Kino uslubidagi keng kadr: tungi stadion.\",\"added\":[\"rakurs\",\"yorug‘lik\"]}"}]}]}`)
		case "/images/generations", "/images/edits":
			if *failImages {
				w.WriteHeader(500)
				io.WriteString(w, `{"error":{"message":"server overloaded"}}`)
				return
			}
			var size string
			var n = 1
			b := map[string]any{}
			if r.URL.Path == "/images/edits" {
				if err := r.ParseMultipartForm(50 << 20); err != nil {
					t.Errorf("multipart: %v", err)
				}
				size = r.FormValue("size")
				if r.FormValue("n") == "2" {
					n = 2
				}
				b["images"] = len(r.MultipartForm.File["image[]"])
				b["prompt"] = r.FormValue("prompt")
			} else {
				json.NewDecoder(r.Body).Decode(&b)
				size = b["size"].(string)
				n = int(b["n"].(float64))
			}
			b["size"] = size
			log.add(r.URL.Path, b)
			var ww, hh int
			_, _ = fmtSscan(size, &ww, &hh)
			var data []map[string]string
			for i := 0; i < n; i++ {
				data = append(data, map[string]string{"b64_json": base64.StdEncoding.EncodeToString(pngOf(ww, hh))})
			}
			json.NewEncoder(w).Encode(map[string]any{"data": data})
		default:
			w.WriteHeader(404)
		}
	}))
}

func fmtSscan(size string, w, h *int) (int, error) {
	parts := strings.Split(size, "x")
	*w, *h = atoi(parts[0]), atoi(parts[1])
	return 2, nil
}

func atoi(s string) int {
	n := 0
	for _, c := range s {
		n = n*10 + int(c-'0')
	}
	return n
}

func fakeGemini(t *testing.T, log *fakeLog) *httptest.Server {
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("x-goog-api-key") != "AIzaTestGeminiKey123" {
			w.WriteHeader(403)
			io.WriteString(w, `{"error":{"message":"API key not valid"}}`)
			return
		}
		if r.URL.Path == "/v1beta/models" {
			io.WriteString(w, `{"models":[{"name":"models/gemini-3-pro-image","supportedGenerationMethods":["generateContent"]},{"name":"models/gemini-3.6-flash","supportedGenerationMethods":["generateContent"]},{"name":"models/gemini-3.8-flash-tts","supportedGenerationMethods":["generateContent"]}]}`)
			return
		}
		var b map[string]any
		json.NewDecoder(r.Body).Decode(&b)
		log.add(r.URL.Path, b)
		gc, _ := b["generationConfig"].(map[string]any)
		if gc["responseMimeType"] == "application/json" {
			io.WriteString(w, `{"candidates":[{"content":{"parts":[{"text":"{\"prompt\":\"Gemini prompt\",\"added\":[\"kadr\"]}"}]}}]}`)
			return
		}
		ic := gc["imageConfig"].(map[string]any)
		w2, h2 := 2048, 878
		if ic["aspectRatio"] == "9:16" {
			w2, h2 = 864, 1536
		}
		json.NewEncoder(w).Encode(map[string]any{"candidates": []any{map[string]any{"content": map[string]any{"parts": []any{
			map[string]any{"inlineData": map[string]any{"mimeType": "image/png", "data": base64.StdEncoding.EncodeToString(pngOf(w2, h2))}},
		}}}}})
	}))
}

// Runs only with TEST_DATABASE_URL pointing at a throwaway Postgres database.
func TestAIService(t *testing.T) {
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
	if err := Migrate(ctx, conn); err != nil {
		t.Fatal(err)
	}
	conn.Exec(`DELETE FROM ai_providers; DELETE FROM ai_settings`)

	oLog, gLog := &fakeLog{}, &fakeLog{}
	fail := false
	oa, gm := fakeOpenAI(t, oLog, &fail), fakeGemini(t, gLog)
	defer oa.Close()
	defer gm.Close()
	svc, err := New(Options{DB: conn, MasterKey: "test-master-key-1234567890", Token: "internal-token-123456", OpenAIURL: oa.URL, GeminiURL: gm.URL})
	if err != nil {
		t.Fatal(err)
	}
	h := svc.Routes()
	call := func(method, path string, body any, out any) int {
		var r io.Reader
		if body != nil {
			b, _ := json.Marshal(body)
			r = bytes.NewReader(b)
		}
		req := httptest.NewRequest(method, path, r)
		req.Header.Set("X-Internal-Token", "internal-token-123456")
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		if out != nil {
			json.Unmarshal(rec.Body.Bytes(), out)
		}
		if rec.Code >= 300 {
			t.Logf("%s %s → %d %s", method, path, rec.Code, rec.Body.String())
		}
		return rec.Code
	}

	// internal token is required
	req := httptest.NewRequest("GET", "/v1/providers", nil)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != 401 {
		t.Fatalf("no token: %d", rec.Code)
	}

	// nothing connected → generation is refused with a clear message
	var e struct {
		Error struct{ Code, Message string }
	}
	if c := call("POST", "/v1/improve", map[string]any{"prompt": "Tungi stadion, final"}, &e); c != 409 || e.Error.Code != "not_connected" {
		t.Fatalf("not connected: %d %+v", c, e)
	}

	// wrong key → saved but status error
	var pv ProviderView
	call("PUT", "/v1/providers/openai", map[string]any{"api_key": "sk-wrong-key-000000"}, &pv)
	if pv.Status != "error" || !strings.Contains(pv.LastError, "API kalit") {
		t.Fatalf("wrong key: %+v", pv)
	}
	// right key
	if c := call("PUT", "/v1/providers/openai", map[string]any{"api_key": "sk-test-openai-key-123"}, &pv); c != 200 {
		t.Fatal(c)
	}
	if pv.Status != "ok" || pv.KeyMask != "sk-••••••••••••-123" || len(pv.ImageModels) != 2 || pv.ImageModels[0] != "gpt-image-2.5-sunburst" || strings.Join(pv.TextModels, ",") != "gpt-6-luna,gpt-6.1-terra,gpt-6.1-sol,gpt-6-astra,gpt-5.6-luna" {
		t.Fatalf("provider view: %+v", pv)
	}
	var raw []byte
	conn.QueryRow(`SELECT api_key_enc FROM ai_providers WHERE provider='openai'`).Scan(&raw)
	if bytes.Contains(raw, []byte("sk-test")) {
		t.Fatal("key stored in plain text")
	}
	// empty key on update keeps the stored one
	call("PUT", "/v1/providers/openai", map[string]any{"api_key": "", "org_id": "org-1"}, &pv)
	if pv.Status != "ok" || pv.OrgID != "org-1" {
		t.Fatalf("keep key: %+v", pv)
	}

	// improve
	var imp ImproveResult
	if c := call("POST", "/v1/improve", map[string]any{"prompt": "Tungi stadion, final oldidan", "layout": "shade", "assets": []string{"Liga logotipi"}}, &imp); c != 200 {
		t.Fatal(c)
	}
	if imp.Prompt != "Kino uslubidagi keng kadr: tungi stadion." || len(imp.Added) != 2 || imp.Model != "gpt-6-luna" {
		t.Fatalf("improve: %+v", imp)
	}
	sent := oLog.body[len(oLog.body)-1]
	if sent["model"] != "gpt-6-luna" || !strings.Contains(sent["input"].(string), "Liga logotipi") || !strings.Contains(sent["input"].(string), "chap 45%") {
		t.Fatalf("improve request: %+v", sent)
	}

	// images with one asset: desktop via edits (n=2), mobile recomposed per variant
	asset := AssetIn{Label: "Liga logotipi", Mime: "image/png", Data: pngOf(64, 64)}
	var res ImagesResult
	if c := call("POST", "/v1/images", map[string]any{"prompt": "Kino uslubidagi keng kadr", "layout": "shade", "formats": []string{"hero_mobile", "hero_desktop"}, "assets": []AssetIn{asset}}, &res); c != 200 {
		t.Fatal(c)
	}
	if res.Provider != "openai" || len(res.Variants) != 2 {
		t.Fatalf("images: %+v", res)
	}
	for i, v := range res.Variants {
		d, m := v.Images["hero_desktop"], v.Images["hero_mobile"]
		if d.Width != 2400 || d.Height != 1100 || m.Width != 1080 || m.Height != 1920 {
			t.Fatalf("variant %d sizes: %+v %+v", i, d.Width, m.Width)
		}
		cfg, _, err := image.DecodeConfig(bytes.NewReader(d.Data))
		if err != nil || cfg.Width != 2400 || cfg.Height != 1100 {
			t.Fatalf("decoded desktop: %v %+v", err, cfg)
		}
	}
	if len(res.Warnings) != 1 || !strings.Contains(res.Warnings[0], "JPEG") {
		t.Fatalf("expected the no-cwebp warning: %v", res.Warnings)
	}
	var edits, sizes []string
	for i, hit := range oLog.hits {
		if hit == "/images/edits" {
			edits = append(edits, oLog.body[i]["size"].(string))
			sizes = append(sizes, strings.Repeat("x", int(oLog.body[i]["images"].(int))))
		}
	}
	if len(edits) != 3 || edits[0] != "2400x1104" || edits[1] != "1088x1920" || sizes[0] != "x" || sizes[1] != "xx" {
		t.Fatalf("edit calls: %v refs %v", edits, sizes)
	}

	// no assets → generations endpoint
	call("POST", "/v1/images", map[string]any{"prompt": "Kino uslubidagi keng kadr", "layout": "panel", "formats": []string{"hero_desktop"}}, &res)
	if oLog.hits[len(oLog.hits)-1] != "/images/generations" || len(res.Variants) != 2 {
		t.Fatalf("generations: %v", oLog.hits)
	}

	// settings validation and switch to Gemini
	var st Settings
	call("GET", "/v1/settings", nil, &st)
	st.Variants = 9
	if c := call("PUT", "/v1/settings", st, nil); c != 422 {
		t.Fatalf("validation: %d", c)
	}
	st.Variants, st.Provider, st.FileFormat = 1, "gemini", "png"
	if c := call("PUT", "/v1/settings", st, &st); c != 200 {
		t.Fatal(c)
	}
	if c := call("POST", "/v1/images", map[string]any{"prompt": "x stadion", "formats": []string{"hero_desktop"}}, &e); c != 409 {
		t.Fatalf("gemini not connected: %d", c)
	}
	call("PUT", "/v1/providers/gemini", map[string]any{"api_key": "AIzaTestGeminiKey123"}, &pv)
	if pv.Status != "ok" || len(pv.ImageModels) != 1 || len(pv.TextModels) != 1 {
		t.Fatalf("gemini view: %+v", pv)
	}
	if c := call("POST", "/v1/images", map[string]any{"prompt": "Kino kadr", "layout": "shade", "formats": []string{"hero_desktop", "hero_mobile"}, "assets": []AssetIn{asset}}, &res); c != 200 {
		t.Fatal(c)
	}
	if res.Provider != "gemini" || len(res.Variants) != 1 || res.Variants[0].Images["hero_mobile"].Mime != "image/png" || res.Variants[0].Images["hero_desktop"].Height != 1100 {
		t.Fatalf("gemini images: %+v", res.Warnings)
	}
	var ratios []string
	for i, hit := range gLog.hits {
		if strings.HasSuffix(hit, ":generateContent") {
			gc := gLog.body[i]["generationConfig"].(map[string]any)
			if ic, ok := gc["imageConfig"].(map[string]any); ok {
				ratios = append(ratios, ic["aspectRatio"].(string)+"/"+ic["imageSize"].(string))
			}
		}
	}
	if strings.Join(ratios, ",") != "21:9/4K,9:16/4K" {
		t.Fatalf("gemini ratios: %v", ratios)
	}

	// fallback: OpenAI fails, Gemini answers
	st.Provider, st.Fallback = "openai", true
	call("PUT", "/v1/settings", st, &st)
	fail = true
	if c := call("POST", "/v1/images", map[string]any{"prompt": "Kino kadr", "formats": []string{"hero_desktop"}}, &res); c != 200 || res.Provider != "gemini" {
		t.Fatalf("fallback: %d %s", c, res.Provider)
	}
	st.Fallback = false
	call("PUT", "/v1/settings", st, &st)
	if c := call("POST", "/v1/images", map[string]any{"prompt": "Kino kadr", "formats": []string{"hero_desktop"}}, &e); c != 502 || !strings.Contains(e.Error.Message, "server overloaded") {
		t.Fatalf("provider error: %d %+v", c, e)
	}

	// disconnect
	if c := call("DELETE", "/v1/providers/gemini", nil, nil); c != 204 {
		t.Fatal(c)
	}
	var list struct{ Providers []ProviderView }
	call("GET", "/v1/providers", nil, &list)
	if len(list.Providers) != 2 || list.Providers[1].Connected {
		t.Fatalf("list: %+v", list)
	}
}

func TestOpenAISize(t *testing.T) {
	for _, c := range []struct {
		model string
		w, h  int
		want  string
	}{
		{"gpt-image-2.5-sunburst", 2400, 1100, "2400x1104"},
		{"gpt-image-2", 1080, 1920, "1088x1920"},
		{"gpt-image-2", 4096, 4096, "2880x2880"},
		{"gpt-image-1.5", 2400, 1100, "1536x1024"},
		{"gpt-image-1", 1080, 1920, "1024x1536"},
	} {
		if got := openAISize(c.model, c.w, c.h); got != c.want {
			t.Errorf("%s %dx%d = %s, want %s", c.model, c.w, c.h, got, c.want)
		}
	}
}

func TestCoverResize(t *testing.T) {
	out, err := finish(pngOf(3000, 1000), 1200, 1200, "jpeg", 80, "")
	if err != nil || out.Width != 1200 || out.Mime != "image/jpeg" {
		t.Fatal(err, out.Mime)
	}
	cfg, _, _ := image.DecodeConfig(bytes.NewReader(out.Data))
	if cfg.Width != 1200 || cfg.Height != 1200 {
		t.Fatalf("%+v", cfg)
	}
}
