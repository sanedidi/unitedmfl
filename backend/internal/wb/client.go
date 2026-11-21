// Package wb is a small client for the Wildberries seller API: product cards
// (Content), photos, prices and WB-warehouse stocks (Analytics).
//
// Requests are spaced per API category to stay inside WB's per-seller limits
// (see Gaps); a 429 answer carries the wait WB asked for.
package wb

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Hosts are the API domains, one per category.
type Hosts struct {
	Content   string // cards, photos, categories
	Prices    string // prices and discounts
	Analytics string // WB-warehouse stocks
	Common    string // seller info
}

// DefaultHosts are the production domains.
func DefaultHosts() Hosts {
	return Hosts{
		Content:   "https://content-api.wildberries.ru",
		Prices:    "https://discounts-prices-api.wildberries.ru",
		Analytics: "https://seller-analytics-api.wildberries.ru",
		Common:    "https://common-api.wildberries.ru",
	}
}

// HostsFrom sends every category to one base URL (tests, a proxy).
func HostsFrom(base string) Hosts {
	base = strings.TrimRight(base, "/")
	return Hosts{Content: base, Prices: base, Analytics: base, Common: base}
}

// Request buckets with their own limits.
const (
	bContent      = "content"       // most Content methods: 100 / min
	bContentWrite = "content_write" // card create / update: 10 / min
	bContentErr   = "content_err"   // failed cards list: 8 / min
	bMedia        = "media"         // photos: 100 / min
	bPrices       = "prices"        // 10 / 6 s
	bAnalytics    = "analytics"     // stocks report: 3 / min
	bCommon       = "common"        // seller info: 1 / min (burst 10)
	bPing         = "ping"          // 3 / 30 s per domain
)

// Gaps is the pause kept between two requests of one bucket.
func Gaps() map[string]time.Duration {
	return map[string]time.Duration{
		bContent: 600 * time.Millisecond, bContentWrite: 6 * time.Second, bContentErr: 7500 * time.Millisecond,
		bMedia: 600 * time.Millisecond, bPrices: 600 * time.Millisecond, bAnalytics: 20 * time.Second,
		bCommon: 0, bPing: 0,
	}
}

// Limiter spaces requests per bucket; one per process (all clients share the seller's limits).
type Limiter struct {
	mu   sync.Mutex
	gap  map[string]time.Duration
	next map[string]time.Time
}

func NewLimiter(gaps map[string]time.Duration) *Limiter {
	return &Limiter{gap: gaps, next: map[string]time.Time{}}
}

func (l *Limiter) wait(ctx context.Context, bucket string) error {
	if l == nil {
		return nil
	}
	l.mu.Lock()
	now := time.Now()
	at := l.next[bucket]
	if at.Before(now) {
		at = now
	}
	l.next[bucket] = at.Add(l.gap[bucket])
	l.mu.Unlock()
	if d := time.Until(at); d > 0 {
		t := time.NewTimer(d)
		defer t.Stop()
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-t.C:
		}
	}
	return nil
}

// hold pushes the next request of a bucket back (after a 429).
func (l *Limiter) hold(bucket string, d time.Duration) {
	if l == nil || d <= 0 {
		return
	}
	l.mu.Lock()
	if at := time.Now().Add(d); at.After(l.next[bucket]) {
		l.next[bucket] = at
	}
	l.mu.Unlock()
}

// Error is a WB answer other than 2xx, or an envelope with error=true.
type Error struct {
	Status     int
	Text       string
	RetryAfter time.Duration
}

func (e *Error) Error() string {
	if e.Text == "" {
		return fmt.Sprintf("WB: HTTP %d", e.Status)
	}
	return e.Text
}

// IsAuth: the token is wrong, revoked or expired.
func IsAuth(err error) bool {
	var e *Error
	return errors.As(err, &e) && e.Status == http.StatusUnauthorized
}

// IsForbidden: the token has no access to this API category.
func IsForbidden(err error) bool {
	var e *Error
	return errors.As(err, &e) && e.Status == http.StatusForbidden
}

// IsTransient: worth retrying later (WB busy, limit, network).
func IsTransient(err error) bool {
	var e *Error
	if errors.As(err, &e) {
		return e.Status == http.StatusTooManyRequests || e.Status >= 500 || e.Status == 0
	}
	return err != nil && !errors.Is(err, context.Canceled)
}

// RetryAfter is the wait WB asked for (429), if any.
func RetryAfter(err error) time.Duration {
	var e *Error
	if errors.As(err, &e) {
		return e.RetryAfter
	}
	return 0
}

// Client talks to the WB API with one token.
type Client struct {
	token string
	hosts Hosts
	hc    *http.Client
	lim   *Limiter
}

func New(token string, hosts Hosts, lim *Limiter) *Client {
	return &Client{token: token, hosts: hosts, hc: &http.Client{Timeout: 60 * time.Second}, lim: lim}
}

func (c *Client) do(ctx context.Context, bucket, method, rawURL string, in, out any) error {
	if err := c.lim.wait(ctx, bucket); err != nil {
		return err
	}
	var body io.Reader
	if in != nil {
		b, err := json.Marshal(in)
		if err != nil {
			return err
		}
		body = bytes.NewReader(b)
	}
	req, err := http.NewRequestWithContext(ctx, method, rawURL, body)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", c.token)
	req.Header.Set("Accept", "application/json")
	if in != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	res, err := c.hc.Do(req)
	if err != nil {
		return &Error{Status: 0, Text: "WB javob bermadi: " + err.Error()}
	}
	defer res.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(res.Body, 32<<20))
	if res.StatusCode < 200 || res.StatusCode > 299 {
		e := &Error{Status: res.StatusCode, Text: errText(raw)}
		if res.StatusCode == http.StatusTooManyRequests {
			e.RetryAfter = retryAfter(res.Header)
			c.lim.hold(bucket, e.RetryAfter)
		}
		if e.Text == "" {
			e.Text = fmt.Sprintf("WB: HTTP %d", res.StatusCode)
		}
		return e
	}
	// Content answers {data, error, errorText, additionalErrors}
	var env struct {
		Error     bool            `json:"error"`
		ErrorText string          `json:"errorText"`
		Extra     json.RawMessage `json:"additionalErrors"`
	}
	if json.Unmarshal(raw, &env) == nil && env.Error {
		t := env.ErrorText
		if x := extraText(env.Extra); x != "" {
			t = strings.TrimSpace(t + ": " + x)
		}
		return &Error{Status: http.StatusBadRequest, Text: t}
	}
	if out != nil && len(raw) > 0 {
		if err := json.Unmarshal(raw, out); err != nil {
			return fmt.Errorf("WB javobini o‘qib bo‘lmadi: %w", err)
		}
	}
	return nil
}

func retryAfter(h http.Header) time.Duration {
	for _, k := range []string{"X-Ratelimit-Retry", "Retry-After", "X-Ratelimit-Reset"} {
		if v := h.Get(k); v != "" {
			if n, err := strconv.ParseFloat(v, 64); err == nil && n > 0 {
				return time.Duration(n * float64(time.Second))
			}
		}
	}
	return 10 * time.Second
}

// errText digs a readable message out of a WB error body.
func errText(raw []byte) string {
	var m map[string]json.RawMessage
	if json.Unmarshal(raw, &m) != nil {
		s := strings.TrimSpace(string(raw))
		if len(s) > 300 {
			s = s[:300]
		}
		return s
	}
	var parts []string
	for _, k := range []string{"errorText", "title", "detail", "message", "error"} {
		var s string
		if json.Unmarshal(m[k], &s) == nil && s != "" && !contains(parts, s) {
			parts = append(parts, s)
		}
	}
	if x := extraText(m["additionalErrors"]); x != "" {
		parts = append(parts, x)
	}
	return strings.Join(parts, ": ")
}

func extraText(raw json.RawMessage) string {
	if len(raw) == 0 || string(raw) == "null" {
		return ""
	}
	var s string
	if json.Unmarshal(raw, &s) == nil {
		return s
	}
	var m map[string]any
	if json.Unmarshal(raw, &m) == nil {
		var out []string
		for k, v := range m {
			out = append(out, fmt.Sprintf("%s: %v", k, v))
		}
		return strings.Join(out, "; ")
	}
	return ""
}

func contains(list []string, s string) bool {
	for _, x := range list {
		if x == s {
			return true
		}
	}
	return false
}

// TokenExpiry reads exp from a WB token (a JWT); zero when it cannot.
func TokenExpiry(token string) time.Time {
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return time.Time{}
	}
	b, err := base64.RawURLEncoding.DecodeString(strings.TrimRight(parts[1], "="))
	if err != nil {
		return time.Time{}
	}
	var p struct {
		Exp int64 `json:"exp"`
	}
	if json.Unmarshal(b, &p) != nil || p.Exp == 0 {
		return time.Time{}
	}
	return time.Unix(p.Exp, 0)
}

// ---------- token check ----------

// Ping checks the token against one API category; host is one of Hosts.
func (c *Client) Ping(ctx context.Context, host string) error {
	return c.do(ctx, bPing, http.MethodGet, host+"/ping", nil, nil)
}

type SellerInfo struct {
	Name      string `json:"name"`
	SID       string `json:"sid"`
	TIN       string `json:"tin"`
	TradeMark string `json:"tradeMark"`
	Country   string `json:"country"`
}

func (c *Client) SellerInfo(ctx context.Context) (SellerInfo, error) {
	var out SellerInfo
	err := c.do(ctx, bCommon, http.MethodGet, c.hosts.Common+"/api/v1/seller-info", nil, &out)
	return out, err
}

func (c *Client) Hosts() Hosts { return c.hosts }

// ---------- categories ----------

type Subject struct {
	SubjectID   int    `json:"subjectID"`
	ParentID    int    `json:"parentID"`
	SubjectName string `json:"subjectName"`
	ParentName  string `json:"parentName"`
}

// Subjects finds WB subjects (categories) by name.
func (c *Client) Subjects(ctx context.Context, name string, limit int) ([]Subject, error) {
	q := url.Values{"locale": {"ru"}, "limit": {strconv.Itoa(limit)}}
	if name != "" {
		q.Set("name", name)
	}
	var out struct {
		Data []Subject `json:"data"`
	}
	err := c.do(ctx, bContent, http.MethodGet, c.hosts.Content+"/content/v2/object/all?"+q.Encode(), nil, &out)
	return out.Data, err
}

// Charc is one characteristic of a subject.
type Charc struct {
	CharcID         int    `json:"charcID"`
	SubjectID       int    `json:"subjectID"`
	Name            string `json:"name"`
	Required        bool   `json:"required"`
	UnitName        string `json:"unitName"`
	MaxCount        int    `json:"maxCount"`
	Popular         bool   `json:"popular"`
	CharcType       int    `json:"charcType"` // 1 strings, 4 number, 0 unused
	ExistNamedField bool   `json:"existNamedField"`
}

func (c *Client) Charcs(ctx context.Context, subjectID int) ([]Charc, error) {
	var out struct {
		Data []Charc `json:"data"`
	}
	err := c.do(ctx, bContent, http.MethodGet, fmt.Sprintf("%s/content/v2/object/charcs/%d?locale=ru", c.hosts.Content, subjectID), nil, &out)
	return out.Data, err
}

// Directory returns the allowed values of colors, countries, kinds (gender) or seasons.
func (c *Client) Directory(ctx context.Context, name string) ([]string, error) {
	var out struct {
		Data []json.RawMessage `json:"data"`
	}
	if err := c.do(ctx, bContent, http.MethodGet, fmt.Sprintf("%s/content/v2/directory/%s?locale=ru", c.hosts.Content, name), nil, &out); err != nil {
		return nil, err
	}
	vals := make([]string, 0, len(out.Data))
	for _, r := range out.Data {
		var s string
		if json.Unmarshal(r, &s) == nil {
			vals = append(vals, s)
			continue
		}
		var o struct {
			Name string `json:"name"`
		}
		if json.Unmarshal(r, &o) == nil && o.Name != "" {
			vals = append(vals, o.Name)
		}
	}
	return vals, nil
}

// ---------- cards ----------

type Dimensions struct {
	Length       int     `json:"length"`
	Width        int     `json:"width"`
	Height       int     `json:"height"`
	WeightBrutto float64 `json:"weightBrutto"`
}

type CharValue struct {
	ID    int `json:"id"`
	Value any `json:"value"` // []string or a number
}

type CardSize struct {
	ChrtID   int64    `json:"chrtID,omitempty"`
	TechSize string   `json:"techSize,omitempty"`
	WBSize   string   `json:"wbSize,omitempty"`
	Price    int64    `json:"price,omitempty"`
	SKUs     []string `json:"skus,omitempty"`
}

type Photo struct {
	Big string `json:"big"`
}

type DocItem struct {
	ID            string `json:"id,omitempty"`
	Type          int    `json:"type"`
	Number        string `json:"number,omitempty"`
	ProductNumber string `json:"productNumber,omitempty"`
	TradeName     string `json:"tradeName,omitempty"`
	Applicant     string `json:"applicant,omitempty"`
	StartDate     string `json:"startDate,omitempty"`
	EndDate       string `json:"endDate,omitempty"`
	IsEndless     bool   `json:"isEndless,omitempty"`
}

type Documents struct {
	Items            []DocItem `json:"items,omitempty"`
	ExcludeDocuments bool      `json:"excludeDocuments,omitempty"`
}

// CardChar is a characteristic as WB lists it.
type CardChar struct {
	ID    int    `json:"id"`
	Name  string `json:"name"`
	Value any    `json:"value"`
}

// Card is a product card as WB lists it.
type Card struct {
	NmID            int64      `json:"nmID"`
	ImtID           int64      `json:"imtID"`
	SubjectID       int        `json:"subjectID"`
	SubjectName     string     `json:"subjectName"`
	VendorCode      string     `json:"vendorCode"`
	Brand           string     `json:"brand"`
	Title           string     `json:"title"`
	Description     string     `json:"description"`
	KizMarked       bool       `json:"kizMarked"`
	GTIN            string     `json:"gtin"`
	Photos          []Photo    `json:"photos"`
	Dimensions      Dimensions `json:"dimensions"`
	Documents       *Documents `json:"documents"`
	Characteristics []CardChar `json:"characteristics"`
	Sizes           []CardSize `json:"sizes"`
	UpdatedAt       string     `json:"updatedAt"`
}

// NewCard is one card to create (cards/upload, one card per group).
type NewCard struct {
	VendorCode      string      `json:"vendorCode"`
	Brand           string      `json:"brand,omitempty"`
	Title           string      `json:"title"`
	Description     string      `json:"description,omitempty"`
	Dimensions      Dimensions  `json:"dimensions"`
	Characteristics []CharValue `json:"characteristics,omitempty"`
	Sizes           []CardSize  `json:"sizes"`
}

// CardUpdate is a full card for cards/update (anything left out is cleared by WB).
type CardUpdate struct {
	NmID            int64       `json:"nmID"`
	VendorCode      string      `json:"vendorCode"`
	Brand           string      `json:"brand,omitempty"`
	Title           string      `json:"title"`
	Description     string      `json:"description,omitempty"`
	KizMarked       bool        `json:"kizMarked,omitempty"`
	GTIN            string      `json:"gtin,omitempty"`
	Dimensions      Dimensions  `json:"dimensions"`
	Documents       *Documents  `json:"documents,omitempty"`
	Characteristics []CharValue `json:"characteristics,omitempty"`
	Sizes           []CardSize  `json:"sizes"`
}

// Upload creates cards; WB builds them asynchronously (see ErrorList).
func (c *Client) Upload(ctx context.Context, subjectID int, cards ...NewCard) error {
	body := make([]map[string]any, 0, len(cards))
	for _, cd := range cards {
		body = append(body, map[string]any{"subjectID": subjectID, "variants": []NewCard{cd}})
	}
	return c.do(ctx, bContentWrite, http.MethodPost, c.hosts.Content+"/content/v2/cards/upload", body, nil)
}

func (c *Client) Update(ctx context.Context, cards ...CardUpdate) error {
	return c.do(ctx, bContentWrite, http.MethodPost, c.hosts.Content+"/content/v2/cards/update", cards, nil)
}

type cardsPage struct {
	Cards  []Card `json:"cards"`
	Cursor struct {
		UpdatedAt string `json:"updatedAt"`
		NmID      int64  `json:"nmID"`
		Total     int    `json:"total"`
	} `json:"cursor"`
}

func (c *Client) cardsPage(ctx context.Context, text, updatedAt string, nmID int64) (*cardsPage, error) {
	cursor := map[string]any{"limit": 100}
	if updatedAt != "" {
		cursor["updatedAt"], cursor["nmID"] = updatedAt, nmID
	}
	filter := map[string]any{"withPhoto": -1}
	if text != "" {
		filter["textSearch"] = text
	}
	var out cardsPage
	err := c.do(ctx, bContent, http.MethodPost, c.hosts.Content+"/content/v2/get/cards/list?locale=ru",
		map[string]any{"settings": map[string]any{"cursor": cursor, "filter": filter}}, &out)
	return &out, err
}

// CardByVendorCode finds a card by the seller's article; nil when WB has none.
func (c *Client) CardByVendorCode(ctx context.Context, vendorCode string) (*Card, error) {
	p, err := c.cardsPage(ctx, vendorCode, "", 0)
	if err != nil {
		return nil, err
	}
	for i := range p.Cards {
		if strings.EqualFold(p.Cards[i].VendorCode, vendorCode) {
			return &p.Cards[i], nil
		}
	}
	return nil, nil
}

// AllCards lists every card of the seller (up to max).
func (c *Client) AllCards(ctx context.Context, max int) ([]Card, error) {
	var all []Card
	updatedAt, nm := "", int64(0)
	for len(all) < max {
		p, err := c.cardsPage(ctx, "", updatedAt, nm)
		if err != nil {
			return all, err
		}
		all = append(all, p.Cards...)
		if len(p.Cards) < 100 || p.Cursor.UpdatedAt == "" {
			break
		}
		updatedAt, nm = p.Cursor.UpdatedAt, p.Cursor.NmID
	}
	return all, nil
}

// FailedCard is why WB refused to create a card.
type FailedCard struct {
	Errors []string
	At     time.Time
}

// FailedCards maps vendor codes (lower case) of cards WB refused to create to the reasons, newest first.
func (c *Client) FailedCards(ctx context.Context) (map[string]FailedCard, error) {
	var out struct {
		Data struct {
			Items []struct {
				Errors    map[string][]string `json:"errors"`
				UpdatedAt string              `json:"updatedAt"`
			} `json:"items"`
		} `json:"data"`
	}
	err := c.do(ctx, bContentErr, http.MethodPost, c.hosts.Content+"/content/v2/cards/error/list?locale=ru",
		map[string]any{"cursor": map[string]any{"limit": 100}, "order": map[string]any{"ascending": false}}, &out)
	if err != nil {
		return nil, err
	}
	res := map[string]FailedCard{}
	for _, it := range out.Data.Items {
		at, _ := time.Parse(time.RFC3339, it.UpdatedAt)
		for vc, errs := range it.Errors {
			k := strings.ToLower(vc)
			if prev, seen := res[k]; !seen || at.After(prev.At) {
				res[k] = FailedCard{Errors: errs, At: at}
			}
		}
	}
	return res, nil
}

// Barcodes generates n new barcodes.
func (c *Client) Barcodes(ctx context.Context, n int) ([]string, error) {
	var out struct {
		Data []string `json:"data"`
	}
	err := c.do(ctx, bContent, http.MethodPost, c.hosts.Content+"/content/v2/barcodes", map[string]any{"count": n}, &out)
	if err == nil && len(out.Data) < n {
		err = &Error{Status: http.StatusBadGateway, Text: "WB shtrix-kod bermadi"}
	}
	return out.Data, err
}

// SaveMedia replaces the card's photos with the given public URLs (in order).
func (c *Client) SaveMedia(ctx context.Context, nmID int64, urls []string) error {
	return c.do(ctx, bMedia, http.MethodPost, c.hosts.Content+"/content/v3/media/save", map[string]any{"nmId": nmID, "data": urls}, nil)
}

// ---------- prices ----------

type PriceItem struct {
	NmID     int64 `json:"nmID"`
	Price    int64 `json:"price"`
	Discount int   `json:"discount"`
}

// SetPrices uploads prices; WB applies them asynchronously.
func (c *Client) SetPrices(ctx context.Context, items ...PriceItem) error {
	err := c.do(ctx, bPrices, http.MethodPost, c.hosts.Prices+"/api/v2/upload/task", map[string]any{"data": items}, nil)
	var e *Error
	if errors.As(err, &e) && e.Status == 208 { // the same prices are already set
		return nil
	}
	return err
}

type Goods struct {
	NmID       int64  `json:"nmID"`
	VendorCode string `json:"vendorCode"`
	Sizes      []struct {
		SizeID          int64   `json:"sizeID"`
		Price           int64   `json:"price"`
		DiscountedPrice float64 `json:"discountedPrice"`
		TechSizeName    string  `json:"techSizeName"`
	} `json:"sizes"`
	Currency string `json:"currencyIsoCode4217"`
	Discount int    `json:"discount"`
}

// Prices lists the current prices of every card.
func (c *Client) Prices(ctx context.Context) ([]Goods, error) {
	var all []Goods
	for offset := 0; ; offset += 1000 {
		var out struct {
			Data struct {
				ListGoods []Goods `json:"listGoods"`
			} `json:"data"`
		}
		if err := c.do(ctx, bPrices, http.MethodGet, fmt.Sprintf("%s/api/v2/list/goods/filter?limit=1000&offset=%d", c.hosts.Prices, offset), nil, &out); err != nil {
			return all, err
		}
		all = append(all, out.Data.ListGoods...)
		if len(out.Data.ListGoods) < 1000 {
			return all, nil
		}
	}
}

// ---------- stocks ----------

type StockRow struct {
	NmID     int64 `json:"nmId"`
	ChrtID   int64 `json:"chrtId"`
	Quantity int   `json:"quantity"`
}

// WBStocks returns stocks on WB warehouses (FBO) for the given cards; WB refreshes them every 30 min.
func (c *Client) WBStocks(ctx context.Context, nmIDs []int64) ([]StockRow, error) {
	var all []StockRow
	for start := 0; start < len(nmIDs); start += 1000 {
		ids := nmIDs[start:min(start+1000, len(nmIDs))]
		for offset := 0; ; {
			var out struct {
				Data struct {
					Items []StockRow `json:"items"`
				} `json:"data"`
			}
			const limit = 250000
			if err := c.do(ctx, bAnalytics, http.MethodPost, c.hosts.Analytics+"/api/analytics/v1/stocks-report/wb-warehouses",
				map[string]any{"nmIds": ids, "limit": limit, "offset": offset}, &out); err != nil {
				return all, err
			}
			all = append(all, out.Data.Items...)
			if len(out.Data.Items) < limit {
				break
			}
			offset += limit
		}
	}
	return all, nil
}
