package protocol

import (
	"context"
	"encoding/json"
	"os"
	"testing"
)

// TestSamplePDF runs against a real protocol when PROTOCOL_SAMPLE points to a PDF (not committed).
func TestSamplePDF(t *testing.T) {
	path := os.Getenv("PROTOCOL_SAMPLE")
	if path == "" {
		t.Skip("PROTOCOL_SAMPLE not set")
	}
	words, method, pages, err := ExtractWords(context.Background(), path, "application/pdf")
	if err != nil {
		t.Fatal(err)
	}
	ex := Parse(words)
	issues := Validate(ex)
	b, _ := json.MarshalIndent(map[string]any{"method": method, "pages": pages, "extracted": ex, "issues": issues}, "", "  ")
	if os.Getenv("PROTOCOL_DUMP") != "" {
		_ = os.WriteFile(os.Getenv("PROTOCOL_DUMP"), b, 0o644)
	}
	if ex.Home.Total == nil || ex.Away.Total == nil {
		t.Fatal("score not parsed")
	}
}
