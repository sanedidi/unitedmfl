package api

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/sanedidi/unitedmfl/backend/internal/httpx"
)

// Instagram feed (Instagram API with Instagram Login, graph.instagram.com).
//
// The admin pastes a long-lived user access token of the league's professional
// (Business/Creator) account. The API then:
//   - refreshes the token before its 60-day expiry,
//   - pulls the latest posts every InstagramSyncEvery,
//   - copies each post's image into /uploads (Instagram CDN URLs expire),
//   - tells the site to drop its cache when the feed changes.

const igFeedSize = 24

// igVersion is the Graph API version used for profile and media reads.
// Token refresh lives on the unversioned endpoint.
const igVersion = "/v23.0"

var igMu sync.Mutex // one sync / token change at a time

type igMedia struct {
	ID               string `json:"id"`
	Caption          string `json:"caption"`
	MediaType        string `json:"media_type"`
	MediaProductType string `json:"media_product_type"`
	MediaURL         string `json:"media_url"`
	ThumbnailURL     string `json:"thumbnail_url"`
	Permalink        string `json:"permalink"`
	Timestamp        string `json:"timestamp"`
}

type igAPIError struct {
	Error *struct {
		Message string `json:"message"`
		Type    string `json:"type"`
		Code    int    `json:"code"`
	} `json:"error"`
}

var igIDRe = regexp.MustCompile(`^[0-9]{1,40}$`)

func (s *Server) igClient() *http.Client { return &http.Client{Timeout: 30 * time.Second} }

// igGet calls the Graph API and decodes the JSON answer into out.
func (s *Server) igGet(ctx context.Context, path string, q url.Values, out any) error {
	u := s.Cfg.InstagramAPIURL + path + "?" + q.Encode()
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	res, err := s.igClient().Do(req)
	if err != nil {
		return fmt.Errorf("instagram: %w", err)
	}
	defer res.Body.Close()
	body, err := io.ReadAll(io.LimitReader(res.Body, 4<<20))
	if err != nil {
		return fmt.Errorf("instagram: %w", err)
	}
	if res.StatusCode != http.StatusOK {
		var e igAPIError
		if json.Unmarshal(body, &e) == nil && e.Error != nil {
			return fmt.Errorf("instagram %d: %s", res.StatusCode, e.Error.Message)
		}
		return fmt.Errorf("instagram: status %d", res.StatusCode)
	}
	return json.Unmarshal(body, out)
}

type igAccount struct {
	Token     string
	UserID    string
	Username  string
	ExpiresAt sql.NullTime
	SetAt     sql.NullTime
}

func (s *Server) igLoadAccount(ctx context.Context) (igAccount, error) {
	var a igAccount
	err := s.DB.QueryRowContext(ctx, `SELECT access_token, ig_user_id, username, token_expires_at, token_set_at FROM instagram_account WHERE id = 1`).
		Scan(&a.Token, &a.UserID, &a.Username, &a.ExpiresAt, &a.SetAt)
	if errors.Is(err, sql.ErrNoRows) {
		return a, nil
	}
	return a, err
}

func (s *Server) igSetError(ctx context.Context, msg string) {
	_, _ = s.DB.ExecContext(ctx, `UPDATE instagram_account SET last_error = $1, updated_at = now() WHERE id = 1`, msg)
}

// igConnect validates a token against /me and stores it.
func (s *Server) igConnect(ctx context.Context, token string) error {
	var me struct {
		UserID   string `json:"user_id"`
		ID       string `json:"id"`
		Username string `json:"username"`
	}
	if err := s.igGet(ctx, igVersion+"/me", url.Values{"fields": {"user_id,username"}, "access_token": {token}}, &me); err != nil {
		return err
	}
	uid := me.UserID
	if uid == "" {
		uid = me.ID
	}
	// A long-lived token lives 60 days; the exact expiry is learnt on the first refresh.
	_, err := s.DB.ExecContext(ctx, `INSERT INTO instagram_account (id, access_token, ig_user_id, username, token_expires_at, token_set_at, last_error, updated_at)
		VALUES (1, $1, $2, $3, now() + interval '60 days', now(), '', now())
		ON CONFLICT (id) DO UPDATE SET access_token = EXCLUDED.access_token, ig_user_id = EXCLUDED.ig_user_id,
			username = EXCLUDED.username, token_expires_at = EXCLUDED.token_expires_at, token_set_at = now(), last_error = '', updated_at = now()`,
		token, uid, me.Username)
	return err
}

// igRefreshToken extends a long-lived token when it is older than a day and
// expires within 20 days (Instagram refuses to refresh tokens younger than 24h).
func (s *Server) igRefreshToken(ctx context.Context, a igAccount) error {
	if a.SetAt.Valid && time.Since(a.SetAt.Time) < 25*time.Hour {
		return nil
	}
	if a.ExpiresAt.Valid && time.Until(a.ExpiresAt.Time) > 20*24*time.Hour {
		return nil
	}
	var out struct {
		AccessToken string `json:"access_token"`
		ExpiresIn   int64  `json:"expires_in"`
	}
	if err := s.igGet(ctx, "/refresh_access_token", url.Values{"grant_type": {"ig_refresh_token"}, "access_token": {a.Token}}, &out); err != nil {
		return err
	}
	if out.AccessToken == "" {
		return errors.New("instagram: empty refreshed token")
	}
	if out.ExpiresIn <= 0 {
		out.ExpiresIn = 60 * 24 * 3600
	}
	_, err := s.DB.ExecContext(ctx, `UPDATE instagram_account SET access_token = $1, token_expires_at = now() + make_interval(secs => $2),
		token_set_at = now(), updated_at = now() WHERE id = 1`, out.AccessToken, out.ExpiresIn)
	if err == nil {
		slog.Info("instagram: token refreshed", "expires_in_days", out.ExpiresIn/86400)
	}
	return err
}

// igSync refreshes the token if needed and mirrors the latest posts.
func (s *Server) igSync(ctx context.Context) error {
	igMu.Lock()
	defer igMu.Unlock()

	a, err := s.igLoadAccount(ctx)
	if err != nil || a.Token == "" {
		return err
	}
	if err := s.igRefreshToken(ctx, a); err != nil {
		slog.Warn("instagram: token refresh failed", "err", err)
	} else if a, err = s.igLoadAccount(ctx); err != nil {
		return err
	}

	var page struct {
		Data []igMedia `json:"data"`
	}
	q := url.Values{
		"fields":       {"id,caption,media_type,media_product_type,media_url,thumbnail_url,permalink,timestamp"},
		"limit":        {fmt.Sprint(igFeedSize)},
		"access_token": {a.Token},
	}
	if err := s.igGet(ctx, igVersion+"/me/media", q, &page); err != nil {
		s.igSetError(ctx, err.Error())
		return err
	}

	existing := map[string]string{} // id -> image_url
	rows, err := s.DB.QueryContext(ctx, `SELECT id, image_url FROM instagram_posts`)
	if err != nil {
		return err
	}
	for rows.Next() {
		var id, img string
		if rows.Scan(&id, &img) == nil {
			existing[id] = img
		}
	}
	rows.Close()

	changed := false
	keep := map[string]bool{}
	for _, m := range page.Data {
		if !igIDRe.MatchString(m.ID) || m.Permalink == "" {
			continue
		}
		posted, err := time.Parse("2006-01-02T15:04:05-0700", m.Timestamp)
		if err != nil {
			posted = time.Now()
		}
		img := existing[m.ID]
		if img == "" {
			src := m.MediaURL
			if m.MediaType == "VIDEO" || src == "" {
				src = m.ThumbnailURL
			}
			if src == "" {
				continue
			}
			if img, err = s.igDownload(ctx, m.ID, src); err != nil {
				slog.Warn("instagram: image download failed", "id", m.ID, "err", err)
				continue
			}
			changed = true
		}
		keep[m.ID] = true
		res, err := s.DB.ExecContext(ctx, `INSERT INTO instagram_posts (id, caption, media_type, is_reel, image_url, permalink, posted_at, synced_at)
			VALUES ($1,$2,$3,$4,$5,$6,$7, now())
			ON CONFLICT (id) DO UPDATE SET caption = EXCLUDED.caption, media_type = EXCLUDED.media_type, is_reel = EXCLUDED.is_reel,
				image_url = EXCLUDED.image_url, permalink = EXCLUDED.permalink, posted_at = EXCLUDED.posted_at, synced_at = now()
			WHERE (instagram_posts.caption, instagram_posts.media_type, instagram_posts.image_url, instagram_posts.permalink)
			   IS DISTINCT FROM (EXCLUDED.caption, EXCLUDED.media_type, EXCLUDED.image_url, EXCLUDED.permalink)`,
			m.ID, m.Caption, m.MediaType, m.MediaProductType == "REELS", img, m.Permalink, posted)
		if err != nil {
			return err
		}
		if n, _ := res.RowsAffected(); n > 0 {
			changed = true
		}
	}
	// drop posts deleted on Instagram or pushed out of the feed
	for id, img := range existing {
		if keep[id] {
			continue
		}
		if _, err := s.DB.ExecContext(ctx, `DELETE FROM instagram_posts WHERE id = $1`, id); err == nil {
			s.igRemoveFile(img)
			changed = true
		}
	}
	_, _ = s.DB.ExecContext(ctx, `UPDATE instagram_account SET last_sync_at = now(), last_error = '', updated_at = now() WHERE id = 1`)
	if changed {
		s.web.notify()
	}
	return nil
}

// igDownload copies a post image into /uploads/images/ig-<id>.<ext>.
func (s *Server) igDownload(ctx context.Context, id, src string) (string, error) {
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, src, nil)
	res, err := s.igClient().Do(req)
	if err != nil {
		return "", err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return "", fmt.Errorf("status %d", res.StatusCode)
	}
	ext := map[string]string{"image/webp": ".webp", "image/jpeg": ".jpg", "image/png": ".png", "image/heic": ".heic"}[strings.Split(res.Header.Get("Content-Type"), ";")[0]]
	if ext == "" {
		return "", fmt.Errorf("not an image: %q", res.Header.Get("Content-Type"))
	}
	if err := os.MkdirAll(s.imagesDir(), 0o755); err != nil {
		return "", err
	}
	name := "ig-" + id + ext
	tmp := filepath.Join(s.imagesDir(), name+".part")
	f, err := os.Create(tmp)
	if err != nil {
		return "", err
	}
	limit := s.Cfg.MaxUploadBytes
	n, err := io.Copy(f, io.LimitReader(res.Body, limit+1))
	f.Close()
	if err != nil || n > limit {
		os.Remove(tmp)
		if err == nil {
			err = fmt.Errorf("larger than %d bytes", limit)
		}
		return "", err
	}
	if err := os.Rename(tmp, filepath.Join(s.imagesDir(), name)); err != nil {
		return "", err
	}
	return s.Cfg.PublicBaseURL + "/uploads/images/" + name, nil
}

func (s *Server) igRemoveFile(img string) {
	name := filepath.Base(img)
	if strings.HasPrefix(name, "ig-") {
		_ = os.Remove(filepath.Join(s.imagesDir(), name))
	}
}

// RunInstagramSync seeds the token from INSTAGRAM_ACCESS_TOKEN (once) and keeps
// the feed fresh until ctx is cancelled.
func (s *Server) RunInstagramSync(ctx context.Context) {
	if s.Cfg.InstagramToken != "" {
		if a, err := s.igLoadAccount(ctx); err == nil && a.Token == "" {
			if err := s.igConnect(ctx, s.Cfg.InstagramToken); err != nil {
				slog.Warn("instagram: INSTAGRAM_ACCESS_TOKEN rejected", "err", err)
			}
		}
	}
	t := time.NewTimer(10 * time.Second)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
		if err := s.igSync(ctx); err != nil {
			slog.Warn("instagram: sync failed", "err", err)
		}
		t.Reset(s.Cfg.InstagramSyncEvery)
	}
}

// ---------- public ----------

func (s *Server) publicInstagram(w http.ResponseWriter, r *http.Request) {
	limit, _ := pageParams(r)
	if r.URL.Query().Get("limit") == "" || limit > igFeedSize {
		limit = 12
	}
	s.respondQuery(w, r, `SELECT json_build_object(
		'username', coalesce((SELECT username FROM instagram_account WHERE id = 1 AND access_token <> ''), ''),
		'posts', (SELECT coalesce(json_agg(p ORDER BY p.posted_at DESC), '[]') FROM (
			SELECT id, caption, media_type, is_reel, image_url, permalink, posted_at FROM instagram_posts
			WHERE NOT is_hidden AND EXISTS (SELECT 1 FROM instagram_account WHERE id = 1 AND access_token <> '')
			ORDER BY posted_at DESC LIMIT $1) p))`, limit)
}

// ---------- admin ----------

func (s *Server) adminInstagram(w http.ResponseWriter, r *http.Request) {
	s.respondQuery(w, r, `SELECT json_build_object(
		'connected', coalesce(a.access_token <> '', false),
		'username', coalesce(a.username, ''),
		'token_expires_at', a.token_expires_at,
		'last_sync_at', a.last_sync_at,
		'last_error', coalesce(a.last_error, ''),
		'posts', (SELECT coalesce(json_agg(p ORDER BY p.posted_at DESC), '[]') FROM (
			SELECT id, caption, media_type, is_reel, image_url, permalink, posted_at, is_hidden FROM instagram_posts) p))
		FROM (SELECT 1) one LEFT JOIN instagram_account a ON a.id = 1`)
}

func (s *Server) connectInstagram(w http.ResponseWriter, r *http.Request) {
	var in struct {
		AccessToken string `json:"access_token"`
	}
	if err := httpx.Decode(r, &in); err != nil {
		httpx.Fail(w, r, err)
		return
	}
	token := strings.TrimSpace(in.AccessToken)
	if len(token) < 20 || strings.ContainsAny(token, " \n\t") {
		httpx.Fail(w, r, httpx.Validation(map[string]any{"access_token": "Token noto‘g‘ri"}))
		return
	}
	igMu.Lock()
	err := s.igConnect(r.Context(), token)
	igMu.Unlock()
	if err != nil {
		httpx.Fail(w, r, httpx.BadRequest("Instagram tokenni qabul qilmadi: "+err.Error()))
		return
	}
	if err := s.igSync(r.Context()); err != nil {
		slog.Warn("instagram: first sync failed", "err", err)
	}
	s.audit(r, "instagram.connect", "instagram", 1, nil)
	s.adminInstagram(w, r)
}

func (s *Server) disconnectInstagram(w http.ResponseWriter, r *http.Request) {
	igMu.Lock()
	defer igMu.Unlock()
	rows, err := s.DB.QueryContext(r.Context(), `DELETE FROM instagram_posts RETURNING image_url`)
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	for rows.Next() {
		var img string
		if rows.Scan(&img) == nil {
			s.igRemoveFile(img)
		}
	}
	rows.Close()
	if _, err := s.DB.ExecContext(r.Context(), `DELETE FROM instagram_account`); err != nil {
		httpx.Fail(w, r, err)
		return
	}
	s.audit(r, "instagram.disconnect", "instagram", 1, nil)
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) syncInstagram(w http.ResponseWriter, r *http.Request) {
	if err := s.igSync(r.Context()); err != nil {
		httpx.Fail(w, r, httpx.BadRequest("Sinxronlash xatosi: "+err.Error()))
		return
	}
	s.adminInstagram(w, r)
}

func (s *Server) patchInstagramPost(w http.ResponseWriter, r *http.Request) {
	var in struct {
		IsHidden bool `json:"is_hidden"`
	}
	if err := httpx.Decode(r, &in); err != nil {
		httpx.Fail(w, r, err)
		return
	}
	id := chi.URLParam(r, "id")
	res, err := s.DB.ExecContext(r.Context(), `UPDATE instagram_posts SET is_hidden = $2 WHERE id = $1`, id, in.IsHidden)
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	if n, _ := res.RowsAffected(); n == 0 {
		httpx.Fail(w, r, httpx.ErrNotFound)
		return
	}
	s.audit(r, "instagram.post", "instagram", 1, map[string]any{"id": id, "is_hidden": in.IsHidden})
	w.WriteHeader(http.StatusNoContent)
}
