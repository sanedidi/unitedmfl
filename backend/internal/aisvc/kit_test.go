package aisvc

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"

	"github.com/sanedidi/unitedmfl/backend/internal/db"
)

func TestKitDress(t *testing.T) {
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

	var mu sync.Mutex
	analysis := `{"people":1,"face_visible":true,"graphic":true,"wearing_jersey":true,"framing":"half","notes":"Qo‘llar chalishtirilgan"}`
	var prompts []string
	var refs []int
	var sizes []string
	var askImages []int
	oa := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/models":
			io.WriteString(w, `{"data":[{"id":"gpt-image-2.5-sunburst"},{"id":"gpt-6-luna"}]}`)
		case "/responses":
			var b struct {
				Input []struct {
					Content []map[string]any `json:"content"`
				} `json:"input"`
				Text struct {
					Format struct {
						Name string `json:"name"`
					} `json:"format"`
				} `json:"text"`
			}
			json.NewDecoder(r.Body).Decode(&b)
			n := 0
			for _, c := range b.Input[0].Content {
				if c["type"] == "input_image" && strings.HasPrefix(c["image_url"].(string), "data:image/") {
					n++
				}
			}
			mu.Lock()
			askImages = append(askImages, n)
			a := analysis
			mu.Unlock()
			text := a
			if b.Text.Format.Name == "kit_description" {
				text = `{"description":"Oq asos, yashil-ko‘k yoqa, ko‘krakda «kontent markazi»."}`
			}
			json.NewEncoder(w).Encode(map[string]any{"output_text": text})
		case "/images/edits":
			r.ParseMultipartForm(50 << 20)
			mu.Lock()
			prompts = append(prompts, r.FormValue("prompt"))
			refs = append(refs, len(r.MultipartForm.File["image[]"]))
			sizes = append(sizes, r.FormValue("size"))
			mu.Unlock()
			var ww, hh int
			fmtSscan(r.FormValue("size"), &ww, &hh)
			json.NewEncoder(w).Encode(map[string]any{"data": []map[string]string{{"b64_json": base64.StdEncoding.EncodeToString(pngOf(ww/8, hh/8))}}})
		default:
			w.WriteHeader(404)
		}
	}))
	defer oa.Close()
	svc, err := New(Options{DB: conn, MasterKey: "test-master-key-1234567890", Token: "internal-token-123456", OpenAIURL: oa.URL, GeminiURL: oa.URL})
	if err != nil {
		t.Fatal(err)
	}
	h := svc.Routes()
	call := func(path string, body any, out any) int {
		b, _ := json.Marshal(body)
		method := "POST"
		if strings.HasPrefix(path, "PUT ") {
			method, path = "PUT", strings.TrimPrefix(path, "PUT ")
		}
		req := httptest.NewRequest(method, path, bytes.NewReader(b))
		req.Header.Set("X-Internal-Token", "internal-token-123456")
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		json.Unmarshal(rec.Body.Bytes(), out)
		if rec.Code >= 300 {
			t.Logf("%s → %d %s", path, rec.Code, rec.Body.String())
		}
		return rec.Code
	}
	var pv ProviderView
	if c := call("PUT /v1/providers/openai", map[string]any{"api_key": "sk-test-openai-key-123"}, &pv); c != 200 {
		t.Fatal(c)
	}
	// defaults include the kit settings and the owner's prompt template
	st, _ := svc.Settings(ctx)
	if !st.Kit.AutoOnKit || !st.Kit.Analyze || !strings.Contains(st.Kit.Prompt, "{rasm_holati}") || !strings.Contains(st.Kit.Prompt, "PRESERVE IDENTITY") {
		t.Fatalf("kit defaults: %+v", st.Kit)
	}
	// a template without {rasm_holati} is refused
	bad := st
	bad.Kit.Prompt = "dress {o‘yinchi}"
	if _, err := svc.SaveSettings(ctx, bad); err == nil {
		t.Fatal("template without {rasm_holati} accepted")
	}

	photo := AssetIn{Label: "photo", Mime: "image/png", Data: pngOf(600, 800)}
	kit := AssetIn{Label: "kit", Mime: "image/png", Data: pngOf(256, 256)}

	var d DescribeResult
	if c := call("/v1/kit/describe", DescribeInput{Kit: kit, Team: "Ravshan Kulob"}, &d); c != 200 || !strings.Contains(d.Description, "kontent markazi") || d.Model != "gpt-6-luna" {
		t.Fatalf("describe: %d %+v", c, d)
	}

	// poster photo: studio background, head and shoulders 3:4, old jersey replaced
	var res DressResult
	if c := call("/v1/kit/dress", DressInput{Photo: photo, Kit: kit, Team: "Ravshan Kulob", Player: "Ignatiy Nesterov", Description: d.Description}, &res); c != 200 || res.Status != "done" || res.Image == nil {
		t.Fatalf("dress: %d %+v", c, res)
	}
	if res.Image.Width != 1200 || res.Image.Height != 1600 || !res.Analysis.Studio || !res.Analysis.HeadShoulders {
		t.Fatalf("poster result: %+v %+v", res.Image.Width, res.Analysis)
	}
	p := prompts[0]
	for _, want := range []string{"Ravshan Kulob", "Ignatiy Nesterov", "kontent markazi", "remove all overlaid text", "studio backdrop", "head-and-shoulders", "replace it COMPLETELY"} {
		if !strings.Contains(p, want) {
			t.Fatalf("prompt lacks %q:\n%s", want, p)
		}
	}
	if strings.Contains(p, "{rasm_holati}") || strings.Contains(p, "{jamoa}") || refs[0] != 2 || sizes[0] != "1200x1600" {
		t.Fatalf("placeholders/refs/size: refs=%v sizes=%v", refs, sizes)
	}

	// regular photo: background kept, original ratio (600×800 → 1200×1600, 900×600 → 1600×1072)
	mu.Lock()
	analysis = `{"people":1,"face_visible":true,"graphic":false,"wearing_jersey":false,"framing":"half","notes":""}`
	mu.Unlock()
	wide := AssetIn{Label: "photo", Mime: "image/png", Data: pngOf(900, 600)}
	if c := call("/v1/kit/dress", DressInput{Photo: wide, Kit: kit, Team: "A", Player: "B"}, &res); c != 200 || res.Status != "done" || res.Image.Width != 1600 || res.Image.Height != 1072 || res.Analysis.Studio {
		t.Fatalf("regular: %d %+v %+v", c, res.Image, res.Analysis)
	}
	if !strings.Contains(prompts[1], "keep its original background") || strings.Contains(prompts[1], "studio backdrop") {
		t.Fatalf("regular prompt: %s", prompts[1])
	}

	// several people: no generation until the admin says who
	mu.Lock()
	analysis = `{"people":3,"face_visible":true,"graphic":false,"wearing_jersey":false,"framing":"full","notes":"Guruh rasmi"}`
	mu.Unlock()
	before := len(prompts)
	if c := call("/v1/kit/dress", DressInput{Photo: photo, Kit: kit, Team: "A", Player: "B"}, &res); c != 200 || res.Status != "multi" || len(prompts) != before {
		t.Fatalf("multi: %d %+v", c, res)
	}
	if c := call("/v1/kit/dress", DressInput{Photo: photo, Kit: kit, Team: "A", Player: "B", Hint: "chapdagi, 10-raqam"}, &res); c != 200 || res.Status != "done" || !strings.Contains(prompts[len(prompts)-1], "chapdagi, 10-raqam") {
		t.Fatalf("multi with hint: %d %+v", c, res.Status)
	}
	// face not visible
	mu.Lock()
	analysis = `{"people":1,"face_visible":false,"graphic":false,"wearing_jersey":false,"framing":"full","notes":"Orqa tomondan"}`
	mu.Unlock()
	if c := call("/v1/kit/dress", DressInput{Photo: photo, Kit: kit}, &res); c != 200 || res.Status != "noface" {
		t.Fatalf("noface: %d %+v", c, res)
	}
	for i, n := range askImages {
		if n != 1 {
			t.Fatalf("vision call %d sent %d images", i, n)
		}
	}

	// analysis off: one image call, no vision call
	st, _ = svc.Settings(ctx)
	st.Kit.Analyze = false
	if _, err := svc.SaveSettings(ctx, st); err != nil {
		t.Fatal(err)
	}
	asks := len(askImages)
	if c := call("/v1/kit/dress", DressInput{Photo: photo, Kit: kit}, &res); c != 200 || res.Status != "done" || len(askImages) != asks || !res.Analysis.Skipped {
		t.Fatalf("analysis off: %d %+v", c, res)
	}
}

func TestImageSizeWebP(t *testing.T) {
	// VP8X header: canvas 1199×1599 stored minus one
	b := make([]byte, 30)
	copy(b, "RIFF")
	copy(b[8:], "WEBPVP8X")
	w, h := 1200-1, 1600-1
	b[24], b[25], b[26] = byte(w), byte(w>>8), byte(w>>16)
	b[27], b[28], b[29] = byte(h), byte(h>>8), byte(h>>16)
	if ww, hh, ok := imageSize(b); !ok || ww != 1200 || hh != 1600 {
		t.Fatalf("webp size: %d %d %v", ww, hh, ok)
	}
	if s := geminiSchema(analysisSchema); s["type"] != "OBJECT" || s["additionalProperties"] != nil || s["properties"].(map[string]any)["people"].(map[string]any)["type"] != "INTEGER" {
		t.Fatalf("gemini schema: %+v", s)
	}
}
