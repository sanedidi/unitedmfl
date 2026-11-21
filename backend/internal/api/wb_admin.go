package api

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/lib/pq"

	"github.com/sanedidi/unitedmfl/backend/internal/auth"
	"github.com/sanedidi/unitedmfl/backend/internal/httpx"
	"github.com/sanedidi/unitedmfl/backend/internal/wb"
)

func (s *Server) mountWB(r chi.Router) {
	r.Group(func(r chi.Router) { // connection: administrators only
		r.Use(s.can(auth.PermUsers))
		r.Patch("/wb", s.wbPatch)
		r.Put("/wb/token", s.wbToken)
		r.Delete("/wb/token", s.wbDisconnect)
	})
	r.Group(func(r chi.Router) { // shop work
		r.Use(s.can(auth.PermMerch))
		r.Get("/wb", s.wbState)
		r.Post("/wb/sync", s.wbSyncNow)
		r.Get("/wb/subjects", s.wbSubjects)
		r.Get("/wb/subjects/{id}/charcs", s.wbSubjectCharcs)
		r.Get("/wb/directory/{name}", s.wbDirectoryList)
		r.Post("/wb/products/{id}/push", s.wbPush)
		r.Get("/wb/import", s.wbImportList)
		r.Post("/wb/import", s.wbImport)
	})
}

// ---------- state ----------

type wbLogItem struct {
	At        time.Time `json:"at"`
	Level     string    `json:"level"`
	ProductID *int64    `json:"product_id"`
	Text      string    `json:"text"`
}

type wbStateView struct {
	Connected      bool              `json:"connected"`
	TokenBroken    bool              `json:"token_broken"`
	TokenMasked    string            `json:"token_masked"`
	ExpiresAt      *time.Time        `json:"expires_at"`
	Scopes         []string          `json:"scopes"`
	Seller         map[string]string `json:"seller"`
	Currency       string            `json:"currency"`
	LinkDomain     string            `json:"link_domain"`
	AutoPush       bool              `json:"auto_push"`
	PullStocks     bool              `json:"pull_stocks"`
	AutoOOS        bool              `json:"auto_out_of_stock"`
	Problem        string            `json:"problem"`
	LastError      string            `json:"last_error"`
	LastSyncAt     *time.Time        `json:"last_sync_at"`
	LastPullAt     *time.Time        `json:"last_pull_at"`
	SiteURLMissing bool              `json:"site_url_missing"`
	Counts         map[string]int    `json:"counts"`
	Log            []wbLogItem       `json:"log"`
}

func nullTime(t sql.NullTime) *time.Time {
	if !t.Valid {
		return nil
	}
	return &t.Time
}

func maskWBToken(t string) string {
	if len(t) < 16 {
		return "••••"
	}
	return t[:12] + "••••••••" + t[len(t)-4:]
}

func (s *Server) wbView(ctx context.Context) (*wbStateView, error) {
	st, err := s.wbLoad(ctx)
	if err != nil {
		return nil, err
	}
	v := &wbStateView{Connected: st.connected(), TokenBroken: st.TokenBroken, ExpiresAt: nullTime(st.ExpiresAt), Scopes: st.Scopes,
		Seller:   map[string]string{"name": st.SellerName, "sid": st.SellerSID, "trademark": st.SellerTM, "country": st.SellerCountry},
		Currency: st.Currency, LinkDomain: st.LinkDomain, AutoPush: st.AutoPush, PullStocks: st.PullStocks, AutoOOS: st.AutoOOS,
		Problem: st.Problem, LastError: st.LastError, LastSyncAt: nullTime(st.LastSyncAt), LastPullAt: nullTime(st.LastPullAt),
		SiteURLMissing: s.Cfg.PublicBaseURL == "" && s.Cfg.SiteURL == "", Log: []wbLogItem{}}
	if v.Scopes == nil {
		v.Scopes = []string{}
	}
	if st.Token != "" {
		v.TokenMasked = maskWBToken(st.Token)
	}
	v.Counts = map[string]int{"products": 0, "on_wb": 0, "ready": 0, "queued": 0, "pending": 0, "incomplete": 0, "error": 0, "site_only": 0, "cards": 0}
	rows, err := s.DB.QueryContext(ctx, `SELECT CASE WHEN NOT wb_enabled THEN 'site_only' WHEN wb_state = '' THEN 'queued' ELSE wb_state END, count(*),
		count(*) FILTER (WHERE wb_nm_id IS NOT NULL) FROM products GROUP BY 1`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var k string
		var n, cards int
		if err := rows.Scan(&k, &n, &cards); err != nil {
			return nil, err
		}
		v.Counts[k] += n
		v.Counts["products"] += n
		v.Counts["cards"] += cards
	}
	var onWB int
	_ = s.DB.QueryRowContext(ctx, `SELECT count(*) FROM products WHERE wb_enabled AND wb_nm_id IS NOT NULL AND status = 'active' AND coalesce(wb_stock, 1) > 0`).Scan(&onWB)
	v.Counts["on_wb"] = onWB
	lr, err := s.DB.QueryContext(ctx, `SELECT at, level, product_id, text FROM wb_log ORDER BY id DESC LIMIT 12`)
	if err != nil {
		return nil, err
	}
	defer lr.Close()
	for lr.Next() {
		var it wbLogItem
		if err := lr.Scan(&it.At, &it.Level, &it.ProductID, &it.Text); err != nil {
			return nil, err
		}
		v.Log = append(v.Log, it)
	}
	return v, nil
}

func (s *Server) wbState(w http.ResponseWriter, r *http.Request) {
	v, err := s.wbView(r.Context())
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	httpx.JSON(w, 200, v)
}

var reWBDomain = regexp.MustCompile(`^(www\.)?wildberries\.[a-z]{2,3}$`)

func (s *Server) wbPatch(w http.ResponseWriter, r *http.Request) {
	var in struct {
		AutoPush   *bool   `json:"auto_push"`
		PullStocks *bool   `json:"pull_stocks"`
		AutoOOS    *bool   `json:"auto_out_of_stock"`
		LinkDomain *string `json:"link_domain"`
	}
	if err := httpx.Decode(r, &in); err != nil {
		httpx.Fail(w, r, err)
		return
	}
	sets, args := []string{}, []any{}
	add := func(col string, v any) {
		args = append(args, v)
		sets = append(sets, fmt.Sprintf("%s = $%d", col, len(args)))
	}
	if in.AutoPush != nil {
		add("auto_push", *in.AutoPush)
	}
	if in.PullStocks != nil {
		add("pull_stocks", *in.PullStocks)
	}
	if in.AutoOOS != nil {
		add("auto_out_of_stock", *in.AutoOOS)
	}
	if in.LinkDomain != nil {
		d := strings.ToLower(strings.TrimSpace(*in.LinkDomain))
		if !reWBDomain.MatchString(d) {
			httpx.Fail(w, r, httpx.Validation(map[string]any{"link_domain": "Masalan: wildberries.uz"}))
			return
		}
		add("link_domain", d)
	}
	if len(sets) > 0 {
		if _, err := s.DB.ExecContext(r.Context(), `UPDATE wb_settings SET `+strings.Join(sets, ", ")+`, updated_at = now() WHERE id = 1`, args...); err != nil {
			httpx.Fail(w, r, err)
			return
		}
		s.audit(r, "wb.settings", "wb", 1, in)
	}
	s.wbState(w, r)
}

// ---------- token ----------

func (s *Server) wbToken(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Token string `json:"token"`
	}
	if err := httpx.Decode(r, &in); err != nil {
		httpx.Fail(w, r, err)
		return
	}
	token := strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(in.Token), "Bearer "))
	if len(token) < 20 || strings.ContainsAny(token, " \n\t") {
		httpx.Fail(w, r, httpx.Validation(map[string]any{"token": "Token noto‘g‘ri: WB kabinetidagi tokenni to‘liq nusxalang"}))
		return
	}
	ctx := r.Context()
	c := wb.New(token, s.wb.hosts, s.wb.lim)
	h := c.Hosts()
	// Content and Prices are needed; Analytics brings the stocks back
	if err := c.Ping(ctx, h.Content); err != nil {
		msg := wbHuman(err)
		if wb.IsForbidden(err) {
			msg = "Tokenda «Kontent» ruxsati yo‘q"
		}
		httpx.Fail(w, r, httpx.Validation(map[string]any{"token": msg}))
		return
	}
	scopes := []string{"content"}
	if err := c.Ping(ctx, h.Prices); err != nil {
		httpx.Fail(w, r, httpx.Validation(map[string]any{"token": "Tokenda «Narxlar va chegirmalar» ruxsati yo‘q: " + wbHuman(err)}))
		return
	}
	scopes = append(scopes, "prices")
	if err := c.Ping(ctx, h.Analytics); err == nil {
		scopes = append(scopes, "analytics")
	}
	info, _ := c.SellerInfo(ctx) // optional: shown on the settings page
	box, err := s.wb.seal(token)
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	var exp any
	if t := wb.TokenExpiry(token); !t.IsZero() {
		exp = t
	}
	s.wb.mu.Lock()
	_, err = s.DB.ExecContext(ctx, `UPDATE wb_settings SET token_enc = $1, token_set_at = now(), token_expires_at = $2, scopes = $3,
		seller_name = CASE WHEN $4 = '' THEN seller_name ELSE $4 END, seller_sid = CASE WHEN $5 = '' THEN seller_sid ELSE $5 END,
		seller_trademark = CASE WHEN $6 = '' THEN seller_trademark ELSE $6 END, seller_country = CASE WHEN $7 = '' THEN seller_country ELSE $7 END,
		problem = '', last_error = '', updated_at = now() WHERE id = 1`,
		box, exp, pq.Array(scopes), info.Name, info.SID, info.TradeMark, info.Country)
	s.wb.mu.Unlock()
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	s.audit(r, "wb.token", "wb", 1, map[string]any{"scopes": scopes, "seller": info.Name})
	s.wbLog(ctx, "ok", 0, "Wildberries ulandi"+map[bool]string{true: ": " + info.Name, false: ""}[info.Name != ""])
	// products waiting for a token go now
	_, _ = s.DB.ExecContext(ctx, `UPDATE products SET wb_next_try_at = now() WHERE wb_state IN ('queued', 'pending')`)
	go s.wbTick(context.WithoutCancel(ctx), true)
	s.wbState(w, r)
}

func (s *Server) wbDisconnect(w http.ResponseWriter, r *http.Request) {
	s.wb.mu.Lock()
	_, err := s.DB.ExecContext(r.Context(), `UPDATE wb_settings SET token_enc = NULL, token_set_at = NULL, token_expires_at = NULL, scopes = '{}',
		problem = '', last_error = '', updated_at = now() WHERE id = 1`)
	s.wb.mu.Unlock()
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	s.audit(r, "wb.disconnect", "wb", 1, nil)
	s.wbLog(r.Context(), "warn", 0, "Wildberries uzildi")
	s.web.notify()
	s.wbState(w, r)
}

func (s *Server) wbSyncNow(w http.ResponseWriter, r *http.Request) {
	st, err := s.wbLoad(r.Context())
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	if !st.connected() {
		httpx.Fail(w, r, httpx.BadRequest("Wildberries ulanmagan"))
		return
	}
	if st.Problem != "" {
		s.wbSetProblem(r.Context(), "", "") // try again now
	}
	_, _ = s.DB.ExecContext(r.Context(), `UPDATE products SET wb_next_try_at = now() WHERE wb_state IN ('queued', 'pending')`)
	go s.wbTick(context.WithoutCancel(r.Context()), true)
	s.wbState(w, r)
}

// ---------- categories ----------

func (s *Server) wbConnectedClient(r *http.Request) (*wb.Client, error) {
	st, err := s.wbLoad(r.Context())
	if err != nil {
		return nil, err
	}
	if !st.connected() {
		return nil, httpx.NewError(http.StatusConflict, "wb_not_connected", "Wildberries ulanmagan: Tizim → Wildberries bo‘limida token qo‘shing")
	}
	return s.wbClient(st), nil
}

func (s *Server) wbAPIError(w http.ResponseWriter, r *http.Request, err error) {
	if _, ok := err.(*httpx.Error); ok {
		httpx.Fail(w, r, err)
		return
	}
	httpx.Fail(w, r, httpx.NewError(http.StatusBadGateway, "wb_error", wbHuman(err)))
}

func (s *Server) wbSubjects(w http.ResponseWriter, r *http.Request) {
	c, err := s.wbConnectedClient(r)
	if err != nil {
		s.wbAPIError(w, r, err)
		return
	}
	q := strings.TrimSpace(r.URL.Query().Get("q"))
	if len([]rune(q)) < 2 {
		httpx.JSON(w, 200, []wb.Subject{})
		return
	}
	list, err := c.Subjects(r.Context(), q, 30)
	if err != nil {
		s.wbAPIError(w, r, err)
		return
	}
	if list == nil {
		list = []wb.Subject{}
	}
	httpx.JSON(w, 200, list)
}

type wbCharcView struct {
	ID       int    `json:"id"`
	Name     string `json:"name"`
	Required bool   `json:"required"`
	Unit     string `json:"unit"`
	MaxCount int    `json:"max_count"`
	Number   bool   `json:"number"`
	Popular  bool   `json:"popular"`
	Dict     string `json:"dict"` // colors, kinds, countries, seasons — values come from WB
}

func (s *Server) wbSubjectCharcs(w http.ResponseWriter, r *http.Request) {
	id, err := idParam(r, "id")
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	c, err := s.wbConnectedClient(r)
	if err != nil {
		s.wbAPIError(w, r, err)
		return
	}
	list, err := s.wbCharcs(r.Context(), c, int(id))
	if err != nil {
		s.wbAPIError(w, r, err)
		return
	}
	out := []wbCharcView{}
	for _, ch := range list {
		if ch.CharcType == 0 || ch.ExistNamedField {
			continue // title, brand, description, sizes and dimensions have their own fields
		}
		out = append(out, wbCharcView{ID: ch.CharcID, Name: ch.Name, Required: ch.Required, Unit: ch.UnitName, MaxCount: ch.MaxCount,
			Number: ch.CharcType == 4, Popular: ch.Popular, Dict: wbDirectories[ch.Name]})
	}
	sort.SliceStable(out, func(i, j int) bool {
		if out[i].Required != out[j].Required {
			return out[i].Required
		}
		return out[i].Popular && !out[j].Popular
	})
	httpx.JSON(w, 200, out)
}

func (s *Server) wbDirectoryList(w http.ResponseWriter, r *http.Request) {
	name := chi.URLParam(r, "name")
	switch name {
	case "colors", "kinds", "countries", "seasons":
	default:
		httpx.Fail(w, r, httpx.ErrNotFound)
		return
	}
	c, err := s.wbConnectedClient(r)
	if err != nil {
		s.wbAPIError(w, r, err)
		return
	}
	list, err := s.wbDirectory(r.Context(), c, name)
	if err != nil {
		s.wbAPIError(w, r, err)
		return
	}
	if list == nil {
		list = []string{}
	}
	httpx.JSON(w, 200, list)
}

// wbPush: «WB’ga yuborish» on the product page.
func (s *Server) wbPush(w http.ResponseWriter, r *http.Request) {
	id, err := idParam(r, "id")
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	var enabled bool
	if err := s.DB.QueryRowContext(r.Context(), `SELECT wb_enabled FROM products WHERE id = $1`, id).Scan(&enabled); errors.Is(err, sql.ErrNoRows) {
		httpx.Fail(w, r, httpx.ErrNotFound)
		return
	} else if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	if !enabled {
		httpx.Fail(w, r, httpx.BadRequest("Avval «WB’da sotish»ni yoqing va saqlang"))
		return
	}
	// a manual push sends everything again
	_, _ = s.DB.ExecContext(r.Context(), `UPDATE products SET wb_card_hash = CASE WHEN wb_state = 'pending' THEN wb_card_hash ELSE '' END,
		wb_media_hash = '', wb_price_hash = '' WHERE id = $1`, id)
	s.wbQueue(r.Context(), id, true)
	s.audit(r, "wb.push", "product", id, nil)
	var raw []byte
	if err := s.DB.QueryRowContext(r.Context(), `SELECT row_to_json(t) FROM products t WHERE id = $1`, id).Scan(&raw); err != nil {
		httpx.Fail(w, r, err)
		return
	}
	writeRaw(w, 200, raw)
}

// ---------- import from the WB cabinet ----------

type wbImportItem struct {
	NmID        int64  `json:"nm_id"`
	VendorCode  string `json:"vendor_code"`
	Title       string `json:"title"`
	SubjectName string `json:"subject_name"`
	Photo       string `json:"photo"`
	Sizes       int    `json:"sizes"`
}

// wbNewCards lists WB cards that no product is linked to.
func (s *Server) wbNewCards(ctx context.Context, c *wb.Client) ([]wb.Card, int, error) {
	cards, err := c.AllCards(ctx, 2000)
	if err != nil {
		return nil, 0, err
	}
	known := map[string]bool{}
	rows, err := s.DB.QueryContext(ctx, `SELECT lower(wb_vendor_code), coalesce(wb_nm_id, 0) FROM products`)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()
	for rows.Next() {
		var vc string
		var nm int64
		if err := rows.Scan(&vc, &nm); err != nil {
			return nil, 0, err
		}
		if vc != "" {
			known["v:"+vc] = true
		}
		if nm > 0 {
			known[fmt.Sprint("n:", nm)] = true
		}
	}
	var out []wb.Card
	for _, cd := range cards {
		if !known["v:"+strings.ToLower(cd.VendorCode)] && !known[fmt.Sprint("n:", cd.NmID)] {
			out = append(out, cd)
		}
	}
	return out, len(cards), nil
}

func (s *Server) wbImportList(w http.ResponseWriter, r *http.Request) {
	c, err := s.wbConnectedClient(r)
	if err != nil {
		s.wbAPIError(w, r, err)
		return
	}
	cards, total, err := s.wbNewCards(r.Context(), c)
	if err != nil {
		s.wbAPIError(w, r, err)
		return
	}
	items := make([]wbImportItem, 0, len(cards))
	for _, cd := range cards {
		it := wbImportItem{NmID: cd.NmID, VendorCode: cd.VendorCode, Title: cd.Title, SubjectName: cd.SubjectName, Sizes: len(cd.Sizes)}
		if len(cd.Photos) > 0 {
			it.Photo = cd.Photos[0].Big
		}
		items = append(items, it)
	}
	httpx.JSON(w, 200, map[string]any{"total": total, "items": items})
}

var reSlugChars = regexp.MustCompile(`[^a-z0-9]+`)

func slugFrom(s string) string {
	s = reSlugChars.ReplaceAllString(strings.ToLower(s), "-")
	s = strings.Trim(s, "-")
	if s == "" {
		s = "mahsulot"
	}
	if len(s) > 60 {
		s = strings.Trim(s[:60], "-")
	}
	return s
}

func (s *Server) wbImport(w http.ResponseWriter, r *http.Request) {
	var in struct {
		NmIDs []int64 `json:"nm_ids"`
	}
	if err := httpx.Decode(r, &in); err != nil {
		httpx.Fail(w, r, err)
		return
	}
	if len(in.NmIDs) == 0 {
		httpx.Fail(w, r, httpx.BadRequest("Kartochkalarni tanlang"))
		return
	}
	c, err := s.wbConnectedClient(r)
	if err != nil {
		s.wbAPIError(w, r, err)
		return
	}
	ctx := r.Context()
	s.wb.mu.Lock()
	defer s.wb.mu.Unlock()
	cards, _, err := s.wbNewCards(ctx, c)
	if err != nil {
		s.wbAPIError(w, r, err)
		return
	}
	prices := map[int64]wb.Goods{}
	if goods, err := c.Prices(ctx); err == nil {
		for _, g := range goods {
			prices[g.NmID] = g
		}
	}
	want := map[int64]bool{}
	for _, id := range in.NmIDs {
		want[id] = true
	}
	var created []int64
	for _, cd := range cards {
		if !want[cd.NmID] {
			continue
		}
		id, err := s.wbImportCard(ctx, cd, prices[cd.NmID])
		if err != nil {
			httpx.Fail(w, r, dbError(err))
			return
		}
		created = append(created, id)
	}
	s.audit(r, "wb.import", "product", 0, map[string]any{"nm_ids": in.NmIDs, "created": created})
	if len(created) > 0 {
		s.wbLog(ctx, "ok", 0, fmt.Sprintf("%d ta kartochka WB’dan import qilindi", len(created)))
	}
	httpx.JSON(w, 200, map[string]any{"created": created})
}

func (s *Server) wbImportCard(ctx context.Context, cd wb.Card, g wb.Goods) (int64, error) {
	tx, err := s.DB.BeginTx(ctx, nil)
	if err != nil {
		return 0, err
	}
	defer tx.Rollback()
	base := slugFrom(cd.VendorCode)
	slug := base
	for i := 2; ; i++ {
		var n int
		if err := tx.QueryRowContext(ctx, `SELECT count(*) FROM products WHERE slug = $1`, slug).Scan(&n); err != nil {
			return 0, err
		}
		if n == 0 {
			break
		}
		slug = fmt.Sprintf("%s-%d", base, i)
	}
	var images []string
	for _, ph := range cd.Photos {
		if ph.Big != "" {
			images = append(images, ph.Big)
		}
	}
	chars := make([]wbChar, 0, len(cd.Characteristics))
	for _, ch := range cd.Characteristics {
		chars = append(chars, wbChar{ID: ch.ID, Name: ch.Name, Value: ch.Value})
	}
	var price int64
	status := "hidden" // no price yet: the admin checks it before showing
	if len(g.Sizes) > 0 && g.Sizes[0].Price > 0 {
		price, status = g.Sizes[0].Price, "active"
	}
	name := cd.Title
	if strings.TrimSpace(name) == "" {
		name = cd.VendorCode
	}
	d := cd.Dimensions
	var id int64
	err = tx.QueryRowContext(ctx, `INSERT INTO products (slug, name, category, price_uzs, description, images, status, visible,
		wb_enabled, wb_subject_id, wb_subject_name, wb_brand, wb_vendor_code, wb_title, wb_description, wb_desc_from_site, wb_chars,
		wb_price, wb_discount, pkg_length, pkg_width, pkg_height, pkg_weight_g, wb_nm_id, wb_imt_id, wb_state)
		VALUES ($1, $2, $3, $4, $5, $6, $7, true, true, $8, $9, $10, $11, $12, $5, true, $13, NULLIF($4::bigint, 0), $14,
		NULLIF($15, 0), NULLIF($16, 0), NULLIF($17, 0), NULLIF($18, 0), $19, $20, 'queued') RETURNING id`,
		slug, truncRunes(name, 120), truncRunes(cd.SubjectName, 40), price, cd.Description, pq.Array(images), status,
		cd.SubjectID, cd.SubjectName, cd.Brand, cd.VendorCode, truncRunes(cd.Title, wbTitleMax), jsonText(chars),
		g.Discount, d.Length, d.Width, d.Height, int(d.WeightBrutto*1000+0.5), cd.NmID, cd.ImtID).Scan(&id)
	if err != nil {
		return 0, err
	}
	for _, sz := range cd.Sizes {
		size := sz.TechSize
		if wbSizeless(size) {
			size = "Yagona"
		}
		bc := ""
		if len(sz.SKUs) > 0 {
			bc = sz.SKUs[0]
		}
		if _, err := tx.ExecContext(ctx, `INSERT INTO product_variants (product_id, size, sku, available, wb_size, barcode, wb_chrt_id)
			VALUES ($1, $2, $3, true, $4, $5, $6)`, id, truncRunes(size, 20), truncRunes(cd.VendorCode+"-"+size, 60), sz.WBSize, bc, sz.ChrtID); err != nil {
			return 0, err
		}
	}
	if err := tx.Commit(); err != nil {
		return 0, err
	}
	// mark what WB already has, so the first pass sends nothing back
	if p, err := s.wbProduct(ctx, id); err == nil {
		urls, _ := s.wbImageURLs(p)
		_, chars := s.wbCheckNoCharcs(p)
		_, _ = s.DB.ExecContext(ctx, `UPDATE products SET wb_media_hash = $2, wb_price_hash = $3, wb_card_hash = $4 WHERE id = $1`,
			id, hashOf(urls), hashOf([]any{p.price(), p.Discount}), p.cardHash(chars))
	}
	s.wb.poke()
	return id, nil
}

// wbCheckNoCharcs builds the characteristics as stored (no WB list at hand).
func (s *Server) wbCheckNoCharcs(p *wbProduct) ([]string, []wb.CharValue) {
	var out []wb.CharValue
	for _, ch := range p.Chars {
		typ := 1
		switch ch.Value.(type) {
		case float64:
			typ = 4
		}
		if v, ok := charValue(wb.Charc{CharcID: ch.ID, CharcType: typ}, ch.Value); ok {
			out = append(out, wb.CharValue{ID: ch.ID, Value: v})
		}
	}
	return nil, out
}

func jsonText(v any) string {
	b, _ := json.Marshal(v)
	return string(b)
}

func truncRunes(s string, n int) string {
	r := []rune(strings.TrimSpace(s))
	if len(r) > n {
		r = r[:n]
	}
	return string(r)
}
