package httpx

import "testing"

func TestTranslateRussian(t *testing.T) {
	cases := map[string]string{
		"Topilmadi":                       "Не найдено",
		"JSON noto‘g‘ri: unexpected EOF":  "Неверный JSON: unexpected EOF",
		"Kod noto‘g‘ri — yana 2 urinish":  "Неверный код — осталось попыток: 2",
		"5-qator: tug‘ilgan sana tushunarsiz — «32.13.2000»": "Строка 5: непонятная дата рождения — «32.13.2000»",
		"A-3-12 o‘rni band yoki mavjud emas": "A-3-12 — место занято или не существует",
		"Rolingizda bu amal uchun huquq yo‘q: matches:edit": "У вашей роли нет права на это действие: matches:edit",
		"Team X": "Team X",
	}
	for in, want := range cases {
		if got := Translate("ru", in); got != want {
			t.Errorf("%q → %q, want %q", in, got, want)
		}
	}
	if Translate("uz", "Topilmadi") != "Topilmadi" {
		t.Error("uz must not change")
	}
}
