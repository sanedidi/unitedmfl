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
	Addr               string
	DatabaseURL        string
	JWTSecret          []byte
	AccessTTL          time.Duration
	RefreshTTL         time.Duration
	UploadDir          string
	WebRevalidateURL   string // e.g. http://web:3000/internal/revalidate
	RevalidateSecret   string
	MirrorImageHosts   string // external hosts whose banner images are copied into /uploads
	PublicBaseURL      string // prefix for uploaded file URLs; empty = site-relative (/uploads/...)
	CORSOrigins        []string
	AdminEmail         string
	AdminPassword      string
	AdminName          string
	MaxUploadBytes     int64
	MaxVideoBytes      int64 // uploaded video files (Videolar → «Fayl yuklash»)
	Env                string
	PointsWin          int
	PointsDraw         int
	PointsLoss         int
	LineupBenchMax     int           // substitutes allowed in a matchday squad (0 = no limit)
	TelegramToken      string        // Live-pult bot token from @BotFather; empty = bot disabled
	MediaBotToken      string        // Media reja bot (a separate bot) token; empty = no Media reja reminders
	TelegramAPIURL     string        // Bot API base URL (override only for tests or a local Bot API server)
	InstagramToken     string        // optional: long-lived token to connect on first start (normally set in the admin)
	InstagramAPIURL    string        // Instagram Graph API host (override only for tests)
	FacebookGraphURL   string        // Facebook Graph API host (override only for tests)
	InstagramSyncEvery time.Duration // how often the feed is pulled
	AIServiceURL       string        // internal AI service (OpenAI / Gemini); empty = AI features off
	AIInternalToken    string        // shared secret sent to the AI service
	WebInternalURL     string        // the site container, for brand assets (logo) sent to the AI service
	SiteURL            string        // public origin of the site (team page links in registration notices)
	RegisterURL        string        // public origin of the team registration site; empty = admin shows only the code
	EskizEmail         string        // SMS codes for the registration site (notify.eskiz.uz); empty = no SMS
	EskizPassword      string
	EskizFrom          string
	EskizURL           string
	SMSCodeText        string // %s is replaced by the code (Eskiz checks texts against approved templates)
	WBAPIURL           string // Wildberries API: one base URL for every category (tests, a proxy); empty = WB's own domains
	// match tickets: payments and the face check service
	PaymeMerchantID     string // Payme merchant (kassa) id; empty = Payme off
	PaymeKey            string // Payme merchant API key (Basic auth password of callbacks)
	PaymeCheckoutURL    string
	ClickServiceID      string // Click Shop API; empty = Click off
	ClickMerchantID     string
	ClickSecretKey      string
	ClickMerchantUserID string
	FaceServiceURL      string // face comparison service (in Uzbekistan); empty = controllers compare photos by eye
	TestPayments        bool   // "test" provider (instant payment) — never in production
	SecretsKey          []byte // encrypts tokens stored in the database (Telegram stickers); AI_MASTER_KEY, else JWT_SECRET
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
		MaxVideoBytes:    int64(envInt("MAX_VIDEO_MB", 2048)) << 20,
		Env:              env("APP_ENV", "development"),
		WebRevalidateURL: env("WEB_REVALIDATE_URL", ""),
		RevalidateSecret: env("REVALIDATE_SECRET", ""),
		MirrorImageHosts: env("MIRROR_IMAGE_HOSTS", "www.unitedmfl.com,unitedmfl.com"),
		// Points rules are a proposal until confirmed by the league regulations.
		PointsWin:  envInt("POINTS_WIN", 3),
		PointsDraw: envInt("POINTS_DRAW", 1),
		PointsLoss: envInt("POINTS_LOSS", 0),
		// Bench size is a proposal until confirmed by the league regulations.
		LineupBenchMax:      envInt("LINEUP_BENCH_MAX", 9),
		TelegramToken:       env("TELEGRAM_BOT_TOKEN", ""),
		MediaBotToken:       env("TELEGRAM_MEDIA_BOT_TOKEN", ""),
		TelegramAPIURL:      strings.TrimRight(env("TELEGRAM_API_URL", "https://api.telegram.org"), "/"),
		InstagramToken:      env("INSTAGRAM_ACCESS_TOKEN", ""),
		InstagramAPIURL:     strings.TrimRight(env("INSTAGRAM_API_URL", "https://graph.instagram.com"), "/"),
		FacebookGraphURL:    strings.TrimRight(env("FACEBOOK_GRAPH_URL", "https://graph.facebook.com"), "/"),
		InstagramSyncEvery:  time.Duration(max(envInt("INSTAGRAM_SYNC_MIN", 30), 5)) * time.Minute,
		AIServiceURL:        strings.TrimRight(env("AI_SERVICE_URL", ""), "/"),
		AIInternalToken:     env("AI_INTERNAL_TOKEN", ""),
		WebInternalURL:      strings.TrimRight(env("WEB_INTERNAL_URL", "http://web:3000"), "/"),
		SiteURL:             strings.TrimRight(env("SITE_URL", ""), "/"),
		RegisterURL:         strings.TrimRight(env("REGISTER_PUBLIC_URL", ""), "/"),
		EskizEmail:          env("ESKIZ_EMAIL", ""),
		EskizPassword:       env("ESKIZ_PASSWORD", ""),
		EskizFrom:           env("ESKIZ_FROM", "4546"),
		EskizURL:            strings.TrimRight(env("ESKIZ_URL", "https://notify.eskiz.uz"), "/"),
		WBAPIURL:            strings.TrimRight(env("WB_API_URL", ""), "/"),
		PaymeMerchantID:     env("PAYME_MERCHANT_ID", ""),
		PaymeKey:            env("PAYME_KEY", ""),
		PaymeCheckoutURL:    strings.TrimRight(env("PAYME_CHECKOUT_URL", "https://checkout.paycom.uz"), "/"),
		ClickServiceID:      env("CLICK_SERVICE_ID", ""),
		ClickMerchantID:     env("CLICK_MERCHANT_ID", ""),
		ClickSecretKey:      env("CLICK_SECRET_KEY", ""),
		ClickMerchantUserID: env("CLICK_MERCHANT_USER_ID", ""),
		FaceServiceURL:      strings.TrimRight(env("FACE_SERVICE_URL", ""), "/"),
		TestPayments:        env("TEST_PAYMENTS", "") == "1",
		SMSCodeText:         env("SMS_CODE_TEXT", "United MFL: jamoa arizasi uchun tasdiqlash kodi %s"),
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
	if c.Env == "production" {
		c.TestPayments = false
	}
	c.SecretsKey = []byte(env("AI_MASTER_KEY", ""))
	if len(c.SecretsKey) < 16 {
		c.SecretsKey = c.JWTSecret
	}
	return c, nil
}
