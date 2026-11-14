package aisvc

import (
	"fmt"
	"strings"
)

// Format is one output size the admin can generate for (hero desktop, hero mobile…).
type Format struct {
	Label   string `json:"label"`
	W       int    `json:"w"`
	H       int    `json:"h"`
	Enabled bool   `json:"enabled"`
}

// Settings are the shared image-generation settings managed in the admin
// (AI-servis → Rasm generatsiyasi). The banner page only sends a description.
type Settings struct {
	Provider   string            `json:"provider"` // openai | gemini
	Fallback   bool              `json:"fallback"` // try the other connected provider on error
	ImageModel map[string]string `json:"image_model"`
	TextModel  map[string]string `json:"text_model"`

	Quality     string `json:"quality"`     // low | medium | high
	Variants    int    `json:"variants"`    // 1..4
	FileFormat  string `json:"file_format"` // webp | jpeg | png
	Compression int    `json:"compression"` // 40..100 (jpeg / webp quality)

	Formats map[string]Format `json:"formats"`
	Order   []string          `json:"format_order"`

	Style      string `json:"style"`      // brand style, prepended to every image prompt
	Forbidden  string `json:"forbidden"`  // things the picture must not contain
	TextSpace  bool   `json:"text_space"` // leave a calm zone for the banner text
	Moderation string `json:"moderation"` // OpenAI: auto | low
	People     string `json:"people"`     // Gemini personGeneration: ALLOW_ADULT | ALLOW_ALL | DONT_ALLOW

	ImproveInstruction string `json:"improve_instruction"`
	ImproveLanguage    string `json:"improve_language"` // user | en

	DefaultAssets map[string]bool `json:"default_assets"` // logo, crests, kits, stadium
	MaxAssets     int             `json:"max_assets"`
}

const defaultInstruction = "Sen sport fotosuratchisi va art-direktorsan. Foydalanuvchi tavsifini rasm modeli uchun aniq promptga aylantir: kadr, rakurs, yorug‘lik, ranglar (grafit, laym), banner ko‘rinishiga qarab matn uchun bo‘sh zona va assetlar joylashuvi. Matn va yozuv qo‘shma. Mazmunni o‘zgartirma."

// DefaultSettings is what a fresh install starts with.
func DefaultSettings() Settings {
	return Settings{
		Provider:   "openai",
		ImageModel: map[string]string{"openai": "gpt-image-2.5-sunburst", "gemini": "gemini-3-pro-image"},
		TextModel:  map[string]string{"openai": "gpt-6-luna", "gemini": "gemini-3.6-flash"},
		Quality:    "high", Variants: 2, FileFormat: "webp", Compression: 85,
		Formats: map[string]Format{
			"hero_desktop": {Label: "Hero — desktop", W: 2400, H: 1100, Enabled: true},
			"hero_mobile":  {Label: "Hero — mobil", W: 1080, H: 1920, Enabled: true},
			"news_cover":   {Label: "Yangilik muqovasi", W: 1600, H: 900, Enabled: true},
			"merch":        {Label: "Merch kartasi", W: 1200, H: 1200, Enabled: false},
		},
		Order:              []string{"hero_desktop", "hero_mobile", "news_cover", "merch"},
		Style:              "Professional sport fotosurati, United MFL. Tungi stadion yoritilishi, chuqur kontrast, grafit va laym aksentlar. Real, kino uslubidagi kadr.",
		Forbidden:          "matn va yozuvlar, suv belgisi, buzilgan logotiplar, taniqli shaxslar yuzi",
		TextSpace:          true,
		Moderation:         "auto",
		People:             "ALLOW_ADULT",
		ImproveInstruction: defaultInstruction,
		ImproveLanguage:    "user",
		DefaultAssets:      map[string]bool{"logo": true, "crests": true, "kits": false, "stadium": false},
		MaxAssets:          6,
	}
}

// merge fills anything missing in s (older saved settings) from the defaults.
func (s *Settings) merge() {
	d := DefaultSettings()
	if s.Provider == "" {
		s.Provider = d.Provider
	}
	if s.ImageModel == nil {
		s.ImageModel = map[string]string{}
	}
	if s.TextModel == nil {
		s.TextModel = map[string]string{}
	}
	for k, v := range d.ImageModel {
		if s.ImageModel[k] == "" {
			s.ImageModel[k] = v
		}
	}
	for k, v := range d.TextModel {
		if s.TextModel[k] == "" {
			s.TextModel[k] = v
		}
	}
	if s.Quality == "" {
		s.Quality = d.Quality
	}
	if s.Variants == 0 {
		s.Variants = d.Variants
	}
	if s.FileFormat == "" {
		s.FileFormat = d.FileFormat
	}
	if s.Compression == 0 {
		s.Compression = d.Compression
	}
	if s.Formats == nil {
		s.Formats = map[string]Format{}
	}
	for k, v := range d.Formats {
		if _, ok := s.Formats[k]; !ok {
			s.Formats[k] = v
		}
	}
	if len(s.Order) == 0 {
		s.Order = d.Order
	}
	for k := range s.Formats {
		if !contains(s.Order, k) {
			s.Order = append(s.Order, k)
		}
	}
	if s.Moderation == "" {
		s.Moderation = d.Moderation
	}
	if s.People == "" {
		s.People = d.People
	}
	if strings.TrimSpace(s.ImproveInstruction) == "" {
		s.ImproveInstruction = d.ImproveInstruction
	}
	if s.ImproveLanguage == "" {
		s.ImproveLanguage = d.ImproveLanguage
	}
	if s.DefaultAssets == nil {
		s.DefaultAssets = d.DefaultAssets
	}
	if s.MaxAssets == 0 {
		s.MaxAssets = d.MaxAssets
	}
}

func (s *Settings) validate() map[string]string {
	e := map[string]string{}
	if s.Provider != "openai" && s.Provider != "gemini" {
		e["provider"] = "openai yoki gemini"
	}
	if !contains([]string{"low", "medium", "high"}, s.Quality) {
		e["quality"] = "low, medium yoki high"
	}
	if s.Variants < 1 || s.Variants > 4 {
		e["variants"] = "1 dan 4 gacha"
	}
	if !contains([]string{"webp", "jpeg", "png"}, s.FileFormat) {
		e["file_format"] = "webp, jpeg yoki png"
	}
	if s.Compression < 40 || s.Compression > 100 {
		e["compression"] = "40 dan 100 gacha"
	}
	for k, f := range s.Formats {
		if f.W < 256 || f.H < 256 || f.W > 4096 || f.H > 4096 {
			e["formats."+k] = "o‘lcham 256–4096 px oralig‘ida bo‘lsin"
		}
	}
	if !contains([]string{"auto", "low"}, s.Moderation) {
		e["moderation"] = "auto yoki low"
	}
	if !contains([]string{"ALLOW_ADULT", "ALLOW_ALL", "DONT_ALLOW"}, s.People) {
		e["people"] = "ALLOW_ADULT, ALLOW_ALL yoki DONT_ALLOW"
	}
	if !contains([]string{"user", "en"}, s.ImproveLanguage) {
		e["improve_language"] = "user yoki en"
	}
	if s.MaxAssets < 0 || s.MaxAssets > 14 {
		e["max_assets"] = "0 dan 14 gacha"
	}
	if len(s.Style) > 2000 || len(s.Forbidden) > 1000 || len(s.ImproveInstruction) > 4000 {
		e["style"] = "matn juda uzun"
	}
	return e
}

func contains(list []string, v string) bool {
	for _, x := range list {
		if x == v {
			return true
		}
	}
	return false
}

// formatsFor returns the requested keys that exist and are enabled, in settings order.
func (s *Settings) formatsFor(keys []string) ([]string, error) {
	var out []string
	for _, k := range s.Order {
		if !contains(keys, k) {
			continue
		}
		f, ok := s.Formats[k]
		if !ok || !f.Enabled {
			continue
		}
		out = append(out, k)
	}
	for _, k := range keys {
		if _, ok := s.Formats[k]; !ok {
			return nil, fmt.Errorf("noma’lum format: %s", k)
		}
	}
	if len(out) == 0 {
		return nil, fmt.Errorf("hech bir format yoqilmagan")
	}
	return out, nil
}
