package aisvc

import (
	"context"
	"database/sql"
	"embed"
	"encoding/json"
	"errors"
	"time"

	"github.com/lib/pq"

	"github.com/sanedidi/unitedmfl/backend/internal/db"
)

//go:embed migrations/*.sql
var migrationsFS embed.FS

// Migrate creates the AI service tables (tracked separately from the API's migrations).
func Migrate(ctx context.Context, conn *sql.DB) error {
	return db.MigrateFS(ctx, conn, migrationsFS, "migrations", "ai_schema_migrations")
}

// Credentials are what a provider call needs; the key is decrypted only in memory.
type Credentials struct {
	APIKey  string
	OrgID   string
	BaseURL string
}

// ProviderView is what the admin sees about a connection (never the key).
type ProviderView struct {
	Provider    string     `json:"provider"`
	Connected   bool       `json:"connected"`
	KeyMask     string     `json:"key_mask"`
	OrgID       string     `json:"org_id"`
	BaseURL     string     `json:"base_url"`
	Status      string     `json:"status"` // ok | error | unknown | off
	CheckedAt   *time.Time `json:"checked_at"`
	LatencyMS   int        `json:"latency_ms"`
	ImageModels []string   `json:"image_models"`
	TextModels  []string   `json:"text_models"`
	LastError   string     `json:"last_error"`
}

type store struct {
	db  *sql.DB
	box *sealer
}

var providers = []string{"openai", "gemini"}

func (s *store) providers(ctx context.Context) ([]ProviderView, error) {
	out := make([]ProviderView, 0, len(providers))
	for _, p := range providers {
		v, err := s.provider(ctx, p)
		if err != nil {
			return nil, err
		}
		out = append(out, v)
	}
	return out, nil
}

func (s *store) provider(ctx context.Context, p string) (ProviderView, error) {
	v := ProviderView{Provider: p, Status: "off", ImageModels: []string{}, TextModels: []string{}}
	var checked sql.NullTime
	err := s.db.QueryRowContext(ctx, `SELECT key_mask, org_id, base_url, status, checked_at, latency_ms, image_models, text_models, last_error
		FROM ai_providers WHERE provider=$1`, p).
		Scan(&v.KeyMask, &v.OrgID, &v.BaseURL, &v.Status, &checked, &v.LatencyMS, pq.Array(&v.ImageModels), pq.Array(&v.TextModels), &v.LastError)
	if errors.Is(err, sql.ErrNoRows) {
		return v, nil
	}
	if err != nil {
		return v, err
	}
	v.Connected = true
	if checked.Valid {
		t := checked.Time
		v.CheckedAt = &t
	}
	return v, nil
}

func (s *store) credentials(ctx context.Context, p string) (Credentials, bool, error) {
	var enc []byte
	var c Credentials
	err := s.db.QueryRowContext(ctx, `SELECT api_key_enc, org_id, base_url FROM ai_providers WHERE provider=$1`, p).Scan(&enc, &c.OrgID, &c.BaseURL)
	if errors.Is(err, sql.ErrNoRows) {
		return c, false, nil
	}
	if err != nil {
		return c, false, err
	}
	key, err := s.box.open(enc)
	if err != nil {
		return c, false, err
	}
	c.APIKey = key
	return c, true, nil
}

func (s *store) saveCredentials(ctx context.Context, p string, c Credentials) error {
	enc, err := s.box.seal(c.APIKey)
	if err != nil {
		return err
	}
	_, err = s.db.ExecContext(ctx, `INSERT INTO ai_providers (provider, api_key_enc, key_mask, org_id, base_url, status, updated_at)
		VALUES ($1,$2,$3,$4,$5,'unknown',now())
		ON CONFLICT (provider) DO UPDATE SET api_key_enc=EXCLUDED.api_key_enc, key_mask=EXCLUDED.key_mask,
			org_id=EXCLUDED.org_id, base_url=EXCLUDED.base_url, updated_at=now()`, p, enc, maskKey(c.APIKey), c.OrgID, c.BaseURL)
	return err
}

func (s *store) saveCheck(ctx context.Context, p string, latency time.Duration, m Models, checkErr error) error {
	status, msg := "ok", ""
	if checkErr != nil {
		status, msg = "error", checkErr.Error()
	}
	if m.Image == nil {
		m.Image = []string{}
	}
	if m.Text == nil {
		m.Text = []string{}
	}
	q := `UPDATE ai_providers SET status=$2, checked_at=now(), latency_ms=$3, last_error=$4, updated_at=now()`
	args := []any{p, status, int(latency.Milliseconds()), msg}
	if checkErr == nil { // keep the last known model lists when a check fails
		q += `, image_models=$5, text_models=$6`
		args = append(args, pq.Array(m.Image), pq.Array(m.Text))
	}
	_, err := s.db.ExecContext(ctx, q+` WHERE provider=$1`, args...)
	return err
}

func (s *store) deleteProvider(ctx context.Context, p string) error {
	_, err := s.db.ExecContext(ctx, `DELETE FROM ai_providers WHERE provider=$1`, p)
	return err
}

func (s *store) settings(ctx context.Context) (Settings, error) {
	var raw []byte
	err := s.db.QueryRowContext(ctx, `SELECT data FROM ai_settings WHERE id=1`).Scan(&raw)
	if errors.Is(err, sql.ErrNoRows) {
		return DefaultSettings(), nil
	}
	if err != nil {
		return Settings{}, err
	}
	var st Settings
	if err := json.Unmarshal(raw, &st); err != nil {
		return Settings{}, err
	}
	st.merge()
	return st, nil
}

func (s *store) saveSettings(ctx context.Context, st Settings) error {
	raw, err := json.Marshal(st)
	if err != nil {
		return err
	}
	_, err = s.db.ExecContext(ctx, `INSERT INTO ai_settings (id, data, updated_at) VALUES (1, $1, now())
		ON CONFLICT (id) DO UPDATE SET data=EXCLUDED.data, updated_at=now()`, raw)
	return err
}
