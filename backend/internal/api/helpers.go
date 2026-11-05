package api

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"path/filepath"
	"regexp"
	"strings"
)

var rePhone = regexp.MustCompile(`^\+?[0-9 ()\-]{7,20}$`)

// rawJSON embeds pre-rendered JSON into encoding/json output.
type rawJSON []byte

func (r rawJSON) MarshalJSON() ([]byte, error) {
	if len(r) == 0 {
		return []byte("null"), nil
	}
	return r, nil
}

var _ json.Marshaler = rawJSON(nil)

func randomName(ext string) string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b) + ext
}

func sanitizeFilename(name string) string {
	name = filepath.Base(name)
	name = strings.Map(func(r rune) rune {
		if r == '"' || r == '\\' || r < 32 {
			return '_'
		}
		return r
	}, name)
	if len(name) > 120 {
		name = name[len(name)-120:]
	}
	return name
}
