package api

import (
	"bytes"
	"testing"
)

func TestWriteSSEMultiline(t *testing.T) {
	var b bytes.Buffer
	writeSSE(&b, "match", []byte("{\"a\": [1, \n 2]}"))
	want := "event: match\ndata: {\"a\": [1, \ndata:  2]}\n\n"
	if b.String() != want {
		t.Fatalf("got %q want %q", b.String(), want)
	}
}
