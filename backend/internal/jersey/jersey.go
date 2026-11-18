// Package jersey holds a shirt number the way it is printed on the kit.
package jersey

import (
	"bytes"
	"database/sql/driver"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"unicode"
)

// Number is a shirt number: digits, optionally with letters («10», «Z10», «7A»).
// The empty value means «no number»: NULL in the database, null in JSON.
type Number string

// MaxLen is the longest number that still fits a shirt and the pitch markers.
const MaxLen = 4

// ErrInvalid is returned for input that is not 1–4 letters and digits.
var ErrInvalid = errors.New("raqam 1–4 ta belgi: raqamlar va harflar (masalan 10 yoki Z10)")

// Parse normalises typed input: «z 10» → «Z10», «07» → «7». Spaces are dropped,
// letters are upper-cased, a plain number loses its leading zeros. Empty input
// is «no number» and valid; ok is false for anything but 1–4 letters and digits.
func Parse(s string) (Number, bool) {
	var b strings.Builder
	digits := true
	n := 0
	for _, r := range s {
		switch {
		case unicode.IsSpace(r):
			continue
		case r >= '0' && r <= '9':
		case unicode.IsLetter(r):
			digits = false
			r = unicode.ToUpper(r)
		default:
			return "", false
		}
		b.WriteRune(r)
		n++
	}
	if n == 0 {
		return "", true
	}
	out := b.String()
	if digits {
		out = strings.TrimLeft(out, "0")
		if out == "" {
			out = "0"
		}
		n = len(out)
	}
	if n > MaxLen {
		return "", false
	}
	return Number(out), true
}

// FromInt turns a plain number (a protocol row, old data) into a Number.
func FromInt(n int) Number {
	if n < 0 {
		return ""
	}
	return Number(strconv.Itoa(n))
}

func (n Number) String() string { return string(n) }

// Ord is the numeric part for ordering: 2 < 10 < Z10 (letters break ties in
// the caller). Numbers without digits and «no number» sort last.
func (n Number) Ord() int {
	v, seen := 0, false
	for _, r := range n {
		if r >= '0' && r <= '9' {
			v, seen = v*10+int(r-'0'), true
		}
	}
	if !seen {
		return 1 << 30
	}
	return v
}

// Less orders numbers the way a team sheet does: 1, 2, 10, Z10, A, «none».
func Less(a, b Number) bool {
	if x, y := a.Ord(), b.Ord(); x != y {
		return x < y
	}
	if a == "" || b == "" {
		return a != "" // «no number» goes last
	}
	return a < b
}

// MarshalJSON writes null for «no number».
func (n Number) MarshalJSON() ([]byte, error) {
	if n == "" {
		return []byte("null"), nil
	}
	return json.Marshal(string(n))
}

// UnmarshalJSON accepts null, a JSON number (10) and a string («z 10»).
func (n *Number) UnmarshalJSON(b []byte) error {
	b = bytes.TrimSpace(b)
	if len(b) == 0 || bytes.Equal(b, []byte("null")) {
		*n = ""
		return nil
	}
	s := string(b)
	if b[0] == '"' {
		if err := json.Unmarshal(b, &s); err != nil {
			return err
		}
	}
	v, ok := Parse(s)
	if !ok {
		return ErrInvalid
	}
	*n = v
	return nil
}

// Scan reads the column: NULL is «no number».
func (n *Number) Scan(src any) error {
	switch v := src.(type) {
	case nil:
		*n = ""
	case string:
		*n = Number(v)
	case []byte:
		*n = Number(v)
	case int64:
		*n = Number(strconv.FormatInt(v, 10))
	default:
		return fmt.Errorf("jersey: cannot scan %T", src)
	}
	return nil
}

// Value stores «no number» as NULL.
func (n Number) Value() (driver.Value, error) {
	if n == "" {
		return nil, nil
	}
	return string(n), nil
}
