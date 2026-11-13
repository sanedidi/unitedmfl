// Package config loads runtime settings from environment variables.
package config

import (
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"
)

type Config struct {
	Addr             string
	DatabaseURL      string
	JWTSecret        []byte
	AccessTTL        time.Duration
	RefreshTTL       time.Duration
	UploadDir        string
	WebRevalidateURL string // e.g. http://web:3000/internal/revalidate
	RevalidateSecret string
	MirrorImageHosts string // external hosts whose banner images are copied into /uploads
	PublicBaseURL    string // prefix for uploaded file URLs; empty = site-relative (/uploads/...)
	CORSOrigins      []string
	AdminEmail       string
	AdminPassword    string
	AdminName        string
	MaxUploadBytes   int64
	Env              string
	PointsWin        int
	PointsDraw       int
	PointsLoss       int
	LineupBenchMax   int    // substitutes allowed in a matchday squad (0 = no limit)
	TelegramToken    string // Live-pult bot token from @BotFather; empty = bot disabled
	TelegramAPIURL   string // Bot API base URL (override only for tests or a local Bot API server)
	InstagramToken     string        // optional: long-lived token to connect on first start (normally set in the admin)
	InstagramAPIURL    string        // Instagram Graph API host (override only for tests)
	InstagramSyncEvery time.Duration // how often the feed is pulled
}

func env(key, def string) string {
	if v := strings.TrimSpace(os.Getenv(key)); v != "" {
		return v
	}
	return def
}

func envInt(key string, def int) int {
	if v := os.Getenv(key); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			return n
		}
	}
	return def
}

// Load reads configuration and validates required values.
func Load() (*Config, error) {
	c := &Config{
		Addr:             env("ADDR", ":8080"),
		DatabaseURL:      env("DATABASE_URL", "postgres://unitedmfl:unitedmfl@localhost:5432/unitedmfl?sslmode=disable"),
		JWTSecret:        []byte(env("JWT_SECRET", "")),
		AccessTTL:        time.Duration(envInt("ACCESS_TTL_MIN", 60)) * time.Minute,
		RefreshTTL:       time.Duration(envInt("REFRESH_TTL_DAYS", 30)) * 24 * time.Hour,
		UploadDir:        env("UPLOAD_DIR", "./data/uploads"),
		PublicBaseURL:    strings.TrimRight(env("UPLOAD_URL_BASE", ""), "/"),
		AdminEmail:       env("ADMIN_EMAIL", ""),
		AdminPassword:    env("ADMIN_PASSWORD", ""),
		AdminName:        env("ADMIN_NAME", "Bosh admin"),
		MaxUploadBytes:   int64(envInt("MAX_UPLOAD_MB", 20)) << 20,
		Env:              env("APP_ENV", "development"),
		WebRevalidateURL: env("WEB_REVALIDATE_URL", ""),
		RevalidateSecret: env("REVALIDATE_SECRET", ""),
		MirrorImageHosts: env("MIRROR_IMAGE_HOSTS", "www.unitedmfl.com,unitedmfl.com"),
		// Points rules are a proposal until confirmed by the league regulations.
		PointsWin:  envInt("POINTS_WIN", 3),
		PointsDraw: envInt("POINTS_DRAW", 1),
		PointsLoss: envInt("POINTS_LOSS", 0),
		// Bench size is a proposal until confirmed by the league regulations.
		LineupBenchMax: envInt("LINEUP_BENCH_MAX", 9),
		TelegramToken:  env("TELEGRAM_BOT_TOKEN", ""),
		TelegramAPIURL: strings.TrimRight(env("TELEGRAM_API_URL", "https://api.telegram.org"), "/"),
		InstagramToken:     env("INSTAGRAM_ACCESS_TOKEN", ""),
		InstagramAPIURL:    strings.TrimRight(env("INSTAGRAM_API_URL", "https://graph.instagram.com"), "/"),
		InstagramSyncEvery: time.Duration(max(envInt("INSTAGRAM_SYNC_MIN", 30), 5)) * time.Minute,
	}
	for _, o := range strings.Split(env("CORS_ORIGINS", "*"), ",") {
		if o = strings.TrimSpace(o); o != "" {
			c.CORSOrigins = append(c.CORSOrigins, o)
		}
	}
	if len(c.JWTSecret) < 32 {
		if c.Env == "production" {
			return nil, fmt.Errorf("JWT_SECRET must be at least 32 characters in production")
		}
		c.JWTSecret = []byte("dev-only-secret-change-me-dev-only-secret")
	}
	return c, nil
}
