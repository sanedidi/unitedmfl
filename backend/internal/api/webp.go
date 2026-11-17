package api

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

// Every image saved under /uploads/images is stored as WebP, converted by
// libvips without visible quality loss:
//
//   - PNG, GIF (animation kept) and other lossless sources → lossless WebP,
//     pixel-for-pixel identical to the upload;
//   - JPEG, HEIC/HEIF and AVIF photos → WebP at quality 92 (true lossless would
//     make a photo 2–3× heavier than the JPEG it came from);
//   - WebP uploads are stored byte-for-byte, never re-encoded.
//
// The resolution is kept (only images over webpMaxSide px are scaled down),
// EXIF rotation is applied and metadata (GPS included) is stripped.

const (
	webpMaxSide  = 6000
	webpPhotoQ   = 92
	imageMaxMB   = 25 // matches client_max_body_size in the nginx config
	tmpUpPrefix  = ".up-"
	tmpEncPrefix = ".enc-"
)

// encodeWebP turns src (sniffed as kind, see photoKind) into the WebP file dst.
// It is a variable so tests can run without libvips.
var encodeWebP = func(ctx context.Context, src, dst, kind string) error {
	in, opts := src, "[lossless,strip]"
	switch kind {
	case "jpg", "heic":
		opts = fmt.Sprintf("[Q=%d,strip,smart_subsample]", webpPhotoQ)
	case "gif":
		in = src + "[n=-1]" // every frame
	}
	ctx, cancel := context.WithTimeout(ctx, 3*time.Minute)
	defer cancel()
	// "x>" — only ever shrink; vipsthumbnail applies EXIF orientation itself.
	cmd := exec.CommandContext(ctx, "vipsthumbnail", in,
		"--size", fmt.Sprintf("%dx%d>", webpMaxSide, webpMaxSide), "-o", dst+opts)
	if b, err := cmd.CombinedOutput(); err != nil {
		return fmt.Errorf("vipsthumbnail: %w: %s", err, strings.TrimSpace(string(b)))
	}
	return nil
}

var kindExt = map[string]string{"jpg": ".jpg", "png": ".png", "gif": ".gif", "webp": ".webp", "heic": ".heic"}

// storeImage moves the temporary file src (sniffed as kind) into imagesDir as
// WebP and returns the new file name (prefix + random + ".webp"). src is
// always consumed. Without libvips (dev machines, tests) the original format
// is kept so uploads still work.
func (s *Server) storeImage(ctx context.Context, src, kind, prefix string) (string, error) {
	defer os.Remove(src)
	if kind == "webp" {
		name := prefix + randomName(".webp")
		return name, moveFile(src, filepath.Join(s.imagesDir(), name))
	}
	name := prefix + randomName(".webp")
	dst := filepath.Join(s.imagesDir(), name)
	select {
	case photoSlots <- struct{}{}:
	case <-ctx.Done():
		return "", ctx.Err()
	}
	err := encodeWebP(ctx, src, dst, kind)
	<-photoSlots
	if err == nil {
		return name, nil
	}
	os.Remove(dst)
	if errors.Is(err, exec.ErrNotFound) {
		slog.Warn("vipsthumbnail not found: image kept in its original format")
		name = prefix + randomName(kindExt[kind])
		return name, moveFile(src, filepath.Join(s.imagesDir(), name))
	}
	return "", err
}

// storeImageBytes is storeImage for an image already in memory.
// It returns "" (and no error) when data is not a supported image.
func (s *Server) storeImageBytes(ctx context.Context, data []byte, prefix string) (string, error) {
	kind := photoKind(data[:min(len(data), 512)])
	if kind == "" {
		return "", nil
	}
	tmp, err := os.CreateTemp(s.imagesDir(), tmpUpPrefix+"*")
	if err != nil {
		return "", err
	}
	_, err = tmp.Write(data)
	tmp.Close()
	if err != nil {
		os.Remove(tmp.Name())
		return "", err
	}
	return s.storeImage(ctx, tmp.Name(), kind, prefix)
}

// moveFile renames src to dst, copying when they are on different filesystems.
func moveFile(src, dst string) error {
	if err := os.Rename(src, dst); err == nil {
		return os.Chmod(dst, 0o644) // temp files are created 0600
	}
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.OpenFile(dst, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o644)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		os.Remove(dst)
		return err
	}
	return out.Close()
}

// sniffFile returns photoKind of the file at path.
func sniffFile(path string) string {
	f, err := os.Open(path)
	if err != nil {
		return ""
	}
	defer f.Close()
	head := make([]byte, 512)
	n, _ := io.ReadFull(f, head)
	return photoKind(head[:n])
}
