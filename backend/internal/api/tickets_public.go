package api

import (
	"bytes"
	"database/sql"
	"errors"
	"image"
	"image/jpeg"
	_ "image/png" // selfies may come as PNG from some browsers
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/sanedidi/unitedmfl/backend/internal/auth"
	"github.com/sanedidi/unitedmfl/backend/internal/httpx"
	"github.com/sanedidi/unitedmfl/backend/internal/tickets"
)

// Public ticket API for the site: zones and prices of a match, checkout,
// the buyer's order page, a single ticket (friend link), face activation and
// the live QR code.

func (s *Server) mountTicketsPublic(r chi.Router) {
	r.Get("/matches/{id}/tickets", s.publicMatchTickets)
	r.With(s.contactLimiter.Middleware).Post("/ticket-orders", s.publicCreateOrder)
	r.Get("/ticket-orders/{token}", s.publicOrder)
	r.Post("/ticket-orders/{token}/pay", s.publicPayOrder)
	r.Post("/ticket-orders/{token}/refund-request", s.publicRefundRequest)
	r.Post("/ticket-orders/{token}/tickets/{id}/share", s.publicShareTicket)
	r.Get("/tickets/{token}", s.publicTicket)
	r.Get("/tickets/{token}/qr", s.publicTicketQR)
	r.With(s.regUploadLimiter.Middleware).Post("/tickets/{token}/activate", s.publicActivateFace)
	r.Post("/tickets/{token}/activate-document", s.publicActivateDocument)
	s.mountPayments(r)
}

type publicSale struct {
	Match       map[string]any `json:"match"`
	Status      string         `json:"status"` // none | soon | open | paused | closed | sold_out
	SaleFrom    *time.Time     `json:"sale_from"`
	SaleTo      *time.Time     `json:"sale_to"`
	Zones       []zonePrice    `json:"zones"`
	Layout      any            `json:"layout"`
	MaxPerOrder int            `json:"max_per_order"`
	HoldMinutes int            `json:"hold_minutes"`
	RefundHours int            `json:"refund_hours"`
	ServiceFee  int64          `json:"service_fee"`
	FaceMode    string         `json:"face_mode"`
	Providers   []string       `json:"providers"`
	Telegram    bool           `json:"telegram_delivery"`
}

func (s *Server) publicMatchTickets(w http.ResponseWriter, r *http.Request) {
	id, err := idParam(r, "id")
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	m, err := s.matchSummary(r, id)
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	out := publicSale{Match: m, Status: "none", Zones: []zonePrice{}, Providers: s.enabledProviders()}
	sale, err := s.saleByMatch(r.Context(), s.DB, id, false)
	if err != nil || sale.Status == "draft" || sale.LayoutID == nil {
		httpx.JSON(w, 200, out)
		return
	}
	l, err := s.saleLayout(r.Context(), s.DB, sale)
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	prices, err := s.salePrices(r.Context(), s.DB, sale, l)
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	left := 0
	for _, p := range prices {
		if p.Enabled && p.Price > 0 {
			out.Zones = append(out.Zones, p)
			left += p.Left
		}
	}
	now := time.Now()
	out.Status = sale.Status
	switch {
	case sale.Status == "open" && sale.SaleFrom != nil && now.Before(*sale.SaleFrom):
		out.Status = "soon"
	case sale.Status == "open" && sale.SaleTo != nil && now.After(*sale.SaleTo):
		out.Status = "closed"
	case sale.Status == "open" && left == 0:
		out.Status = "sold_out"
	}
	// the site draws the map: geometry and zones, without blocked/removed detail
	for i := range l.Stands {
		for j := range l.Stands[i].Sections {
			for k := range l.Stands[i].Sections[j].Rows {
				l.Stands[i].Sections[j].Rows[k].Blocked = nil
			}
		}
	}
	out.Layout = l
	out.SaleFrom, out.SaleTo = sale.SaleFrom, sale.SaleTo
	out.MaxPerOrder, out.HoldMinutes, out.RefundHours = sale.MaxPerOrder, sale.HoldMinutes, sale.RefundHours
	out.ServiceFee, out.FaceMode, out.Telegram = sale.ServiceFee, sale.FaceMode, sale.TelegramDeliv
	w.Header().Set("Cache-Control", "no-store")
	httpx.JSON(w, 200, out)
}

func (s *Server) publicCreateOrder(w http.ResponseWriter, r *http.Request) {
	var in struct {
		MatchID  int64       `json:"match_id"`
		Items    []orderItem `json:"items"`
		Name     string      `json:"buyer_name"`
		Phone    string      `json:"phone"`
		Email    string      `json:"email"`
		Telegram bool        `json:"telegram"`
		Agree    bool        `json:"agree"`
	}
	if err := httpx.Decode(r, &in); err != nil {
		httpx.Fail(w, r, err)
		return
	}
	bad := map[string]any{}
	in.Name = strings.TrimSpace(in.Name)
	if len([]rune(in.Name)) < 3 || len(in.Name) > 120 {
		bad["buyer_name"] = "Ism familiyani kiriting"
	}
	phone, ok := auth.NormalizePhone(in.Phone)
	if !ok {
		bad["phone"] = "Telefon raqami noto‘g‘ri"
	}
	in.Email = strings.TrimSpace(in.Email)
	if in.Email != "" && (!strings.Contains(in.Email, "@") || len(in.Email) > 120) {
		bad["email"] = "Email noto‘g‘ri"
	}
	if !in.Agree {
		bad["agree"] = "Oferta shartlariga rozilik kerak"
	}
	for _, it := range in.Items {
		it.Seats = nil // the site doesn't pick seats (best free seats are assigned)
		for _, h := range it.Holders {
			if len(h) > 120 {
				bad["holders"] = "Ism juda uzun"
			}
		}
	}
	if len(bad) > 0 {
		httpx.Fail(w, r, httpx.Validation(bad))
		return
	}
	for i := range in.Items {
		in.Items[i].Seats = nil
	}
	co, err := s.createOrder(r.Context(), newOrder{MatchID: in.MatchID, Items: in.Items, Name: in.Name, Phone: phone, Email: in.Email,
		Telegram: in.Telegram, Source: "site"})
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	httpx.JSON(w, 201, co)
}

type publicOrderView struct {
	Number         string         `json:"number"`
	Status         string         `json:"status"`
	BuyerName      string         `json:"buyer_name"`
	Phone          string         `json:"phone"`
	Total          int64          `json:"total"`
	ServiceFee     int64          `json:"service_fee"`
	Refunded       int64          `json:"refunded"`
	Provider       string         `json:"provider"`
	CardMask       string         `json:"card_mask"`
	CreatedAt      time.Time      `json:"created_at"`
	PaidAt         *time.Time     `json:"paid_at"`
	HoldUntil      *time.Time     `json:"hold_until"`
	Match          map[string]any `json:"match"`
	Tickets        []ticketView   `json:"tickets"`
	FaceMode       string         `json:"face_mode"`
	ActivateBy     *time.Time     `json:"activate_by"`
	RefundDeadline *time.Time     `json:"refund_deadline"`
	Providers      []string       `json:"providers"`
	Transfer       bool           `json:"transfer_allowed"`
	NoFaceEntry    bool           `json:"no_face_entry"`
}

func (s *Server) orderByToken(r *http.Request, token string) (int64, *publicOrderView, *ticketSale, *tickets.Layout, error) {
	var v publicOrderView
	var id, matchID int64
	var paid, hold sql.NullTime
	err := s.DB.QueryRowContext(r.Context(), `SELECT o.id, o.number, o.status, o.buyer_name, o.phone, o.total, o.service_fee, o.refunded,
		o.provider, o.card_mask, o.created_at, o.paid_at, o.hold_until, ts.match_id
		FROM ticket_orders o JOIN ticket_sales ts ON ts.id=o.sale_id WHERE o.access_token=$1`, token).Scan(&id, &v.Number, &v.Status,
		&v.BuyerName, &v.Phone, &v.Total, &v.ServiceFee, &v.Refunded, &v.Provider, &v.CardMask, &v.CreatedAt, &paid, &hold, &matchID)
	if errors.Is(err, sql.ErrNoRows) || token == "" {
		return 0, nil, nil, nil, httpx.ErrNotFound
	}
	if err != nil {
		return 0, nil, nil, nil, err
	}
	v.PaidAt, v.HoldUntil = nullTime(paid), nullTime(hold)
	v.Phone = maskPhone(v.Phone)
	sale, err := s.saleByMatch(r.Context(), s.DB, matchID, false)
	if err != nil {
		return 0, nil, nil, nil, err
	}
	l, err := s.saleLayout(r.Context(), s.DB, sale)
	if err != nil {
		return 0, nil, nil, nil, err
	}
	prices, _ := s.salePrices(r.Context(), s.DB, sale, l)
	if v.Tickets, err = s.orderTickets(r, id, l, prices, true); err != nil {
		return 0, nil, nil, nil, err
	}
	if v.Match, err = s.matchSummary(r, matchID); err != nil {
		return 0, nil, nil, nil, err
	}
	v.FaceMode, v.Transfer, v.NoFaceEntry = sale.FaceMode, sale.TransferOK, sale.NoFaceEntry
	v.RefundDeadline = refundDeadline(sale, v.Match)
	if k, _ := v.Match["kickoff_at"].(*time.Time); k != nil {
		t := k.Add(-time.Duration(sale.ActivationHrs) * time.Hour)
		v.ActivateBy = &t
	}
	v.Providers = s.enabledProviders()
	return id, &v, sale, l, nil
}

func (s *Server) publicOrder(w http.ResponseWriter, r *http.Request) {
	_, v, _, _, err := s.orderByToken(r, chi.URLParam(r, "token"))
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	httpx.JSON(w, 200, v)
}

// publicPayOrder starts the payment: returns the provider's checkout URL
// (or pays at once with the test provider outside production).
func (s *Server) publicPayOrder(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Provider string `json:"provider"`
		Return   string `json:"return_url"`
	}
	if err := httpx.Decode(r, &in); err != nil {
		httpx.Fail(w, r, err)
		return
	}
	id, v, _, _, err := s.orderByToken(r, chi.URLParam(r, "token"))
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	if v.Status != "pending" {
		httpx.Fail(w, r, httpx.NewError(409, "not_pending", "Buyurtma to‘lovni kutmayapti"))
		return
	}
	if v.HoldUntil != nil && time.Now().After(*v.HoldUntil) {
		httpx.Fail(w, r, httpx.NewError(409, "expired", "Band qilish muddati tugadi — chiptalarni qaytadan tanlang"))
		return
	}
	enabled := false
	for _, p := range s.enabledProviders() {
		if p == in.Provider {
			enabled = true
		}
	}
	if !enabled {
		httpx.Fail(w, r, httpx.BadRequest("To‘lov usuli mavjud emas"))
		return
	}
	ret := s.Cfg.SiteURL + "/chiptalar/" + chi.URLParam(r, "token")
	switch in.Provider {
	case "test":
		if _, err := s.markPaid(r.Context(), s.DB, id, "test", "test-"+randToken(6), "TEST •••• 0000"); err != nil {
			httpx.Fail(w, r, err)
			return
		}
		s.afterPaid(id)
		httpx.JSON(w, 200, map[string]any{"paid": true, "url": ret})
	case "payme":
		_, _ = s.DB.ExecContext(r.Context(), `UPDATE ticket_orders SET provider='payme' WHERE id=$1`, id)
		httpx.JSON(w, 200, map[string]any{"url": s.paymeCheckoutURL(id, v.Total, ret)})
	case "click":
		_, _ = s.DB.ExecContext(r.Context(), `UPDATE ticket_orders SET provider='click' WHERE id=$1`, id)
		httpx.JSON(w, 200, map[string]any{"url": s.clickCheckoutURL(id, v.Total, ret)})
	}
}

func (s *Server) publicRefundRequest(w http.ResponseWriter, r *http.Request) {
	id, v, _, _, err := s.orderByToken(r, chi.URLParam(r, "token"))
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	if v.Status != "paid" {
		httpx.Fail(w, r, httpx.BadRequest("Bu buyurtma uchun qaytarish so‘rovi yuborib bo‘lmaydi"))
		return
	}
	if v.RefundDeadline != nil && time.Now().After(*v.RefundDeadline) {
		httpx.Fail(w, r, httpx.BadRequest("Qaytarish muddati o‘tgan"))
		return
	}
	for _, t := range v.Tickets {
		if t.Status == "used" {
			httpx.Fail(w, r, httpx.BadRequest("Chipta ishlatilgan"))
			return
		}
	}
	if _, err := s.DB.ExecContext(r.Context(), `UPDATE ticket_orders SET status='refund_requested', updated_at=now() WHERE id=$1 AND status='paid'`, id); err != nil {
		httpx.Fail(w, r, err)
		return
	}
	httpx.JSON(w, 200, map[string]any{"ok": true})
}

// publicShareTicket marks a ticket as sent to a friend and returns its link.
func (s *Server) publicShareTicket(w http.ResponseWriter, r *http.Request) {
	oid, v, sale, _, err := s.orderByToken(r, chi.URLParam(r, "token"))
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	tid, err := idParam(r, "id")
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	if !sale.TransferOK {
		httpx.Fail(w, r, httpx.BadRequest("Bu match chiptalarini boshqa odamga o‘tkazib bo‘lmaydi"))
		return
	}
	var tok string
	var activated sql.NullTime
	if err := s.DB.QueryRowContext(r.Context(), `SELECT holder_token, activated_at FROM tickets WHERE id=$1 AND order_id=$2 AND status='active'`, tid, oid).Scan(&tok, &activated); err != nil {
		httpx.Fail(w, r, httpx.ErrNotFound)
		return
	}
	if activated.Valid {
		httpx.Fail(w, r, httpx.BadRequest("Chipta faollashtirilgan — uni boshqa odamga o‘tkazib bo‘lmaydi"))
		return
	}
	var in struct {
		Cancel bool `json:"cancel"`
	}
	_ = httpx.Decode(r, &in)
	if in.Cancel { // a new link: the old one stops working
		tok = randToken(18)
		_, err = s.DB.ExecContext(r.Context(), `UPDATE tickets SET holder_token=$2, transfer_sent_at=NULL WHERE id=$1`, tid, tok)
	} else {
		_, err = s.DB.ExecContext(r.Context(), `UPDATE tickets SET transfer_sent_at=now() WHERE id=$1`, tid)
	}
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	_ = v
	httpx.JSON(w, 200, map[string]any{"url": s.Cfg.SiteURL + "/chipta/" + tok, "token": tok})
}

type ticketCtx struct {
	ID      int64
	OrderID int64
	Sale    *ticketSale
	Layout  *tickets.Layout
	View    ticketView
	Secret  []byte
	Match   map[string]any
	Kickoff *time.Time
}

func (s *Server) ticketByHolder(r *http.Request, token string) (*ticketCtx, error) {
	var tc ticketCtx
	var matchID int64
	var oStatus string
	err := s.DB.QueryRowContext(r.Context(), `SELECT t.id, t.order_id, t.qr_secret, ts.match_id, o.status FROM tickets t
		JOIN ticket_orders o ON o.id=t.order_id JOIN ticket_sales ts ON ts.id=t.sale_id WHERE t.holder_token=$1`, token).
		Scan(&tc.ID, &tc.OrderID, &tc.Secret, &matchID, &oStatus)
	if errors.Is(err, sql.ErrNoRows) || token == "" {
		return nil, httpx.ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	if tc.Sale, err = s.saleByMatch(r.Context(), s.DB, matchID, false); err != nil {
		return nil, err
	}
	if tc.Layout, err = s.saleLayout(r.Context(), s.DB, tc.Sale); err != nil {
		return nil, err
	}
	prices, _ := s.salePrices(r.Context(), s.DB, tc.Sale, tc.Layout)
	all, err := s.orderTickets(r, tc.OrderID, tc.Layout, prices, false)
	if err != nil {
		return nil, err
	}
	for _, t := range all {
		if t.ID == tc.ID {
			tc.View = t
		}
	}
	if tc.Match, err = s.matchSummary(r, matchID); err != nil {
		return nil, err
	}
	tc.Kickoff, _ = tc.Match["kickoff_at"].(*time.Time)
	return &tc, nil
}

func (tc *ticketCtx) faceNeeded() bool {
	return faceRequired(tc.Sale, tc.View.ZoneKind)
}

// ready: the ticket can show its QR (active and, if needed, bound to a face).
func (tc *ticketCtx) ready() bool {
	if tc.View.Status != "active" && tc.View.Status != "used" {
		return false
	}
	return !tc.faceNeeded() || tc.View.FaceStatus != "none"
}

func (s *Server) publicTicket(w http.ResponseWriter, r *http.Request) {
	tc, err := s.ticketByHolder(r, chi.URLParam(r, "token"))
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	var activateBy *time.Time
	if tc.Kickoff != nil {
		t := tc.Kickoff.Add(-time.Duration(tc.Sale.ActivationHrs) * time.Hour)
		activateBy = &t
	}
	w.Header().Set("Cache-Control", "no-store")
	httpx.JSON(w, 200, map[string]any{"ticket": tc.View, "match": tc.Match, "face_required": tc.faceNeeded(),
		"ready": tc.ready(), "activate_by": activateBy, "no_face_entry": tc.Sale.NoFaceEntry, "dynamic_qr": tc.Sale.DynamicQR,
		"retention_days": tc.Sale.FaceRetainDays})
}

func (s *Server) publicTicketQR(w http.ResponseWriter, r *http.Request) {
	tc, err := s.ticketByHolder(r, chi.URLParam(r, "token"))
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	if !tc.ready() {
		httpx.Fail(w, r, httpx.NewError(409, "not_ready", "Avval chiptani faollashtiring"))
		return
	}
	now := time.Now()
	code := tickets.Code(tc.Secret, tc.View.Number, tc.Sale.DynamicQR, now)
	left := 0
	if tc.Sale.DynamicQR {
		win := int64(tickets.Window / time.Second)
		left = int(win - now.Unix()%win)
	}
	w.Header().Set("Cache-Control", "no-store")
	httpx.JSON(w, 200, map[string]any{"code": code, "dynamic": tc.Sale.DynamicQR, "seconds_left": left, "status": tc.View.Status})
}

func (s *Server) activationOpen(tc *ticketCtx) error {
	if tc.View.Status != "active" {
		return httpx.BadRequest("Chipta faol emas")
	}
	if tc.View.FaceStatus != "none" {
		return httpx.NewError(409, "already", "Chipta allaqachon faollashtirilgan")
	}
	if tc.Kickoff != nil && time.Now().After(tc.Kickoff.Add(-time.Duration(tc.Sale.ActivationHrs)*time.Hour)) {
		return httpx.NewError(409, "late", "Faollashtirish muddati tugadi — kassaga hujjat bilan murojaat qiling")
	}
	return nil
}

// publicActivateFace binds a selfie to the ticket (multipart: photo, holder_name, consent=1, liveness).
func (s *Server) publicActivateFace(w http.ResponseWriter, r *http.Request) {
	tc, err := s.ticketByHolder(r, chi.URLParam(r, "token"))
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	if err := s.activationOpen(tc); err != nil {
		httpx.Fail(w, r, err)
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, 6<<20)
	if err := r.ParseMultipartForm(6 << 20); err != nil {
		httpx.Fail(w, r, httpx.BadRequest("Rasm juda katta"))
		return
	}
	if r.FormValue("consent") != "1" {
		httpx.Fail(w, r, httpx.Validation(map[string]any{"consent": "Biometrik ma’lumotlarga rozilik kerak"}))
		return
	}
	name := strings.TrimSpace(r.FormValue("holder_name"))
	if len([]rune(name)) < 3 || len(name) > 120 {
		httpx.Fail(w, r, httpx.Validation(map[string]any{"holder_name": "Ism familiyani kiriting"}))
		return
	}
	f, _, err := r.FormFile("photo")
	if err != nil {
		httpx.Fail(w, r, httpx.Validation(map[string]any{"photo": "Selfi kerak"}))
		return
	}
	raw, _ := io.ReadAll(io.LimitReader(f, 6<<20))
	f.Close()
	photo, err := normalizeSelfie(raw)
	if err != nil {
		httpx.Fail(w, r, httpx.Validation(map[string]any{"photo": "Rasmni o‘qib bo‘lmadi"}))
		return
	}
	var tmpl []byte
	if s.Cfg.FaceServiceURL != "" {
		t, err := s.faceTemplate(r.Context(), photo)
		if err != nil {
			httpx.Fail(w, r, httpx.Validation(map[string]any{"photo": err.Error()}))
			return
		}
		tmpl = s.sealFace(t)
	}
	deleteAfter := time.Now().Add(30 * 24 * time.Hour)
	if tc.Kickoff != nil {
		deleteAfter = tc.Kickoff.Add(time.Duration(tc.Sale.FaceRetainDays) * 24 * time.Hour)
	}
	tx, err := s.DB.BeginTx(r.Context(), nil)
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	defer tx.Rollback()
	if _, err := tx.ExecContext(r.Context(), `INSERT INTO ticket_faces(ticket_id, photo_enc, template_enc, liveness, consent_at, delete_after)
		VALUES ($1,$2,$3,$4,now(),$5) ON CONFLICT (ticket_id) DO UPDATE SET photo_enc=$2, template_enc=$3, liveness=$4, consent_at=now(), delete_after=$5`,
		tc.ID, s.sealFace(photo), nullBytes(tmpl), []byte(livenessJSON(r.FormValue("liveness"))), deleteAfter); err != nil {
		httpx.Fail(w, r, err)
		return
	}
	if _, err := tx.ExecContext(r.Context(), `UPDATE tickets SET face_status='bound', activated_at=now(), holder_name=$2 WHERE id=$1`, tc.ID, name); err != nil {
		httpx.Fail(w, r, err)
		return
	}
	if err := tx.Commit(); err != nil {
		httpx.Fail(w, r, err)
		return
	}
	httpx.JSON(w, 200, map[string]any{"ok": true})
}

func livenessJSON(s string) string {
	s = strings.TrimSpace(s)
	if !strings.HasPrefix(s, "{") || len(s) > 2000 {
		return "{}"
	}
	return s
}

// publicActivateDocument: the holder refused biometrics — entry by ID document
// (allowed only when the sale permits it); the ticket keeps the holder's name.
func (s *Server) publicActivateDocument(w http.ResponseWriter, r *http.Request) {
	tc, err := s.ticketByHolder(r, chi.URLParam(r, "token"))
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	if err := s.activationOpen(tc); err != nil {
		httpx.Fail(w, r, err)
		return
	}
	if !tc.Sale.NoFaceEntry {
		httpx.Fail(w, r, httpx.BadRequest("Bu match uchun yuzsiz kirish yoqilmagan"))
		return
	}
	var in struct {
		Name string `json:"holder_name"`
	}
	if err := httpx.Decode(r, &in); err != nil {
		httpx.Fail(w, r, err)
		return
	}
	in.Name = strings.TrimSpace(in.Name)
	if len([]rune(in.Name)) < 3 || len(in.Name) > 120 {
		httpx.Fail(w, r, httpx.Validation(map[string]any{"holder_name": "Hujjatdagi ism familiyani kiriting"}))
		return
	}
	if _, err := s.DB.ExecContext(r.Context(), `UPDATE tickets SET face_status='document', activated_at=now(), holder_name=$2 WHERE id=$1`, tc.ID, in.Name); err != nil {
		httpx.Fail(w, r, err)
		return
	}
	httpx.JSON(w, 200, map[string]any{"ok": true})
}

// normalizeSelfie decodes the upload and re-encodes a small JPEG (max 480 px):
// no EXIF, no original file kept.
func normalizeSelfie(raw []byte) ([]byte, error) {
	img, _, err := image.Decode(bytes.NewReader(raw))
	if err != nil {
		return nil, err
	}
	b := img.Bounds()
	if b.Dx() < 120 || b.Dy() < 120 {
		return nil, errors.New("small")
	}
	img = downscale(img, 480)
	var out bytes.Buffer
	if err := jpeg.Encode(&out, img, &jpeg.Options{Quality: 82}); err != nil {
		return nil, err
	}
	return out.Bytes(), nil
}

// downscale is a box-filter resize so the longer side is at most maxSide.
func downscale(src image.Image, maxSide int) image.Image {
	b := src.Bounds()
	w, h := b.Dx(), b.Dy()
	if w <= maxSide && h <= maxSide {
		return src
	}
	nw, nh := maxSide, h*maxSide/w
	if h > w {
		nh, nw = maxSide, w*maxSide/h
	}
	dst := image.NewRGBA(image.Rect(0, 0, nw, nh))
	for y := 0; y < nh; y++ {
		y0, y1 := b.Min.Y+y*h/nh, b.Min.Y+(y+1)*h/nh
		for x := 0; x < nw; x++ {
			x0, x1 := b.Min.X+x*w/nw, b.Min.X+(x+1)*w/nw
			var r, g, bl, n uint32
			for yy := y0; yy < max(y1, y0+1); yy += 2 {
				for xx := x0; xx < max(x1, x0+1); xx += 2 {
					cr, cg, cb, _ := src.At(xx, yy).RGBA()
					r, g, bl, n = r+cr, g+cg, bl+cb, n+1
				}
			}
			i := dst.PixOffset(x, y)
			dst.Pix[i], dst.Pix[i+1], dst.Pix[i+2], dst.Pix[i+3] = uint8(r/n>>8), uint8(g/n>>8), uint8(bl/n>>8), 255
		}
	}
	return dst
}
