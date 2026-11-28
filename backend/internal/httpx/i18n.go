package httpx

import (
	"bytes"
	"encoding/json"
	"net/http"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
)

// API messages are written in Uzbek (the source language). When the client asks
// for Russian (X-Lang: ru header, or the site's "lang" cookie) error messages and
// the "message"/"text" fields of JSON responses are translated with ruMessages
// (i18n_ru.go). Unknown messages stay in Uzbek.

// Lang is the interface language of the request: "ru" or "uz".
func Lang(r *http.Request) string {
	if r == nil {
		return "uz"
	}
	if v := strings.ToLower(strings.TrimSpace(r.Header.Get("X-Lang"))); v == "ru" || v == "uz" {
		return v
	}
	if c, err := r.Cookie("lang"); err == nil && c.Value == "ru" {
		return "ru"
	}
	return "uz"
}

type langWriter struct {
	http.ResponseWriter
	lang string
}

func (l *langWriter) Flush() {
	if f, ok := l.ResponseWriter.(http.Flusher); ok {
		f.Flush()
	}
}
func (l *langWriter) Unwrap() http.ResponseWriter { return l.ResponseWriter }

// Localize remembers the request language on the ResponseWriter so JSON() can
// translate messages. Must be the innermost of the common middlewares.
func Localize(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if Lang(r) == "ru" {
			w = &langWriter{ResponseWriter: w, lang: "ru"}
		}
		next.ServeHTTP(w, r)
	})
}

func writerLang(w http.ResponseWriter) string {
	if lw, ok := w.(*langWriter); ok {
		return lw.lang
	}
	return "uz"
}

type msgPattern struct {
	re  *regexp.Regexp
	out string
	src string
}

var (
	i18nOnce  sync.Once
	ruExact   map[string]string
	ruPattern []msgPattern
	ruPrefix  []string // keys used as a message start: "JSON noto‘g‘ri: "
	ruSuffix  []string // keys used as a message end: " o‘rni band"
	verbRe    = regexp.MustCompile(`%(\[\d+\])?[dsvqw]`)
)

func i18nInit() {
	ruExact = map[string]string{}
	for k, v := range ruMessages {
		if verbRe.MatchString(k) {
			parts := verbRe.Split(k, -1)
			var b strings.Builder
			b.WriteString("^")
			for i, p := range parts {
				b.WriteString(regexp.QuoteMeta(p))
				if i < len(parts)-1 {
					b.WriteString("(.+?)")
				}
			}
			b.WriteString("$")
			ruPattern = append(ruPattern, msgPattern{re: regexp.MustCompile(b.String()), out: v, src: k})
			continue
		}
		ruExact[k] = v
		if strings.HasSuffix(k, " ") || strings.HasSuffix(k, "(") {
			ruPrefix = append(ruPrefix, k)
		}
		if strings.HasPrefix(k, " ") || strings.HasPrefix(k, ":") {
			ruSuffix = append(ruSuffix, k)
		}
	}
	// most specific first
	sort.Slice(ruPattern, func(i, j int) bool { return len(ruPattern[i].src) > len(ruPattern[j].src) })
	sort.Slice(ruPrefix, func(i, j int) bool { return len(ruPrefix[i]) > len(ruPrefix[j]) })
	sort.Slice(ruSuffix, func(i, j int) bool { return len(ruSuffix[i]) > len(ruSuffix[j]) })
}

// Translate returns msg in lang ("ru"); unknown messages are returned unchanged.
func Translate(lang, msg string) string {
	if lang != "ru" || msg == "" {
		return msg
	}
	i18nOnce.Do(i18nInit)
	return translate(msg, 0)
}

func translate(msg string, depth int) string {
	if depth > 4 || strings.TrimSpace(msg) == "" {
		return msg
	}
	if v, ok := ruExact[msg]; ok {
		return v
	}
	for _, p := range ruPattern {
		m := p.re.FindStringSubmatch(msg)
		if m == nil {
			continue
		}
		args := m[1:]
		next := 0
		return verbRe.ReplaceAllStringFunc(p.out, func(verb string) string {
			idx := next
			if strings.HasPrefix(verb, "%[") {
				n, _ := strconv.Atoi(verb[2:strings.Index(verb, "]")])
				idx = n - 1
			} else {
				next++
			}
			if idx < 0 || idx >= len(args) {
				return verb
			}
			a := args[idx]
			if c := verb[len(verb)-1]; c == 's' || c == 'v' {
				a = translate(a, depth+1)
			}
			return a
		})
	}
	for _, k := range ruPrefix {
		if strings.HasPrefix(msg, k) && len(msg) > len(k) {
			return ruExact[k] + translate(msg[len(k):], depth+1)
		}
	}
	for _, k := range ruSuffix {
		if strings.HasSuffix(msg, k) && len(msg) > len(k) {
			return translate(msg[:len(msg)-len(k)], depth+1) + ruExact[k]
		}
	}
	return msg
}

// translateValue walks decoded JSON and translates message-like string fields.
func translateValue(v any, key string) any {
	switch x := v.(type) {
	case map[string]any:
		for k, val := range x {
			x[k] = translateValue(val, k)
		}
		return x
	case []any:
		for i, val := range x {
			x[i] = translateValue(val, key)
		}
		return x
	case string:
		switch key {
		case "message", "text", "hint", "warning", "fields":
			return Translate("ru", x)
		}
	}
	return v
}

func (e *Error) localized(lang string) *Error {
	if lang != "ru" {
		return e
	}
	c := *e
	c.Message = Translate(lang, e.Message)
	if len(e.Fields) > 0 {
		c.Fields = make(map[string]any, len(e.Fields))
		for k, v := range e.Fields {
			if s, ok := v.(string); ok {
				c.Fields[k] = Translate(lang, s)
			} else {
				c.Fields[k] = v
			}
		}
	}
	return &c
}

// localizeJSON translates "message"/"text" fields of an already encoded body.
func localizeJSON(body []byte) []byte {
	if !bytes.Contains(body, []byte(`"message":`)) && !bytes.Contains(body, []byte(`"text":`)) && !bytes.Contains(body, []byte(`"hint":`)) {
		return body
	}
	dec := json.NewDecoder(bytes.NewReader(body))
	dec.UseNumber()
	var v any
	if err := dec.Decode(&v); err != nil {
		return body
	}
	var buf bytes.Buffer
	if err := json.NewEncoder(&buf).Encode(translateValue(v, "")); err != nil {
		return body
	}
	return buf.Bytes()
}
