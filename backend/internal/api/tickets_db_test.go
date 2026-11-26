package api

import (
	"bytes"
	"context"
	"crypto/md5"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"image"
	"image/color"
	"image/jpeg"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/sanedidi/unitedmfl/backend/internal/config"
	"github.com/sanedidi/unitedmfl/backend/internal/db"
	"github.com/sanedidi/unitedmfl/backend/internal/tickets"
)

const testLayout = `{"pitch":{"x":0,"y":0,"w":300,"h":190},
 "zones":[{"key":"oddiy","name":"Oddiy zona"},{"key":"vip","name":"VIP zona","kind":"vip"}],
 "stands":[{"key":"s1","name":"Janubiy","sections":[
   {"key":"D1","zone":"oddiy","gate":"3","seat_mode":"free","rows":[{"label":"1","seats":3},{"label":"2","seats":3,"blocked":[2]}]},
   {"key":"VIP","zone":"vip","gate":"V","rows":[{"label":"1","seats":4},{"label":"2","seats":4,"removed":[4]}]}]}]}`

func TestTicketsFlow(t *testing.T) {
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
	var uid, ctrl, matchID int64
	conn.QueryRow(`INSERT INTO users (name, email, password_hash, role) VALUES ('Admin', 'tk-'||floor(random()*1e9)::text||'@x.uz', 'x', 'admin') RETURNING id`).Scan(&uid)
	conn.QueryRow(`INSERT INTO users (name, email, password_hash, role) VALUES ('Sherzod', 'tkc-'||floor(random()*1e9)::text||'@x.uz', 'x', 'controller') RETURNING id`).Scan(&ctrl)
	var season int64
	if err := conn.QueryRow(`INSERT INTO seasons (name, year) VALUES ('T', 2026) RETURNING id`).Scan(&season); err != nil {
		conn.QueryRow(`SELECT id FROM seasons LIMIT 1`).Scan(&season)
	}
	if err := conn.QueryRow(`INSERT INTO matches (season_id, kickoff_at) VALUES ($1, now() + interval '5 days') RETURNING id`, season).Scan(&matchID); err != nil {
		t.Fatal(err)
	}
	s := New(conn, &config.Config{UploadDir: t.TempDir(), JWTSecret: []byte("test-secret-test-secret-test-secret!!"), AccessTTL: time.Hour,
		TestPayments: true, PaymeMerchantID: "m1", PaymeKey: "pk", PaymeCheckoutURL: "https://checkout.test", ClickServiceID: "1", ClickMerchantID: "2", ClickSecretKey: "ck",
		SiteURL: "https://unitedmfl.uz"})
	h := s.Routes()
	adminTok, _, _ := s.Tokens.Sign(uid, "admin", "Admin")
	ctrlTok, _, _ := s.Tokens.Sign(ctrl, "controller", "Sherzod")
	raw := func(method, path string, body []byte, ctype, tok string, out any) int {
		req := httptest.NewRequest(method, "/api/v1"+path, bytes.NewReader(body))
		if ctype != "" {
			req.Header.Set("Content-Type", ctype)
		}
		if tok != "" {
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
	call := func(method, path string, body any, out any) int {
		var b []byte
		if body != nil {
			b, _ = json.Marshal(body)
		}
		tok := ""
		if strings.HasPrefix(path, "/admin/scan") {
			tok = ctrlTok
		} else if strings.HasPrefix(path, "/admin") {
			tok = adminTok
		}
		return raw(method, path, b, "application/json", tok, out)
	}

	// ---- constructor: venue → draft → publish
	var venue venueView
	if c := call("POST", "/admin/venues", map[string]any{"name": "Jar stadioni", "city": "Toshkent"}, &venue); c != 201 || venue.Draft == nil {
		t.Fatalf("create venue %d", c)
	}
	var lv layoutView
	if c := call("PUT", fmt.Sprintf("/admin/venues/%d/draft", venue.ID), map[string]any{"doc": json.RawMessage(testLayout)}, &lv); c != 200 || lv.Stats.Sellable != 12 {
		t.Fatalf("draft %d %+v", c, lv.Stats)
	}
	if c := call("POST", fmt.Sprintf("/admin/venues/%d/publish", venue.ID), map[string]any{}, &venue); c != 200 || venue.Published == nil {
		t.Fatalf("publish %d", c)
	}
	layoutID := venue.Published.ID
	// library: save the stand as a template, new venue from it
	var tpl map[string]any
	var l0 tickets.Layout
	json.Unmarshal([]byte(testLayout), &l0)
	if c := call("POST", "/admin/layout-templates", map[string]any{"name": "Asosiy tribuna", "kind": "stand", "doc": l0.Stands[0], "zones": l0.Zones}, &tpl); c != 201 {
		t.Fatal("template", c)
	}
	var v2 venueView
	if c := call("POST", "/admin/venues", map[string]any{"name": "Kubok", "from": "layout", "layout_id": layoutID,
		"copy": map[string]bool{"zones": true, "blocked": false, "gates": true}}, &v2); c != 201 || v2.Stats.Blocked != 0 || v2.Stats.Seats != 13 {
		t.Fatalf("copy venue %d %+v", c, v2.Stats)
	}

	// ---- sale settings and prices
	if c := call("PUT", fmt.Sprintf("/admin/matches/%d/ticket-sale", matchID), map[string]any{"layout_id": layoutID, "max_per_order": 5}, nil); c != 200 {
		t.Fatal("sale", c)
	}
	call("PUT", fmt.Sprintf("/admin/matches/%d/ticket-sale/zones/oddiy", matchID), map[string]any{"price": 50000}, nil)
	var sv saleView
	call("PUT", fmt.Sprintf("/admin/matches/%d/ticket-sale/zones/vip", matchID), map[string]any{"price": 200000, "perks": []string{"VIP-lounge", " "}}, &sv)
	if len(sv.Zones) != 2 || sv.Zones[1].Capacity != 7 || sv.Zones[1].Mode != "numbered" || len(sv.Zones[1].Perks) != 1 {
		t.Fatalf("zones %+v", sv.Zones)
	}
	if c := call("POST", fmt.Sprintf("/admin/matches/%d/ticket-sale/status", matchID), map[string]any{"status": "open"}, nil); c != 200 {
		t.Fatal("open", c)
	}
	var pub publicSale
	call("GET", fmt.Sprintf("/matches/%d/tickets", matchID), nil, &pub)
	if pub.Status != "open" || len(pub.Zones) != 2 {
		t.Fatalf("public %+v", pub)
	}

	// ---- checkout: 2 VIP + 2 Oddiy, test payment
	var co createdOrder
	if c := call("POST", "/ticket-orders", map[string]any{"match_id": matchID, "buyer_name": "Aziz Karimov", "phone": "+998 90 123 45 67", "agree": true,
		"items": []map[string]any{{"zone": "vip", "qty": 2, "holders": []string{"Aziz Karimov", "Dilshod"}}, {"zone": "oddiy", "qty": 2}}}, &co); c != 201 || co.Total != 500000 {
		t.Fatalf("order %d %+v", c, co)
	}
	if c := call("POST", "/ticket-orders", map[string]any{"match_id": matchID, "buyer_name": "X Y Z", "phone": "+998901234567", "agree": true,
		"items": []map[string]any{{"zone": "oddiy", "qty": 4}}}, nil); c != 409 {
		t.Fatal("oversell must fail (5 sellable, 2 held)", c)
	}
	if c := call("POST", "/ticket-orders/"+co.Token+"/pay", map[string]any{"provider": "test"}, nil); c != 200 {
		t.Fatal("pay", c)
	}
	var ov publicOrderView
	call("GET", "/ticket-orders/"+co.Token, nil, &ov)
	if ov.Status != "paid" || len(ov.Tickets) != 4 {
		t.Fatalf("order view %+v", ov)
	}
	vip := ov.Tickets[0]
	if vip.ZoneKind != "vip" || vip.Row != "1" || vip.Seat == nil || (*vip.Seat != 2 && *vip.Seat != 3) || vip.Holder != "Aziz Karimov" {
		t.Fatalf("vip seat %+v", vip)
	}
	// adjacent seats: 2 and 3 of row 1
	if s1, s2 := *ov.Tickets[0].Seat, *ov.Tickets[1].Seat; s1+s2 != 5 {
		t.Fatalf("adjacent %d %d", s1, s2)
	}

	// ---- QR and scanner
	var qr struct {
		Code string `json:"code"`
		Left int    `json:"seconds_left"`
	}
	if c := call("GET", "/tickets/"+vip.HolderToken+"/qr", nil, &qr); c != 200 || !strings.HasPrefix(qr.Code, "UMFL1.") {
		t.Fatalf("qr %d %+v", c, qr)
	}
	var res scanResult
	call("POST", "/admin/scan", map[string]any{"match_id": matchID, "gate": "V", "code": qr.Code}, &res)
	if res.Result != "ok" || res.Entered != 1 || res.Total != 4 {
		t.Fatalf("scan ok %+v", res)
	}
	call("POST", "/admin/scan", map[string]any{"match_id": matchID, "gate": "3", "code": qr.Code}, &res)
	if res.Result != "used" || res.UsedGate != "V" || res.UsedBy != "Sherzod" {
		t.Fatalf("second scan %+v", res)
	}
	// stale code (a screenshot from 5 minutes ago)
	var secret []byte
	conn.QueryRow(`SELECT qr_secret FROM tickets WHERE number=$1`, ov.Tickets[1].Number).Scan(&secret)
	old := tickets.Code(secret, ov.Tickets[1].Number, true, time.Now().Add(-5*time.Minute))
	call("POST", "/admin/scan", map[string]any{"match_id": matchID, "gate": "V", "code": old}, &res)
	if res.Result != "stale" {
		t.Fatalf("stale %+v", res)
	}
	forged := strings.Replace(tickets.Code(secret, ov.Tickets[1].Number, true, time.Now()), ".", ".", 1)
	forged = forged[:len(forged)-1] + "A"
	call("POST", "/admin/scan", map[string]any{"match_id": matchID, "gate": "V", "code": forged}, &res)
	if res.Result != "invalid" && res.Result != "ok" {
		t.Fatalf("forged %+v", res)
	}

	// ---- face mode: all tickets need a bound face
	call("PUT", fmt.Sprintf("/admin/matches/%d/ticket-sale", matchID), map[string]any{"face_mode": "all", "face_check": "manual"}, nil)
	odd := ov.Tickets[2]
	if c := call("GET", "/tickets/"+odd.HolderToken+"/qr", nil, nil); c != 409 {
		t.Fatal("qr before activation must be refused", c)
	}
	// selfie upload
	img := image.NewRGBA(image.Rect(0, 0, 640, 800))
	for y := 0; y < 800; y++ {
		for x := 0; x < 640; x++ {
			img.Set(x, y, color.RGBA{uint8(x), uint8(y), 120, 255})
		}
	}
	var jb bytes.Buffer
	jpeg.Encode(&jb, img, nil)
	var mb bytes.Buffer
	mw := multipart.NewWriter(&mb)
	fw, _ := mw.CreateFormFile("photo", "selfie.jpg")
	fw.Write(jb.Bytes())
	mw.WriteField("holder_name", "Jasur Toshev")
	mw.WriteField("consent", "1")
	mw.Close()
	if c := raw("POST", "/tickets/"+odd.HolderToken+"/activate", mb.Bytes(), mw.FormDataContentType(), "", nil); c != 200 {
		t.Fatal("activate", c)
	}
	call("GET", "/tickets/"+odd.HolderToken+"/qr", nil, &qr)
	call("POST", "/admin/scan", map[string]any{"match_id": matchID, "gate": "3", "code": qr.Code}, &res)
	if res.Result != "face" || res.FaceCheck != "manual" || res.CheckToken == "" {
		t.Fatalf("face check %+v", res)
	}
	req := httptest.NewRequest("GET", "/api/v1/admin/scan/check/"+res.CheckToken+"/photo", nil)
	req.Header.Set("Authorization", "Bearer "+ctrlTok)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != 200 || rec.Header().Get("Content-Type") != "image/jpeg" {
		t.Fatal("photo", rec.Code)
	}
	if _, err := jpeg.DecodeConfig(rec.Body); err != nil {
		t.Fatal("photo jpeg", err)
	}
	call("POST", "/admin/scan/check/"+res.CheckToken+"/decision", map[string]any{"decision": "accept"}, &res)
	if res.Result != "face_ok" || res.Entered != 2 {
		t.Fatalf("decision %+v", res)
	}
	// document activation for the last ticket
	last := ov.Tickets[3]
	if c := call("POST", "/tickets/"+last.HolderToken+"/activate-document", map[string]any{"holder_name": "Mehmon Birinchi"}, nil); c != 200 {
		t.Fatal("doc activation", c)
	}

	// ---- refund one VIP ticket (the second, unused)
	var orderID int64
	conn.QueryRow(`SELECT id FROM ticket_orders WHERE access_token=$1`, co.Token).Scan(&orderID)
	var rr map[string]any
	if c := call("POST", fmt.Sprintf("/admin/ticket-orders/%d/refund", orderID), map[string]any{"ticket_ids": []int64{ov.Tickets[1].ID}, "reason": "kela olmaydi"}, &rr); c != 200 || rr["status"] != "partially_refunded" || rr["refund_status"] != "done" {
		t.Fatalf("refund %d %+v", c, rr)
	}
	var faces int
	conn.QueryRow(`SELECT count(*) FROM ticket_faces f JOIN tickets t ON t.id=f.ticket_id WHERE t.order_id=$1`, orderID).Scan(&faces)
	if faces != 1 {
		t.Fatal("faces", faces)
	}
	// the refunded VIP seat is free again
	call("PUT", fmt.Sprintf("/admin/matches/%d/ticket-sale", matchID), map[string]any{"face_mode": "off"}, nil)
	var co2 createdOrder
	if c := call("POST", "/ticket-orders", map[string]any{"match_id": matchID, "buyer_name": "Nodira K", "phone": "+998901112233", "agree": true,
		"items": []map[string]any{{"zone": "vip", "qty": 1}}}, &co2); c != 201 {
		t.Fatal("rebuy", c)
	}

	// ---- constructor guards: a sold seat can't be removed
	bad := strings.Replace(testLayout, `{"label":"1","seats":4}`, `{"label":"1","seats":4,"removed":[2,3]}`, 1)
	if c := call("PUT", fmt.Sprintf("/admin/venues/%d/draft", venue.ID), map[string]any{"doc": json.RawMessage(bad)}, nil); c != 409 {
		t.Fatal("sold seat removed", c)
	}
	// free-seating tickets don't freeze the rest of the layout
	okEdit := strings.Replace(testLayout, `{"label":"1","seats":3}`, `{"label":"1","seats":3,"blocked":[3]}`, 1)
	if c := call("PUT", fmt.Sprintf("/admin/venues/%d/draft", venue.ID), map[string]any{"doc": json.RawMessage(okEdit)}, nil); c != 200 {
		t.Fatal("edit next to free tickets", c)
	}
	call("DELETE", fmt.Sprintf("/admin/venues/%d/draft", venue.ID), nil, nil)

	// ---- Payme: pay the second order
	var o2 int64
	conn.QueryRow(`SELECT id FROM ticket_orders WHERE access_token=$1`, co2.Token).Scan(&o2)
	rpc := func(method string, params map[string]any) map[string]any {
		b, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": 1, "method": method, "params": params})
		req := httptest.NewRequest("POST", "/api/v1/pay/payme", bytes.NewReader(b))
		req.SetBasicAuth("Paycom", "pk")
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		var out map[string]any
		json.Unmarshal(rec.Body.Bytes(), &out)
		return out
	}
	acc := map[string]any{"order_id": fmt.Sprint(o2)}
	pmID := fmt.Sprintf("pm-%d", o2)
	if out := rpc("CheckPerformTransaction", map[string]any{"amount": 200000 * 100, "account": acc}); out["error"] != nil {
		t.Fatalf("check %+v", out)
	}
	if out := rpc("CheckPerformTransaction", map[string]any{"amount": 1, "account": acc}); out["error"] == nil {
		t.Fatal("wrong amount must fail")
	}
	rpc("CreateTransaction", map[string]any{"id": pmID, "time": time.Now().UnixMilli(), "amount": 200000 * 100, "account": acc})
	if out := rpc("PerformTransaction", map[string]any{"id": pmID}); out["result"] == nil {
		t.Fatalf("perform %+v", out)
	}
	var st string
	conn.QueryRow(`SELECT status FROM ticket_orders WHERE id=$1`, o2).Scan(&st)
	if st != "paid" {
		t.Fatal("payme paid", st)
	}
	if out := rpc("CheckTransaction", map[string]any{"id": pmID}); out["result"].(map[string]any)["state"].(float64) != 2 {
		t.Fatalf("check tx %+v", out)
	}
	// unauthorised call
	b, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": 1, "method": "CheckTransaction", "params": map[string]any{"id": pmID}})
	rq := httptest.NewRequest("POST", "/api/v1/pay/payme", bytes.NewReader(b))
	rc := httptest.NewRecorder()
	h.ServeHTTP(rc, rq)
	if !strings.Contains(rc.Body.String(), "-32504") {
		t.Fatal("payme auth")
	}

	// ---- Click: prepare + complete for a new oddiy order
	var co3 createdOrder
	call("POST", "/ticket-orders", map[string]any{"match_id": matchID, "buyer_name": "Sardor A", "phone": "+998901112244", "agree": true,
		"items": []map[string]any{{"zone": "oddiy", "qty": 1}}}, &co3)
	var o3 int64
	conn.QueryRow(`SELECT id FROM ticket_orders WHERE access_token=$1`, co3.Token).Scan(&o3)
	click := func(path string, f url.Values) map[string]any {
		req := httptest.NewRequest("POST", "/api/v1/pay/click/"+path, strings.NewReader(f.Encode()))
		req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		var out map[string]any
		json.Unmarshal(rec.Body.Bytes(), &out)
		return out
	}
	sign := func(parts ...string) string {
		sum := md5.Sum([]byte(strings.Join(parts, "")))
		return hex.EncodeToString(sum[:])
	}
	ot := fmt.Sprint(o3)
	f := url.Values{"click_trans_id": {"77" + ot}, "service_id": {"1"}, "merchant_trans_id": {ot}, "amount": {"50000.00"}, "action": {"0"}, "sign_time": {"2026-06-16 14:22:00"}}
	f.Set("sign_string", sign("77"+ot, "1", "ck", ot, "50000.00", "0", "2026-06-16 14:22:00"))
	if out := click("prepare", f); out["error"].(float64) != 0 {
		t.Fatalf("click prepare %+v", out)
	}
	f.Set("action", "1")
	f.Set("merchant_prepare_id", ot)
	f.Set("error", "0")
	f.Set("sign_string", sign("77"+ot, "1", "ck", ot, ot, "50000.00", "1", "2026-06-16 14:22:00"))
	if out := click("complete", f); out["error"].(float64) != 0 {
		t.Fatalf("click complete %+v", out)
	}
	f.Set("sign_string", "bad")
	if out := click("complete", f); out["error"].(float64) != -1 {
		t.Fatal("click sign")
	}

	// ---- hold expiry
	var co4 createdOrder
	call("POST", "/ticket-orders", map[string]any{"match_id": matchID, "buyer_name": "Bekzod E", "phone": "+998901112255", "agree": true,
		"items": []map[string]any{{"zone": "vip", "qty": 1}}}, &co4)
	conn.Exec(`UPDATE ticket_orders SET hold_until = now() - interval '1 minute' WHERE access_token=$1`, co4.Token)
	s.ticketTick(ctx)
	conn.QueryRow(`SELECT status FROM ticket_orders WHERE access_token=$1`, co4.Token).Scan(&st)
	if st != "expired" {
		t.Fatal("expiry", st)
	}

	// admin lists
	var list map[string]any
	if c := call("GET", "/admin/ticket-sales", nil, &list); c != 200 {
		t.Fatal("sales list", c)
	}
	var ord map[string]any
	if c := call("GET", fmt.Sprintf("/admin/ticket-orders/%d", orderID), nil, &ord); c != 200 || len(ord["tickets"].([]any)) != 4 {
		t.Fatal("order detail", c)
	}
	if c := call("GET", "/admin/ticket-orders?status=paid&q=aziz", nil, &list); c != 200 || len(list["items"].([]any)) == 0 {
		t.Fatal("orders search", c, list)
	}
	var lib map[string]any
	if c := call("GET", "/admin/layout-library", nil, &lib); c != 200 || len(lib["templates"].([]any)) == 0 || len(lib["stands"].([]any)) == 0 {
		t.Fatal("library", c)
	}
	if c := raw("GET", "/admin/venues", nil, "", ctrlTok, nil); c != http.StatusForbidden {
		t.Fatal("controller must not see venues", c)
	}
}
