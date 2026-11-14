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

// DefaultKitPrompt is the owner's squad-portrait prompt, generalised to any team.
// Sections 4, 6 and 8 make the standard front-facing 3:4 chest-up studio portrait.
const DefaultKitPrompt = `# UNIVERSAL FOOTBALL PLAYER STUDIO PORTRAIT — STRICT IDENTITY PRESERVATION

## ROLE & OBJECTIVE

Act as a world-class professional sports photographer, expert photo compositor, and high-end portrait retoucher.

Transform the uploaded photograph of {o‘yinchi} into a professional, photorealistic football squad portrait of {jamoa}.

The result must match the visual consistency of an official football team photoshoot.

ABSOLUTE REQUIREMENTS:
1. Preserve the EXACT identity of the person from IMAGE 1.
2. Dress the person in the EXACT official {jamoa} football jersey from IMAGE 2.
3. Make the person's FACE look DIRECTLY into the camera.
4. Make the person's ENTIRE UPPER BODY face DIRECTLY toward the camera.
5. Replace the original background with a CLEAN, SOLID LIGHT-GRAY STUDIO BACKGROUND.
6. Create a realistic professional sports portrait without changing the person's recognizable facial features.

This is an IMAGE EDITING AND PHOTO COMPOSITING TASK, not an opportunity to invent a new person.

## 1. INPUT IMAGE PRIORITY

IMAGE 1 — PERSON / IDENTITY REFERENCE ({o‘yinchi}). This is the primary and authoritative source for the person's identity. Preserve: exact facial identity; original facial proportions; eye shape and color; nose and lips; eyebrows; jawline and cheekbones; natural skin tone and texture; hairstyle, hair color and hairline; beard, mustache or clean-shaven appearance; recognizable facial details; approximate age and natural appearance.

IMAGE 2 — OFFICIAL FOOTBALL JERSEY of {jamoa}. This is the authoritative clothing reference. Description: {forma_tavsifi}
Reproduce the jersey exactly as in IMAGE 2: base color and fabric pattern, collar and sleeve cuffs, every sponsor logo with its exact text, sleeve patches on the correct sleeves (left/right from the wearer's view), graphics and illustrations, original logo proportions, colors and placements. Do not invent, redesign, simplify or replace any logos or jersey details. If the person already wears this jersey, preserve its original design.

## 2. PHOTO-SPECIFIC NOTES (from the automatic check of IMAGE 1 — follow them)

{rasm_holati}

## 3. CRITICAL — FACE MUST REMAIN THE SAME PERSON

IDENTITY PRESERVATION IS THE HIGHEST PRIORITY.
Do NOT: generate a different face; replace the person with a lookalike; change the facial structure; change eye spacing, eye shape, nose or lips; change hairstyle or facial hair; artificially beautify the person; smooth or reshape the skin; make the person look older or younger; change the person's ethnicity or recognizable appearance.
Preserve the original facial expression as closely as possible: a smile stays a natural smile, a neutral expression stays neutral.
When changing the head angle, reconstruct only what is necessary for the new perspective while maintaining maximum identity similarity.
The final face must be immediately recognizable as the person in IMAGE 1.

## 4. MANDATORY — FULL FRONTAL BODY POSITION

This requirement overrides the original pose and camera angle.
THE PERSON MUST FACE THE CAMERA STRAIGHT ON:
- Head facing directly forward; eyes looking directly into the camera lens; nose pointing toward the camera; both eyes visible from a frontal perspective.
- Both shoulders facing forward; shoulder line horizontal and symmetrical; chest and torso facing directly toward the camera without rotation.
- Body centered in the image; natural upright posture; both arms resting naturally at the sides; both sleeves visible; nothing in the hands.
IMPORTANT: the face AND the entire torso must face the camera. A frontal face with a sideways body is NOT acceptable. A frontal torso with the head turned sideways is NOT acceptable. Do not use a three-quarter angle, do not rotate the shoulders, do not tilt the body. Do not preserve the original pose if it conflicts with the required frontal position.
The result must look like an official football squad registration photograph.

## 5. EXACT FOOTBALL JERSEY REPRODUCTION

Replace all original upper-body clothing with the official reference jersey.
Remove: jackets, hoodies, shirts, sweaters, backpacks and straps, necklaces and chains, lanyards and name badges worn over the clothing, and any objects obstructing the uniform (the jersey's own printed badges and sleeve patches always stay).
The jersey must fit the person's natural body proportions with realistic sports polyester fabric, accurate fabric texture, natural folds and wrinkles, correct collar shape, correct sleeve length, authentic stitching, physically realistic shadows and accurate placement of all logos and graphics.
The shirt must look like a real manufactured football jersey. Never generate fictional sponsor names, distorted text or invented graphics.

## 6. MANDATORY — LIGHT-GRAY STUDIO BACKGROUND

REPLACE THE ENTIRE ORIGINAL BACKGROUND with a clean, neutral, light-gray studio backdrop. Target background color: #D3D3D6.
Uniform light-gray color with subtle natural studio lighting; very soft tonal variation is acceptable. No patterns, textures, objects, buildings, stadiums, crowds, office interiors, windows, furniture, promotional graphics or text, and no artificial orange or blue lighting.
The background must resemble a professional football club's official player portrait studio. Never preserve the original background.

## 7. PROFESSIONAL STUDIO LIGHTING

Large softbox near the camera; soft frontal illumination; subtle natural facial shadows; even lighting across the jersey; neutral white balance; accurate natural skin colors; moderate contrast. No harsh highlights, no dramatic colored rim lighting, no cinematic orange glow. Avoid overexposure, excessive sharpening and artificial HDR.
The image must look like a real photograph captured with a professional DSLR or mirrorless camera.

## 8. STANDARDIZED COMPOSITION (same for every person)

- Aspect ratio 3:4 vertical, 1200 × 1600 pixels.
- Chest-up portrait: person centered; head fully visible with comfortable space above it (no cropped hair); face in the upper third of the frame; both shoulders fully visible with the tops of both sleeves and their patches; the frame ends at mid-torso, just below the chest sponsor and chest graphics.
- Camera at eye level, straight-on angle, portrait lens equivalent to 85mm, natural proportions, no wide-angle facial distortion, sharp facial details, realistic depth of field.
The portrait must visually match the framing of the other official squad photos.

## 9. AUTOMATIC SOURCE IMAGE HANDLING

- Casual photograph: extract the person, remove the original background, change the clothing and position them front-facing.
- Football poster: remove all surrounding poster graphics, text, logos, decorative elements and color effects; extract the real person and create a clean studio portrait.
- Screenshot: ignore all application interface elements and surrounding graphics; use only the actual person as the identity reference.
- Sideways or three-quarter pose: reposition the head, shoulders and torso into a fully frontal pose while preserving identity.
- Crossed arms: change the pose so both arms rest naturally at the sides.
- Objects: remove phones, bags, microphones and unrelated objects.
- Low resolution: preserve recognizable facial information and improve clarity conservatively without inventing new facial features.

## 10. STRICT NEGATIVE INSTRUCTIONS

Never generate: a different person; a generic AI-generated face; altered facial proportions; a different hairstyle; incorrect facial hair; a side-facing head; a side-facing torso; rotated shoulders; a three-quarter pose; crossed arms; hands holding objects; an incorrect football jersey; missing sleeve patches; invented logos; incorrect sponsor text; a dark background; a stadium or office background; orange backlighting; cartoon rendering; CGI appearance; plastic skin; excessive skin smoothing; artificially enhanced facial features; unnatural anatomy; extra fingers or arms; promotional text or watermarks.

## 11. FINAL QUALITY CONTROL

Same person as IMAGE 1, facial features preserved; looking DIRECTLY into the camera; HEAD, BOTH SHOULDERS, CHEST and the ENTIRE TORSO facing straight forward; both arms resting naturally at the sides; jersey identical to IMAGE 2 with all logos and sleeve patches correctly positioned; neutral LIGHT-GRAY background; professional, realistic lighting; centered 3:4 chest-up framing; looks like a genuine football team photoshoot.

## FINAL EXECUTION INSTRUCTION

CREATE A CLEAN, PHOTOREALISTIC, FRONT-FACING FOOTBALL PLAYER STUDIO PORTRAIT.
Use IMAGE 1 exclusively as the person's identity reference and IMAGE 2 exclusively as the official jersey reference.
Make the person's HEAD, EYES, SHOULDERS, CHEST and TORSO face DIRECTLY toward the camera, both arms resting naturally at the sides, on a uniform LIGHT-GRAY studio background (#D3D3D6), in a centered 3:4 chest-up frame.
Preserve the person's recognizable identity, hairstyle, facial hair, skin texture and natural expression. Reproduce the official jersey as accurately as possible.
PRIORITY ORDER: 1. Facial identity preservation. 2. Fully frontal head and body alignment. 3. Exact official jersey reproduction. 4. Uniform light-gray background. 5. Photorealistic studio quality.

FINAL RESULT: a professional official football squad portrait of the ORIGINAL person, standing straight, looking directly at the camera, wearing the exact reference jersey, against a clean light-gray studio background.`

// kitPromptV1 is the previous default; settings that still hold it get the new one.
const kitPromptV1 = `# FOOTBALL JERSEY PHOTO EDITING

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
	// untouched copies of earlier defaults follow the current default
	if k.Prompt == kitPromptV1 || k.Prompt == strings.Replace(kitPromptV1, "(where they conflict with sections 1, 3 or 5 about pose, gaze, framing, lighting or background, these win; facial identity is always preserved)", "(they take precedence over section 5)", 1) {
		k.Prompt = d.Prompt
	}
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
	"type": "object", "additionalProperties": false, "required": []string{"description", "number_visible", "number_style"},
	"properties": map[string]any{
		"description":    map[string]any{"type": "string"},
		"number_visible": map[string]any{"type": "boolean"},
		"number_style":   map[string]any{"type": "string"},
	},
}

const analyzeSystem = `You check a player's photo before a football-jersey try-on edit. Look at the image and answer in JSON:
people — how many people are clearly visible (count only real people, not drawings);
face_visible — true if the main person's face is visible, frontal or three-quarter, and not tiny (at least ~5% of the image height);
graphic — true if this is a designed poster/graphic rather than a plain photo: overlaid text, name lists, logos, flags, brush strokes, heavy artistic effects;
wearing_jersey — true if the person already wears a football/sports jersey;
framing — headshot, half (waist up) or full (full body);
notes — one short sentence in Uzbek (Latin) for the admin about anything unusual (pose, crossed arms, occlusion, low quality).`

// standardPortrait turns any photo into the league's roster portrait: facing the
// camera, chest-up, plain grey studio backdrop (like the official squad photos).
const standardPortrait = `- STANDARD TEAM ROSTER PORTRAIT. These instructions OVERRIDE every rule in this prompt about keeping the original pose, head position, camera angle, gaze, framing, lighting or background. Facial identity must still be preserved exactly: same facial features and proportions, hair, beard, skin tone and texture, age; keep their natural expression (a smile stays a smile).
- Pose: the person stands facing the camera straight on, shoulders square and level, head upright and centred (not tilted, not turned), eyes looking directly into the lens. Arms relaxed down at the sides; no crossed arms, no hands near the face.
- Framing: centred chest-up portrait in 3:4 — top of the hair about 5% below the top edge, the image ending at mid-torso; the whole jersey front from the collar down (sponsor, chest badge and both sleeve patches) clearly visible and symmetric.
- Background and light: a seamless plain neutral light-grey studio backdrop (no texture, no vignette, no objects, no stadium); soft, even frontal studio lighting with no coloured, warm or rim/back light and no lens flare; natural colours.
- Remove necklaces, chains and anything worn over the jersey.`

// rasmHolati turns the analysis and settings into photo-specific editing instructions.
// frontalTemplate: the prompt template already carries the standard-portrait rules.
func rasmHolati(k KitSettings, a *PhotoAnalysis, hint string, frontalTemplate bool) string {
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
	case a.Front && frontalTemplate:
		// the template's own sections describe the frontal studio portrait
	case a.Front:
		lines = append(lines, standardPortrait)
	default:
		lines = append(lines, "- POSE AND BACKGROUND OVERRIDE: keep the original pose, head angle, gaze and camera angle of IMAGE 1; ignore any requirement in this prompt to re-pose the person to face the camera.")
		if a.Studio {
			lines = append(lines, "- Replace the background with a clean, neutral light-grey professional studio backdrop with soft even lighting; keep the person's lighting consistent with it.")
		} else {
			lines = append(lines, "- IMAGE 1 is a regular photo: keep its original background, framing and lighting; ignore any requirement in this prompt to replace the background or change the framing.")
		}
		if a.HeadShoulders {
			lines = append(lines, "- Frame the result as a centred head-and-shoulders portrait in 3:4, eyes in the upper third, the jersey chest (sponsor and collar) clearly visible.")
		}
	}
	if a.WearingJersey {
		lines = append(lines, "- The person already wears a jersey: replace it COMPLETELY with the jersey from IMAGE 2, including all old sponsors, badges and patches.")
	}
	if a.Framing == "headshot" && !a.HeadShoulders {
		lines = append(lines, "- Only the top of the jersey is visible: reproduce the collar, shoulders and visible chest details exactly.")
	}
	if !a.Skipped && a.Notes != "" {
		lines = append(lines, "- Note from the check: "+a.Notes)
	}
	if len(lines) == 0 {
		lines = append(lines, "- Regular photo of one person: apply all the rules of this prompt as written.")
	}
	return strings.Join(lines, "\n")
}

// numberRule tells the image model which player number the jersey must show.
// kit_has_number may be unknown (old description) or wrong, so even without it the
// rule says what to do if IMAGE 2 does show a number: never copy the sample's.
func numberRule(in DressInput) string {
	n := strings.TrimSpace(in.Number)
	style := strings.TrimSpace(in.NumberStyle)
	if style == "" {
		style = "the same font, size, colours, outline and position as the number in IMAGE 2"
	}
	const ignore = " Ignore any digits mentioned in the jersey description — they belong to the sample jersey."
	switch {
	case in.Staff:
		return "\n- PLAYER NUMBER: this person is coaching staff — show the jersey WITHOUT any player number. If IMAGE 2 shows a number on the front, do NOT reproduce it: fill that area with the jersey's plain fabric and pattern." + ignore
	case n == "" && in.NumberOnKit:
		return "\n- PLAYER NUMBER: show the jersey WITHOUT any player number (fill that area with the jersey's plain fabric and pattern). Never copy the number from IMAGE 2." + ignore
	case n == "":
		return "\n- PLAYER NUMBER: do not add any player number. If IMAGE 2 shows a number on the front, remove it (plain fabric and pattern instead)." + ignore
	}
	digits := fmt.Sprintf("exactly \"%s\" (%d digit%s: %s)", n, len([]rune(n)), map[bool]string{true: "", false: "s"}[len([]rune(n)) == 1], strings.Join(strings.Split(n, ""), " "))
	if in.NumberOnKit {
		return fmt.Sprintf("\n- PLAYER NUMBER (critical): IMAGE 2 is a sample jersey; its number belongs to another player. The number on the result MUST be %s — %s. Never copy the number shown in IMAGE 2 or in IMAGE 1; check the digits before finishing.%s", digits, style, ignore)
	}
	return fmt.Sprintf("\n- PLAYER NUMBER (critical): this player's number is %s. If the jersey in IMAGE 2 shows a player number on the front, replace it with %s in %s — never copy the number from IMAGE 2. If IMAGE 2 shows no number on the front, do not add one.%s", digits, digits, style, ignore)
}

// isFrontalTemplate reports whether the template already demands the frontal studio portrait.
func isFrontalTemplate(p string) bool {
	return strings.Contains(p, "FULL FRONTAL") && strings.Contains(p, "STUDIO BACKGROUND")
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
	Description   string `json:"description"`
	NumberVisible bool   `json:"number_visible"` // a player number is printed on the front (visible in a chest-up portrait)
	NumberStyle   string `json:"number_style"`   // its look and position, without the digits
	Provider      string `json:"provider"`
	Model         string `json:"model"`
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
	system := "You describe a football jersey for a photo-editing model that must reproduce it exactly. In 2–4 sentences cover: base colour and fabric pattern; collar and sleeve cuffs (colours, stripes); every sponsor logo/text with its exact spelling and position; sleeve patches and which sleeve (from the wearer's view); any graphics, illustrations or brush strokes and where they are. No marketing words. " +
		"A player number on the jersey belongs to one player only: NEVER write its digits in the description — describe only its style and position (e.g. «large white player number with a blue ring in the centre of the chest»). " +
		"number_visible: true if a player number is printed on the FRONT of the jersey (chest or belly) so it would be visible in a chest-up portrait; false if there is no number or it is only on the back/shorts. " +
		"number_style: if number_visible, its font, colours, outline/ring and exact position without the digits; otherwise an empty string. " + lang
	user := fmt.Sprintf("Team: %s. Describe the jersey in the image. Answer as JSON {\"description\": \"...\", \"number_visible\": true|false, \"number_style\": \"...\"}.", strings.TrimSpace(in.Team))
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
				Description   string `json:"description"`
				NumberVisible bool   `json:"number_visible"`
				NumberStyle   string `json:"number_style"`
			}
			if json.Unmarshal(raw, &out) == nil && strings.TrimSpace(out.Description) != "" {
				return DescribeResult{Description: strings.TrimSpace(out.Description), NumberVisible: out.NumberVisible, NumberStyle: strings.TrimSpace(out.NumberStyle), Provider: name, Model: model}, nil
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
	// player numbers: the kit shows one on the front; Number is this person's
	// ("" for coaching staff → the jersey is shown without a number)
	NumberOnKit bool   `json:"number_on_kit"`
	NumberStyle string `json:"number_style"`
	Number      string `json:"number"`
	Staff       bool   `json:"staff"`
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
			rasmHolati(k, a, "", isFrontalTemplate(k.Prompt))
			res.Status, res.Analysis, res.MS = "multi", a, time.Since(start).Milliseconds()
			return res, nil
		}
		if a.People == 0 || !a.FaceVisible {
			rasmHolati(k, a, hint, isFrontalTemplate(k.Prompt))
			res.Status, res.Analysis, res.MS = "noface", a, time.Since(start).Milliseconds()
			return res, nil
		}
	}
	if a == nil {
		a = &PhotoAnalysis{People: 1, FaceVisible: true, Framing: "half", Skipped: true}
	}
	holati := rasmHolati(k, a, hint, isFrontalTemplate(k.Prompt)) + numberRule(in)
	res.Analysis = a
	w, h := kitOutputSize(k, a, in.Photo.Data)
	prompt := kitPrompt(k, strings.TrimSpace(in.Team), strings.TrimSpace(in.Player), strings.TrimSpace(in.Description), holati)
	prompt = strings.ReplaceAll(prompt, "{raqam}", strings.TrimSpace(in.Number))
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
