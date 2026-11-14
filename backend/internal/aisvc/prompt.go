package aisvc

import (
	"fmt"
	"strings"
)

// Where the banner text sits for each hero layout — the picture must keep it calm.
var layoutSpace = map[string]string{
	"shade":  "kadrning chap 45% qismi qorong‘iroq va muhim detallarsiz bo‘lsin (u yerda matn turadi); asosiy obyekt o‘ng tomonda",
	"panel":  "kadrning pastki 45% qismi muhim detallarsiz bo‘lsin (u yerni matn paneli yopadi); asosiy obyekt yuqori yarmida",
	"glass":  "chap pastki burchak sokin bo‘lsin (u yerda matn kartasi turadi); asosiy obyekt o‘ng va yuqorida",
	"split":  "asosiy obyekt o‘ng yarmida; chap yarmini qiya to‘q tekislik yopadi",
	"poster": "markaz sokin va atmosferali bo‘lsin (matn markazda turadi); asosiy detallar chetlarda",
}

const mobileSpace = "vertikal kadr: pastki yarmi sokin bo‘lsin (u yerda matn turadi), asosiy obyekt yuqori yarmida"

func spaceHint(layout, format string, f Format) string {
	if f.H > f.W {
		return mobileSpace
	}
	if h, ok := layoutSpace[layout]; ok && strings.HasPrefix(format, "hero") {
		return h
	}
	return "kompozitsiya muvozanatli, chetlarda kesilib qolmasin"
}

// improveMessages builds the system and user text for the prompt-improvement call.
func improveMessages(st Settings, in ImproveInput) (system, user string) {
	lang := "Foydalanuvchi qaysi tilda yozgan bo‘lsa, javobni shu tilda yoz."
	if st.ImproveLanguage == "en" {
		lang = "Write the improved prompt in English."
	}
	system = st.ImproveInstruction + "\n\n" + lang +
		"\nJavob JSON: {\"prompt\": yaxshilangan prompt (bitta paragraf, 60–120 so‘z), \"added\": qo‘shilgan narsalar ro‘yxati (2–6 ta qisqa ibora, masalan «rakurs», «yorug‘lik»)}."
	var b strings.Builder
	fmt.Fprintf(&b, "Tavsif: %s\n", strings.TrimSpace(in.Prompt))
	if st.TextSpace {
		fmt.Fprintf(&b, "Banner ko‘rinishi: %s — %s\n", in.Layout, spaceHint(in.Layout, "hero_desktop", Format{W: 2, H: 1}))
	}
	if len(in.Assets) > 0 {
		fmt.Fprintf(&b, "Namuna rasmlar (assetlar) modelga biriktiriladi: %s. Ularni qayerda va qanday ko‘rsatishni yoz, buzmasdan.\n", strings.Join(in.Assets, ", "))
	} else {
		b.WriteString("Assetlar yo‘q: rasm faqat tavsif asosida yaratiladi, logotip va gerb chizilmasin.\n")
	}
	if st.Forbidden != "" {
		fmt.Fprintf(&b, "Rasmda bo‘lmasligi kerak: %s\n", st.Forbidden)
	}
	return system, b.String()
}

// imagePrompt is the final text sent to the image model for one format.
func imagePrompt(st Settings, prompt, layout, format string, f Format, assets []string, recompose bool) string {
	var b strings.Builder
	if st.Style != "" {
		b.WriteString(strings.TrimSpace(st.Style) + "\n\n")
	}
	if recompose {
		fmt.Fprintf(&b, "Biriktirilgan birinchi rasmdagi sahnani %d×%d formatga qayta kompozitsiya qil: o‘sha joy, yorug‘lik, ranglar va obyektlar.\n\n", f.W, f.H)
	}
	b.WriteString(strings.TrimSpace(prompt))
	fmt.Fprintf(&b, "\n\nFormat: %d×%d.", f.W, f.H)
	if st.TextSpace {
		fmt.Fprintf(&b, " Kompozitsiya: %s.", spaceHint(layout, format, f))
	}
	if len(assets) > 0 {
		fmt.Fprintf(&b, "\nBiriktirilgan namuna rasmlardan foydalan (%s): ularni aniq va buzmasdan joylashtir.", strings.Join(assets, ", "))
	}
	if st.Forbidden != "" {
		fmt.Fprintf(&b, "\nRasmda bo‘lmasin: %s.", st.Forbidden)
	}
	return b.String()
}
