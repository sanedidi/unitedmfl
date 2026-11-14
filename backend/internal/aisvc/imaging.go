package aisvc

import (
	"bytes"
	"fmt"
	"image"
	"image/color"
	"image/draw"
	"image/jpeg"
	"image/png"
	"math"
	"os"
	"os/exec"
)

func sqrt(v float64) float64 { return math.Sqrt(v) }

// Output is one finished picture.
type Output struct {
	Mime   string `json:"mime"`
	Data   []byte `json:"data"`
	Width  int    `json:"width"`
	Height int    `json:"height"`
}

// finish crops the provider image to the target aspect (centred), resizes it
// to exactly w×h and encodes it. WebP needs the cwebp tool; without it the
// result falls back to JPEG.
func finish(src []byte, w, h int, format string, quality int, cwebp string) (Output, error) {
	img, _, err := image.Decode(bytes.NewReader(src))
	if err != nil {
		return Output{}, fmt.Errorf("rasmni o‘qib bo‘lmadi: %w", err)
	}
	dst := coverResize(img, w, h)
	switch format {
	case "png":
		var buf bytes.Buffer
		if err := png.Encode(&buf, dst); err != nil {
			return Output{}, err
		}
		return Output{Mime: "image/png", Data: buf.Bytes(), Width: w, Height: h}, nil
	case "webp":
		if b, err := encodeWebP(dst, quality, cwebp); err == nil {
			return Output{Mime: "image/webp", Data: b, Width: w, Height: h}, nil
		}
	}
	var buf bytes.Buffer
	if err := jpeg.Encode(&buf, dst, &jpeg.Options{Quality: quality}); err != nil {
		return Output{}, err
	}
	return Output{Mime: "image/jpeg", Data: buf.Bytes(), Width: w, Height: h}, nil
}

func encodeWebP(img image.Image, quality int, cwebp string) ([]byte, error) {
	if cwebp == "" {
		return nil, fmt.Errorf("cwebp yo‘q")
	}
	path, err := exec.LookPath(cwebp)
	if err != nil {
		return nil, err
	}
	in, err := os.CreateTemp("", "ai-*.png")
	if err != nil {
		return nil, err
	}
	defer os.Remove(in.Name())
	if err := png.Encode(in, img); err != nil {
		in.Close()
		return nil, err
	}
	in.Close()
	out := in.Name() + ".webp"
	defer os.Remove(out)
	if b, err := exec.Command(path, "-quiet", "-q", fmt.Sprint(quality), in.Name(), "-o", out).CombinedOutput(); err != nil {
		return nil, fmt.Errorf("cwebp: %v: %s", err, b)
	}
	return os.ReadFile(out)
}

// coverResize scales img to cover w×h and crops the overflow evenly.
// Downscaling averages the covered source area; upscaling is bilinear.
func coverResize(img image.Image, w, h int) *image.RGBA {
	src := toRGBA(img)
	sb := src.Bounds()
	sw, sh := float64(sb.Dx()), float64(sb.Dy())
	scale := math.Max(float64(w)/sw, float64(h)/sh)
	cw, ch := float64(w)/scale, float64(h)/scale // source window
	ox, oy := (sw-cw)/2, (sh-ch)/2
	dst := image.NewRGBA(image.Rect(0, 0, w, h))
	step := 1 / scale // source pixels per destination pixel
	for y := 0; y < h; y++ {
		sy0 := oy + float64(y)*step
		for x := 0; x < w; x++ {
			sx0 := ox + float64(x)*step
			var c color.RGBA
			if step > 1 {
				c = boxAvg(src, sx0, sy0, step)
			} else {
				c = bilinear(src, sx0+step/2-0.5, sy0+step/2-0.5)
			}
			dst.SetRGBA(x, y, c)
		}
	}
	return dst
}

func toRGBA(img image.Image) *image.RGBA {
	if r, ok := img.(*image.RGBA); ok && r.Bounds().Min == (image.Point{}) {
		return r
	}
	b := img.Bounds()
	r := image.NewRGBA(image.Rect(0, 0, b.Dx(), b.Dy()))
	draw.Draw(r, r.Bounds(), img, b.Min, draw.Src)
	return r
}

func boxAvg(src *image.RGBA, x0, y0, step float64) color.RGBA {
	b := src.Bounds()
	xa, ya := int(x0), int(y0)
	xb, yb := int(math.Ceil(x0+step)), int(math.Ceil(y0+step))
	xb, yb = min(xb, b.Max.X), min(yb, b.Max.Y)
	var r, g, bl, a, n uint32
	for y := ya; y < yb; y++ {
		i := src.PixOffset(xa, y)
		for x := xa; x < xb; x++ {
			r += uint32(src.Pix[i])
			g += uint32(src.Pix[i+1])
			bl += uint32(src.Pix[i+2])
			a += uint32(src.Pix[i+3])
			n++
			i += 4
		}
	}
	if n == 0 {
		return src.RGBAAt(min(xa, b.Max.X-1), min(ya, b.Max.Y-1))
	}
	return color.RGBA{uint8(r / n), uint8(g / n), uint8(bl / n), uint8(a / n)}
}

func bilinear(src *image.RGBA, fx, fy float64) color.RGBA {
	b := src.Bounds()
	clamp := func(v, hi int) int { return max(0, min(v, hi)) }
	x0, y0 := int(math.Floor(fx)), int(math.Floor(fy))
	dx, dy := fx-float64(x0), fy-float64(y0)
	x0c, x1c := clamp(x0, b.Max.X-1), clamp(x0+1, b.Max.X-1)
	y0c, y1c := clamp(y0, b.Max.Y-1), clamp(y0+1, b.Max.Y-1)
	p := func(x, y int) [4]float64 {
		c := src.RGBAAt(x, y)
		return [4]float64{float64(c.R), float64(c.G), float64(c.B), float64(c.A)}
	}
	a, bb, c, d := p(x0c, y0c), p(x1c, y0c), p(x0c, y1c), p(x1c, y1c)
	var out [4]uint8
	for i := 0; i < 4; i++ {
		v := a[i]*(1-dx)*(1-dy) + bb[i]*dx*(1-dy) + c[i]*(1-dx)*dy + d[i]*dx*dy
		out[i] = uint8(math.Round(math.Max(0, math.Min(255, v))))
	}
	return color.RGBA{out[0], out[1], out[2], out[3]}
}
