package api

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/sanedidi/unitedmfl/backend/internal/config"
	"github.com/sanedidi/unitedmfl/backend/internal/db"
	"github.com/sanedidi/unitedmfl/backend/internal/wb"
)

// fakeWB is a Wildberries API stand-in: cards are built one «tick» after upload.
type fakeWB struct {
	mu        sync.Mutex
	token     string
	noAnalyt  bool
	cards     map[string]*wb.Card // vendor code → card (visible in cards/list)
	building  []*wb.Card          // uploaded, not built yet
	failed    map[string][]string // vendor code → errors (cards/error/list)
	media     map[int64][]string
	prices    map[int64][2]int64 // nm → price, discount
	stocks    map[int64]int      // chrt → quantity
	nextNm    int64
	nextBC    int
	updates   int
	uploads   int
	priceDown bool // upload/task answers 500
	calls     []string
}

func newFakeWB(token string) *fakeWB {
	return &fakeWB{token: token, cards: map[string]*wb.Card{}, failed: map[string][]string{}, media: map[int64][]string{},
		prices: map[int64][2]int64{}, stocks: map[int64]int{}, nextNm: 900000, nextBC: 1}
}

// build makes the uploaded cards visible (WB builds them asynchronously).
func (f *fakeWB) build() {
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, c := range f.building {
		f.cards[strings.ToLower(c.VendorCode)] = c
	}
	f.building = nil
}

var fakeCharcs = []wb.Charc{
	{CharcID: 14177449, Name: "Цвет", Required: true, CharcType: 1, MaxCount: 3},
	{CharcID: 14177450, Name: "Состав", Required: true, CharcType: 1},
	{CharcID: 89008, Name: "Вес товара без упаковки (г)", CharcType: 4},
	{CharcID: 1, Name: "Наименование", Required: true, CharcType: 1, ExistNamedField: true},
	{CharcID: 2, Name: "Не используется", CharcType: 0},
}

func (f *fakeWB) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls = append(f.calls, r.Method+" "+r.URL.Path)
	reply := func(v any) { json.NewEncoder(w).Encode(v) }
	fail := func(code int, text string) {
		w.WriteHeader(code)
		reply(map[string]any{"title": text, "status": code})
	}
	if r.Header.Get("Authorization") != f.token {
		fail(401, "unauthorized")
		return
	}
	var body map[string]any
	var list []map[string]any
	raw, _ := readAll(r)
	_ = json.Unmarshal(raw, &body)
	_ = json.Unmarshal(raw, &list)
	p := r.URL.Path
	switch {
	case p == "/ping":
		if f.noAnalyt && strings.Contains(r.Header.Get("X-Test-Host"), "analytics") {
			fail(403, "forbidden")
			return
		}
		reply(map[string]string{"Status": "OK"})
	case p == "/api/v1/seller-info":
		reply(map[string]string{"name": "YaTT Mambetov", "sid": "abc-sid", "tradeMark": "United MFL", "country": "UZ"})
	case p == "/content/v2/object/all":
		reply(map[string]any{"data": []wb.Subject{{SubjectID: 192, ParentID: 1, SubjectName: "Футболки", ParentName: "Одежда"}}})
	case strings.HasPrefix(p, "/content/v2/object/charcs/"):
		reply(map[string]any{"data": fakeCharcs})
	case p == "/content/v2/directory/colors":
		reply(map[string]any{"data": []map[string]string{{"name": "черный", "parentName": "черный"}, {"name": "белый"}}})
	case p == "/content/v2/get/cards/list":
		settings, _ := body["settings"].(map[string]any)
		filter, _ := settings["filter"].(map[string]any)
		text, _ := filter["textSearch"].(string)
		out := []wb.Card{}
		for _, c := range f.cards {
			if text == "" || strings.Contains(strings.ToLower(c.VendorCode), strings.ToLower(text)) {
				out = append(out, *c)
			}
		}
		reply(map[string]any{"cards": out, "cursor": map[string]any{"total": len(out)}})
	case p == "/content/v2/cards/error/list":
		items := []map[string]any{}
		for vc, errs := range f.failed {
			items = append(items, map[string]any{"vendorCodes": []string{vc}, "errors": map[string][]string{vc: errs}, "updatedAt": time.Now().UTC().Format(time.RFC3339)})
		}
		reply(map[string]any{"data": map[string]any{"items": items, "cursor": map[string]any{"next": false}}})
	case p == "/content/v2/barcodes":
		n := int(body["count"].(float64))
		var out []string
		for i := 0; i < n; i++ {
			out = append(out, fmt.Sprintf("20434188%05d", f.nextBC))
			f.nextBC++
		}
		reply(map[string]any{"data": out})
	case p == "/content/v2/cards/upload":
		f.uploads++
		for _, g := range list {
			subj := int(g["subjectID"].(float64))
			for _, vr := range g["variants"].([]any) {
				b, _ := json.Marshal(vr)
				var nc wb.NewCard
				json.Unmarshal(b, &nc)
				vc := strings.ToLower(nc.VendorCode)
				if strings.Contains(nc.Title, "BAD") {
					f.failed[vc] = []string{"Поле Наименование не должно содержать запрещенные слова"}
					continue
				}
				delete(f.failed, vc)
				f.nextNm++
				c := &wb.Card{NmID: f.nextNm, ImtID: f.nextNm + 5000, SubjectID: subj, VendorCode: nc.VendorCode, Brand: nc.Brand, Title: nc.Title,
					Description: nc.Description, Dimensions: nc.Dimensions,
					Documents: &wb.Documents{Items: []wb.DocItem{{ID: "doc-1", Type: 2, Number: "ЕАЭС 123"}}}}
				for i, sz := range nc.Sizes {
					sz.ChrtID = f.nextNm*10 + int64(i)
					sz.Price = 0
					c.Sizes = append(c.Sizes, sz)
				}
				f.building = append(f.building, c)
				f.prices[c.NmID] = [2]int64{nc.Sizes[0].Price, 0}
			}
		}
		reply(map[string]any{"data": nil, "error": false})
	case p == "/content/v2/cards/update":
		f.updates++
		for _, it := range list {
			b, _ := json.Marshal(it)
			var u wb.CardUpdate
			json.Unmarshal(b, &u)
			c := f.cards[strings.ToLower(u.VendorCode)]
			if c == nil || c.NmID != u.NmID {
				fail(400, "card not found")
				return
			}
			if u.Documents == nil || len(u.Documents.Items) != 1 {
				fail(400, "documents were dropped")
				return
			}
			for _, old := range c.Sizes { // barcodes cannot be removed
				found := false
				for _, ns := range u.Sizes {
					if ns.ChrtID == old.ChrtID {
						found = true
						for _, k := range old.SKUs {
							if !contains(ns.SKUs, k) {
								fail(400, "barcode removed")
								return
							}
						}
					}
				}
				if !found {
					fail(400, "size removed")
					return
				}
			}
			c.Title, c.Description, c.Brand, c.Dimensions = u.Title, u.Description, u.Brand, u.Dimensions
			for i := range u.Sizes {
				if u.Sizes[i].ChrtID == 0 {
					u.Sizes[i].ChrtID = c.NmID*10 + int64(len(c.Sizes)+i)
				}
			}
			c.Sizes = u.Sizes
		}
		reply(map[string]any{"data": nil, "error": false})
	case p == "/content/v3/media/save":
		nm := int64(body["nmId"].(float64))
		var urls []string
		for _, u := range body["data"].([]any) {
			urls = append(urls, u.(string))
		}
		f.media[nm] = urls
		reply(map[string]any{"data": nil, "error": false})
	case p == "/api/v2/upload/task":
		if f.priceDown {
			fail(500, "internal")
			return
		}
		for _, it := range body["data"].([]any) {
			m := it.(map[string]any)
			f.prices[int64(m["nmID"].(float64))] = [2]int64{int64(m["price"].(float64)), int64(m["discount"].(float64))}
		}
		reply(map[string]any{"data": map[string]any{"id": 1}, "error": false})
	case p == "/api/v2/list/goods/filter":
		goods := []map[string]any{}
		for nm, pr := range f.prices {
			final := float64(pr[0]) * float64(100-pr[1]) / 100
			goods = append(goods, map[string]any{"nmID": nm, "currencyIsoCode4217": "UZS", "discount": pr[1],
				"sizes": []map[string]any{{"sizeID": 1, "price": pr[0], "discountedPrice": final}}})
		}
		reply(map[string]any{"data": map[string]any{"listGoods": goods}})
	case p == "/api/analytics/v1/stocks-report/wb-warehouses":
		items := []map[string]any{}
		for _, c := range f.cards {
			for _, sz := range c.Sizes {
				items = append(items, map[string]any{"nmId": c.NmID, "chrtId": sz.ChrtID, "warehouseId": -999999, "warehouseName": "Склад WB",
					"quantity": f.stocks[sz.ChrtID]})
			}
		}
		reply(map[string]any{"data": map[string]any{"items": items}})
	default:
		fail(404, "no such method: "+p)
	}
}

func readAll(r *http.Request) ([]byte, error) {
	var b bytes.Buffer
	_, err := b.ReadFrom(r.Body)
	return b.Bytes(), err
}

// Wildberries: connect a token, create a card from a product, follow edits
// (update keeps documents and barcodes), send photos and price, pull prices
// and WB-warehouse stocks back, refusals and retries, import from the cabinet.
func TestWildberries(t *testing.T) {
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("TEST_DATABASE_URL not set")
	}
	ctx := context.Background()
	conn, err := db.Open(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	if err := db.Migrate(ctx, conn); err != nil {
		t.Fatal(err)
	}
	for _, q := range []string{`DELETE FROM products WHERE slug LIKE 'wbt-%' OR wb_vendor_code <> ''`, `DELETE FROM wb_log`,
		`UPDATE wb_settings SET token_enc = NULL, scopes = '{}', problem = '', last_error = '', currency = '', last_pull_at = NULL,
		 auto_push = true, pull_stocks = true, auto_out_of_stock = true, link_domain = 'wildberries.uz'`} {
		if _, err := conn.Exec(q); err != nil {
			t.Fatal(err)
		}
	}
	const token = "eyJhbGciOiJFUzI1NiJ9.eyJleHAiOjE4MTAwMDAwMDB9.c2lnbmF0dXJlLXRlc3Q"
	fake := newFakeWB(token)
	srv := httptest.NewServer(fake)
	defer srv.Close()

	s := New(conn, &config.Config{UploadDir: t.TempDir(), WBAPIURL: srv.URL, SiteURL: "https://unitedmfl.uz",
		JWTSecret: []byte("test-secret-test-secret-test-secret!!"), AccessTTL: time.Hour})
	s.wb.lim = wb.NewLimiter(nil)
	h := s.Routes()
	var uid int64
	if err := conn.QueryRow(`INSERT INTO users (name, email, password_hash, role) VALUES ('Admin', 'wb-'||floor(random()*1e9)::text||'@x.uz', 'x', 'admin') RETURNING id`).Scan(&uid); err != nil {
		t.Fatal(err)
	}
	tok, _, _ := s.Tokens.Sign(uid, "admin", "Admin")
	call := func(method, path string, body any, out any) int {
		var b []byte
		if body != nil {
			b, _ = json.Marshal(body)
		}
		req := httptest.NewRequest(method, "/api/v1"+path, bytes.NewReader(b))
		if strings.HasPrefix(path, "/admin") {
			req.Header.Set("Authorization", "Bearer "+tok)
		}
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		if out != nil {
			json.Unmarshal(rec.Body.Bytes(), out)
		}
		if rec.Code >= 300 {
			t.Logf("%s %s → %d %s", method, path, rec.Code, rec.Body.String())
		}
		return rec.Code
	}
	tick := func() {
		time.Sleep(20 * time.Millisecond) // let a background tick from an admin action finish
		s.wbTick(ctx, false)
	}
	type prod struct {
		ID       int64    `json:"id"`
		State    string   `json:"wb_state"`
		Error    string   `json:"wb_error"`
		NmID     *int64   `json:"wb_nm_id"`
		Vendor   string   `json:"wb_vendor_code"`
		Title    string   `json:"wb_title"`
		Status   string   `json:"status"`
		Stock    *int     `json:"wb_stock"`
		CurFinal *int64   `json:"wb_cur_final"`
		Chars    []any    `json:"wb_chars"`
		Images   []string `json:"images"`
	}
	getP := func(id int64) prod {
		var p prod
		if c := call("GET", fmt.Sprintf("/admin/products/%d", id), nil, &p); c != 200 {
			t.Fatalf("product: %d", c)
		}
		return p
	}

	// not connected: categories ask for a token
	if c := call("GET", "/admin/wb/subjects?q=futbolka", nil, nil); c != 409 {
		t.Fatalf("subjects without token: %d", c)
	}
	// token: a wrong one is refused, the right one connects
	if c := call("PUT", "/admin/wb/token", map[string]string{"token": "wrong-token-wrong-token-wrong"}, nil); c != 422 {
		t.Fatalf("wrong token: %d", c)
	}
	var st wbStateView
	if c := call("PUT", "/admin/wb/token", map[string]string{"token": token}, &st); c != 200 || !st.Connected || st.Seller["name"] != "YaTT Mambetov" {
		t.Fatalf("token: %d %+v", c, st)
	}
	if !contains(st.Scopes, "analytics") || st.ExpiresAt == nil || strings.Contains(st.TokenMasked, "c2lnbmF0dXJl") {
		t.Fatalf("scopes / expiry / mask: %+v", st)
	}
	var box []byte
	conn.QueryRow(`SELECT token_enc FROM wb_settings`).Scan(&box)
	if bytes.Contains(box, []byte(token[:20])) {
		t.Fatal("token stored in plain text")
	}

	// categories and characteristics come from WB; named fields are left out
	var subjects []wb.Subject
	if c := call("GET", "/admin/wb/subjects?q=футб", nil, &subjects); c != 200 || len(subjects) != 1 || subjects[0].SubjectID != 192 {
		t.Fatalf("subjects: %d %+v", c, subjects)
	}
	var charcs []wbCharcView
	if c := call("GET", "/admin/wb/subjects/192/charcs", nil, &charcs); c != 200 || len(charcs) != 3 || !charcs[0].Required || charcs[0].Dict != "colors" {
		t.Fatalf("charcs: %d %+v", c, charcs)
	}
	var colors []string
	if c := call("GET", "/admin/wb/directory/colors", nil, &colors); c != 200 || len(colors) != 2 {
		t.Fatalf("colors: %d %v", c, colors)
	}

	// a product switched on with a missing characteristic is «incomplete»
	var p prod
	if c := call("POST", "/admin/products", map[string]any{"slug": "wbt-black", "name": "Futbolka MFL Black", "price_uzs": 259000,
		"images": []string{"/uploads/images/shirt.webp"}, "description": "**Rasmiy** o‘yin futbolkasi", "status": "active", "visible": true,
		"wb_enabled": true, "wb_subject_id": 192, "wb_subject_name": "Футболки", "wb_brand": "United MFL",
		"wb_chars":    []any{map[string]any{"id": 14177449, "name": "Цвет", "value": "черный"}},
		"wb_discount": 8, "pkg_length": 30, "pkg_width": 25, "pkg_height": 3, "pkg_weight_g": 300}, &p); c != 201 {
		t.Fatalf("create: %d", c)
	}
	for _, sz := range []string{"S", "M"} {
		if c := call("POST", "/admin/product-variants", map[string]any{"product_id": p.ID, "size": sz, "wb_size": map[string]string{"S": "44", "M": "46-48"}[sz], "available": true}, nil); c != 201 {
			t.Fatalf("variant: %d", c)
		}
	}
	tick()
	p = getP(p.ID)
	if p.Vendor != "WBT-BLACK" || p.Title != "Futbolka MFL Black" {
		t.Fatalf("defaults: %+v", p)
	}
	if p.State != "incomplete" || !strings.Contains(p.Error, "«Состав»") {
		t.Fatalf("incomplete: %+v", p)
	}
	if fake.uploads != 0 {
		t.Fatal("an incomplete card was sent")
	}

	// filled in → created (barcodes first), pending until WB builds it
	call("PATCH", fmt.Sprintf("/admin/products/%d", p.ID), map[string]any{"wb_chars": []any{
		map[string]any{"id": 14177449, "value": "черный"}, map[string]any{"id": 14177450, "value": "полиэстер 100%"},
		map[string]any{"id": 89008, "value": "180"}}}, nil)
	tick()
	if p = getP(p.ID); p.State != "pending" || fake.uploads != 1 {
		t.Fatalf("pending: %+v uploads=%d", p, fake.uploads)
	}
	var barcodes int
	conn.QueryRow(`SELECT count(*) FROM product_variants WHERE product_id = $1 AND barcode <> ''`, p.ID).Scan(&barcodes)
	if barcodes != 2 {
		t.Fatalf("barcodes: %d", barcodes)
	}
	conn.Exec(`UPDATE products SET wb_next_try_at = now() WHERE id = $1`, p.ID)
	tick() // still building
	if p = getP(p.ID); p.State != "pending" || fake.uploads != 1 {
		t.Fatalf("still pending: %+v", p)
	}
	fake.build()
	conn.Exec(`UPDATE products SET wb_next_try_at = now() WHERE id = $1`, p.ID)
	tick()
	p = getP(p.ID)
	if p.State != "ready" || p.NmID == nil {
		t.Fatalf("ready: %+v", p)
	}
	nm := *p.NmID
	if got := fake.media[nm]; len(got) != 1 || got[0] != "https://unitedmfl.uz/uploads/images/shirt.webp" {
		t.Fatalf("media: %v", got)
	}
	if fake.prices[nm] != [2]int64{259000, 8} {
		t.Fatalf("price: %v", fake.prices[nm])
	}
	if fake.updates != 0 {
		t.Fatal("a fresh card was updated")
	}
	if c := fake.cards["wbt-black"]; c.Description != "Rasmiy o‘yin futbolkasi" {
		t.Fatalf("description sent as markdown: %q", c.Description)
	}
	var chrt int64
	conn.QueryRow(`SELECT wb_chrt_id FROM product_variants WHERE product_id = $1 AND size = 'M'`, p.ID).Scan(&chrt)
	if chrt == 0 {
		t.Fatal("size IDs not linked")
	}

	// saving without changes sends nothing; a new title updates the card (documents and barcodes kept)
	call("PATCH", fmt.Sprintf("/admin/products/%d", p.ID), map[string]any{"featured": true}, nil)
	tick()
	if fake.updates != 0 || len(fake.media) != 1 {
		t.Fatalf("unchanged product was sent: updates=%d", fake.updates)
	}
	call("PATCH", fmt.Sprintf("/admin/products/%d", p.ID), map[string]any{"wb_title": "Futbolka United MFL Black"}, nil)
	call("POST", "/admin/product-variants", map[string]any{"product_id": p.ID, "size": "L", "wb_size": "50", "available": true}, nil)
	tick()
	if p = getP(p.ID); p.State != "ready" || fake.updates != 1 || fake.cards["wbt-black"].Title != "Futbolka United MFL Black" || len(fake.cards["wbt-black"].Sizes) != 3 {
		t.Fatalf("update: %+v updates=%d", p, fake.updates)
	}

	// price service down: retried, then the new price goes
	fake.priceDown = true
	call("PATCH", fmt.Sprintf("/admin/products/%d", p.ID), map[string]any{"wb_price": 279000}, nil)
	tick()
	var attempts int
	conn.QueryRow(`SELECT wb_attempts FROM products WHERE id = $1`, p.ID).Scan(&attempts)
	if p = getP(p.ID); p.State != "queued" || attempts != 1 {
		t.Fatalf("retry: %+v attempts=%d", p, attempts)
	}
	fake.priceDown = false
	conn.Exec(`UPDATE products SET wb_next_try_at = now() WHERE id = $1`, p.ID)
	tick()
	if p = getP(p.ID); p.State != "ready" || fake.prices[nm][0] != 279000 {
		t.Fatalf("price after retry: %+v %v", p, fake.prices[nm])
	}

	// prices and stocks come back; all sizes at 0 → «Tugagan», then back
	fake.mu.Lock()
	for _, sz := range fake.cards["wbt-black"].Sizes {
		fake.stocks[sz.ChrtID] = 0
	}
	fake.stocks[chrt] = 7
	fake.mu.Unlock()
	s.wbTick(ctx, true)
	p = getP(p.ID)
	if p.Stock == nil || *p.Stock != 7 || p.CurFinal == nil || *p.CurFinal != 256680 {
		t.Fatalf("pull: %+v", p)
	}
	var pub struct {
		Product struct {
			Price    int64  `json:"price_uzs"`
			Sale     *int64 `json:"sale_price_uzs"`
			Discount *int   `json:"discount_pct"`
			URL      string `json:"wb_url"`
			Stock    *int   `json:"wb_stock"`
		} `json:"product"`
		Variants []struct {
			Size      string `json:"size"`
			Available bool   `json:"available"`
		} `json:"variants"`
	}
	if c := call("GET", "/products/wbt-black", nil, &pub); c != 200 {
		t.Fatalf("public: %d", c)
	}
	if pub.Product.Price != 279000 || pub.Product.Sale == nil || *pub.Product.Sale != 256680 || pub.Product.Discount == nil || *pub.Product.Discount != 8 {
		t.Fatalf("public price: %+v", pub.Product)
	}
	if pub.Product.URL != fmt.Sprintf("https://wildberries.uz/catalog/%d/detail.aspx", nm) {
		t.Fatalf("public url: %q", pub.Product.URL)
	}
	for _, v := range pub.Variants {
		if v.Available != (v.Size == "M") {
			t.Fatalf("sizes without stock must be off: %+v", pub.Variants)
		}
	}
	fake.mu.Lock()
	fake.stocks[chrt] = 0
	fake.mu.Unlock()
	s.wbTick(ctx, true)
	if p = getP(p.ID); p.Status != "out_of_stock" {
		t.Fatalf("auto out of stock: %+v", p)
	}
	fake.mu.Lock()
	fake.stocks[chrt] = 3
	fake.mu.Unlock()
	s.wbTick(ctx, true)
	if p = getP(p.ID); p.Status != "active" {
		t.Fatalf("back in stock: %+v", p)
	}

	// WB refuses a card: the reason is shown, no retry
	var bad prod
	call("POST", "/admin/products", map[string]any{"slug": "wbt-bad", "name": "Kepka", "price_uzs": 99000, "images": []string{"https://cdn.example/cap.jpg"},
		"wb_enabled": true, "wb_subject_id": 192, "wb_brand": "United MFL", "wb_title": "Kepka BAD", "wb_chars": []any{
			map[string]any{"id": 14177449, "value": "белый"}, map[string]any{"id": 14177450, "value": "хлопок"}},
		"pkg_length": 20, "pkg_width": 20, "pkg_height": 10, "pkg_weight_g": 150}, &bad)
	call("POST", "/admin/product-variants", map[string]any{"product_id": bad.ID, "size": "Yagona", "available": true}, nil)
	tick()
	conn.Exec(`UPDATE products SET wb_next_try_at = now() WHERE id = $1`, bad.ID)
	tick()
	if bad = getP(bad.ID); bad.State != "error" || !strings.Contains(bad.Error, "запрещенные слова") {
		t.Fatalf("refused: %+v", bad)
	}
	// fixed and pushed again → goes through
	call("PATCH", fmt.Sprintf("/admin/products/%d", bad.ID), map[string]any{"wb_title": "Kepka United MFL"}, nil)
	tick()
	fake.build()
	conn.Exec(`UPDATE products SET wb_next_try_at = now() WHERE id = $1`, bad.ID)
	tick()
	if bad = getP(bad.ID); bad.State != "ready" {
		t.Fatalf("after fix: %+v", bad)
	}
	if sz := fake.cards["wbt-bad"].Sizes; len(sz) != 1 || sz[0].TechSize != "" {
		t.Fatalf("one-size product sent with a size: %+v", sz)
	}

	// import: a card made in the WB cabinet becomes a product, nothing is sent back
	fake.mu.Lock()
	fake.cards["mfl-sc-win"] = &wb.Card{NmID: 777001, ImtID: 1, SubjectID: 50, SubjectName: "Шарфы", VendorCode: "MFL-SC-WIN", Brand: "United MFL",
		Title: "Sharf MFL Winter", Photos: []wb.Photo{{Big: "https://basket.wb/1.webp"}}, Dimensions: wb.Dimensions{Length: 20, Width: 15, Height: 5, WeightBrutto: 0.2},
		Sizes:           []wb.CardSize{{ChrtID: 777001000, SKUs: []string{"2040000000001"}}},
		Characteristics: []wb.CardChar{{ID: 14177449, Name: "Цвет", Value: []any{"черный"}}, {ID: 14177450, Name: "Состав", Value: []any{"акрил"}}}}
	fake.prices[777001] = [2]int64{159000, 0}
	fake.mu.Unlock()
	var imp struct {
		Total int            `json:"total"`
		Items []wbImportItem `json:"items"`
	}
	if c := call("GET", "/admin/wb/import", nil, &imp); c != 200 || len(imp.Items) != 1 || imp.Items[0].NmID != 777001 {
		t.Fatalf("import list: %d %+v", c, imp)
	}
	var created struct {
		Created []int64 `json:"created"`
	}
	if c := call("POST", "/admin/wb/import", map[string]any{"nm_ids": []int64{777001}}, &created); c != 200 || len(created.Created) != 1 {
		t.Fatalf("import: %d %+v", c, created)
	}
	updates, mediaCalls := fake.updates, len(fake.media)
	tick()
	sc := getP(created.Created[0])
	if sc.State != "ready" || sc.NmID == nil || *sc.NmID != 777001 || sc.Status != "active" || len(sc.Images) != 1 {
		t.Fatalf("imported: %+v", sc)
	}
	if fake.media[777001] != nil || len(fake.media) != mediaCalls || fake.prices[777001][0] != 159000 {
		t.Fatalf("import sent photos or price back")
	}
	_ = updates
	if c := call("GET", "/admin/wb/import", nil, &imp); c != 200 || len(imp.Items) != 0 {
		t.Fatalf("imported card still offered: %+v", imp)
	}

	// a revoked token stops the worker and shows the problem
	fake.mu.Lock()
	fake.token = "revoked"
	fake.mu.Unlock()
	call("PATCH", fmt.Sprintf("/admin/products/%d", p.ID), map[string]any{"wb_discount": 10}, nil)
	tick()
	if c := call("GET", "/admin/wb", nil, &st); c != 200 || st.Problem != "token_invalid" {
		t.Fatalf("revoked token: %+v", st)
	}
	if st.Counts["cards"] < 3 || len(st.Log) == 0 {
		t.Fatalf("counts / log: %+v", st)
	}
	// disconnected: the site falls back to its own price and no WB button
	call("DELETE", "/admin/wb/token", nil, nil)
	call("GET", "/products/wbt-black", nil, &pub)
	if pub.Product.URL != "" || pub.Product.Price != 259000 {
		t.Fatalf("after disconnect: %+v", pub.Product)
	}
}
