package aisvc

import (
	"fmt"
	"strings"
	"unicode/utf8"
)

// BannerText is what the banner will show on top of the picture. It sizes the text zone
// and gives the model the subject of the banner (the text itself is never drawn).
type BannerText struct {
	Title string `json:"title"`
	Badge string `json:"badge"`
	Meta  bool   `json:"meta"` // date / venue line
	CTA   bool   `json:"cta"`  // ticket button
}

// layoutSpec mirrors the site's hero layouts (web/src/app/globals.css, .hero--*).
// Zones are in percent of the frame so they hold for any output size.
type layoutSpec struct {
	name    string
	text    func(wide bool) string // desktop: where the text block covers the picture
	subject string                 // desktop: where the main subject goes
	tone    string                 // how the text zone should look
	mobile  string                 // vertical frame
}

var layouts = map[string]layoutSpec{
	"shade": {
		name: "Chapdagi soya",
		text: func(wide bool) string {
			return fmt.Sprintf("matn bloki chap tomonda: kenglik bo‘yicha 0–%d%%, balandlik bo‘yicha 35–88%% (belgi, sarlavha, sana, tugmalar); ustiga chapdan o‘ngga qorong‘i gradient tushadi", pick(wide, 58, 48))
		},
		subject: "asosiy obyektlar (futbolchilar, to‘p, yuzlar) o‘ng tomonda, kenglik bo‘yicha 52–92%, balandlik bo‘yicha 12–85%",
		tone:    "chap tomon tabiiy ravishda qorong‘i va kam detalli (tungi osmon, xira tribuna, tuman, projektor nuri) — oq matn yaxshi o‘qilsin",
		mobile:  "vertikal kadr: pastki 55% matn va tugmalar uchun — sokin va qorong‘iroq; asosiy obyektlar yuqori 8–45% oralig‘ida, markazda",
	},
	"panel": {
		name: "Pastki panel",
		text: func(bool) string {
			return "kadrning pastki 40% qismini to‘q panel butunlay yopadi, matn shu panelda; rasm yuqoriroq (50% 30%) tekislanadi"
		},
		subject: "asosiy obyektlar va yuzlar faqat yuqori 8–58% balandlikda, markazda; pastki qismda faqat ikkinchi darajali fon (maydon, o‘t)",
		tone:    "yuqori qism yorqin va ta’sirli bo‘lishi mumkin — matn rasm ustida emas",
		mobile:  "vertikal kadr: pastki 50% panel bilan yopiladi; asosiy obyektlar yuqori 8–48% oralig‘ida, markazda",
	},
	"glass": {
		name: "Shisha karta",
		text: func(wide bool) string {
			return fmt.Sprintf("chap pastki burchakda xira shisha karta: kenglik bo‘yicha 0–%d%%, balandlik bo‘yicha 38–92%%; pastdan qorong‘i gradient", pick(wide, 52, 46))
		},
		subject: "asosiy obyektlar o‘ng tomonda va yuqori markazda, kenglik bo‘yicha 50–92%",
		tone:    "karta ostidagi fon bir tekis va xira (karta orqali ko‘rinadi) — kontrastli detallar, yozuvlar va yuzlar u yerda bo‘lmasin",
		mobile:  "vertikal kadr: pastki 55% karta bilan yopiladi; asosiy obyektlar yuqori 8–45% oralig‘ida, markazda",
	},
	"split": {
		name: "Diagonal",
		text: func(bool) string {
			return "chap tomonni qiya to‘q tekislik butunlay yopadi: yuqorida 0–58%, pastda 0–46% kenglik; u yerdagi hech narsa ko‘rinmaydi, matn shu tekislikda"
		},
		subject: "asosiy obyektlar faqat o‘ng tomonda, kenglik bo‘yicha 60–92%; rasm o‘ngga (75%) tekislanib kesiladi",
		tone:    "o‘ng qism yorqin va to‘liq kompozitsiya bo‘lsin, chap qismga muhim narsa qo‘yma",
		mobile:  "vertikal kadr: pastki 50% to‘q tekislik bilan yopiladi; asosiy obyektlar yuqori 8–48% oralig‘ida, markazda",
	},
	"poster": {
		name: "Afisha",
		text: func(bool) string {
			return "matn markazda: kenglik bo‘yicha 18–82%, balandlik bo‘yicha 28–78% (katta sarlavha, belgi, tugmalar); markazga radial qorong‘ilik tushadi"
		},
		subject: "asosiy obyektlar chap va o‘ng chetlarda (kenglik 8–25% va 75–92%) yoki markazda orqa fonda kichik va xira",
		tone:    "markaz sokin va biroz qorong‘i, lekin bo‘sh emas (projektor nurlari, tuman, xira tribuna) — afisha kayfiyati",
		mobile:  "vertikal kadr: markaziy 30–75% balandlik matn uchun sokin; obyektlar yuqori 6–28% va pastki chetlarda",
	},
}

const (
	desktopCommon = "Pastki 12% butun kenglik bo‘ylab slayd yorliqlari turadi — u yerda muhim detal bo‘lmasin. " +
		"Sayt turli ekranlarda rasm chetlarini kesadi: yuzlar, to‘p va logotiplar chetdan kamida 8% ichkarida bo‘lsin."
	mobileCommon = "Chetlar kesilishi mumkin: muhim detallar chetdan kamida 10% ichkarida bo‘lsin."
	assetRule    = "Logotip va gerblarni sahnaga tabiiy joylashtir (stadion LED-ekrani, bayroq, futbolka ko‘kragi, reklama paneli), " +
		"burchakka yopishtirilgan belgi sifatida emas; ularni matn zonasiga va kadr chetiga qo‘yma."
)

func pick(cond bool, a, b int) int {
	if cond {
		return a
	}
	return b
}

func specFor(layout string) layoutSpec {
	if s, ok := layouts[layout]; ok {
		return s
	}
	return layouts["shade"]
}

// wideText reports whether the title needs the wider text zone.
func wideText(b *BannerText) bool {
	return b != nil && utf8.RuneCountInString(strings.TrimSpace(b.Title)) > 28
}

// compositionHint describes where the banner text sits for one output format.
func compositionHint(layout, format string, f Format, banner *BannerText) string {
	if !strings.HasPrefix(format, "hero") {
		return "kompozitsiya muvozanatli, asosiy obyekt markazda, chetlarda kesilib qolmasin"
	}
	s := specFor(layout)
	if f.H > f.W {
		return fmt.Sprintf("«%s» ko‘rinishi, mobil. %s. %s", s.name, s.mobile, mobileCommon)
	}
	return fmt.Sprintf("«%s» ko‘rinishi. Matn zonasi: %s. Obyektlar: %s. Matn zonasi: %s. %s",
		s.name, s.text(wideText(banner)), s.subject, s.tone, desktopCommon)
}

// bannerContext tells the model what the banner is about (text is overlaid by the site).
func bannerContext(b *BannerText) string {
	if b == nil || strings.TrimSpace(b.Title) == "" {
		return ""
	}
	var parts []string
	parts = append(parts, fmt.Sprintf("sarlavha «%s»", strings.TrimSpace(b.Title)))
	if strings.TrimSpace(b.Badge) != "" {
		parts = append(parts, fmt.Sprintf("belgi «%s»", strings.TrimSpace(b.Badge)))
	}
	var extra []string
	if b.Meta {
		extra = append(extra, "sana/joy qatori")
	}
	if b.CTA {
		extra = append(extra, "chipta tugmasi")
	}
	if len(extra) > 0 {
		parts = append(parts, "shuningdek "+strings.Join(extra, " va "))
	}
	return "Banner matni (sayt rasm ustiga o‘zi chiqaradi, rasmga yozma): " + strings.Join(parts, ", ") + "."
}

// improveMessages builds the system and user text for the prompt-improvement call.
func improveMessages(st Settings, in ImproveInput) (system, user string) {
	lang := "Foydalanuvchi qaysi tilda yozgan bo‘lsa, javobni shu tilda yoz."
	if st.ImproveLanguage == "en" {
		lang = "Write the improved prompt in English."
	}
	system = st.ImproveInstruction + "\n\n" + lang +
		"\nPromptda kompozitsiyani aniq yoz: asosiy obyektlar kadrning qaysi qismida, matn zonasi qayerda va u qanday ko‘rinadi." +
		"\nJavob JSON: {\"prompt\": yaxshilangan prompt (bitta paragraf, 70–140 so‘z), \"added\": qo‘shilgan narsalar ro‘yxati (2–6 ta qisqa ibora, masalan «rakurs», «yorug‘lik»)}."
	var b strings.Builder
	fmt.Fprintf(&b, "Tavsif: %s\n", strings.TrimSpace(in.Prompt))
	if c := bannerContext(in.Banner); c != "" {
		b.WriteString(c + " Rasm mazmuni shu bannerga mos bo‘lsin.\n")
	}
	if st.TextSpace {
		fmt.Fprintf(&b, "Kompozitsiya (desktop 2400×1100): %s\n", compositionHint(in.Layout, "hero_desktop", Format{W: 2400, H: 1100}, in.Banner))
	}
	if len(in.Assets) > 0 {
		fmt.Fprintf(&b, "Namuna rasmlar (assetlar) modelga biriktiriladi: %s. Ularni qayerda va qanday ko‘rsatishni yoz, buzmasdan. %s\n", strings.Join(in.Assets, ", "), assetRule)
	} else {
		b.WriteString("Assetlar yo‘q: rasm faqat tavsif asosida yaratiladi, logotip va gerb chizilmasin.\n")
	}
	if st.Forbidden != "" {
		fmt.Fprintf(&b, "Rasmda bo‘lmasligi kerak: %s\n", st.Forbidden)
	}
	return system, b.String()
}

// imagePrompt is the final text sent to the image model for one format.
func imagePrompt(st Settings, prompt, layout, format string, f Format, assets []string, recompose bool, banner *BannerText) string {
	var b strings.Builder
	if st.Style != "" {
		b.WriteString(strings.TrimSpace(st.Style) + "\n\n")
	}
	if recompose {
		fmt.Fprintf(&b, "Biriktirilgan birinchi rasmdagi sahnani %d×%d formatga qayta kompozitsiya qil: o‘sha joy, yorug‘lik, ranglar va obyektlar; obyektlarni quyidagi zonalarga qayta joylashtir.\n\n", f.W, f.H)
	}
	b.WriteString(strings.TrimSpace(prompt))
	fmt.Fprintf(&b, "\n\nFormat: %d×%d.", f.W, f.H)
	if st.TextSpace {
		fmt.Fprintf(&b, "\nKompozitsiya: %s", compositionHint(layout, format, f, banner))
	}
	if c := bannerContext(banner); c != "" {
		b.WriteString("\n" + c)
	}
	if len(assets) > 0 {
		fmt.Fprintf(&b, "\nBiriktirilgan namuna rasmlardan foydalan (%s): ularni aniq va buzmasdan joylashtir. %s", strings.Join(assets, ", "), assetRule)
	}
	b.WriteString("\nRasmda hech qanday matn, harf va raqamli yozuv bo‘lmasin (futbolka raqamlaridan tashqari).")
	if st.Forbidden != "" {
		fmt.Fprintf(&b, "\nRasmda bo‘lmasin: %s.", st.Forbidden)
	}
	return b.String()
}
