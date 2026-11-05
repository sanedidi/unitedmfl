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
	Addr           string
	DatabaseURL    string
	JWTSecret      []byte
	AccessTTL      time.Duration
	RefreshTTL     time.Duration
	UploadDir      string
	PublicBaseURL  string // prefix for uploaded file URLs; empty = site-relative (/uploads/...)
	CORSOrigins    []string
	AdminEmail     string
	AdminPassword  string
	AdminName      string
	MaxUploadBytes int64
	Env            string
	PointsWin      int
	PointsDraw     int
	PointsLoss     int
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
		Addr:           env("ADDR", ":8080"),
		DatabaseURL:    env("DATABASE_URL", "postgres://unitedmfl:unitedmfl@localhost:5432/unitedmfl?sslmode=disable"),
		JWTSecret:      []byte(env("JWT_SECRET", "")),
		AccessTTL:      time.Duration(envInt("ACCESS_TTL_MIN", 60)) * time.Minute,
		RefreshTTL:     time.Duration(envInt("REFRESH_TTL_DAYS", 30)) * 24 * time.Hour,
		UploadDir:      env("UPLOAD_DIR", "./data/uploads"),
		PublicBaseURL:  strings.TrimRight(env("UPLOAD_URL_BASE", ""), "/"),
		AdminEmail:     env("ADMIN_EMAIL", ""),
		AdminPassword:  env("ADMIN_PASSWORD", ""),
		AdminName:      env("ADMIN_NAME", "Bosh admin"),
		MaxUploadBytes: int64(envInt("MAX_UPLOAD_MB", 20)) << 20,
		Env:            env("APP_ENV", "development"),
		// Points rules are a proposal until confirmed by the league regulations.
		PointsWin:  envInt("POINTS_WIN", 3),
		PointsDraw: envInt("POINTS_DRAW", 1),
		PointsLoss: envInt("POINTS_LOSS", 0),
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
