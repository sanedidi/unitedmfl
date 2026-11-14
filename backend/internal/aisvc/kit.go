package aisvc

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"image"
	"log/slog"
	"strings"
	"time"

	"github.com/sanedidi/unitedmfl/backend/internal/httpx"
)

// KitSettings control dressing players in their team's kit (photo editing).
type KitSettings struct {
	AutoOnKit    bool   `json:"auto_on_kit"`    // a new/changed team kit queues every player with a photo
	AutoOnPlayer bool   `json:"auto_on_player"` // a new player photo is dressed automatically
	Describe     bool   `json:"describe"`       // the text model writes {forma_tavsifi} from the kit photo
	Analyze      bool   `json:"analyze"`        // check the player photo before editing ({rasm_holati})
	Quality      string `json:"quality"`        // low | medium | high
	Size         string `json:"size"`           // original (keep the photo's ratio) | portrait (1200×1600)
	Background   string `json:"background"`     // auto | keep | studio
	Framing      string `json:"framing"`        // auto | keep | head_shoulders
	Pose         string `json:"pose"`           // front (standard roster portrait, facing the camera) | keep
	Prompt       string `json:"prompt"`         // template with {jamoa} {forma_tavsifi} {o‘yinchi} {rasm_holati}
}

// DefaultKitPrompt is the owner's jersey-editing prompt, generalised to any team.
const DefaultKitPrompt = `# FOOTBALL JERSEY PHOTO EDITING

ROLE: Act as a professional sports photographer, high-end photo retoucher and expert photo compositor. Dress the person from IMAGE 1 in the EXACT football jersey from IMAGE 2. This is a PHOTO EDITING task, NOT a new portrait generation task.

IMAGE 1 — PERSON PHOTO: the original photograph of {o‘yinchi}.
IMAGE 2 — OFFICIAL JERSEY REFERENCE of {jamoa}: {forma_tavsifi}
The reference jersey must be reproduced as accurately as possible.

PHOTO-SPECIFIC INSTRUCTIONS (where they conflict with sections 1, 3 or 5 about pose, gaze, framing, lighting or background, these win; facial identity is always preserved):
{rasm_holati}

1. ABSOLUTE PRIORITY — PRESERVE IDENTITY. The face must remain identical to the original photograph. Do NOT regenerate, redraw or reinterpret the face; do NOT change facial features, proportions, expression, eyes, eyebrows, nose, lips, ears, jawline, skin tone, natural skin texture, hairstyle, hairline, beard or mustache. No beauty filters, face enhancement or skin smoothing. Preserve age, head position, camera angle and gaze. Treat the face as a protected, non-editable region.

2. REPLACE CLOTHING ONLY. Replace the upper-body clothing with the EXACT jersey from IMAGE 2: same design, colors, logos, typography and graphics; all sponsor and team logos reproduced accurately; correct placement of sleeve patches; original collar and sleeve trim. Adapt the jersey naturally to the body and pose with realistic fabric tension, folds and shadows. No invented sponsors, logos or text. Do NOT simplify or redesign the jersey. It must look like the actual physical garment, not a painted texture.

3. PRESERVE PERSON AND POSE. Keep body proportions, shoulder width, arm position, posture, hands, fingers, watches, bracelets and other personal items. Crossed arms stay crossed; sideways or seated poses are kept; keep natural occlusion and never invent hidden parts of the jersey that contradict the reference.

4. PHOTOREALISTIC FABRIC AND LIGHTING. Realistic sports polyester, natural wrinkles and stitching, accurate shadows around shoulders, chest and arms, correct perspective, seamless integration with the original lighting and natural transitions around neck, arms and sleeves. Avoid cartoon look, artificial skin, CGI appearance, oversharpening, plastic fabric, distorted logos, incorrect text and body modifications.

5. BACKGROUND AND COMPOSITION. Preserve the original background, camera perspective, framing, lighting direction and depth of field unless the photo-specific instructions say otherwise. Do not add stadiums, crowds, dramatic lighting or graphic effects.

6. UNIVERSAL ADAPTATION. Works for any person, pose, camera angle and lighting. Adapt ONLY the jersey to the person; never change the person to fit the jersey.

7. FINAL CHECK. Same recognizable individual; identity and expression unchanged; pose and proportions preserved; jersey matches IMAGE 2 with correct logos, patches and colors; natural folds and shadows; looks like an authentic DSLR sports portrait with no AI facial artifacts.

Change ONLY the clothing. Preserve EVERYTHING else. Photorealistic, professional sports photography, natural skin texture, realistic fabric, accurate identity preservation, high-resolution output.`

func defaultKit() KitSettings {
	return KitSettings{AutoOnKit: true, AutoOnPlayer: true, Describe: true, Analyze: true, Quality: "high",
		Size: "original", Background: "auto", Framing: "auto", Pose: "front", Prompt: DefaultKitPrompt}
}

func (k *KitSettings) merge() {
	d := defaultKit()
	if strings.TrimSpace(k.Prompt) == "" && k.Quality == "" { // never saved: take every default
		*k = d
		return
	}
	if strings.TrimSpace(k.Prompt) == "" {
		k.Prompt = d.Prompt
	}
	if k.Quality == "" {
		k.Quality = d.Quality
	}
	if k.Size == "" {
		k.Size = d.Size
	}
	if k.Background == "" {
		k.Background = d.Background
	}
	if k.Framing == "" {
		k.Framing = d.Framing
	}
	if k.Pose == "" {
		k.Pose = d.Pose
	}
}

func (k *KitSettings) validate(e map[string]string) {
	if !contains([]string{"low", "medium", "high"}, k.Quality) {
		e["kit.quality"] = "low, medium yoki high"
	}
	if !contains([]string{"original", "portrait"}, k.Size) {
		e["kit.size"] = "original yoki portrait"
	}
	if !contains([]string{"auto", "keep", "studio"}, k.Background) {
		e["kit.background"] = "auto, keep yoki studio"
	}
	if !contains([]string{"auto", "keep", "head_shoulders"}, k.Framing) {
		e["kit.framing"] = "auto, keep yoki head_shoulders"
	}
	if !contains([]string{"front", "keep"}, k.Pose) {
		e["kit.pose"] = "front yoki keep"
	}
	if len(k.Prompt) > 12000 {
		e["kit.prompt"] = "shablon juda uzun"
	} else if !strings.Contains(k.Prompt, "{rasm_holati}") {
		e["kit.prompt"] = "shablonda {rasm_holati} bo‘lishi kerak"
	}
}

// PhotoAnalysis is the text model's look at a player photo before editing.
type PhotoAnalysis struct {
	People        int    `json:"people"`         // people clearly visible
	FaceVisible   bool   `json:"face_visible"`   // the main face is visible and large enough
	Graphic       bool   `json:"graphic"`        // poster / designed graphic: text, logos, effects
	WearingJersey bool   `json:"wearing_jersey"` // already in a football jersey
	Framing       string `json:"framing"`        // headshot | half | full
	Notes         string `json:"notes"`          // short remark for the admin
	Skipped       bool   `json:"skipped,omitempty"`
	// What the editor decided (filled by the service, shown in the admin)
	Studio        bool `json:"studio"`
	HeadShoulders bool `json:"head_shoulders"`
	Front         bool `json:"front"` // re-posed as a standard roster portrait
}

var analysisSchema = map[string]any{
	"type": "object", "additionalProperties": false,
	"required": []string{"people", "face_visible", "graphic", "wearing_jersey", "framing", "notes"},
	"properties": map[string]any{
		"people":         map[string]any{"type": "integer"},
		"face_visible":   map[string]any{"type": "boolean"},
		"graphic":        map[string]any{"type": "boolean"},
		"wearing_jersey": map[string]any{"type": "boolean"},
		"framing":        map[string]any{"type": "string", "enum": []string{"headshot", "half", "full"}},
		"notes":          map[string]any{"type": "string"},
	},
}

var describeSchema = map[string]any{
	"type": "object", "additionalProperties": false, "required": []string{"description"},
	"properties": map[string]any{"description": map[string]any{"type": "string"}},
}

const analyzeSystem = `You check a player's photo before a football-jersey try-on edit. Look at the image and answer in JSON:
people — how many people are clearly visible (count only real people, not drawings);
face_visible — true if the main person's face is visible, frontal or three-quarter, and not tiny (at least ~5% of the image height);
graphic — true if this is a designed poster/graphic rather than a plain photo: overlaid text, name lists, logos, flags, brush strokes, heavy artistic effects;
wearing_jersey — true if the person already wears a football/sports jersey;
framing — headshot, half (waist up) or full (full body);
notes — one short sentence in Uzbek (Latin) for the admin about anything unusual (pose, crossed arms, occlusion, low quality).`

// rasmHolati turns the analysis and settings into photo-specific editing instructions.
// standardPortrait turns any photo into the league's roster portrait: facing the
// camera, chest-up, plain grey studio backdrop (like the official squad photos).
const standardPortrait = `- STANDARD TEAM ROSTER PORTRAIT. These instructions OVERRIDE every rule in this prompt about keeping the original pose, head position, camera angle, gaze, framing, lighting or background. Facial identity must still be preserved exactly: same facial features and proportions, hair, beard, skin tone and texture, age; keep their natural expression (a smile stays a smile).
- Pose: the person stands facing the camera straight on, shoulders square and level, head upright and centred (not tilted, not turned), eyes looking directly into the lens. Arms relaxed down at the sides; no crossed arms, no hands near the face.
- Framing: centred chest-up portrait in 3:4 — top of the hair about 5% below the top edge, the image ending at mid-torso; the whole jersey front from the collar down (sponsor, chest badge and both sleeve patches) clearly visible and symmetric.
- Background and light: a seamless plain neutral light-grey studio backdrop (no texture, no vignette, no objects, no stadium); soft, even frontal studio lighting with no coloured, warm or rim/back light and no lens flare; natural colours.
- Remove necklaces, chains and anything worn over the jersey.`

// rasmHolati turns the analysis and settings into photo-specific editing instructions.
func rasmHolati(k KitSettings, a *PhotoAnalysis, hint string) string {
	var lines []string
	if a == nil {
		a = &PhotoAnalysis{People: 1, FaceVisible: true, Framing: "half", Skipped: true}
	}
	a.Front = k.Pose == "front"
	a.Studio = a.Front || k.Background == "studio" || (k.Background == "auto" && a.Graphic)
	a.HeadShoulders = a.Front || k.Framing == "head_shoulders" || (k.Framing == "auto" && a.Studio)
	if hint != "" {
		lines = append(lines, fmt.Sprintf("- Several people are visible. Edit ONLY the person described as: %s. Remove everyone else.", hint))
	}
	if a.Graphic {
		lines = append(lines, "- IMAGE 1 is a designed poster/graphic, not a plain photo. Use ONLY the person: remove all overlaid text, name lists, logos, flags, brush strokes and graphic effects. Do not reproduce any of them.")
	}
	switch {
	case a.Front:
		lines = append(lines, standardPortrait)
	case a.Studio:
		lines = append(lines, "- Replace the background with a clean, neutral light-grey professional studio backdrop with soft even lighting; keep the person's lighting consistent with it.")
	default:
		lines = append(lines, "- IMAGE 1 is a regular photo: keep its original background, framing and lighting.")
	}
	if a.HeadShoulders && !a.Front {
		lines = append(lines, "- Frame the result as a centred head-and-shoulders portrait in 3:4, eyes in the upper third, the jersey chest (sponsor and collar) clearly visible.")
	}
	if a.WearingJersey {
		lines = append(lines, "- The person already wears a jersey: replace it COMPLETELY with the jersey from IMAGE 2, including all old sponsors, badges and patches.")
	}
	if a.Framing == "headshot" && !a.HeadShoulders {
		lines = append(lines, "- Only the top of the jersey is visible: reproduce the collar, shoulders and visible chest details exactly.")
	}
	return strings.Join(lines, "\n")
}

func kitPrompt(k KitSettings, team, player, description, holati string) string {
	if strings.TrimSpace(description) == "" {
		description = "follow IMAGE 2 exactly."
	}
	r := strings.NewReplacer("{jamoa}", team, "{forma_tavsifi}", description, "{o‘yinchi}", player, "{oyinchi}", player, "{rasm_holati}", holati)
	return r.Replace(k.Prompt)
}

// imageSize reads the pixel size of a PNG, JPEG or WebP picture.
func imageSize(data []byte) (int, int, bool) {
	if cfg, _, err := image.DecodeConfig(bytes.NewReader(data)); err == nil {
		return cfg.Width, cfg.Height, true
	}
	if len(data) < 30 || string(data[0:4]) != "RIFF" || string(data[8:12]) != "WEBP" {
		return 0, 0, false
	}
	switch string(data[12:16]) {
	case "VP8X":
		w := int(data[24]) | int(data[25])<<8 | int(data[26])<<16
		h := int(data[27]) | int(data[28])<<8 | int(data[29])<<16
		return w + 1, h + 1, true
	case "VP8 ":
		w := int(binary.LittleEndian.Uint16(data[26:28]) & 0x3fff)
		h := int(binary.LittleEndian.Uint16(data[28:30]) & 0x3fff)
		return w, h, true
	case "VP8L":
		b := binary.LittleEndian.Uint32(data[21:25])
		return int(b&0x3fff) + 1, int((b>>14)&0x3fff) + 1, true
	}
	return 0, 0, false
}

// kitOutputSize keeps the photo's ratio (long side 1600) or uses a 3:4 portrait.
func kitOutputSize(k KitSettings, a *PhotoAnalysis, photo []byte) (int, int) {
	if k.Size == "portrait" || (a != nil && a.HeadShoulders) {
		return 1200, 1600
	}
	w, h, ok := imageSize(photo)
	if !ok || w <= 0 || h <= 0 {
		return 1200, 1600
	}
	scale := 1600 / float64(max(w, h))
	r := func(v float64) int { return max(256, int(v+8)/16*16) }
	return r(float64(w) * scale), r(float64(h) * scale)
}

// DescribeInput asks for a text description of a team kit.
type DescribeInput struct {
	Kit  AssetIn `json:"kit"`
	Team string  `json:"team"`
}

// DescribeResult is the kit description for {forma_tavsifi}.
type DescribeResult struct {
	Description string `json:"description"`
	Provider    string `json:"provider"`
	Model       string `json:"model"`
}

// Describe writes a kit description from the kit photo with the text (vision) model.
func (s *Service) Describe(ctx context.Context, in DescribeInput) (DescribeResult, error) {
	if len(in.Kit.Data) == 0 {
		return DescribeResult{}, httpx.Validation(map[string]any{"kit": "Forma rasmi kerak"})
	}
	st, err := s.st.settings(ctx)
	if err != nil {
		return DescribeResult{}, err
	}
	order, err := s.order(ctx, st)
	if err != nil {
		return DescribeResult{}, err
	}
	lang := "Write in Uzbek (Latin script)."
	if st.ImproveLanguage == "en" {
		lang = "Write in English."
	}
	system := "You describe a football jersey for a photo-editing model that must reproduce it exactly. In 2–4 sentences cover: base colour and fabric pattern; collar and sleeve cuffs (colours, stripes); every sponsor logo/text with its exact spelling and position; sleeve patches and which sleeve (from the wearer's view); any graphics, illustrations or brush strokes and where they are. No marketing words. " + lang
	user := fmt.Sprintf("Team: %s. Describe the jersey in the image. Answer as JSON {\"description\": \"...\"}.", strings.TrimSpace(in.Team))
	var lastErr error
	for _, name := range order {
		c, _, err := s.st.credentials(ctx, name)
		if err != nil {
			return DescribeResult{}, err
		}
		model := st.TextModel[name]
		raw, err := s.provs[name].Ask(ctx, c, model, system, user, []Ref{{Label: "kit", Mime: in.Kit.Mime, Data: in.Kit.Data}}, "kit_description", describeSchema)
		if err == nil {
			var out struct {
				Description string `json:"description"`
			}
			if json.Unmarshal(raw, &out) == nil && strings.TrimSpace(out.Description) != "" {
				return DescribeResult{Description: strings.TrimSpace(out.Description), Provider: name, Model: model}, nil
			}
			err = &ProviderError{Status: 502, Message: "Matn modeli forma tavsifini qaytarmadi"}
		}
		lastErr = err
		slog.Warn("kit describe failed", "provider", name, "err", err)
		if ctx.Err() != nil {
			break
		}
	}
	return DescribeResult{}, lastErr
}

// DressInput is one player photo to put into the team kit.
type DressInput struct {
	Photo       AssetIn `json:"photo"`
	Kit         AssetIn `json:"kit"`
	Team        string  `json:"team"`
	Player      string  `json:"player"`
	Description string  `json:"description"`
	Hint        string  `json:"hint"` // which person, when the photo has several
}

// DressResult: status done (image set), multi (several people, hint needed) or noface.
type DressResult struct {
	Status   string         `json:"status"`
	Image    *Output        `json:"image,omitempty"`
	Analysis *PhotoAnalysis `json:"analysis,omitempty"`
	Provider string         `json:"provider"`
	Model    string         `json:"model"`
	MS       int64          `json:"ms"`
	Warnings []string       `json:"warnings"`
}

// Dress edits the player photo so the player wears the team kit.
func (s *Service) Dress(ctx context.Context, in DressInput) (DressResult, error) {
	if len(in.Photo.Data) == 0 || len(in.Kit.Data) == 0 {
		return DressResult{}, httpx.Validation(map[string]any{"photo": "O‘yinchi rasmi va forma rasmi kerak"})
	}
	st, err := s.st.settings(ctx)
	if err != nil {
		return DressResult{}, err
	}
	order, err := s.order(ctx, st)
	if err != nil {
		return DressResult{}, err
	}
	k := st.Kit
	res := DressResult{Warnings: []string{}}
	start := time.Now()
	hint := strings.TrimSpace(in.Hint)
	var a *PhotoAnalysis
	if k.Analyze {
		a, err = s.analyze(ctx, st, order, in.Photo)
		if err != nil {
			res.Warnings = append(res.Warnings, "Rasm tahlili bajarilmadi: "+err.Error())
			a = nil
		}
	}
	if a != nil {
		if a.People > 1 && hint == "" {
			rasmHolati(k, a, "")
			res.Status, res.Analysis, res.MS = "multi", a, time.Since(start).Milliseconds()
			return res, nil
		}
		if a.People == 0 || !a.FaceVisible {
			rasmHolati(k, a, hint)
			res.Status, res.Analysis, res.MS = "noface", a, time.Since(start).Milliseconds()
			return res, nil
		}
	}
	if a == nil {
		a = &PhotoAnalysis{People: 1, FaceVisible: true, Framing: "half", Skipped: true}
	}
	holati := rasmHolati(k, a, hint)
	res.Analysis = a
	w, h := kitOutputSize(k, a, in.Photo.Data)
	prompt := kitPrompt(k, strings.TrimSpace(in.Team), strings.TrimSpace(in.Player), strings.TrimSpace(in.Description), holati)
	refs := []Ref{{Label: "person", Mime: in.Photo.Mime, Data: in.Photo.Data}, {Label: "jersey", Mime: in.Kit.Mime, Data: in.Kit.Data}}
	var lastErr error
	for _, name := range order {
		c, _, err := s.st.credentials(ctx, name)
		if err != nil {
			return DressResult{}, err
		}
		model := st.ImageModel[name]
		raw, err := s.provs[name].Images(ctx, c, ImageJob{Model: model, Prompt: prompt, W: w, H: h, N: 1, Quality: k.Quality, Refs: refs, Moderation: st.Moderation, People: st.People})
		if err == nil {
			out, ferr := finish(raw[0], w, h, st.FileFormat, st.Compression, s.cwebp)
			if ferr != nil {
				return DressResult{}, ferr
			}
			if st.FileFormat == "webp" && out.Mime != "image/webp" {
				res.Warnings = append(res.Warnings, "WebP kodlovchi topilmadi — JPEG saqlandi")
			}
			res.Status, res.Image, res.Provider, res.Model = "done", &out, name, model
			res.MS = time.Since(start).Milliseconds()
			return res, nil
		}
		lastErr = err
		slog.Warn("kit dress failed", "provider", name, "err", err)
		if ctx.Err() != nil {
			break
		}
	}
	return DressResult{}, lastErr
}

func (s *Service) analyze(ctx context.Context, st Settings, order []string, photo AssetIn) (*PhotoAnalysis, error) {
	var lastErr error
	for _, name := range order {
		c, _, err := s.st.credentials(ctx, name)
		if err != nil {
			return nil, err
		}
		raw, err := s.provs[name].Ask(ctx, c, st.TextModel[name], analyzeSystem, "Analyse this photo.", []Ref{{Label: "photo", Mime: photo.Mime, Data: photo.Data}}, "photo_analysis", analysisSchema)
		if err == nil {
			var a PhotoAnalysis
			if err = json.Unmarshal(raw, &a); err == nil {
				return &a, nil
			}
			err = &ProviderError{Status: 502, Message: "tahlil javobi noto‘g‘ri"}
		}
		lastErr = err
		if ctx.Err() != nil {
			break
		}
	}
	return nil, lastErr
}

// geminiSchema converts a JSON schema (OpenAI style) to Gemini's OpenAPI subset.
func geminiSchema(s map[string]any) map[string]any {
	out := map[string]any{}
	for k, v := range s {
		switch k {
		case "additionalProperties":
			continue
		case "type":
			out[k] = strings.ToUpper(v.(string))
		case "properties":
			props := map[string]any{}
			for pk, pv := range v.(map[string]any) {
				props[pk] = geminiSchema(pv.(map[string]any))
			}
			out[k] = props
		case "items":
			out[k] = geminiSchema(v.(map[string]any))
		default:
			out[k] = v
		}
	}
	return out
}

// cleanJSON strips code fences some models wrap around JSON.
func cleanJSON(text string) json.RawMessage {
	text = strings.TrimSpace(text)
	text = strings.TrimPrefix(strings.TrimSuffix(strings.TrimPrefix(text, "```json"), "```"), "```")
	return json.RawMessage(strings.TrimSpace(text))
}
