// Package sticker turns a team logo into a Telegram static sticker:
// a 512×512 PNG with a transparent background, at most 512 KB.
//
// Steps:
//  1. Background. A logo on a plain background (white, or any single colour
//     covering most of the border) loses that background: only pixels of that
//     colour CONNECTED TO THE EDGE become transparent, so white eyes, letters
//     and patterns inside the logo stay. A logo that already has transparency
//     is kept as is; a photo-like border (no single colour) is not touched.
//  2. Edges. The pixels next to the removed background get a soft alpha and
//     the background colour is taken out of them (no white halo on dark chats).
//  3. Fit. The logo is cropped to its content and centred in 512×512 with a margin.
//  4. Outline (optional). A white border around the shape, the usual sticker
//     look, so dark logos stay visible in Telegram's dark theme.
//  5. Size. PNG at best compression; if it is still over 512 KB the colours
//     are slightly reduced until it fits.
package sticker

import (
	"bytes"
	"errors"
	"image"
	"image/color"
	"image/png"
	"math"
	"sort"
)

const (
	Size     = 512       // Telegram: one side exactly 512 px
	MaxBytes = 512 << 10 // Telegram: static sticker file limit
	margin   = 16        // free space around the logo
	outlineW = 10        // white border width (px at 512)
	bgTol    = 38        // max channel difference still counted as background
	bgShare  = 0.6       // share of border pixels that must be the background colour
	edgeBand = 2         // px of soft edge next to the removed background
)

// Options control the result.
type Options struct {
	Outline bool // white border around the logo
}

// ErrEmpty is returned for an image with nothing left after background removal.
var ErrEmpty = errors.New("logotipda tasvir topilmadi")

// Build returns the sticker PNG for img.
func Build(img image.Image, o Options) ([]byte, error) {
	src := toNRGBA(img)
	cut := RemoveBackground(src)
	box, ok := contentBounds(cut)
	if !ok {
		return nil, ErrEmpty
	}
	cut = crop(cut, box)
	pad := margin
	if o.Outline {
		pad += outlineW
	}
	out := fit(cut, Size-2*pad)
	if o.Outline {
		out = addOutline(out, outlineW)
	}
	return encode(out)
}

// ---------- background ----------

// RemoveBackground returns a copy of img whose plain, edge-connected
// background is transparent. Images with transparency or a busy border
// are returned unchanged (as a copy).
func RemoveBackground(img *image.NRGBA) *image.NRGBA {
	out := image.NewNRGBA(img.Rect)
	copy(out.Pix, img.Pix)
	w, h := img.Rect.Dx(), img.Rect.Dy()
	if w < 3 || h < 3 {
		return out
	}
	border := borderPixels(img)
	transparent := 0
	for _, c := range border {
		if c.A < 128 {
			transparent++
		}
	}
	if float64(transparent) >= 0.5*float64(len(border)) {
		return out // already cut out
	}
	bg := medianColor(border)
	same := 0
	for _, c := range border {
		if diff(c, bg) <= bgTol {
			same++
		}
	}
	if float64(same) < bgShare*float64(len(border)) {
		return out // no plain background: keep the picture whole
	}

	// flood fill from the edge over background-coloured pixels (4-connected)
	isBg := make([]bool, w*h)
	queue := make([]int, 0, 2*(w+h))
	push := func(x, y int) {
		i := y*w + x
		if isBg[i] || diff(at(img, x, y), bg) > bgTol {
			return
		}
		isBg[i] = true
		queue = append(queue, i)
	}
	for x := 0; x < w; x++ {
		push(x, 0)
		push(x, h-1)
	}
	for y := 0; y < h; y++ {
		push(0, y)
		push(w-1, y)
	}
	for len(queue) > 0 {
		i := queue[len(queue)-1]
		queue = queue[:len(queue)-1]
		x, y := i%w, i/w
		if x > 0 {
			push(x-1, y)
		}
		if x < w-1 {
			push(x+1, y)
		}
		if y > 0 {
			push(x, y-1)
		}
		if y < h-1 {
			push(x, y+1)
		}
	}

	// distance (in px, up to edgeBand) from each pixel to the background
	near := make([]uint8, w*h)
	front := []int{}
	for i, b := range isBg {
		if b {
			near[i] = 255
		}
	}
	for i := range isBg {
		if !isBg[i] && touches(isBg, i, w, h) {
			near[i] = 1
			front = append(front, i)
		}
	}
	for d := uint8(2); d <= edgeBand; d++ {
		next := []int{}
		for _, i := range front {
			x, y := i%w, i/w
			for _, j := range [4]int{i - 1, i + 1, i - w, i + w} {
				if j < 0 || j >= w*h || near[j] != 0 || isBg[j] {
					continue
				}
				if (j == i-1 && x == 0) || (j == i+1 && x == w-1) || (j == i-w && y == 0) || (j == i+w && y == h-1) {
					continue
				}
				near[j] = d
				next = append(next, j)
			}
		}
		front = next
	}

	lo, hi := float64(bgTol)/2, float64(bgTol)*2
	for i := range isBg {
		p := out.Pix[i*4 : i*4+4]
		switch {
		case isBg[i]:
			p[0], p[1], p[2], p[3] = 0, 0, 0, 0
		case near[i] > 0 && near[i] <= edgeBand:
			c := color.NRGBA{p[0], p[1], p[2], p[3]}
			a := (float64(diff(c, bg)) - lo) / (hi - lo)
			a = math.Max(0, math.Min(1, a))
			if a >= 1 {
				continue
			}
			if a <= 0.02 {
				p[0], p[1], p[2], p[3] = 0, 0, 0, 0
				continue
			}
			// c = a·fg + (1−a)·bg  →  fg = (c − (1−a)·bg) / a
			p[0] = unblend(p[0], bg.R, a)
			p[1] = unblend(p[1], bg.G, a)
			p[2] = unblend(p[2], bg.B, a)
			p[3] = uint8(math.Round(float64(p[3]) * a))
		}
	}
	return out
}

func unblend(c, bg uint8, a float64) uint8 {
	v := (float64(c) - (1-a)*float64(bg)) / a
	return uint8(math.Max(0, math.Min(255, math.Round(v))))
}

func touches(isBg []bool, i, w, h int) bool {
	x, y := i%w, i/w
	return (x > 0 && isBg[i-1]) || (x < w-1 && isBg[i+1]) || (y > 0 && isBg[i-w]) || (y < h-1 && isBg[i+w])
}

func borderPixels(img *image.NRGBA) []color.NRGBA {
	w, h := img.Rect.Dx(), img.Rect.Dy()
	out := make([]color.NRGBA, 0, 2*(w+h))
	for x := 0; x < w; x++ {
		out = append(out, at(img, x, 0), at(img, x, h-1))
	}
	for y := 1; y < h-1; y++ {
		out = append(out, at(img, 0, y), at(img, w-1, y))
	}
	return out
}

func medianColor(cs []color.NRGBA) color.NRGBA {
	ch := func(f func(color.NRGBA) uint8) uint8 {
		v := make([]int, len(cs))
		for i, c := range cs {
			v[i] = int(f(c))
		}
		sort.Ints(v)
		return uint8(v[len(v)/2])
	}
	return color.NRGBA{
		R: ch(func(c color.NRGBA) uint8 { return c.R }),
		G: ch(func(c color.NRGBA) uint8 { return c.G }),
		B: ch(func(c color.NRGBA) uint8 { return c.B }),
		A: 255,
	}
}

// diff is the largest per-channel difference (alpha-aware: a transparent
// pixel differs from an opaque colour).
func diff(a, b color.NRGBA) int {
	d := 0
	for _, v := range [4]int{int(a.R) - int(b.R), int(a.G) - int(b.G), int(a.B) - int(b.B), int(a.A) - int(b.A)} {
		if v < 0 {
			v = -v
		}
		if v > d {
			d = v
		}
	}
	return d
}

func at(img *image.NRGBA, x, y int) color.NRGBA {
	i := y*img.Stride + x*4
	p := img.Pix[i : i+4]
	return color.NRGBA{p[0], p[1], p[2], p[3]}
}

func toNRGBA(img image.Image) *image.NRGBA {
	b := img.Bounds()
	out := image.NewNRGBA(image.Rect(0, 0, b.Dx(), b.Dy()))
	if n, ok := img.(*image.NRGBA); ok && n.Rect.Min == (image.Point{}) && n.Stride == 4*b.Dx() {
		copy(out.Pix, n.Pix)
		return out
	}
	for y := 0; y < b.Dy(); y++ {
		for x := 0; x < b.Dx(); x++ {
			out.Set(x, y, img.At(b.Min.X+x, b.Min.Y+y))
		}
	}
	return out
}

// ---------- crop and fit ----------

func contentBounds(img *image.NRGBA) (image.Rectangle, bool) {
	w, h := img.Rect.Dx(), img.Rect.Dy()
	x0, y0, x1, y1 := w, h, -1, -1
	for y := 0; y < h; y++ {
		row := img.Pix[y*img.Stride:]
		for x := 0; x < w; x++ {
			if row[x*4+3] > 8 {
				x0, y0 = min(x0, x), min(y0, y)
				x1, y1 = max(x1, x), max(y1, y)
			}
		}
	}
	if x1 < 0 {
		return image.Rectangle{}, false
	}
	return image.Rect(x0, y0, x1+1, y1+1), true
}

func crop(img *image.NRGBA, r image.Rectangle) *image.NRGBA {
	out := image.NewNRGBA(image.Rect(0, 0, r.Dx(), r.Dy()))
	for y := 0; y < r.Dy(); y++ {
		copy(out.Pix[y*out.Stride:(y+1)*out.Stride], img.Pix[(r.Min.Y+y)*img.Stride+r.Min.X*4:])
	}
	return out
}

// fit scales img to fit a box×box square and centres it on a transparent Size×Size canvas.
func fit(img *image.NRGBA, box int) *image.NRGBA {
	w, h := img.Rect.Dx(), img.Rect.Dy()
	k := math.Min(float64(box)/float64(w), float64(box)/float64(h))
	nw, nh := max(1, int(math.Round(float64(w)*k))), max(1, int(math.Round(float64(h)*k)))
	scaled := resize(img, nw, nh)
	out := image.NewNRGBA(image.Rect(0, 0, Size, Size))
	ox, oy := (Size-nw)/2, (Size-nh)/2
	for y := 0; y < nh; y++ {
		copy(out.Pix[(oy+y)*out.Stride+ox*4:], scaled.Pix[y*scaled.Stride:y*scaled.Stride+nw*4])
	}
	return out
}

// resize is a separable triangle-filter resampler on premultiplied colour:
// bilinear when enlarging, area-weighted when shrinking.
func resize(img *image.NRGBA, nw, nh int) *image.NRGBA {
	w, h := img.Rect.Dx(), img.Rect.Dy()
	// premultiplied float planes
	src := make([]float64, w*h*4)
	for i := 0; i < w*h; i++ {
		p := img.Pix[i*4 : i*4+4]
		a := float64(p[3]) / 255
		src[i*4], src[i*4+1], src[i*4+2], src[i*4+3] = float64(p[0])*a, float64(p[1])*a, float64(p[2])*a, float64(p[3])
	}
	tmp := make([]float64, nw*h*4)
	for x := 0; x < nw; x++ {
		ws, idx := weights(w, nw, x)
		for y := 0; y < h; y++ {
			var acc [4]float64
			for k, sx := range idx {
				j := (y*w + sx) * 4
				for c := 0; c < 4; c++ {
					acc[c] += src[j+c] * ws[k]
				}
			}
			copy(tmp[(y*nw+x)*4:], acc[:])
		}
	}
	out := image.NewNRGBA(image.Rect(0, 0, nw, nh))
	for y := 0; y < nh; y++ {
		ws, idx := weights(h, nh, y)
		for x := 0; x < nw; x++ {
			var acc [4]float64
			for k, sy := range idx {
				j := (sy*nw + x) * 4
				for c := 0; c < 4; c++ {
					acc[c] += tmp[j+c] * ws[k]
				}
			}
			p := out.Pix[y*out.Stride+x*4:]
			a := math.Max(0, math.Min(255, acc[3]))
			p[3] = uint8(math.Round(a))
			if a > 0 {
				f := 255 / a
				for c := 0; c < 3; c++ {
					p[c] = uint8(math.Max(0, math.Min(255, math.Round(acc[c]*f))))
				}
			}
		}
	}
	return out
}

// weights returns the source taps and normalised weights for output index i.
func weights(n, nn, i int) ([]float64, []int) {
	scale := float64(n) / float64(nn)
	support := math.Max(1, scale)
	center := (float64(i)+0.5)*scale - 0.5
	lo, hi := int(math.Floor(center-support)), int(math.Ceil(center+support))
	var ws []float64
	var idx []int
	sum := 0.0
	for s := lo; s <= hi; s++ {
		d := math.Abs(float64(s)-center) / support
		if d >= 1 {
			continue
		}
		wt := 1 - d
		ws = append(ws, wt)
		idx = append(idx, min(max(s, 0), n-1))
		sum += wt
	}
	if sum == 0 {
		return []float64{1}, []int{min(max(int(math.Round(center)), 0), n-1)}
	}
	for k := range ws {
		ws[k] /= sum
	}
	return ws, idx
}

// ---------- outline ----------

// addOutline puts a white, anti-aliased border of width px behind the shape.
func addOutline(img *image.NRGBA, width int) *image.NRGBA {
	w, h := img.Rect.Dx(), img.Rect.Dy()
	inside := make([]bool, w*h)
	for i := range inside {
		inside[i] = img.Pix[i*4+3] >= 128
	}
	dist := distance(inside, w, h)
	out := image.NewNRGBA(img.Rect)
	for i := 0; i < w*h; i++ {
		oa := math.Max(0, math.Min(1, float64(width)+0.5-dist[i]))
		p := img.Pix[i*4 : i*4+4]
		fa := float64(p[3]) / 255
		// logo over white outline
		a := fa + oa*(1-fa)
		q := out.Pix[i*4 : i*4+4]
		if a <= 0 {
			continue
		}
		for c := 0; c < 3; c++ {
			v := (float64(p[c])*fa + 255*oa*(1-fa)) / a
			q[c] = uint8(math.Round(math.Min(255, v)))
		}
		q[3] = uint8(math.Round(a * 255))
	}
	return out
}

// distance is the exact Euclidean distance from every pixel to the nearest
// inside pixel (Felzenszwalb & Huttenlocher), 0 inside.
func distance(inside []bool, w, h int) []float64 {
	const inf = 1e20
	f := make([]float64, w*h)
	for i, in := range inside {
		if !in {
			f[i] = inf
		}
	}
	n := max(w, h)
	col, d := make([]float64, n), make([]float64, n)
	v, z := make([]int, n), make([]float64, n+1)
	for x := 0; x < w; x++ {
		for y := 0; y < h; y++ {
			col[y] = f[y*w+x]
		}
		edt1(col[:h], d[:h], v, z)
		for y := 0; y < h; y++ {
			f[y*w+x] = d[y]
		}
	}
	for y := 0; y < h; y++ {
		edt1(f[y*w:y*w+w], d[:w], v, z)
		for x := 0; x < w; x++ {
			f[y*w+x] = math.Sqrt(d[x])
		}
	}
	return f
}

func edt1(f, d []float64, v []int, z []float64) {
	n := len(f)
	k := 0
	v[0] = 0
	z[0], z[1] = math.Inf(-1), math.Inf(1)
	for q := 1; q < n; q++ {
		s := ((f[q] + float64(q*q)) - (f[v[k]] + float64(v[k]*v[k]))) / float64(2*q-2*v[k])
		for s <= z[k] {
			k--
			s = ((f[q] + float64(q*q)) - (f[v[k]] + float64(v[k]*v[k]))) / float64(2*q-2*v[k])
		}
		k++
		v[k] = q
		z[k], z[k+1] = s, math.Inf(1)
	}
	k = 0
	for q := 0; q < n; q++ {
		for z[k+1] < float64(q) {
			k++
		}
		d[q] = float64((q-v[k])*(q-v[k])) + f[v[k]]
	}
}

// ---------- encoding ----------

func encode(img *image.NRGBA) ([]byte, error) {
	enc := png.Encoder{CompressionLevel: png.BestCompression}
	for _, bits := range []uint{8, 6, 5, 4} {
		src := img
		if bits < 8 {
			src = posterize(img, bits)
		}
		var buf bytes.Buffer
		if err := enc.Encode(&buf, src); err != nil {
			return nil, err
		}
		if buf.Len() <= MaxBytes {
			return buf.Bytes(), nil
		}
	}
	return nil, errors.New("stiker 512 KB dan katta chiqdi")
}

// posterize keeps the top bits of every channel, which PNG compresses much better.
func posterize(img *image.NRGBA, bits uint) *image.NRGBA {
	out := image.NewNRGBA(img.Rect)
	mask := uint8(0xFF << (8 - bits))
	half := uint8(1 << (7 - bits))
	for i, v := range img.Pix {
		if i%4 == 3 {
			out.Pix[i] = v
			continue
		}
		q := v & mask
		if int(q)+int(half) <= 255 {
			q += half
		}
		out.Pix[i] = q
	}
	return out
}
