package api

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"errors"
	"fmt"
	"image"
	_ "image/gif"  // logos without libvips (dev, tests)
	_ "image/jpeg" // logos without libvips (dev, tests)
	_ "image/png"  // logos without libvips (dev, tests)
	"io"
	"log/slog"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/sanedidi/unitedmfl/backend/internal/auth"
	"github.com/sanedidi/unitedmfl/backend/internal/httpx"
	"github.com/sanedidi/unitedmfl/backend/internal/sticker"
)

// Telegram stickers and custom emoji from team logos (Tizim → Telegram stikerlar).
//
// Two set kinds share the bot and the owner: stickers (512×512, up to 120
// per set) and emoji (100×100, up to 200 per set). Each kind has its own
// sets, look (outline) and on/off switch; rows in tg_stickers are per team
// and kind.
//
// The admin enters a bot token and picks the set owner among the Telegram
// accounts that sent /start to the bot. «To‘plamni yaratish» creates the set
// with the first logo; from then on a background worker keeps one sticker per
// team with a logo:
//
//   - a new team (or a logo added) → the sticker is added;
//   - a changed logo → the sticker is replaced (when «Avtomatik yangilash» is on);
//   - a deleted team (or a removed logo) → the sticker is deleted.
//
// The worker compares teams with tg_stickers every 30 s and right after any
// team change, so every write path (admin, registration approval) is covered.
// Telegram failures are retried 5 times (1, 5, 15, 60 min, 6 h), then the
// team is marked «Xato». The bot token is AES-GCM encrypted at rest.

const (
	stkSetLimit    = 120 // stickers per set
	stkEmojiLimit  = 200 // custom emoji per set
	stkMaxAttempts = 6   // the first try and 5 retries
	stkBatch       = 20
)

var stkRetryDelays = []time.Duration{time.Minute, 5 * time.Minute, 15 * time.Minute, time.Hour, 6 * time.Hour}

var stkSlugRe = regexp.MustCompile(`^[a-z][a-z0-9_]*[a-z0-9]$`)

type stickerSvc struct {
	mu        sync.Mutex // one Telegram writer at a time (worker and admin actions)
	wake      chan struct{}
	ownerWake chan struct{}
	aead      cipher.AEAD
}

func newStickerSvc(secret []byte) *stickerSvc {
	key := sha256.Sum256(append([]byte("tg-stickers:"), secret...))
	block, _ := aes.NewCipher(key[:])
	aead, _ := cipher.NewGCM(block)
	return &stickerSvc{wake: make(chan struct{}, 1), ownerWake: make(chan struct{}, 1), aead: aead}
}

func (k *stickerSvc) poke() {
	select {
	case k.wake <- struct{}{}:
	default:
	}
}

func (k *stickerSvc) seal(plain string) ([]byte, error) {
	nonce := make([]byte, k.aead.NonceSize())
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return nil, err
	}
	return k.aead.Seal(nonce, nonce, []byte(plain), nil), nil
}

func (k *stickerSvc) open(box []byte) (string, error) {
	n := k.aead.NonceSize()
	if len(box) < n {
		return "", errors.New("bad ciphertext")
	}
	out, err := k.aead.Open(nil, box[:n], box[n:], nil)
	return string(out), err
}

// teamStickerChanged wakes the worker after a team write or delete.
func teamStickerChanged(s *Server) {
	if s.stk != nil {
		s.stk.poke()
	}
}

// ---------- settings ----------

const (
	kindSticker = "sticker"
	kindEmoji   = "emoji"
)

var stkKinds = []string{kindSticker, kindEmoji}

type stkSettings struct {
	Token         string
	TokenBroken   bool // stored, but cannot be decrypted (secret changed)
	BotID         int64
	BotUsername   string
	OwnerID       int64
	OwnerUsername string
	OwnerName     string
	SetSlug       string
	SetTitle      string
	Outline       bool
	AutoUpdate    bool
	Enabled       bool // stickers: the first set has been created
	EmojiEnabled  bool // emoji: kept in step with the teams
	EmojiSlug     string
	EmojiTitle    string
	EmojiOutline  bool
	Problem       string
	LastError     string
	LastSyncAt    sql.NullTime
}

// stkKindCfg is one set kind (stickers or emoji) as the worker sees it.
type stkKindCfg struct {
	Kind    string
	Enabled bool
	Slug    string
	Title   string
	Outline bool
}

func (st *stkSettings) kind(k string) stkKindCfg {
	if k == kindEmoji {
		return stkKindCfg{kindEmoji, st.EmojiEnabled, st.EmojiSlug, st.EmojiTitle, st.EmojiOutline}
	}
	return stkKindCfg{kindSticker, st.Enabled, st.SetSlug, st.SetTitle, st.Outline}
}

func stkLimit(kind string) int {
	if kind == kindEmoji {
		return stkEmojiLimit
	}
	return stkSetLimit
}

func stkSetURL(kind, name string) string {
	if kind == kindEmoji {
		return "https://t.me/addemoji/" + name
	}
	return "https://t.me/addstickers/" + name
}

func (k stkKindCfg) source(crest string) string { return crest + k.flag() }

func (k stkKindCfg) flag() string {
	if k.Outline {
		return "|o1"
	}
	return "|o0"
}

func (s *Server) stkLoad(ctx context.Context) (*stkSettings, error) {
	var st stkSettings
	var box []byte
	err := s.DB.QueryRowContext(ctx, `SELECT token_enc, bot_id, bot_username, owner_id, owner_username, owner_name,
		set_slug, set_title, outline, auto_update, enabled, emoji_enabled, emoji_slug, emoji_title, emoji_outline,
		problem, last_error, last_sync_at FROM tg_sticker_settings WHERE id = 1`).
		Scan(&box, &st.BotID, &st.BotUsername, &st.OwnerID, &st.OwnerUsername, &st.OwnerName,
			&st.SetSlug, &st.SetTitle, &st.Outline, &st.AutoUpdate, &st.Enabled, &st.EmojiEnabled, &st.EmojiSlug, &st.EmojiTitle, &st.EmojiOutline,
			&st.Problem, &st.LastError, &st.LastSyncAt)
	if err != nil {
		return nil, err
	}
	if len(box) > 0 {
		if st.Token, err = s.stk.open(box); err != nil {
			st.Token, st.TokenBroken = "", true
		}
	}
	return &st, nil
}

func (st *stkSettings) connected() bool { return st.Token != "" && st.OwnerID != 0 }

func (st *stkSettings) ready() bool { return st.connected() && (st.Enabled || st.EmojiEnabled) }

func (s *Server) stkClient(st *stkSettings) *tgStkClient {
	return newTGStkClient(s.Cfg.TelegramAPIURL, st.Token)
}

// sameBotAsLive: the sticker bot is the Live-pult bot, whose own polling
// loop records /start (two getUpdates consumers would fight).
func (s *Server) sameBotAsLive(st *stkSettings) bool {
	return s.Cfg.TelegramToken != "" && st.BotID != 0 && botIDFromToken(s.Cfg.TelegramToken) == st.BotID
}

func stkSetName(slug string, ord int, bot string) string {
	n := slug
	if ord > 1 {
		n += fmt.Sprint(ord)
	}
	return n + "_by_" + bot
}

func stkSetTitle(title string, ord int) string {
	if ord > 1 {
		return fmt.Sprintf("%s %d", title, ord)
	}
	return title
}

func (s *Server) stkSetProblem(ctx context.Context, problem, msg string) {
	_, _ = s.DB.ExecContext(ctx, `UPDATE tg_sticker_settings SET problem = $1, last_error = $2, updated_at = now() WHERE id = 1`, problem, msg)
}

func (s *Server) stkHasSets(ctx context.Context, kind string) bool {
	var n int
	_ = s.DB.QueryRowContext(ctx, `SELECT count(*) FROM tg_sticker_sets WHERE kind = $1`, kind).Scan(&n)
	return n > 0
}

// ---------- images ----------

func (s *Server) stickersDir() string { return filepath.Join(s.imagesDir(), "stickers") }

// stkLoadLogo reads a team logo (a file under /uploads/images or an http(s) URL).
func (s *Server) stkLoadLogo(ctx context.Context, crest string) (image.Image, error) {
	var src string
	switch {
	case strings.HasPrefix(crest, "/uploads/images/"):
		rel := filepath.Clean("/" + strings.TrimPrefix(crest, "/uploads/images/"))
		src = filepath.Join(s.imagesDir(), rel)
	case strings.HasPrefix(crest, "http://") || strings.HasPrefix(crest, "https://"):
		tmp, err := s.stkDownload(ctx, crest)
		if err != nil {
			return nil, err
		}
		defer os.Remove(tmp)
		src = tmp
	default:
		return nil, fmt.Errorf("logotip manzili noto‘g‘ri: %s", crest)
	}
	if _, err := os.Stat(src); err != nil {
		return nil, errors.New("logotip fayli topilmadi")
	}
	// libvips reads every upload format (WebP included) and shrinks big logos
	out := filepath.Join(os.TempDir(), "stk-"+randomName(".png"))
	defer os.Remove(out)
	vctx, cancel := context.WithTimeout(ctx, time.Minute)
	defer cancel()
	cmd := exec.CommandContext(vctx, "vipsthumbnail", src, "--size", "1024x1024>", "-o", out)
	if b, err := cmd.CombinedOutput(); err == nil {
		src = out
	} else if !errors.Is(err, exec.ErrNotFound) {
		slog.Warn("sticker: vipsthumbnail failed, trying the Go decoder", "err", err, "out", strings.TrimSpace(string(b)))
	}
	f, err := os.Open(src)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	img, _, err := image.Decode(f)
	if err != nil {
		return nil, errors.New("logotipni o‘qib bo‘lmadi (format qo‘llab-quvvatlanmaydi)")
	}
	return img, nil
}

func (s *Server) stkDownload(ctx context.Context, url string) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return "", err
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return "", errors.New("logotipni yuklab bo‘lmadi")
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return "", fmt.Errorf("logotipni yuklab bo‘lmadi (HTTP %d)", resp.StatusCode)
	}
	f, err := os.CreateTemp("", "stk-src-*")
	if err != nil {
		return "", err
	}
	_, err = io.Copy(f, io.LimitReader(resp.Body, 25<<20))
	f.Close()
	if err != nil {
		os.Remove(f.Name())
		return "", err
	}
	return f.Name(), nil
}

func (s *Server) stkBuild(ctx context.Context, crest string, k stkKindCfg) ([]byte, error) {
	img, err := s.stkLoadLogo(ctx, crest)
	if err != nil {
		return nil, err
	}
	return sticker.Build(img, sticker.Options{Outline: k.Outline, Emoji: k.Kind == kindEmoji})
}

// stkSaveImage keeps the sent PNG so the admin can show it.
func (s *Server) stkSaveImage(teamID int64, kind string, data []byte) string {
	if err := os.MkdirAll(s.stickersDir(), 0o755); err != nil {
		return ""
	}
	prefix := "team"
	if kind == kindEmoji {
		prefix = "emoji"
	}
	name := fmt.Sprintf("%s-%d-%s", prefix, teamID, randomName(".png"))
	if err := os.WriteFile(filepath.Join(s.stickersDir(), name), data, 0o644); err != nil {
		return ""
	}
	return "/uploads/images/stickers/" + name
}

// ---------- worker ----------

// StartStickerWorker keeps the Telegram sets in step with the teams.
func (s *Server) StartStickerWorker(ctx context.Context) {
	go s.stkLoop(ctx)
	go s.stkOwnerLoop(ctx)
}

func (s *Server) stkLoop(ctx context.Context) {
	t := time.NewTicker(30 * time.Second)
	defer t.Stop()
	for {
		s.stkTick(ctx)
		select {
		case <-ctx.Done():
			return
		case <-s.stk.wake:
		case <-t.C:
		}
	}
}

func (s *Server) stkTick(ctx context.Context) {
	defer func() {
		if r := recover(); r != nil {
			slog.Error("sticker worker panic", "panic", r)
		}
	}()
	st, err := s.stkLoad(ctx)
	if err != nil || !st.ready() || st.Problem == "token_invalid" {
		return
	}
	s.stk.mu.Lock()
	defer s.stk.mu.Unlock()
	var kinds []string
	for _, k := range stkKinds {
		if !st.kind(k).Enabled {
			continue
		}
		if err := s.stkReconcile(ctx, st, k); err != nil {
			slog.Warn("sticker reconcile", "kind", k, "err", err)
			return
		}
		kinds = append(kinds, k)
	}
	done := 0
	for i := 0; i < stkBatch && ctx.Err() == nil; i++ {
		var teamID int64
		var kind string
		err := s.DB.QueryRowContext(ctx, `SELECT team_id, kind FROM tg_stickers WHERE state IN ('queued', 'removing') AND next_try_at <= now()
			AND kind = ANY($1::text[]) ORDER BY state = 'removing' DESC, next_try_at, kind, team_id LIMIT 1`, pqArray(kinds)).Scan(&teamID, &kind)
		if errors.Is(err, sql.ErrNoRows) {
			break
		}
		if err != nil {
			slog.Warn("sticker queue", "err", err)
			return
		}
		if stop := s.stkProcess(ctx, st, teamID, kind); stop {
			break
		}
		done++
	}
	if done > 0 {
		_, _ = s.DB.ExecContext(ctx, `UPDATE tg_sticker_settings SET last_sync_at = now() WHERE id = 1`)
	}
}

// stkReconcile queues what changed since the last pass, for one kind.
func (s *Server) stkReconcile(ctx context.Context, st *stkSettings, kind string) error {
	flag := st.kind(kind).flag()
	type stmt struct {
		q    string
		args []any
	}
	gone := `NOT EXISTS (SELECT 1 FROM teams t WHERE t.id = k.team_id AND coalesce(t.crest_url, '') <> '')`
	for _, x := range []stmt{
		// new team or logo added
		{`INSERT INTO tg_stickers (team_id, kind, source, state) SELECT id, $2, crest_url || $1, 'queued' FROM teams
		  WHERE coalesce(crest_url, '') <> '' ON CONFLICT (team_id, kind) DO NOTHING`, []any{flag, kind}},
		// changed logo or look (or a logo put back while its sticker was being removed)
		{`UPDATE tg_stickers k SET state = 'queued', attempts = 0, next_try_at = now(), last_error = '', source = t.crest_url || $1, updated_at = now()
		  FROM teams t WHERE t.id = k.team_id AND k.kind = $3 AND coalesce(t.crest_url, '') <> ''
		    AND (k.state = 'removing' OR (k.source <> t.crest_url || $1 AND k.state <> 'queued' AND ($2 OR k.file_id = '')))`, []any{flag, st.AutoUpdate, kind}},
		// team deleted or logo removed
		{`UPDATE tg_stickers k SET state = 'removing', attempts = 0, next_try_at = now(), last_error = '', updated_at = now()
		  WHERE k.kind = $1 AND k.state <> 'removing' AND k.file_id <> '' AND ` + gone, []any{kind}},
		{`DELETE FROM tg_stickers k WHERE k.kind = $1 AND k.file_id = '' AND ` + gone, []any{kind}},
	} {
		if _, err := s.DB.ExecContext(ctx, x.q, x.args...); err != nil {
			return err
		}
	}
	return nil
}

type stkRow struct {
	TeamID       int64
	Kind         string
	SetName      string
	FileID       string
	FileUniqueID string
	Image        string
	Source       string
	State        string
	Attempts     int
}

func (s *Server) stkRow(ctx context.Context, teamID int64, kind string) (*stkRow, error) {
	r := stkRow{Kind: kind}
	err := s.DB.QueryRowContext(ctx, `SELECT team_id, set_name, file_id, file_unique_id, image, source, state, attempts FROM tg_stickers WHERE team_id = $1 AND kind = $2`, teamID, kind).
		Scan(&r.TeamID, &r.SetName, &r.FileID, &r.FileUniqueID, &r.Image, &r.Source, &r.State, &r.Attempts)
	if err != nil {
		return nil, err
	}
	return &r, nil
}

// stkProcess handles one queued row and reports whether the batch must stop
// (Telegram-wide problem: bad token, owner unreachable, rate limit).
func (s *Server) stkProcess(ctx context.Context, st *stkSettings, teamID int64, kind string) (stop bool) {
	row, err := s.stkRow(ctx, teamID, kind)
	if err != nil {
		return false
	}
	k := st.kind(kind)
	tg := s.stkClient(st)
	if row.State == "removing" {
		err := tg.deleteSticker(ctx, row.FileID)
		if err == nil || tgErrHas(err, "STICKER_ID_INVALID", "not found", "STICKERSET_INVALID", "wrong file_id", "file identifier") {
			s.stkRemoveImage(row.Image)
			_, _ = s.DB.ExecContext(ctx, `DELETE FROM tg_stickers WHERE team_id = $1 AND kind = $2 AND state = 'removing'`, teamID, kind)
			return false
		}
		return s.stkFailed(ctx, row, err)
	}

	var name, short, crest string
	err = s.DB.QueryRowContext(ctx, `SELECT name, coalesce(short_name, ''), coalesce(crest_url, '') FROM teams WHERE id = $1`, teamID).Scan(&name, &short, &crest)
	if err != nil || crest == "" {
		return false // gone: the next reconcile turns it into a removal
	}
	data, err := s.stkBuild(ctx, crest, k)
	if err != nil {
		// a logo that cannot be read will not get better by retrying
		_, _ = s.DB.ExecContext(ctx, `UPDATE tg_stickers SET state = 'error', attempts = $3, last_error = $4, updated_at = now() WHERE team_id = $1 AND kind = $2`,
			teamID, kind, stkMaxAttempts, "Logotip: "+err.Error())
		return false
	}
	setName, fileID, uniq, err := s.stkSend(ctx, st, k, tg, row, data, stkKeywords(name, short))
	if err != nil {
		return s.stkFailed(ctx, row, err)
	}
	img := s.stkSaveImage(teamID, kind, data)
	if _, err := s.DB.ExecContext(ctx, `UPDATE tg_stickers SET set_name = $3, file_id = $4, file_unique_id = $5, image = $6, source = $7,
		state = 'ready', attempts = 0, last_error = '', updated_at = now() WHERE team_id = $1 AND kind = $2`,
		teamID, kind, setName, fileID, uniq, img, k.source(crest)); err != nil {
		slog.Warn("sticker save", "err", err)
	}
	if row.Image != img {
		s.stkRemoveImage(row.Image)
	}
	if st.Problem != "" {
		s.stkSetProblem(ctx, "", "")
		st.Problem = ""
	}
	return false
}

// stkSend adds or replaces the sticker and returns where it landed.
func (s *Server) stkSend(ctx context.Context, st *stkSettings, k stkKindCfg, tg *tgStkClient, row *stkRow, data []byte, kw []string) (set, fileID, uniq string, err error) {
	if row.FileID != "" && row.SetName != "" {
		err = tg.replaceSticker(ctx, st.OwnerID, row.SetName, row.FileID, data, kw)
		if err == nil {
			fileID, uniq, err = s.stkFindNew(ctx, tg, row.SetName, row.TeamID, row.Kind)
			return row.SetName, fileID, uniq, err
		}
		if !tgErrHas(err, "STICKER_ID_INVALID", "not found", "wrong file_id", "file identifier") {
			return "", "", "", err
		}
		// the sticker was deleted in Telegram by hand: add it again
	}
	set, err = s.stkAdd(ctx, st, k, tg, data, kw)
	if err != nil {
		return "", "", "", err
	}
	fileID, uniq, err = s.stkFindNew(ctx, tg, set, row.TeamID, row.Kind)
	return set, fileID, uniq, err
}

// stkAdd puts a new sticker into the last set of its kind that has room, opening the next set when full.
func (s *Server) stkAdd(ctx context.Context, st *stkSettings, k stkKindCfg, tg *tgStkClient, data []byte, kw []string) (string, error) {
	var name string
	var ord, used int
	err := s.DB.QueryRowContext(ctx, `SELECT s.name, s.ord, (SELECT count(*) FROM tg_stickers k WHERE k.set_name = s.name AND k.file_id <> '')
		FROM tg_sticker_sets s WHERE s.kind = $1 ORDER BY s.ord DESC LIMIT 1`, k.Kind).Scan(&name, &ord, &used)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return "", err
	}
	if name != "" && used < stkLimit(k.Kind) {
		err := tg.addSticker(ctx, st.OwnerID, name, data, kw)
		if err == nil || !tgErrHas(err, "STICKERS_TOO_MUCH", "too much stickers", "too many stickers") {
			return name, err
		}
	}
	return s.stkOpenSet(ctx, st, k, tg, ord+1, data, kw)
}

// stkOpenSet creates set number ord of a kind with this sticker as its first one.
// An existing set with that name made by this bot is taken over instead.
func (s *Server) stkOpenSet(ctx context.Context, st *stkSettings, k stkKindCfg, tg *tgStkClient, ord int, data []byte, kw []string) (string, error) {
	name := stkSetName(k.Slug, ord, st.BotUsername)
	title := stkSetTitle(k.Title, ord)
	if _, err := tg.getStickerSet(ctx, name); err == nil {
		if err := tg.addSticker(ctx, st.OwnerID, name, data, kw); err != nil {
			return "", err
		}
	} else if tgErrHas(err, "STICKERSET_INVALID", "not found") {
		typ := "regular"
		if k.Kind == kindEmoji {
			typ = "custom_emoji"
		}
		if err := tg.createSet(ctx, st.OwnerID, name, title, typ, data, kw); err != nil {
			return "", err
		}
	} else {
		return "", err
	}
	_, err := s.DB.ExecContext(ctx, `INSERT INTO tg_sticker_sets (name, ord, title, kind) VALUES ($1, $2, $3, $4) ON CONFLICT (name) DO NOTHING`, name, ord, title, k.Kind)
	return name, err
}

// stkFindNew returns the sticker just added to set: the last one whose
// file_unique_id belongs to no other team.
func (s *Server) stkFindNew(ctx context.Context, tg *tgStkClient, set string, teamID int64, kind string) (string, string, error) {
	got, err := tg.getStickerSet(ctx, set)
	if err != nil {
		return "", "", err
	}
	known := map[string]bool{}
	rows, err := s.DB.QueryContext(ctx, `SELECT file_unique_id FROM tg_stickers WHERE set_name = $1 AND NOT (team_id = $2 AND kind = $3) AND file_unique_id <> ''`, set, teamID, kind)
	if err != nil {
		return "", "", err
	}
	defer rows.Close()
	for rows.Next() {
		var u string
		if rows.Scan(&u) == nil {
			known[u] = true
		}
	}
	var prevUniq string
	_ = s.DB.QueryRowContext(ctx, `SELECT file_unique_id FROM tg_stickers WHERE team_id = $1 AND kind = $2`, teamID, kind).Scan(&prevUniq)
	for i := len(got.Stickers) - 1; i >= 0; i-- {
		k := got.Stickers[i]
		if !known[k.FileUniqueID] && k.FileUniqueID != prevUniq {
			return k.FileID, k.FileUniqueID, nil
		}
	}
	return "", "", errors.New("yangi stiker to‘plamda topilmadi")
}

// stkFailed records a failed attempt and decides whether the batch stops.
func (s *Server) stkFailed(ctx context.Context, row *stkRow, err error) bool {
	msg := stkHuman(err)
	code := tgErrCode(err)
	switch {
	case code == 401 || code == 404:
		s.stkSetProblem(ctx, "token_invalid", msg)
		return true
	case tgErrHas(err, "PEER_ID_INVALID", "USER_ID_INVALID", "bot was blocked", "user is deactivated"):
		s.stkSetProblem(ctx, "owner_blocked", msg)
		_, _ = s.DB.ExecContext(ctx, `UPDATE tg_stickers SET next_try_at = now() + interval '5 minutes', last_error = $3, updated_at = now() WHERE team_id = $1 AND kind = $2`, row.TeamID, row.Kind, msg)
		return true
	case code == 429:
		var e *tgStkError
		errors.As(err, &e)
		wait := time.Duration(max(e.RetryAfter, 5)) * time.Second
		_, _ = s.DB.ExecContext(ctx, `UPDATE tg_stickers SET next_try_at = now() + $3::interval, updated_at = now() WHERE team_id = $1 AND kind = $2`,
			row.TeamID, row.Kind, fmt.Sprintf("%d seconds", int(wait.Seconds())))
		return true
	}
	attempts := row.Attempts + 1
	if code == 0 {
		s.stkSetProblem(ctx, "telegram_down", msg)
	}
	if attempts >= stkMaxAttempts {
		_, _ = s.DB.ExecContext(ctx, `UPDATE tg_stickers SET state = 'error', attempts = $3, last_error = $4, updated_at = now() WHERE team_id = $1 AND kind = $2`, row.TeamID, row.Kind, attempts, msg)
		return code == 0
	}
	delay := stkRetryDelays[min(attempts-1, len(stkRetryDelays)-1)]
	_, _ = s.DB.ExecContext(ctx, `UPDATE tg_stickers SET attempts = $3, last_error = $4, next_try_at = now() + $5::interval, updated_at = now() WHERE team_id = $1 AND kind = $2`,
		row.TeamID, row.Kind, attempts, msg, fmt.Sprintf("%d seconds", int(delay.Seconds())))
	return code == 0 // network trouble: do not hammer the rest of the queue
}

func (s *Server) stkRemoveImage(url string) {
	if name := strings.TrimPrefix(url, "/uploads/images/stickers/"); name != url && name != "" && !strings.Contains(name, "/") {
		_ = os.Remove(filepath.Join(s.stickersDir(), name))
	}
}

func stkKeywords(name, short string) []string {
	var out []string
	total := 0
	for _, k := range []string{name, short, "united mfl"} {
		k = strings.ToLower(strings.TrimSpace(k))
		if k == "" || total+len(k) > 64 {
			continue
		}
		dup := false
		for _, o := range out {
			dup = dup || o == k
		}
		if !dup {
			out = append(out, k)
			total += len(k)
		}
	}
	return out
}

// stkHuman turns Telegram errors into admin-readable Uzbek.
func stkHuman(err error) string {
	switch {
	case err == nil:
		return ""
	case tgErrCode(err) == 401 || tgErrCode(err) == 404:
		return "Bot tokeni yaroqsiz yoki bekor qilingan"
	case tgErrHas(err, "PEER_ID_INVALID", "USER_ID_INVALID", "bot was blocked"):
		return "To‘plam egasi botga /start yubormagan yoki botni to‘xtatgan"
	case tgErrHas(err, "sticker set name is already occupied", "STICKERSET_NAME_OCCUPIED"):
		return "Bu havola band — boshqa havola tanlang"
	case tgErrHas(err, "invalid sticker set name", "STICKERSET_INVALID_NAME", "SHORTNAME_OCCUPY_FAILED"):
		return "Havola noto‘g‘ri: faqat lotin harflari, raqamlar va _"
	case tgErrHas(err, "STICKER_PNG_DIMENSIONS", "STICKER_PNG_NOPNG", "IMAGE_PROCESS_FAILED", "STICKER_FILE_INVALID"):
		return "Telegram rasmni qabul qilmadi: " + err.Error()
	case tgErrCode(err) == 429:
		return "Telegram so‘rovlarni vaqtincha cheklayapti"
	case tgErrCode(err) == 0:
		return "Telegram javob bermadi"
	}
	return err.Error()
}

// ---------- owner detection for a separate bot ----------

// stkOwnerLoop polls a sticker bot that is not the Live-pult bot while the
// owner is not chosen yet, and records who sent /start.
func (s *Server) stkOwnerLoop(ctx context.Context) {
	var offset int64
	var bot int64
	for ctx.Err() == nil {
		st, err := s.stkLoad(ctx)
		if err != nil || st.Token == "" || st.OwnerID != 0 || st.Problem == "token_invalid" || s.sameBotAsLive(st) {
			select {
			case <-ctx.Done():
				return
			case <-s.stk.ownerWake:
			case <-time.After(15 * time.Second):
			}
			continue
		}
		if bot != st.BotID {
			bot, offset = st.BotID, 0
		}
		tg := s.stkClient(st)
		pctx, cancel := context.WithTimeout(ctx, 40*time.Second)
		ups, err := tg.getUpdates(pctx, offset, 25)
		cancel()
		if err != nil {
			if tgErrCode(err) == 409 {
				s.stkSetProblem(ctx, "", "Bot boshqa joyda ishlatilmoqda (webhook yoki boshqa server) — /start kuzatib bo‘lmadi")
			}
			select {
			case <-ctx.Done():
				return
			case <-time.After(10 * time.Second):
			}
			continue
		}
		for _, u := range ups {
			offset = u.UpdateID + 1
			m := u.Message
			if m == nil || m.From == nil || m.From.IsBot || m.Chat.Type != "private" || !strings.HasPrefix(strings.TrimSpace(m.Text), "/start") {
				continue
			}
			RecordBotStart(ctx, s.DB, st.BotID, m.From.ID, m.From.Username, strings.TrimSpace(m.From.FirstName+" "+m.From.LastName))
			_ = tg.send(ctx, m.Chat.ID, "Assalomu alaykum! Bu bot <b>United MFL</b> jamoalari stikerlarini yuritadi.\n\nAdmin panelda sizni stiker to‘plami egasi sifatida tanlashlari mumkin.")
		}
	}
}

// RecordBotStart notes that a Telegram user sent /start to the bot; the Live-pult bot calls it too.
func RecordBotStart(ctx context.Context, db *sql.DB, botID, userID int64, username, name string) {
	if botID == 0 || userID == 0 {
		return
	}
	_, err := db.ExecContext(ctx, `INSERT INTO tg_bot_starts (bot_id, tg_user_id, username, name) VALUES ($1, $2, $3, $4)
		ON CONFLICT (bot_id, tg_user_id) DO UPDATE SET username = EXCLUDED.username, name = EXCLUDED.name, at = now()`, botID, userID, username, name)
	if err != nil {
		slog.Warn("record bot start", "err", err)
	}
}

// ---------- admin API ----------

func (s *Server) mountStickers(r chi.Router) {
	r.Group(func(r chi.Router) {
		r.Use(s.can(auth.PermUsers))
		r.Get("/tg-stickers", s.stkState)
		r.Patch("/tg-stickers", s.stkPatch)
		r.Delete("/tg-stickers", s.stkDisconnect)
		r.Put("/tg-stickers/token", s.stkToken)
		r.Put("/tg-stickers/owner", s.stkOwner)
		r.Post("/tg-stickers/create", s.stkCreate)       // stickers
		r.Post("/tg-stickers/emoji/create", s.stkCreate) // emoji
		r.Post("/tg-stickers/sync", s.stkSync)
		r.Post("/tg-stickers/preview", s.stkPreview)
		r.Post("/tg-stickers/teams/{id}/retry", s.stkRetry)
	})
	r.With(s.can(auth.PermTeams)).Get("/teams/{id}/sticker", s.stkTeam)
}

// stkItem is one team's sticker or emoji as the admin sees it.
type stkItem struct {
	Status    string     `json:"status"` // ready, queued, error, stale, no_logo, waiting
	Image     string     `json:"image"`
	Attempts  int        `json:"attempts"`
	LastError string     `json:"last_error"`
	UpdatedAt *time.Time `json:"updated_at"`
	NextTryAt *time.Time `json:"next_try_at"`
}

type stkTeamView struct {
	TeamID    int64   `json:"team_id"`
	Name      string  `json:"name"`
	ShortName string  `json:"short_name"`
	CrestURL  string  `json:"crest_url"`
	stkItem           // the sticker (flattened, as before)
	Emoji     stkItem `json:"emoji"`
}

type stkCandidate struct {
	ID       int64     `json:"id"`
	Username string    `json:"username"`
	Name     string    `json:"name"`
	At       time.Time `json:"at"`
}

type stkSetView struct {
	Name  string `json:"name"`
	Title string `json:"title"`
	URL   string `json:"url"`
	Count int    `json:"count"`
}

type stkEmojiView struct {
	Enabled bool           `json:"enabled"`
	Created bool           `json:"created"` // an emoji set exists
	Slug    string         `json:"slug"`
	Title   string         `json:"title"`
	Outline bool           `json:"outline"`
	SetURL  string         `json:"set_url"`
	Sets    []stkSetView   `json:"sets"`
	Limit   int            `json:"limit"`
	Counts  map[string]int `json:"counts"`
}

type stkStateView struct {
	Connected   bool           `json:"connected"`
	TokenBroken bool           `json:"token_broken"`
	TokenMasked string         `json:"token_masked"`
	BotUsername string         `json:"bot_username"`
	SameAsLive  bool           `json:"same_as_live"`
	Owner       *stkCandidate  `json:"owner"`
	Candidates  []stkCandidate `json:"candidates"`
	SetSlug     string         `json:"set_slug"`
	SetTitle    string         `json:"set_title"`
	SetURL      string         `json:"set_url"`
	Sets        []stkSetView   `json:"sets"`
	Limit       int            `json:"limit"`
	Outline     bool           `json:"outline"`
	AutoUpdate  bool           `json:"auto_update"`
	Enabled     bool           `json:"enabled"`
	Problem     string         `json:"problem"`
	LastError   string         `json:"last_error"`
	LastSyncAt  *time.Time     `json:"last_sync_at"`
	NextRetryAt *time.Time     `json:"next_retry_at"`
	Counts      map[string]int `json:"counts"`
	Emoji       stkEmojiView   `json:"emoji"`
	Teams       []stkTeamView  `json:"teams"`
}

func stkCounts() map[string]int {
	return map[string]int{"teams": 0, "ready": 0, "queued": 0, "error": 0, "no_logo": 0, "stale": 0}
}

func (s *Server) stkView(ctx context.Context) (*stkStateView, error) {
	st, err := s.stkLoad(ctx)
	if err != nil {
		return nil, err
	}
	v := &stkStateView{
		Connected: st.Token != "", TokenBroken: st.TokenBroken, TokenMasked: maskToken(st.Token), BotUsername: st.BotUsername,
		SameAsLive: s.sameBotAsLive(st), SetSlug: st.SetSlug, SetTitle: st.SetTitle, Limit: stkSetLimit,
		Outline: st.Outline, AutoUpdate: st.AutoUpdate, Enabled: st.Enabled, Problem: st.Problem, LastError: st.LastError,
		Candidates: []stkCandidate{}, Sets: []stkSetView{}, Teams: []stkTeamView{}, Counts: stkCounts(),
		Emoji: stkEmojiView{Enabled: st.EmojiEnabled, Slug: st.EmojiSlug, Title: st.EmojiTitle, Outline: st.EmojiOutline,
			Sets: []stkSetView{}, Limit: stkEmojiLimit, Counts: stkCounts()},
	}
	if st.LastSyncAt.Valid {
		v.LastSyncAt = &st.LastSyncAt.Time
	}
	if st.BotUsername != "" {
		v.SetURL = stkSetURL(kindSticker, stkSetName(st.SetSlug, 1, st.BotUsername))
		v.Emoji.SetURL = stkSetURL(kindEmoji, stkSetName(st.EmojiSlug, 1, st.BotUsername))
	}
	if st.OwnerID != 0 {
		v.Owner = &stkCandidate{ID: st.OwnerID, Username: st.OwnerUsername, Name: st.OwnerName}
	}
	if st.BotID != 0 {
		rows, err := s.DB.QueryContext(ctx, `SELECT tg_user_id, username, name, at FROM tg_bot_starts
			WHERE bot_id = $1 AND at > now() - interval '7 days' ORDER BY at DESC LIMIT 10`, st.BotID)
		if err != nil {
			return nil, err
		}
		for rows.Next() {
			var c stkCandidate
			if rows.Scan(&c.ID, &c.Username, &c.Name, &c.At) == nil {
				v.Candidates = append(v.Candidates, c)
			}
		}
		rows.Close()
	}
	rows, err := s.DB.QueryContext(ctx, `SELECT s.kind, s.name, s.title, (SELECT count(*) FROM tg_stickers k WHERE k.set_name = s.name AND k.file_id <> '')
		FROM tg_sticker_sets s ORDER BY s.kind, s.ord`)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var kind string
		var x stkSetView
		if rows.Scan(&kind, &x.Name, &x.Title, &x.Count) != nil {
			continue
		}
		x.URL = stkSetURL(kind, x.Name)
		if kind == kindEmoji {
			v.Emoji.Sets = append(v.Emoji.Sets, x)
		} else {
			v.Sets = append(v.Sets, x)
		}
	}
	rows.Close()
	if len(v.Sets) > 0 {
		v.SetURL = v.Sets[0].URL
	}
	if len(v.Emoji.Sets) > 0 {
		v.Emoji.Created, v.Emoji.SetURL = true, v.Emoji.Sets[0].URL
	}

	rows, err = s.DB.QueryContext(ctx, `SELECT t.id, t.name, coalesce(t.short_name, ''), coalesce(t.crest_url, ''),
		coalesce(k.state, ''), coalesce(k.image, ''), coalesce(k.attempts, 0), coalesce(k.last_error, ''), k.updated_at, k.next_try_at, coalesce(k.source, ''),
		coalesce(e.state, ''), coalesce(e.image, ''), coalesce(e.attempts, 0), coalesce(e.last_error, ''), e.updated_at, e.next_try_at, coalesce(e.source, '')
		FROM teams t
		LEFT JOIN tg_stickers k ON k.team_id = t.id AND k.kind = 'sticker'
		LEFT JOIN tg_stickers e ON e.team_id = t.id AND e.kind = 'emoji'
		ORDER BY t.name`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	item := func(k stkKindCfg, crest, state, source string, upd, next sql.NullTime, it *stkItem, counts map[string]int, nextRetry **time.Time) {
		if upd.Valid {
			it.UpdatedAt = &upd.Time
		}
		switch {
		case crest == "":
			it.Status = "no_logo"
		case state == "" && !k.Enabled:
			it.Status = "waiting"
		case state == "" || state == "removing":
			it.Status = "queued"
		case state == "ready" && source != k.source(crest):
			it.Status = "stale"
		default:
			it.Status = state
		}
		if it.Status == "queued" && next.Valid && next.Time.After(time.Now()) {
			it.NextTryAt = &next.Time
			if *nextRetry == nil || next.Time.Before(**nextRetry) {
				*nextRetry = &next.Time
			}
		}
		counts["teams"]++
		if _, ok := counts[it.Status]; ok {
			counts[it.Status]++
		}
	}
	for rows.Next() {
		var t stkTeamView
		var sState, sSource, eState, eSource string
		var sUpd, sNext, eUpd, eNext sql.NullTime
		if err := rows.Scan(&t.TeamID, &t.Name, &t.ShortName, &t.CrestURL,
			&sState, &t.Image, &t.Attempts, &t.LastError, &sUpd, &sNext, &sSource,
			&eState, &t.Emoji.Image, &t.Emoji.Attempts, &t.Emoji.LastError, &eUpd, &eNext, &eSource); err != nil {
			return nil, err
		}
		item(st.kind(kindSticker), t.CrestURL, sState, sSource, sUpd, sNext, &t.stkItem, v.Counts, &v.NextRetryAt)
		item(st.kind(kindEmoji), t.CrestURL, eState, eSource, eUpd, eNext, &t.Emoji, v.Emoji.Counts, &v.NextRetryAt)
		v.Teams = append(v.Teams, t)
	}
	return v, rows.Err()
}

func (s *Server) stkState(w http.ResponseWriter, r *http.Request) {
	v, err := s.stkView(r.Context())
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	httpx.JSON(w, 200, v)
}

func (s *Server) stkPatch(w http.ResponseWriter, r *http.Request) {
	var in struct {
		SetSlug      *string `json:"set_slug"`
		SetTitle     *string `json:"set_title"`
		Outline      *bool   `json:"outline"`
		AutoUpdate   *bool   `json:"auto_update"`
		EmojiSlug    *string `json:"emoji_slug"`
		EmojiTitle   *string `json:"emoji_title"`
		EmojiOutline *bool   `json:"emoji_outline"`
		EmojiEnabled *bool   `json:"emoji_enabled"`
	}
	if err := httpx.Decode(r, &in); err != nil {
		httpx.Fail(w, r, err)
		return
	}
	s.stk.mu.Lock()
	defer s.stk.mu.Unlock()
	ctx := r.Context()
	st, err := s.stkLoad(ctx)
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	emojiCreated := s.stkHasSets(ctx, kindEmoji)

	slug := func(field string, in *string, cur *string, created bool, other string) bool {
		if in == nil {
			return true
		}
		v := strings.ToLower(strings.TrimSpace(*in))
		msg := ""
		switch {
		case created && v != *cur:
			msg = "To‘plam yaratilgandan keyin havolani o‘zgartirib bo‘lmaydi"
		case v == other:
			msg = "Stikerlar va emoji havolalari har xil bo‘lsin"
		default:
			msg = stkCheckSlug(v, st.BotUsername)
		}
		if msg != "" {
			httpx.Fail(w, r, httpx.Validation(map[string]any{field: msg}))
			return false
		}
		*cur = v
		return true
	}
	if !slug("set_slug", in.SetSlug, &st.SetSlug, st.Enabled || s.stkHasSets(ctx, kindSticker), st.EmojiSlug) ||
		!slug("emoji_slug", in.EmojiSlug, &st.EmojiSlug, emojiCreated, st.SetSlug) {
		return
	}
	title := func(field, kind string, in *string, cur *string) bool {
		if in == nil {
			return true
		}
		v := strings.TrimSpace(*in)
		if n := len([]rune(v)); n < 1 || n > 60 {
			httpx.Fail(w, r, httpx.Validation(map[string]any{field: "Nom 1–60 belgi bo‘lsin"}))
			return false
		}
		if v != *cur && st.Token != "" {
			if err := s.stkRetitle(ctx, st, kind, v); err != nil {
				httpx.Fail(w, r, httpx.BadRequest("Telegram nomni o‘zgartirmadi: "+stkHuman(err)))
				return false
			}
		}
		*cur = v
		return true
	}
	if !title("set_title", kindSticker, in.SetTitle, &st.SetTitle) || !title("emoji_title", kindEmoji, in.EmojiTitle, &st.EmojiTitle) {
		return
	}
	stickerLook := in.Outline != nil && *in.Outline != st.Outline
	emojiLook := in.EmojiOutline != nil && *in.EmojiOutline != st.EmojiOutline
	if in.Outline != nil {
		st.Outline = *in.Outline
	}
	if in.EmojiOutline != nil {
		st.EmojiOutline = *in.EmojiOutline
	}
	if in.AutoUpdate != nil {
		st.AutoUpdate = *in.AutoUpdate
	}
	if in.EmojiEnabled != nil {
		if *in.EmojiEnabled && !emojiCreated {
			httpx.Fail(w, r, httpx.BadRequest("Avval emoji to‘plamini yarating"))
			return
		}
		st.EmojiEnabled = *in.EmojiEnabled
	}
	if _, err := s.DB.ExecContext(ctx, `UPDATE tg_sticker_settings SET set_slug = $1, set_title = $2, outline = $3, auto_update = $4,
		emoji_slug = $5, emoji_title = $6, emoji_outline = $7, emoji_enabled = $8, updated_at = now() WHERE id = 1`,
		st.SetSlug, st.SetTitle, st.Outline, st.AutoUpdate, st.EmojiSlug, st.EmojiTitle, st.EmojiOutline, st.EmojiEnabled); err != nil {
		httpx.Fail(w, r, err)
		return
	}
	// a new look is an explicit change: redraw every sticker of that kind, whatever auto-update says
	for kind, changed := range map[string]bool{kindSticker: stickerLook, kindEmoji: emojiLook} {
		if changed {
			_, _ = s.DB.ExecContext(ctx, `UPDATE tg_stickers k SET state = 'queued', attempts = 0, next_try_at = now(), last_error = '',
				source = t.crest_url || $1, updated_at = now() FROM teams t
				WHERE t.id = k.team_id AND k.kind = $2 AND coalesce(t.crest_url, '') <> '' AND k.state <> 'removing'`, st.kind(kind).flag(), kind)
		}
	}
	s.audit(r, "tg_stickers.settings", "tg_stickers", 1, nil)
	s.stk.poke()
	s.stkState(w, r)
}

// stkRetitle renames every Telegram set of a kind.
func (s *Server) stkRetitle(ctx context.Context, st *stkSettings, kind, title string) error {
	rows, err := s.DB.QueryContext(ctx, `SELECT name, ord FROM tg_sticker_sets WHERE kind = $1 ORDER BY ord`, kind)
	if err != nil {
		return err
	}
	type set struct {
		name string
		ord  int
	}
	var sets []set
	for rows.Next() {
		var x set
		if rows.Scan(&x.name, &x.ord) == nil {
			sets = append(sets, x)
		}
	}
	rows.Close()
	tg := s.stkClient(st)
	for _, x := range sets {
		if err := tg.setTitle(ctx, x.name, stkSetTitle(title, x.ord)); err != nil {
			return err
		}
		_, _ = s.DB.ExecContext(ctx, `UPDATE tg_sticker_sets SET title = $2 WHERE name = $1`, x.name, stkSetTitle(title, x.ord))
	}
	return nil
}

func stkCheckSlug(slug, bot string) string {
	switch {
	case !stkSlugRe.MatchString(slug) || strings.Contains(slug, "__"):
		return "Havola lotin harfi bilan boshlansin; faqat kichik lotin harflari, raqamlar va _"
	case len(stkSetName(slug, 99, bot)) > 64:
		return "Havola juda uzun"
	}
	return ""
}

// stkCreate creates the first set of a kind (stickers, or emoji on /emoji/create)
// with the first team logo, then queues the rest.
func (s *Server) stkCreate(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	kind := kindSticker
	if strings.HasSuffix(r.URL.Path, "/emoji/create") {
		kind = kindEmoji
	}
	s.stk.mu.Lock()
	defer s.stk.mu.Unlock()
	st, err := s.stkLoad(ctx)
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	k := st.kind(kind)
	switch {
	case st.Token == "":
		httpx.Fail(w, r, httpx.BadRequest("Avval bot tokenini kiriting"))
		return
	case st.OwnerID == 0:
		httpx.Fail(w, r, httpx.BadRequest("Avval to‘plam egasini tanlang"))
		return
	case s.stkHasSets(ctx, kind):
		httpx.Fail(w, r, httpx.BadRequest("To‘plam allaqachon yaratilgan"))
		return
	}
	field := "set_slug"
	if kind == kindEmoji {
		field = "emoji_slug"
	}
	if msg := stkCheckSlug(k.Slug, st.BotUsername); msg != "" {
		httpx.Fail(w, r, httpx.Validation(map[string]any{field: msg}))
		return
	}
	if st.SetSlug == st.EmojiSlug {
		httpx.Fail(w, r, httpx.Validation(map[string]any{field: "Stikerlar va emoji havolalari har xil bo‘lsin"}))
		return
	}
	var teamID int64
	var name, short, crest string
	err = s.DB.QueryRowContext(ctx, `SELECT id, name, coalesce(short_name, ''), crest_url FROM teams WHERE coalesce(crest_url, '') <> '' ORDER BY id LIMIT 1`).
		Scan(&teamID, &name, &short, &crest)
	if errors.Is(err, sql.ErrNoRows) {
		httpx.Fail(w, r, httpx.BadRequest("Logotipi bor jamoa yo‘q: avval jamoaga logotip yuklang"))
		return
	}
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	data, err := s.stkBuild(ctx, crest, k)
	if err != nil {
		httpx.Fail(w, r, httpx.BadRequest(name+" logotipi: "+err.Error()))
		return
	}
	tg := s.stkClient(st)
	_, _ = s.DB.ExecContext(ctx, `DELETE FROM tg_stickers WHERE kind = $1`, kind)
	set, err := s.stkOpenSet(ctx, st, k, tg, 1, data, stkKeywords(name, short))
	if err != nil {
		httpx.Fail(w, r, httpx.BadRequest("To‘plam yaratilmadi: "+stkHuman(err)))
		return
	}
	fileID, uniq, err := s.stkFindNew(ctx, tg, set, teamID, kind)
	if err != nil {
		httpx.Fail(w, r, httpx.BadRequest("To‘plam yaratildi, lekin stikerni o‘qib bo‘lmadi: "+stkHuman(err)))
		return
	}
	img := s.stkSaveImage(teamID, kind, data)
	if _, err := s.DB.ExecContext(ctx, `INSERT INTO tg_stickers (team_id, kind, set_name, file_id, file_unique_id, image, source, state)
		VALUES ($1, $2, $3, $4, $5, $6, $7, 'ready')`, teamID, kind, set, fileID, uniq, img, k.source(crest)); err != nil {
		httpx.Fail(w, r, err)
		return
	}
	col := "enabled"
	if kind == kindEmoji {
		col, st.EmojiEnabled = "emoji_enabled", true
	} else {
		st.Enabled = true
	}
	if _, err := s.DB.ExecContext(ctx, `UPDATE tg_sticker_settings SET `+col+` = true, problem = '', last_error = '', last_sync_at = now(), updated_at = now() WHERE id = 1`); err != nil {
		httpx.Fail(w, r, err)
		return
	}
	if err := s.stkReconcile(ctx, st, kind); err != nil {
		slog.Warn("sticker reconcile", "err", err)
	}
	s.audit(r, "tg_stickers.create", "tg_stickers", 1, map[string]any{"set": set, "kind": kind})
	s.stk.poke()
	s.stkState(w, r)
}

// stkSync re-checks the token and the sets in Telegram and queues everything that is off.
func (s *Server) stkSync(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	s.stk.mu.Lock()
	st, err := s.stkLoad(ctx)
	if err != nil {
		s.stk.mu.Unlock()
		httpx.Fail(w, r, err)
		return
	}
	if !st.ready() {
		s.stk.mu.Unlock()
		httpx.Fail(w, r, httpx.BadRequest("To‘plam hali yaratilmagan"))
		return
	}
	tg := s.stkClient(st)
	if _, err := tg.getMe(ctx); err != nil {
		s.stk.mu.Unlock()
		if tgErrCode(err) == 401 || tgErrCode(err) == 404 {
			s.stkSetProblem(ctx, "token_invalid", stkHuman(err))
		}
		httpx.Fail(w, r, httpx.BadRequest(stkHuman(err)))
		return
	}
	s.stkSetProblem(ctx, "", "")
	// stickers deleted in Telegram by hand are added again
	rows, err := s.DB.QueryContext(ctx, `SELECT name FROM tg_sticker_sets ORDER BY kind, ord`)
	if err == nil {
		var sets []string
		for rows.Next() {
			var n string
			if rows.Scan(&n) == nil {
				sets = append(sets, n)
			}
		}
		rows.Close()
		for _, n := range sets {
			got, err := tg.getStickerSet(ctx, n)
			if err != nil {
				continue
			}
			have := make([]string, 0, len(got.Stickers))
			for _, k := range got.Stickers {
				have = append(have, k.FileUniqueID)
			}
			_, _ = s.DB.ExecContext(ctx, `UPDATE tg_stickers SET file_id = '', file_unique_id = '', state = CASE WHEN state = 'removing' THEN state ELSE 'queued' END,
				attempts = 0, next_try_at = now(), updated_at = now() WHERE set_name = $1 AND file_unique_id <> '' AND NOT (file_unique_id = ANY($2::text[]))`, n, pqArray(have))
		}
	}
	_, _ = s.DB.ExecContext(ctx, `UPDATE tg_stickers SET state = 'queued', attempts = 0, next_try_at = now(), last_error = '', updated_at = now()
		WHERE state = 'error' OR (state = 'queued' AND attempts > 0)`)
	_, _ = s.DB.ExecContext(ctx, `UPDATE tg_stickers SET next_try_at = now() WHERE state = 'removing'`)
	for _, k := range stkKinds {
		if st.kind(k).Enabled {
			if err := s.stkReconcile(ctx, st, k); err != nil {
				slog.Warn("sticker reconcile", "kind", k, "err", err)
			}
		}
	}
	s.stk.mu.Unlock()
	s.audit(r, "tg_stickers.sync", "tg_stickers", 1, nil)
	s.stk.poke()
	s.stkState(w, r)
}

func stkKindParam(r *http.Request) string {
	if r.URL.Query().Get("kind") == kindEmoji {
		return kindEmoji
	}
	return kindSticker
}

func (s *Server) stkRetry(w http.ResponseWriter, r *http.Request) {
	id, err := idParam(r, "id")
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	kind := stkKindParam(r)
	res, err := s.DB.ExecContext(r.Context(), `UPDATE tg_stickers SET state = 'queued', attempts = 0, next_try_at = now(), last_error = '', updated_at = now()
		WHERE team_id = $1 AND kind = $2 AND state <> 'removing'`, id, kind)
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	if n, _ := res.RowsAffected(); n == 0 {
		// no row yet (or a stale view): let reconcile create it
		_, _ = s.DB.ExecContext(r.Context(), `INSERT INTO tg_stickers (team_id, kind, state) SELECT id, $2, 'queued' FROM teams WHERE id = $1 AND coalesce(crest_url, '') <> ''
			ON CONFLICT DO NOTHING`, id, kind)
	}
	s.stk.poke()
	s.stkState(w, r)
}

func (s *Server) stkDisconnect(w http.ResponseWriter, r *http.Request) {
	s.stk.mu.Lock()
	defer s.stk.mu.Unlock()
	ctx := r.Context()
	rows, err := s.DB.QueryContext(ctx, `DELETE FROM tg_stickers RETURNING image`)
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	for rows.Next() {
		var img string
		if rows.Scan(&img) == nil {
			s.stkRemoveImage(img)
		}
	}
	rows.Close()
	if _, err := s.DB.ExecContext(ctx, `DELETE FROM tg_sticker_sets; UPDATE tg_sticker_settings SET token_enc = NULL, bot_id = 0, bot_username = '',
		token_set_at = NULL, owner_id = 0, owner_username = '', owner_name = '', enabled = false, emoji_enabled = false,
		problem = '', last_error = '', last_sync_at = NULL, updated_at = now() WHERE id = 1`); err != nil {
		httpx.Fail(w, r, err)
		return
	}
	s.audit(r, "tg_stickers.disconnect", "tg_stickers", 1, nil)
	s.stkState(w, r)
}

// stkPreview draws a team's sticker or emoji without sending it.
func (s *Server) stkPreview(w http.ResponseWriter, r *http.Request) {
	var in struct {
		TeamID  int64  `json:"team_id"`
		Outline bool   `json:"outline"`
		Kind    string `json:"kind"`
	}
	if err := httpx.Decode(r, &in); err != nil {
		httpx.Fail(w, r, err)
		return
	}
	var crest string
	q := `SELECT crest_url FROM teams WHERE id = $1 AND coalesce(crest_url, '') <> ''`
	args := []any{in.TeamID}
	if in.TeamID == 0 {
		q, args = `SELECT crest_url FROM teams WHERE coalesce(crest_url, '') <> '' ORDER BY id LIMIT 1`, nil
	}
	if err := s.DB.QueryRowContext(r.Context(), q, args...).Scan(&crest); err != nil {
		httpx.Fail(w, r, httpx.ErrNotFound)
		return
	}
	kind := kindSticker
	if in.Kind == kindEmoji {
		kind = kindEmoji
	}
	data, err := s.stkBuild(r.Context(), crest, stkKindCfg{Kind: kind, Outline: in.Outline})
	if err != nil {
		httpx.Fail(w, r, httpx.BadRequest(err.Error()))
		return
	}
	httpx.JSON(w, 200, map[string]any{"image": "data:image/png;base64," + base64.StdEncoding.EncodeToString(data), "bytes": len(data)})
}

// stkTeam is the «Telegram» block on the team page.
func (s *Server) stkTeam(w http.ResponseWriter, r *http.Request) {
	id, err := idParam(r, "id")
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	v, err := s.stkView(r.Context())
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	for _, t := range v.Teams {
		if t.TeamID == id {
			httpx.JSON(w, 200, map[string]any{"enabled": v.Enabled, "set_url": v.SetURL, "outline": v.Outline,
				"emoji_enabled": v.Emoji.Enabled, "emoji_set_url": v.Emoji.SetURL, "team": t})
			return
		}
	}
	httpx.Fail(w, r, httpx.ErrNotFound)
}

func maskToken(t string) string {
	i := strings.IndexByte(t, ':')
	if i <= 0 || len(t) < i+5 {
		return "••••"
	}
	return t[:min(i, 4)] + "••••:••••" + t[len(t)-4:]
}

func (s *Server) stkToken(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Token string `json:"token"`
	}
	if err := httpx.Decode(r, &in); err != nil {
		httpx.Fail(w, r, err)
		return
	}
	token := strings.TrimSpace(in.Token)
	if botIDFromToken(token) == 0 || len(token) < 30 || strings.ContainsAny(token, " /\n\t") {
		httpx.Fail(w, r, httpx.Validation(map[string]any{"token": "Token noto‘g‘ri: @BotFather bergan tokenni to‘liq kiriting"}))
		return
	}
	me, err := newTGStkClient(s.Cfg.TelegramAPIURL, token).getMe(r.Context())
	if err != nil {
		httpx.Fail(w, r, httpx.Validation(map[string]any{"token": "Telegram tokenni qabul qilmadi: " + stkHuman(err)}))
		return
	}
	box, err := s.stk.seal(token)
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	s.stk.mu.Lock()
	defer s.stk.mu.Unlock()
	st, err := s.stkLoad(r.Context())
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	tx, err := s.DB.BeginTx(r.Context(), nil)
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	defer tx.Rollback()
	if st.BotID != me.ID {
		// another bot cannot edit the old sets: start over (the old sets stay in Telegram)
		if _, err := tx.ExecContext(r.Context(), `UPDATE tg_sticker_settings SET owner_id = 0, owner_username = '', owner_name = '',
			enabled = false, emoji_enabled = false, token_set_at = now() WHERE id = 1`); err != nil {
			httpx.Fail(w, r, err)
			return
		}
		if _, err := tx.ExecContext(r.Context(), `DELETE FROM tg_stickers; DELETE FROM tg_sticker_sets`); err != nil {
			httpx.Fail(w, r, err)
			return
		}
	}
	if _, err := tx.ExecContext(r.Context(), `UPDATE tg_sticker_settings SET token_enc = $1, bot_id = $2, bot_username = $3,
		problem = '', last_error = '', updated_at = now() WHERE id = 1`, box, me.ID, me.Username); err != nil {
		httpx.Fail(w, r, err)
		return
	}
	if err := tx.Commit(); err != nil {
		httpx.Fail(w, r, err)
		return
	}
	s.audit(r, "tg_stickers.token", "tg_stickers", 1, map[string]any{"bot": me.Username})
	select {
	case s.stk.ownerWake <- struct{}{}:
	default:
	}
	s.stk.poke()
	s.stkState(w, r)
}

func (s *Server) stkOwner(w http.ResponseWriter, r *http.Request) {
	var in struct {
		ID int64 `json:"tg_user_id"`
	}
	if err := httpx.Decode(r, &in); err != nil {
		httpx.Fail(w, r, err)
		return
	}
	st, err := s.stkLoad(r.Context())
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	if st.Enabled || st.EmojiEnabled || s.stkHasSets(r.Context(), kindSticker) || s.stkHasSets(r.Context(), kindEmoji) {
		httpx.Fail(w, r, httpx.BadRequest("To‘plam yaratilgan: egasini o‘zgartirib bo‘lmaydi. Avval ulanishni uzing."))
		return
	}
	var c stkCandidate
	err = s.DB.QueryRowContext(r.Context(), `SELECT tg_user_id, username, name, at FROM tg_bot_starts WHERE bot_id = $1 AND tg_user_id = $2`, st.BotID, in.ID).
		Scan(&c.ID, &c.Username, &c.Name, &c.At)
	if errors.Is(err, sql.ErrNoRows) {
		httpx.Fail(w, r, httpx.BadRequest("Bu akkaunt botga /start yubormagan"))
		return
	}
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	if _, err := s.DB.ExecContext(r.Context(), `UPDATE tg_sticker_settings SET owner_id = $1, owner_username = $2, owner_name = $3, updated_at = now() WHERE id = 1`,
		c.ID, c.Username, c.Name); err != nil {
		httpx.Fail(w, r, err)
		return
	}
	if st.Token != "" {
		_ = s.stkClient(st).send(r.Context(), c.ID, "✅ Siz <b>United MFL</b> jamoa stikerlari to‘plamining egasi sifatida tanlandingiz.")
	}
	s.audit(r, "tg_stickers.owner", "tg_stickers", 1, map[string]any{"tg_user_id": c.ID, "username": c.Username})
	s.stkState(w, r)
}

// pqArray formats a text[] literal for lib/pq without importing it here.
func pqArray(items []string) string {
	var b strings.Builder
	b.WriteByte('{')
	for i, it := range items {
		if i > 0 {
			b.WriteByte(',')
		}
		b.WriteByte('"')
		b.WriteString(strings.NewReplacer(`\`, `\\`, `"`, `\"`).Replace(it))
		b.WriteByte('"')
	}
	b.WriteByte('}')
	return b.String()
}
