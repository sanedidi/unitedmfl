package api

import "testing"

func TestVideoExt(t *testing.T) {
	ftyp := func(brand string) []byte { return append([]byte{0, 0, 0, 0x20}, []byte("ftyp"+brand)...) }
	cases := []struct {
		head []byte
		ext  string
		ok   bool
	}{
		{ftyp("isom"), ".mp4", true},
		{ftyp("mp42"), ".mp4", true},
		{ftyp("qt  "), ".mov", true},
		{ftyp("heic"), "", false},
		{ftyp("avif"), "", false},
		{[]byte{0x1A, 0x45, 0xDF, 0xA3, 0x01}, ".webm", true},
		{[]byte("\x89PNG\r\n\x1a\n...."), "", false},
		{[]byte("ab"), "", false},
	}
	for _, c := range cases {
		ext, ok := videoExt(c.head)
		if ext != c.ext || ok != c.ok {
			t.Errorf("videoExt(%q) = %q, %v; want %q, %v", c.head, ext, ok, c.ext, c.ok)
		}
	}
}

func TestVideoFileName(t *testing.T) {
	good := "0123456789abcdef0123456789abcdef.mp4"
	for url, want := range map[string]bool{
		"/uploads/videos/" + good:                     true,
		"https://unitedmfl.uz/uploads/videos/" + good: true,
		"/uploads/videos/" + good + ".part":           false,
		"/uploads/videos/../images/x.png":             false,
		"https://youtu.be/Xk7bP3mQ2aE":                false,
	} {
		if _, ok := videoFileName(url); ok != want {
			t.Errorf("videoFileName(%q) ok=%v, want %v", url, ok, want)
		}
	}
}

func TestPrepareVideo(t *testing.T) {
	good := "/uploads/videos/0123456789abcdef0123456789abcdef.webm"
	if err := prepareVideo(nil, nil, map[string]any{"source": "file", "url": good}, true); err != nil {
		t.Fatalf("file video rejected: %v", err)
	}
	if err := prepareVideo(nil, nil, map[string]any{"source": "file", "url": "https://youtu.be/x"}, true); err == nil {
		t.Fatal("file video with a link accepted")
	}
	if err := prepareVideo(nil, nil, map[string]any{"source": "link", "url": "javascript:alert(1)"}, true); err == nil {
		t.Fatal("non-http link accepted")
	}
	if err := prepareVideo(nil, nil, map[string]any{"source": "link", "url": "https://youtu.be/Xk7bP3mQ2aE"}, true); err != nil {
		t.Fatalf("youtube link rejected: %v", err)
	}
}
