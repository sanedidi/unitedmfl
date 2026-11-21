package api

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"math"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/lib/pq"

	"github.com/sanedidi/unitedmfl/backend/internal/wb"
)

// Wildberries store (Tizim → Wildberries, Merch → mahsulot).
//
// The admin is the only source: a product and its WB card are edited on the
// product page. «Saqlash» queues the product (wb_state = queued); a background
// worker then
//
//   - checks the card locally (category, brand, title, required
//     characteristics, package size, photos) → «incomplete» with the list of
//     what is missing;
//   - creates the card (cards/upload) → «pending» until WB has built it (the
//     nmID shows up in cards/list) or refused it (cards/error/list);
//   - updates the card when its content changed (cards/update, the full card:
//     documents and barcodes already on WB are carried over);
//   - sends the photos (media/save, public URLs of the site) and the price
//     with the discount (upload/task) when they changed;
//   - every 30 minutes pulls prices and WB-warehouse (FBO) stocks back; a
//     product whose sizes all ran out becomes «Vaqtincha tugagan» on the site.
//
// WB failures are retried 5 times (1, 5, 15, 60 min, 6 h), then «Xato». A
// refused token stops the worker until a new one is entered. The token is
// AES-GCM encrypted at rest.

const (
	wbMaxAttempts  = 6
	wbBatch        = 10
	wbPullEvery    = 30 * time.Minute
	wbPendingLimit = 3 * time.Hour // WB normally builds a card within 30 min
	wbTitleMax     = 60
)

var wbRetryDelays = []time.Duration{time.Minute, 5 * time.Minute, 15 * time.Minute, time.Hour, 6 * time.Hour}

type wbSvc struct {
	mu    sync.Mutex // one WB writer at a time (worker and admin actions)
	wake  chan struct{}
	aead  cipher.AEAD
	lim   *wb.Limiter
	hosts wb.Hosts

	cacheMu sync.Mutex
	charcs  map[int]wbCached[[]wb.Charc]
	dirs    map[string]wbCached[[]string]
}

type wbCached[T any] struct {
	at  time.Time
	val T
}

func newWBSvc(secret []byte, apiURL string) *wbSvc {
	key := sha256.Sum256(append([]byte("wildberries:"), secret...))
	block, _ := aes.NewCipher(key[:])
	aead, _ := cipher.NewGCM(block)
	hosts := wb.DefaultHosts()
	if apiURL != "" {
		hosts = wb.HostsFrom(apiURL)
	}
	return &wbSvc{wake: make(chan struct{}, 1), aead: aead, lim: wb.NewLimiter(wb.Gaps()), hosts: hosts,
		charcs: map[int]wbCached[[]wb.Charc]{}, dirs: map[string]wbCached[[]string]{}}
}

func (k *wbSvc) poke() {
	select {
	case k.wake <- struct{}{}:
	default:
	}
}

func (k *wbSvc) seal(plain string) ([]byte, error) {
	nonce := make([]byte, k.aead.NonceSize())
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return nil, err
	}
	return k.aead.Seal(nonce, nonce, []byte(plain), nil), nil
}

func (k *wbSvc) open(box []byte) (string, error) {
	n := k.aead.NonceSize()
	if len(box) < n {
		return "", errors.New("bad ciphertext")
	}
	out, err := k.aead.Open(nil, box[:n], box[n:], nil)
	return string(out), err
}

// ---------- settings ----------

type wbSettings struct {
	Token         string
	TokenBroken   bool
	TokenSetAt    sql.NullTime
	ExpiresAt     sql.NullTime
	Scopes        []string
	SellerName    string
	SellerSID     string
	SellerTM      string
	SellerCountry string
	Currency      string
	LinkDomain    string
	AutoPush      bool
	PullStocks    bool
	AutoOOS       bool
	Problem       string
	LastError     string
	LastSyncAt    sql.NullTime
	LastPullAt    sql.NullTime
}

func (s *Server) wbLoad(ctx context.Context) (*wbSettings, error) {
	var st wbSettings
	var box []byte
	err := s.DB.QueryRowContext(ctx, `SELECT token_enc, token_set_at, token_expires_at, scopes, seller_name, seller_sid, seller_trademark,
		seller_country, currency, link_domain, auto_push, pull_stocks, auto_out_of_stock, problem, last_error, last_sync_at, last_pull_at
		FROM wb_settings WHERE id = 1`).Scan(&box, &st.TokenSetAt, &st.ExpiresAt, pq.Array(&st.Scopes), &st.SellerName, &st.SellerSID, &st.SellerTM,
		&st.SellerCountry, &st.Currency, &st.LinkDomain, &st.AutoPush, &st.PullStocks, &st.AutoOOS, &st.Problem, &st.LastError, &st.LastSyncAt, &st.LastPullAt)
	if err != nil {
		return nil, err
	}
	if len(box) > 0 {
		if st.Token, err = s.wb.open(box); err != nil {
			st.Token, st.TokenBroken = "", true
		}
	}
	return &st, nil
}

func (st *wbSettings) connected() bool { return st.Token != "" }

func (st *wbSettings) has(scope string) bool { return contains(st.Scopes, scope) }

func (s *Server) wbClient(st *wbSettings) *wb.Client { return wb.New(st.Token, s.wb.hosts, s.wb.lim) }

func (s *Server) wbSetProblem(ctx context.Context, problem, msg string) {
	_, _ = s.DB.ExecContext(ctx, `UPDATE wb_settings SET problem = $1, last_error = $2, updated_at = now() WHERE id = 1`, problem, msg)
}

func (s *Server) wbLog(ctx context.Context, level string, productID int64, text string) {
	var pid any
	if productID > 0 {
		pid = productID
	}
	_, _ = s.DB.ExecContext(ctx, `INSERT INTO wb_log (level, product_id, text) VALUES ($1, $2, $3)`, level, pid, text)
}

// wbHuman turns a WB error into a short Uzbek message (WB's own text is kept: it says what to fix).
func wbHuman(err error) string {
	var e *wb.Error
	switch {
	case wb.IsAuth(err):
		return "Token noto‘g‘ri, bekor qilingan yoki muddati o‘tgan"
	case wb.IsForbidden(err):
		return "Tokenda bu bo‘lim uchun ruxsat yo‘q: " + err.Error()
	case errors.As(err, &e) && e.Status == 429:
		return "WB so‘rovlar limiti — keyinroq qayta urinamiz"
	case errors.As(err, &e) && (e.Status >= 500 || e.Status == 0):
		return "WB vaqtincha javob bermayapti"
	case err != nil:
		return err.Error()
	}
	return ""
}

// ---------- characteristics and directories (cached 24 h) ----------

func (s *Server) wbCharcs(ctx context.Context, c *wb.Client, subjectID int) ([]wb.Charc, error) {
	s.wb.cacheMu.Lock()
	if v, ok := s.wb.charcs[subjectID]; ok && time.Since(v.at) < 24*time.Hour {
		s.wb.cacheMu.Unlock()
		return v.val, nil
	}
	s.wb.cacheMu.Unlock()
	list, err := c.Charcs(ctx, subjectID)
	if err != nil {
		return nil, err
	}
	s.wb.cacheMu.Lock()
	s.wb.charcs[subjectID] = wbCached[[]wb.Charc]{time.Now(), list}
	s.wb.cacheMu.Unlock()
	return list, nil
}

var wbDirectories = map[string]string{"Цвет": "colors", "Пол": "kinds", "Страна производства": "countries", "Сезон": "seasons"}

func (s *Server) wbDirectory(ctx context.Context, c *wb.Client, name string) ([]string, error) {
	s.wb.cacheMu.Lock()
	if v, ok := s.wb.dirs[name]; ok && time.Since(v.at) < 24*time.Hour {
		s.wb.cacheMu.Unlock()
		return v.val, nil
	}
	s.wb.cacheMu.Unlock()
	list, err := c.Directory(ctx, name)
	if err != nil {
		return nil, err
	}
	s.wb.cacheMu.Lock()
	s.wb.dirs[name] = wbCached[[]string]{time.Now(), list}
	s.wb.cacheMu.Unlock()
	return list, nil
}

// ---------- product as the worker sees it ----------

type wbChar struct {
	ID    int    `json:"id"`
	Name  string `json:"name"`
	Value any    `json:"value"`
}

type wbVariant struct {
	ID      int64
	Size    string
	WBSize  string
	Barcode string
	ChrtID  sql.NullInt64
}

type wbProduct struct {
	ID           int64
	Slug         string
	Name         string
	Description  string
	Images       []string
	PriceUZS     int64
	Enabled      bool
	SubjectID    sql.NullInt64
	Brand        string
	VendorCode   string
	Title        string
	WBDesc       string
	DescFromSite bool
	Chars        []wbChar
	WBPrice      sql.NullInt64
	Discount     int
	L, W, H, Wg  sql.NullInt64
	NmID         sql.NullInt64
	State        string
	Attempts     int
	CardHash     string
	MediaHash    string
	PriceHash    string
	PendingSince sql.NullTime
	Variants     []wbVariant
}

func (s *Server) wbProduct(ctx context.Context, id int64) (*wbProduct, error) {
	var p wbProduct
	var chars []byte
	err := s.DB.QueryRowContext(ctx, `SELECT id, slug, name, description, images, price_uzs, wb_enabled, wb_subject_id, wb_brand, wb_vendor_code,
		wb_title, wb_description, wb_desc_from_site, wb_chars, wb_price, wb_discount, pkg_length, pkg_width, pkg_height, pkg_weight_g,
		wb_nm_id, wb_state, wb_attempts, wb_card_hash, wb_media_hash, wb_price_hash, wb_pending_since FROM products WHERE id = $1`, id).
		Scan(&p.ID, &p.Slug, &p.Name, &p.Description, pq.Array(&p.Images), &p.PriceUZS, &p.Enabled, &p.SubjectID, &p.Brand, &p.VendorCode,
			&p.Title, &p.WBDesc, &p.DescFromSite, &chars, &p.WBPrice, &p.Discount, &p.L, &p.W, &p.H, &p.Wg,
			&p.NmID, &p.State, &p.Attempts, &p.CardHash, &p.MediaHash, &p.PriceHash, &p.PendingSince)
	if err != nil {
		return nil, err
	}
	_ = json.Unmarshal(chars, &p.Chars)
	rows, err := s.DB.QueryContext(ctx, `SELECT id, size, wb_size, barcode, wb_chrt_id FROM product_variants WHERE product_id = $1 ORDER BY id`, id)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var v wbVariant
		if err := rows.Scan(&v.ID, &v.Size, &v.WBSize, &v.Barcode, &v.ChrtID); err != nil {
			return nil, err
		}
		p.Variants = append(p.Variants, v)
	}
	return &p, rows.Err()
}

func (p *wbProduct) price() int64 {
	if p.WBPrice.Valid && p.WBPrice.Int64 > 0 {
		return p.WBPrice.Int64
	}
	return p.PriceUZS
}

func (p *wbProduct) description() string {
	if p.DescFromSite {
		return plainText(p.Description)
	}
	return strings.TrimSpace(p.WBDesc)
}

// sizeless: one row named «Yagona» (or «—») is a product without sizes.
func wbSizeless(size string) bool {
	switch strings.ToLower(strings.TrimSpace(size)) {
	case "", "—", "-", "yagona", "0", "one size", "onesize":
		return true
	}
	return false
}

var reMdLink = regexp.MustCompile(`!?\[([^\]]*)\]\([^)]*\)`)
var reMdMarks = regexp.MustCompile(`(?m)^\s{0,3}(#{1,6}\s+|>\s?|[-*+]\s+|\d+\.\s+)|[*_~` + "`" + `]{1,3}`)

// plainText strips Markdown for WB (descriptions are plain text there).
func plainText(md string) string {
	t := reMdLink.ReplaceAllString(md, "$1")
	t = reMdMarks.ReplaceAllString(t, "")
	lines := strings.Split(t, "\n")
	for i := range lines {
		lines[i] = strings.TrimRight(lines[i], " \t")
	}
	return strings.TrimSpace(strings.Join(lines, "\n"))
}

// imageURLs are the product photos as public URLs WB can download.
func (s *Server) wbImageURLs(p *wbProduct) ([]string, bool) {
	base := s.Cfg.PublicBaseURL
	if base == "" {
		base = s.Cfg.SiteURL
	}
	out := make([]string, 0, len(p.Images))
	ok := true
	for _, u := range p.Images {
		u = strings.TrimSpace(u)
		switch {
		case u == "":
		case strings.HasPrefix(u, "https://") || strings.HasPrefix(u, "http://"):
			out = append(out, u)
		case strings.HasPrefix(u, "/") && base != "":
			out = append(out, base+u)
		default:
			ok = false
		}
	}
	return out, ok
}

// charValue converts an admin-entered value to the type WB wants for the characteristic.
func charValue(c wb.Charc, v any) (any, bool) {
	var parts []string
	switch x := v.(type) {
	case nil:
	case string:
		for _, s := range strings.Split(x, ",") {
			if s = strings.TrimSpace(s); s != "" {
				parts = append(parts, s)
			}
		}
	case float64:
		parts = []string{strconv.FormatFloat(x, 'f', -1, 64)}
	case json.Number:
		parts = []string{x.String()}
	case []any:
		for _, it := range x {
			if s := strings.TrimSpace(fmt.Sprint(it)); s != "" {
				parts = append(parts, s)
			}
		}
	case []string:
		for _, s := range x {
			if s = strings.TrimSpace(s); s != "" {
				parts = append(parts, s)
			}
		}
	}
	if len(parts) == 0 {
		return nil, false
	}
	if c.CharcType == 4 {
		f, err := strconv.ParseFloat(strings.ReplaceAll(parts[0], ",", "."), 64)
		if err != nil {
			return nil, false
		}
		return f, true
	}
	if c.MaxCount > 0 && len(parts) > c.MaxCount {
		parts = parts[:c.MaxCount]
	}
	return parts, true
}

// wbCheck lists what is missing before the card can go to WB.
func (s *Server) wbCheck(p *wbProduct, charcs []wb.Charc) (missing []string, chars []wb.CharValue) {
	if !p.SubjectID.Valid || p.SubjectID.Int64 <= 0 {
		missing = append(missing, "kategoriya")
	}
	if strings.TrimSpace(p.Brand) == "" {
		missing = append(missing, "brend")
	}
	if strings.TrimSpace(p.VendorCode) == "" {
		missing = append(missing, "sotuvchi artikuli")
	}
	if strings.TrimSpace(p.Title) == "" {
		missing = append(missing, "sarlavha")
	} else if n := len([]rune(p.Title)); n > wbTitleMax {
		missing = append(missing, fmt.Sprintf("sarlavha %d belgidan oshmasin (hozir %d)", wbTitleMax, n))
	}
	if !p.L.Valid || !p.W.Valid || !p.H.Valid || p.L.Int64 <= 0 || p.W.Int64 <= 0 || p.H.Int64 <= 0 {
		missing = append(missing, "qadoq o‘lchami")
	}
	if !p.Wg.Valid || p.Wg.Int64 <= 0 {
		missing = append(missing, "qadoq og‘irligi")
	}
	if p.price() <= 0 {
		missing = append(missing, "WB narxi")
	}
	if len(p.Variants) == 0 {
		missing = append(missing, "o‘lchamlar (o‘lchamsiz mahsulot uchun «Yagona» qatorini qo‘shing)")
	}
	urls, ok := s.wbImageURLs(p)
	if len(urls) == 0 {
		missing = append(missing, "rasm")
	}
	if !ok {
		missing = append(missing, "sayt manzili (PUBLIC_BASE_URL) — WB rasmlarni yuklab olishi uchun")
	}
	given := map[int]any{}
	for _, c := range p.Chars {
		given[c.ID] = c.Value
	}
	for _, c := range charcs {
		if c.CharcType == 0 || c.ExistNamedField {
			continue
		}
		v, ok := charValue(c, given[c.CharcID])
		if ok {
			chars = append(chars, wb.CharValue{ID: c.CharcID, Value: v})
		} else if c.Required {
			missing = append(missing, "«"+c.Name+"»")
		}
	}
	return missing, chars
}

func (p *wbProduct) dims() wb.Dimensions {
	return wb.Dimensions{Length: int(p.L.Int64), Width: int(p.W.Int64), Height: int(p.H.Int64),
		WeightBrutto: math.Round(float64(p.Wg.Int64)) / 1000}
}

func (p *wbProduct) sizes(price int64) []wb.CardSize {
	out := make([]wb.CardSize, 0, len(p.Variants))
	for _, v := range p.Variants {
		sz := wb.CardSize{Price: price}
		if !wbSizeless(v.Size) {
			sz.TechSize, sz.WBSize = strings.TrimSpace(v.Size), strings.TrimSpace(v.WBSize)
		}
		if v.Barcode != "" {
			sz.SKUs = []string{v.Barcode}
		}
		out = append(out, sz)
	}
	return out
}

func hashOf(v any) string {
	b, _ := json.Marshal(v)
	h := sha256.Sum256(b)
	return hex.EncodeToString(h[:12])
}

// cardHash covers what cards/update can change (not price, photos or barcodes).
func (p *wbProduct) cardHash(chars []wb.CharValue) string {
	sizes := p.sizes(0)
	for i := range sizes {
		sizes[i].SKUs = nil
	}
	sort.Slice(chars, func(i, j int) bool { return chars[i].ID < chars[j].ID })
	return hashOf([]any{p.SubjectID.Int64, p.Brand, p.VendorCode, strings.TrimSpace(p.Title), p.description(), p.dims(), chars, sizes})
}

// ---------- worker ----------

// StartWBWorker keeps WB cards in step with the products and pulls prices and stocks.
func (s *Server) StartWBWorker(ctx context.Context) {
	go func() {
		t := time.NewTicker(time.Minute)
		defer t.Stop()
		for {
			s.wbTick(ctx, false)
			select {
			case <-ctx.Done():
				return
			case <-s.wb.wake:
			case <-t.C:
			}
		}
	}()
}

func (s *Server) wbTick(ctx context.Context, forcePull bool) {
	defer func() {
		if r := recover(); r != nil {
			slog.Error("wb worker panic", "panic", r)
		}
	}()
	st, err := s.wbLoad(ctx)
	if err != nil || !st.connected() || st.Problem == "token_invalid" {
		return
	}
	s.wb.mu.Lock()
	defer s.wb.mu.Unlock()
	c := s.wbClient(st)
	sent := 0
	for i := 0; i < wbBatch && ctx.Err() == nil; i++ {
		var id int64
		err := s.DB.QueryRowContext(ctx, `SELECT id FROM products WHERE wb_enabled AND wb_state IN ('queued', 'pending') AND wb_next_try_at <= now()
			ORDER BY wb_next_try_at, id LIMIT 1`).Scan(&id)
		if errors.Is(err, sql.ErrNoRows) {
			break
		}
		if err != nil {
			slog.Warn("wb queue", "err", err)
			return
		}
		stop, did := s.wbProcess(ctx, st, c, id)
		if did {
			sent++
		}
		if stop {
			return
		}
	}
	if sent > 0 {
		_, _ = s.DB.ExecContext(ctx, `UPDATE wb_settings SET last_sync_at = now() WHERE id = 1`)
	}
	if st.PullStocks && (forcePull || !st.LastPullAt.Valid || time.Since(st.LastPullAt.Time) >= wbPullEvery) {
		s.wbPull(ctx, st, c)
	}
}

func (s *Server) wbSetState(ctx context.Context, id int64, state, msg string, next time.Duration) {
	_, _ = s.DB.ExecContext(ctx, `UPDATE products SET wb_state = $2, wb_error = $3, wb_next_try_at = now() + $4 * interval '1 second' WHERE id = $1`,
		id, state, msg, int(next.Seconds()))
}

// wbFail handles a WB error for one product; stop = the worker must pause.
func (s *Server) wbFail(ctx context.Context, p *wbProduct, err error) (stop bool) {
	msg := wbHuman(err)
	if wb.IsAuth(err) {
		s.wbSetProblem(ctx, "token_invalid", msg)
		s.wbLog(ctx, "error", 0, "Token rad etildi — yuborish to‘xtatildi")
		return true
	}
	if wb.IsTransient(err) {
		attempts := p.Attempts + 1
		var e *wb.Error
		if errors.As(err, &e) && (e.Status >= 500 || e.Status == 0) {
			s.wbSetProblem(ctx, "wb_down", msg)
		}
		if attempts >= wbMaxAttempts {
			_, _ = s.DB.ExecContext(ctx, `UPDATE products SET wb_state = 'error', wb_error = $2, wb_attempts = $3 WHERE id = $1`, p.ID, msg, attempts)
			s.wbLog(ctx, "error", p.ID, p.Name+" — "+msg)
			return false
		}
		delay := wbRetryDelays[min(attempts-1, len(wbRetryDelays)-1)]
		if ra := wb.RetryAfter(err); ra > 0 {
			delay = ra
		}
		_, _ = s.DB.ExecContext(ctx, `UPDATE products SET wb_error = $2, wb_attempts = $3, wb_next_try_at = now() + $4 * interval '1 second' WHERE id = $1`,
			p.ID, msg, attempts, int(delay.Seconds()))
		return errors.As(err, &e) && e.Status == 429 // the bucket is held; let the next tick go on
	}
	_, _ = s.DB.ExecContext(ctx, `UPDATE products SET wb_state = 'error', wb_error = $2, wb_attempts = wb_attempts + 1 WHERE id = $1`, p.ID, msg)
	s.wbLog(ctx, "error", p.ID, p.Name+" — rad etildi: "+msg)
	return false
}

// wbProcess sends one product to WB; did = something was sent.
func (s *Server) wbProcess(ctx context.Context, st *wbSettings, c *wb.Client, id int64) (stop, did bool) {
	p, err := s.wbProduct(ctx, id)
	if err != nil {
		return false, false
	}
	if !p.Enabled {
		s.wbSetState(ctx, id, "", "", 0)
		return false, false
	}
	var charcs []wb.Charc
	if p.SubjectID.Valid && p.SubjectID.Int64 > 0 {
		if charcs, err = s.wbCharcs(ctx, c, int(p.SubjectID.Int64)); err != nil {
			return s.wbFail(ctx, p, err), false
		}
	}
	missing, chars := s.wbCheck(p, charcs)
	if len(missing) > 0 {
		s.wbSetState(ctx, id, "incomplete", "To‘ldirilmagan: "+strings.Join(missing, ", "), 0)
		return false, false
	}
	hash := p.cardHash(chars)
	card, err := c.CardByVendorCode(ctx, p.VendorCode)
	if err != nil {
		return s.wbFail(ctx, p, err), false
	}
	if card == nil {
		return s.wbCreate(ctx, c, p, chars, hash)
	}
	// the card exists: link it, then bring it up to date
	if err := s.wbLink(ctx, p, card); err != nil {
		return false, false
	}
	if hash != p.CardHash {
		upd := wb.CardUpdate{NmID: card.NmID, VendorCode: card.VendorCode, Brand: p.Brand, Title: strings.TrimSpace(p.Title),
			Description: p.description(), KizMarked: card.KizMarked, GTIN: card.GTIN, Dimensions: p.dims(), Documents: card.Documents,
			Characteristics: chars, Sizes: mergeSizes(card.Sizes, p.sizes(p.price()))}
		if err := c.Update(ctx, upd); err != nil {
			return s.wbFail(ctx, p, err), false
		}
		_, _ = s.DB.ExecContext(ctx, `UPDATE products SET wb_card_hash = $2 WHERE id = $1`, id, hash)
		if p.CardHash != "" {
			s.wbLog(ctx, "ok", id, p.Name+" — kartochka yangilandi")
		}
		did = true
	}
	urls, _ := s.wbImageURLs(p)
	if mh := hashOf(urls); mh != p.MediaHash {
		if err := c.SaveMedia(ctx, card.NmID, urls); err != nil {
			return s.wbFail(ctx, p, err), did
		}
		_, _ = s.DB.ExecContext(ctx, `UPDATE products SET wb_media_hash = $2 WHERE id = $1`, id, mh)
		did = true
	}
	price := p.price()
	if ph := hashOf([]any{price, p.Discount}); ph != p.PriceHash {
		if err := c.SetPrices(ctx, wb.PriceItem{NmID: card.NmID, Price: price, Discount: p.Discount}); err != nil {
			// a fresh card takes up to 30 min to reach the price service
			var e *wb.Error
			if errors.As(err, &e) && e.Status >= 400 && e.Status < 500 && e.Status != 401 && e.Status != 429 &&
				p.PendingSince.Valid && time.Since(p.PendingSince.Time) < time.Hour {
				_, _ = s.DB.ExecContext(ctx, `UPDATE products SET wb_error = $2, wb_next_try_at = now() + interval '2 minutes' WHERE id = $1`,
					id, "Narx: WB kartochkani hali tayyorlayapti")
				return false, did
			}
			return s.wbFail(ctx, p, err), did
		}
		_, _ = s.DB.ExecContext(ctx, `UPDATE products SET wb_price_hash = $2 WHERE id = $1`, id, ph)
		did = true
	}
	_, _ = s.DB.ExecContext(ctx, `UPDATE products SET wb_state = 'ready', wb_error = '', wb_attempts = 0, wb_pending_since = NULL,
		wb_sent_at = CASE WHEN $2 THEN now() ELSE wb_sent_at END WHERE id = $1`, id, did)
	if p.State == "pending" {
		s.wbLog(ctx, "ok", id, fmt.Sprintf("%s — kartochka tayyor (nm %d)", p.Name, card.NmID))
	}
	s.wbSetProblem(ctx, "", "")
	s.web.notify()
	return false, did
}

// wbCreate sends a new card, or watches one WB is still building.
func (s *Server) wbCreate(ctx context.Context, c *wb.Client, p *wbProduct, chars []wb.CharValue, hash string) (stop, did bool) {
	if p.State == "pending" {
		failed, err := c.FailedCards(ctx)
		if err != nil {
			return s.wbFail(ctx, p, err), false
		}
		// an older refusal of the same article does not count once it was sent again
		if f, ok := failed[strings.ToLower(p.VendorCode)]; ok && len(f.Errors) > 0 &&
			(!p.PendingSince.Valid || f.At.IsZero() || !f.At.Before(p.PendingSince.Time.Add(-time.Minute))) {
			msg := strings.Join(f.Errors, "; ")
			_, _ = s.DB.ExecContext(ctx, `UPDATE products SET wb_state = 'error', wb_error = $2, wb_card_hash = '' WHERE id = $1`, p.ID, msg)
			s.wbLog(ctx, "error", p.ID, p.Name+" — WB kartochkani rad etdi: "+msg)
			return false, false
		}
		if p.PendingSince.Valid && time.Since(p.PendingSince.Time) > wbPendingLimit {
			_, _ = s.DB.ExecContext(ctx, `UPDATE products SET wb_state = 'error', wb_card_hash = '',
				wb_error = 'WB kartochkani 3 soatda yaratmadi — qayta yuboring' WHERE id = $1`, p.ID)
			return false, false
		}
		_, _ = s.DB.ExecContext(ctx, `UPDATE products SET wb_next_try_at = now() + interval '1 minute' WHERE id = $1`, p.ID)
		return false, false
	}
	if p.NmID.Valid && p.NmID.Int64 > 0 {
		_, _ = s.DB.ExecContext(ctx, `UPDATE products SET wb_state = 'error', wb_error = $2 WHERE id = $1`, p.ID,
			fmt.Sprintf("WB’da %s artikulli kartochka topilmadi (nm %d o‘chirilgan yoki artikul o‘zgargan)", p.VendorCode, p.NmID.Int64))
		return false, false
	}
	// barcodes first, so the site keeps the same ones WB gets
	var need []int
	for i, v := range p.Variants {
		if v.Barcode == "" {
			need = append(need, i)
		}
	}
	if len(need) > 0 {
		codes, err := c.Barcodes(ctx, len(need))
		if err != nil {
			return s.wbFail(ctx, p, err), false
		}
		for k, i := range need {
			p.Variants[i].Barcode = codes[k]
			_, _ = s.DB.ExecContext(ctx, `UPDATE product_variants SET barcode = $2 WHERE id = $1 AND barcode = ''`, p.Variants[i].ID, codes[k])
		}
	}
	card := wb.NewCard{VendorCode: p.VendorCode, Brand: p.Brand, Title: strings.TrimSpace(p.Title), Description: p.description(),
		Dimensions: p.dims(), Characteristics: chars, Sizes: p.sizes(p.price())}
	if err := c.Upload(ctx, int(p.SubjectID.Int64), card); err != nil {
		return s.wbFail(ctx, p, err), false
	}
	_, _ = s.DB.ExecContext(ctx, `UPDATE products SET wb_state = 'pending', wb_error = '', wb_attempts = 0, wb_card_hash = $2,
		wb_pending_since = now(), wb_sent_at = now(), wb_next_try_at = now() + interval '1 minute' WHERE id = $1`, p.ID, hash)
	s.wbLog(ctx, "ok", p.ID, p.Name+" — kartochka yuborildi, WB tayyorlayapti")
	return false, true
}

// wbLink stores the card's IDs, size IDs and barcodes on the product.
func (s *Server) wbLink(ctx context.Context, p *wbProduct, card *wb.Card) error {
	if _, err := s.DB.ExecContext(ctx, `UPDATE products SET wb_nm_id = $2, wb_imt_id = $3 WHERE id = $1`, p.ID, card.NmID, card.ImtID); err != nil {
		return err
	}
	for _, v := range p.Variants {
		sz := matchSize(card.Sizes, v)
		if sz == nil {
			continue
		}
		bc := v.Barcode
		if bc == "" && len(sz.SKUs) > 0 {
			bc = sz.SKUs[0]
		}
		_, _ = s.DB.ExecContext(ctx, `UPDATE product_variants SET wb_chrt_id = $2, barcode = $3 WHERE id = $1`, v.ID, sz.ChrtID, bc)
	}
	return nil
}

func matchSize(sizes []wb.CardSize, v wbVariant) *wb.CardSize {
	for i := range sizes {
		if v.ChrtID.Valid && sizes[i].ChrtID == v.ChrtID.Int64 {
			return &sizes[i]
		}
	}
	for i := range sizes {
		if strings.EqualFold(strings.TrimSpace(sizes[i].TechSize), strings.TrimSpace(v.Size)) {
			return &sizes[i]
		}
	}
	if len(sizes) == 1 && wbSizeless(v.Size) {
		return &sizes[0]
	}
	for i := range sizes {
		if v.Barcode != "" && contains(sizes[i].SKUs, v.Barcode) {
			return &sizes[i]
		}
	}
	return nil
}

// mergeSizes keeps WB's size IDs and barcodes (barcodes cannot be removed) and
// the sizes WB has that the product no longer lists (they may hold stock).
func mergeSizes(onWB, mine []wb.CardSize) []wb.CardSize {
	out := make([]wb.CardSize, 0, len(onWB)+len(mine))
	used := map[int]bool{}
	for _, m := range mine {
		idx := -1
		for i, w := range onWB {
			if !used[i] && strings.EqualFold(strings.TrimSpace(w.TechSize), m.TechSize) {
				idx = i
				break
			}
		}
		if idx < 0 && len(onWB) == 1 && len(mine) == 1 {
			idx = 0
		}
		if idx >= 0 {
			used[idx] = true
			w := onWB[idx]
			sz := wb.CardSize{ChrtID: w.ChrtID, TechSize: w.TechSize, WBSize: m.WBSize, SKUs: append([]string{}, w.SKUs...)}
			for _, k := range m.SKUs {
				if !contains(sz.SKUs, k) {
					sz.SKUs = append(sz.SKUs, k)
				}
			}
			out = append(out, sz)
			continue
		}
		out = append(out, m) // a new size: WB wants its price
	}
	for i, w := range onWB {
		if !used[i] {
			out = append(out, wb.CardSize{ChrtID: w.ChrtID, TechSize: w.TechSize, WBSize: w.WBSize, SKUs: w.SKUs})
		}
	}
	return out
}

// ---------- prices and stocks back from WB ----------

func (s *Server) wbPull(ctx context.Context, st *wbSettings, c *wb.Client) {
	type prod struct {
		id     int64
		nm     int64
		status string
		autoOO bool
	}
	rows, err := s.DB.QueryContext(ctx, `SELECT id, wb_nm_id, status, wb_auto_oos FROM products WHERE wb_nm_id IS NOT NULL`)
	if err != nil {
		return
	}
	var prods []prod
	for rows.Next() {
		var p prod
		if rows.Scan(&p.id, &p.nm, &p.status, &p.autoOO) == nil {
			prods = append(prods, p)
		}
	}
	rows.Close()
	defer func() { _, _ = s.DB.ExecContext(ctx, `UPDATE wb_settings SET last_pull_at = now() WHERE id = 1`) }()
	if len(prods) == 0 {
		return
	}
	changed := false
	// prices
	goods, err := c.Prices(ctx)
	if err != nil {
		if wb.IsAuth(err) {
			s.wbSetProblem(ctx, "token_invalid", wbHuman(err))
			return
		}
		s.wbLog(ctx, "warn", 0, "Narxlarni olib bo‘lmadi: "+wbHuman(err))
	} else {
		byNm := map[int64]wb.Goods{}
		for _, g := range goods {
			byNm[g.NmID] = g
			if g.Currency != "" && g.Currency != st.Currency {
				st.Currency = g.Currency
				_, _ = s.DB.ExecContext(ctx, `UPDATE wb_settings SET currency = $1 WHERE id = 1`, g.Currency)
			}
		}
		for _, p := range prods {
			g, ok := byNm[p.nm]
			if !ok || len(g.Sizes) == 0 {
				continue
			}
			res, _ := s.DB.ExecContext(ctx, `UPDATE products SET wb_cur_price = $2, wb_cur_discount = $3, wb_cur_final = $4, wb_pulled_at = now()
				WHERE id = $1 AND (wb_cur_price IS DISTINCT FROM $2 OR wb_cur_discount IS DISTINCT FROM $3 OR wb_cur_final IS DISTINCT FROM $4)`,
				p.id, g.Sizes[0].Price, g.Discount, int64(math.Round(g.Sizes[0].DiscountedPrice)))
			if n, _ := res.RowsAffected(); n > 0 {
				changed = true
			}
		}
	}
	// WB-warehouse stocks
	if st.has("analytics") {
		nms := make([]int64, 0, len(prods))
		for _, p := range prods {
			nms = append(nms, p.nm)
		}
		stocks, err := c.WBStocks(ctx, nms)
		switch {
		case wb.IsForbidden(err):
			s.wbLog(ctx, "warn", 0, "Qoldiq: tokenda «Analitika» ruxsati yo‘q")
		case err != nil:
			s.wbLog(ctx, "warn", 0, "Qoldiqni olib bo‘lmadi: "+wbHuman(err))
		default:
			byChrt := map[int64]int{}
			byNm := map[int64]int{}
			for _, r := range stocks {
				byChrt[r.ChrtID] += r.Quantity
				byNm[r.NmID] += r.Quantity
			}
			for _, p := range prods {
				total := byNm[p.nm]
				res, _ := s.DB.ExecContext(ctx, `UPDATE products SET wb_stock = $2, wb_pulled_at = now() WHERE id = $1 AND wb_stock IS DISTINCT FROM $2`, p.id, total)
				if n, _ := res.RowsAffected(); n > 0 {
					changed = true
				}
				vr, err := s.DB.QueryContext(ctx, `SELECT id, wb_chrt_id FROM product_variants WHERE product_id = $1 AND wb_chrt_id IS NOT NULL`, p.id)
				if err == nil {
					type vv struct{ id, chrt int64 }
					var list []vv
					for vr.Next() {
						var x vv
						if vr.Scan(&x.id, &x.chrt) == nil {
							list = append(list, x)
						}
					}
					vr.Close()
					for _, x := range list {
						res, _ := s.DB.ExecContext(ctx, `UPDATE product_variants SET wb_stock = $2 WHERE id = $1 AND wb_stock IS DISTINCT FROM $2`, x.id, byChrt[x.chrt])
						if n, _ := res.RowsAffected(); n > 0 {
							changed = true
						}
					}
				}
				if st.AutoOOS {
					if total == 0 && p.status == "active" {
						_, _ = s.DB.ExecContext(ctx, `UPDATE products SET status = 'out_of_stock', wb_auto_oos = true WHERE id = $1`, p.id)
						changed = true
					} else if total > 0 && p.autoOO && p.status == "out_of_stock" {
						_, _ = s.DB.ExecContext(ctx, `UPDATE products SET status = 'active', wb_auto_oos = false WHERE id = $1`, p.id)
						changed = true
					}
				}
			}
			s.wbLog(ctx, "ok", 0, fmt.Sprintf("Qoldiq sinxronlandi · %d mahsulot", len(prods)))
		}
	}
	if changed {
		s.web.notify()
	}
	_, _ = s.DB.ExecContext(ctx, `DELETE FROM wb_log WHERE id < (SELECT min(id) FROM (SELECT id FROM wb_log ORDER BY id DESC LIMIT 500) t)`)
}

// ---------- hooks from the CRUD ----------

// wbProductChanged queues a product after a write (the worker skips what WB already has).
func wbProductChanged(s *Server, id int64, old, cur map[string]any) {
	if s.wb == nil {
		return
	}
	ctx := context.Background()
	if cur["wb_enabled"] != true {
		if old != nil && old["wb_enabled"] == true {
			_, _ = s.DB.ExecContext(ctx, `UPDATE products SET wb_state = '', wb_error = '' WHERE id = $1`, id)
		}
		return
	}
	// sensible defaults for a product just switched on
	_, _ = s.DB.ExecContext(ctx, `UPDATE products SET
		wb_vendor_code = CASE WHEN wb_vendor_code = '' THEN left(upper(slug), 72) ELSE wb_vendor_code END,
		wb_title = CASE WHEN wb_title = '' THEN left(name, 60) ELSE wb_title END WHERE id = $1`, id)
	s.wbQueue(ctx, id, false)
}

// wbQueue puts a product in the WB queue; manual = «WB’ga yuborish» (ignores auto_push).
func (s *Server) wbQueue(ctx context.Context, id int64, manual bool) {
	_, _ = s.DB.ExecContext(ctx, `UPDATE products SET wb_state = 'queued', wb_error = '', wb_attempts = 0, wb_next_try_at = now()
		WHERE id = $1 AND wb_enabled AND ($2 OR (SELECT auto_push FROM wb_settings WHERE id = 1))
		AND NOT (wb_state = 'pending' AND NOT $2)`, id, manual)
	s.wb.poke()
}

func wbVariantChanged(s *Server, _ int64, old, cur map[string]any) {
	for _, m := range []map[string]any{cur, old} {
		if m == nil {
			continue
		}
		if pid, ok := m["product_id"].(float64); ok {
			s.wbQueue(context.Background(), int64(pid), false)
			return
		}
	}
}

func wbVariantDeleted(s *Server, id int64, old map[string]any) { wbVariantChanged(s, id, old, nil) }

var reWBVendor = regexp.MustCompile(`^[A-Za-z0-9._/-]{1,72}$`)
