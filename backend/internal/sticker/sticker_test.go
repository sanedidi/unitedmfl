package sticker

import (
	"bytes"
	"image"
	"image/color"
	"image/draw"
	"image/png"
	"math/rand"
	"testing"
)

// logo: a blue disc on a white page with a white "eye" inside it, the kind of
// white that must stay.
func testLogo(w, h int, bg color.NRGBA) *image.NRGBA {
	img := image.NewNRGBA(image.Rect(0, 0, w, h))
	draw.Draw(img, img.Rect, &image.Uniform{bg}, image.Point{}, draw.Src)
	cx, cy, r := w/2, h/2, min(w, h)/3
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			dx, dy := x-cx, y-cy
			switch {
			case dx*dx+dy*dy <= (r/4)*(r/4):
				img.SetNRGBA(x, y, color.NRGBA{255, 255, 255, 255}) // eye
			case dx*dx+dy*dy <= r*r:
				img.SetNRGBA(x, y, color.NRGBA{30, 60, 200, 255})
			}
		}
	}
	return img
}

func TestRemoveBackgroundKeepsInnerWhite(t *testing.T) {
	img := testLogo(300, 360, color.NRGBA{255, 255, 255, 255})
	out := RemoveBackground(img)
	if a := out.NRGBAAt(2, 2).A; a != 0 {
		t.Fatalf("corner alpha = %d, want 0", a)
	}
	if c := out.NRGBAAt(150, 180); c.A != 255 || c.R != 255 {
		t.Fatalf("inner white = %v, want opaque white", c)
	}
	if c := out.NRGBAAt(150+80, 180); c.A != 255 || c.B != 200 {
		t.Fatalf("disc = %v, want opaque blue", c)
	}
}

func TestRemoveBackgroundOtherColour(t *testing.T) {
	img := testLogo(200, 200, color.NRGBA{20, 20, 20, 255}) // black page
	out := RemoveBackground(img)
	if a := out.NRGBAAt(1, 1).A; a != 0 {
		t.Fatalf("black background kept: alpha %d", a)
	}
}

func TestRemoveBackgroundLeavesPhotosAndCutouts(t *testing.T) {
	rng := rand.New(rand.NewSource(1))
	photo := image.NewNRGBA(image.Rect(0, 0, 100, 100))
	for i := range photo.Pix {
		photo.Pix[i] = uint8(rng.Intn(256))
		if i%4 == 3 {
			photo.Pix[i] = 255
		}
	}
	if out := RemoveBackground(photo); !bytes.Equal(out.Pix, photo.Pix) {
		t.Fatal("busy border must not be cut")
	}
	cut := image.NewNRGBA(image.Rect(0, 0, 100, 100)) // already transparent
	cut.SetNRGBA(50, 50, color.NRGBA{255, 255, 255, 255})
	if out := RemoveBackground(cut); out.NRGBAAt(50, 50).A != 255 {
		t.Fatal("transparent logo changed")
	}
}

func TestBuild(t *testing.T) {
	for _, outline := range []bool{false, true} {
		data, err := Build(testLogo(900, 700, color.NRGBA{250, 250, 250, 255}), Options{Outline: outline})
		if err != nil {
			t.Fatal(err)
		}
		if len(data) > MaxBytes {
			t.Fatalf("%d bytes", len(data))
		}
		img, err := png.Decode(bytes.NewReader(data))
		if err != nil {
			t.Fatal(err)
		}
		b := img.Bounds()
		if b.Dx() != Size || b.Dy() != Size {
			t.Fatalf("size %v", b)
		}
		if _, _, _, a := img.At(0, 0).RGBA(); a != 0 {
			t.Fatal("corner not transparent")
		}
		// the disc is centred and fills the box: the middle row reaches near the margin
		left := -1
		for x := 0; x < Size; x++ {
			if _, _, _, a := img.At(x, Size/2).RGBA(); a > 0x8000 {
				left = x
				break
			}
		}
		want := margin
		if outline {
			// the white border starts at the margin, the blue disc after it
			r, g, bl, _ := img.At(left+2, Size/2).RGBA()
			if r>>8 < 240 || g>>8 < 240 || bl>>8 < 240 {
				t.Fatalf("outline pixel not white: %d %d %d", r>>8, g>>8, bl>>8)
			}
		}
		if left < want-2 || left > want+2 {
			t.Fatalf("outline=%v: left edge at %d, want ≈%d", outline, left, want)
		}
	}
}

func TestBuildEmpty(t *testing.T) {
	blank := image.NewNRGBA(image.Rect(0, 0, 50, 50))
	draw.Draw(blank, blank.Rect, &image.Uniform{color.White}, image.Point{}, draw.Src)
	if _, err := Build(blank, Options{}); err != ErrEmpty {
		t.Fatalf("err = %v", err)
	}
}

func TestBuildFitsSizeLimit(t *testing.T) {
	// noise compresses badly: the encoder must reduce colours to stay under 512 KB
	rng := rand.New(rand.NewSource(2))
	img := image.NewNRGBA(image.Rect(0, 0, 600, 600))
	for i := range img.Pix {
		img.Pix[i] = uint8(rng.Intn(256))
		if i%4 == 3 {
			img.Pix[i] = 255
		}
	}
	data, err := Build(img, Options{})
	if err != nil {
		t.Fatal(err)
	}
	if len(data) > MaxBytes {
		t.Fatalf("%d bytes", len(data))
	}
}
