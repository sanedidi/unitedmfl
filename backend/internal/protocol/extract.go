package protocol

import (
	"bufio"
	"bytes"
	"context"
	"fmt"
	"html"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

const normWidth = 600.0

var (
	rePage = regexp.MustCompile(`<page width="([\d.]+)" height="([\d.]+)">`)
	reWord = regexp.MustCompile(`<word xMin="([\d.]+)" yMin="([\d.]+)" xMax="([\d.]+)" yMax="([\d.]+)">([^<]*)</word>`)
)

// Method describes how words were obtained.
const (
	MethodPDFText = "pdf_text"
	MethodOCR     = "ocr"
)

// ExtractWords returns positioned words from a PDF (text layer, OCR fallback) or an image (OCR).
func ExtractWords(ctx context.Context, path, mime string) ([]Word, string, int, error) {
	if mime == "application/pdf" || strings.HasSuffix(strings.ToLower(path), ".pdf") {
		words, pages, err := pdfWords(ctx, path)
		if err == nil && len(words) >= 40 {
			return words, MethodPDFText, pages, nil
		}
		// scanned PDF → rasterise and OCR
		tmp, err := os.MkdirTemp("", "proto-*")
		if err != nil {
			return nil, "", 0, err
		}
		defer os.RemoveAll(tmp)
		if out, err := exec.CommandContext(ctx, "pdftoppm", "-r", "200", "-png", path, filepath.Join(tmp, "p")).CombinedOutput(); err != nil {
			return nil, "", 0, fmt.Errorf("pdftoppm: %v: %s", err, out)
		}
		imgs, _ := filepath.Glob(filepath.Join(tmp, "p-*.png"))
		sort.Strings(imgs)
		var all []Word
		for i, img := range imgs {
			ws, err := ocrWords(ctx, img, i+1)
			if err != nil {
				return nil, "", 0, err
			}
			all = append(all, ws...)
		}
		return all, MethodOCR, len(imgs), nil
	}
	ws, err := ocrWords(ctx, path, 1)
	return ws, MethodOCR, 1, err
}

func pdfWords(ctx context.Context, path string) ([]Word, int, error) {
	out, err := exec.CommandContext(ctx, "pdftotext", "-bbox", path, "-").Output()
	if err != nil {
		return nil, 0, fmt.Errorf("pdftotext: %w", err)
	}
	return ParseBBoxHTML(string(out))
}

// ParseBBoxHTML parses `pdftotext -bbox` output.
func ParseBBoxHTML(doc string) ([]Word, int, error) {
	var words []Word
	parts := rePage.FindAllStringSubmatchIndex(doc, -1)
	for pi, loc := range parts {
		pw, _ := strconv.ParseFloat(doc[loc[2]:loc[3]], 64)
		if pw <= 0 {
			pw = normWidth
		}
		scale := normWidth / pw
		end := len(doc)
		if pi+1 < len(parts) {
			end = parts[pi+1][0]
		}
		for _, m := range reWord.FindAllStringSubmatch(doc[loc[1]:end], -1) {
			x0, _ := strconv.ParseFloat(m[1], 64)
			y0, _ := strconv.ParseFloat(m[2], 64)
			x1, _ := strconv.ParseFloat(m[3], 64)
			y1, _ := strconv.ParseFloat(m[4], 64)
			t := strings.TrimSpace(html.UnescapeString(m[5]))
			if t == "" {
				continue
			}
			words = append(words, Word{Page: pi + 1, X0: x0 * scale, Y0: y0 * scale, X1: x1 * scale, Y1: y1 * scale, Text: t})
		}
	}
	return words, len(parts), nil
}

// ocrWords runs Tesseract and parses its TSV output.
func ocrWords(ctx context.Context, img string, page int) ([]Word, error) {
	cmd := exec.CommandContext(ctx, "tesseract", img, "stdout", "-l", ocrLang(), "--psm", "6", "tsv")
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	out, err := cmd.Output()
	if err != nil {
		return nil, fmt.Errorf("tesseract: %v: %s", err, stderr.String())
	}
	return ParseTesseractTSV(out, page)
}

func ocrLang() string {
	if l := os.Getenv("OCR_LANG"); l != "" {
		return l
	}
	return "eng"
}

// ParseTesseractTSV parses `tesseract ... tsv` output (level 5 rows are words).
func ParseTesseractTSV(tsv []byte, page int) ([]Word, error) {
	var words []Word
	pageWidth := 0.0
	sc := bufio.NewScanner(bytes.NewReader(tsv))
	sc.Buffer(make([]byte, 1<<20), 1<<20)
	first := true
	type raw struct {
		l, t, w, h float64
		text       string
	}
	var raws []raw
	for sc.Scan() {
		if first {
			first = false
			continue
		}
		f := strings.Split(sc.Text(), "\t")
		if len(f) < 12 {
			continue
		}
		level, _ := strconv.Atoi(f[0])
		l, _ := strconv.ParseFloat(f[6], 64)
		t, _ := strconv.ParseFloat(f[7], 64)
		w, _ := strconv.ParseFloat(f[8], 64)
		h, _ := strconv.ParseFloat(f[9], 64)
		if level == 1 {
			pageWidth = w
			continue
		}
		if level != 5 || strings.TrimSpace(f[11]) == "" {
			continue
		}
		raws = append(raws, raw{l, t, w, h, strings.TrimSpace(f[11])})
	}
	if pageWidth <= 0 {
		pageWidth = normWidth
	}
	scale := normWidth / pageWidth
	for _, r := range raws {
		words = append(words, Word{Page: page, X0: r.l * scale, Y0: r.t * scale, X1: (r.l + r.w) * scale, Y1: (r.t + r.h) * scale, Text: r.text})
	}
	return words, sc.Err()
}
