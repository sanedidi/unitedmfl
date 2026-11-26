package tickets

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base32"
	"fmt"
	"strconv"
	"strings"
	"time"
)

// QR codes on tickets.
//
//	UMFL1.<ticket number>.<window>.<signature>
//
// window = unix time / 30 s for dynamic codes (the site redraws the code
// every 30 s, a screenshot goes stale), or 0 for a static code when the
// dynamic QR is switched off for the sale. The signature is an HMAC of the
// number and window with the ticket's own secret, so a code can't be forged
// from the ticket number alone.

const (
	QRPrefix = "UMFL1"
	Window   = 30 * time.Second
	// windows accepted on each side of now: phone clocks drift and the
	// guest needs a moment between opening the code and the scan.
	Skew = 2
)

var b32 = base32.StdEncoding.WithPadding(base32.NoPadding)

// NewSecret returns a random per-ticket QR secret.
func NewSecret() []byte {
	b := make([]byte, 20)
	_, _ = rand.Read(b)
	return b
}

// WindowAt is the dynamic window number of t.
func WindowAt(t time.Time) int64 { return t.Unix() / int64(Window/time.Second) }

func sign(secret []byte, number string, window int64) string {
	m := hmac.New(sha256.New, secret)
	fmt.Fprintf(m, "%s.%d", number, window)
	return b32.EncodeToString(m.Sum(nil))[:12]
}

// Code renders the QR payload. dynamic=false gives the static code.
func Code(secret []byte, number string, dynamic bool, now time.Time) string {
	var w int64
	if dynamic {
		w = WindowAt(now)
	}
	return fmt.Sprintf("%s.%s.%d.%s", QRPrefix, number, w, sign(secret, number, w))
}

// Parsed is a decoded QR payload (signature not yet checked).
type Parsed struct {
	Number string
	Window int64
	Sig    string
}

// ParseCode splits a scanned payload. A bare ticket number (typed by the
// controller) is accepted with Window = -1.
func ParseCode(s string) (Parsed, bool) {
	s = strings.TrimSpace(s)
	if !strings.HasPrefix(s, QRPrefix+".") {
		if s != "" && !strings.ContainsAny(s, " .") && len(s) <= 40 {
			return Parsed{Number: strings.ToUpper(s), Window: -1}, true
		}
		return Parsed{}, false
	}
	p := strings.Split(s, ".")
	if len(p) != 4 {
		return Parsed{}, false
	}
	w, err := strconv.ParseInt(p[2], 10, 64)
	if err != nil || w < 0 {
		return Parsed{}, false
	}
	return Parsed{Number: p[1], Window: w, Sig: p[3]}, true
}

// Verdict of a signature check.
type Verdict int

const (
	Valid Verdict = iota
	BadSignature
	Stale  // dynamic code from another time: a screenshot or an old page
	Static // static code while the sale requires dynamic ones
)

// Verify checks a parsed code against the ticket secret.
func Verify(secret []byte, p Parsed, dynamic bool, now time.Time) Verdict {
	if !hmac.Equal([]byte(sign(secret, p.Number, p.Window)), []byte(p.Sig)) {
		return BadSignature
	}
	if !dynamic {
		return Valid
	}
	if p.Window == 0 {
		return Static
	}
	cur := WindowAt(now)
	if p.Window < cur-Skew || p.Window > cur+Skew {
		return Stale
	}
	return Valid
}
