package api

import (
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/lib/pq"

	"github.com/sanedidi/unitedmfl/backend/internal/auth"
	"github.com/sanedidi/unitedmfl/backend/internal/httpx"
	"github.com/sanedidi/unitedmfl/backend/internal/tickets"
)

// Admin → Chiptalar: sales per match, zone prices, orders, refunds, box
// office and entry security settings.

func (s *Server) mountTicketsAdmin(r chi.Router) {
	// selling at the box office creates an order; everything else views or edits
	r.With(s.can(auth.Key(auth.PermTickets, auth.ActCreate))).Post("/ticket-orders/box-office", s.boxOfficeOrder)
	r.Group(func(r chi.Router) {
		r.Use(s.canEdit(auth.PermTickets))
		r.Get("/ticket-sales", s.listTicketSales)
		r.Get("/matches/{id}/ticket-sale", s.getTicketSale)
		r.Put("/matches/{id}/ticket-sale", s.putTicketSale)
		r.Put("/matches/{id}/ticket-sale/zones/{zone}", s.putZonePrice)
		r.Post("/matches/{id}/ticket-sale/status", s.setSaleStatus)
		r.Delete("/matches/{id}/ticket-sale/faces", s.deleteSaleFaces)
		r.Get("/ticket-orders", s.listTicketOrders)
		r.Get("/ticket-orders/{id}", s.getTicketOrder)
		r.Post("/ticket-orders/{id}/refund", s.refundTicketOrder)
		r.Post("/ticket-orders/{id}/resend", s.resendTicketOrder)
		r.Get("/ticket-scans", s.listTicketScans)
	})
}

type saleRow struct {
	MatchID   int64       `json:"match_id"`
	Title     string      `json:"title"`
	Stage     string      `json:"stage"`
	KickoffAt *time.Time  `json:"kickoff_at"`
	Venue     string      `json:"venue"`
	MatchSt   string      `json:"match_status"`
	SaleID    *int64      `json:"sale_id"`
	Status    string      `json:"status"` // none | draft | open | paused | closed
	SaleTo    *time.Time  `json:"sale_to"`
	SaleFrom  *time.Time  `json:"sale_from"`
	Zones     []zonePrice `json:"zones"`
	Revenue   int64       `json:"revenue"`
	Sold      int         `json:"sold"`
	Capacity  int         `json:"capacity"`
}

const matchTitleSQL = `COALESCE(ht.name,'Aniqlanmagan')||' — '||COALESCE(at.name,'Aniqlanmagan')`

func (s *Server) listTicketSales(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	rows, err := s.DB.QueryContext(ctx, `SELECT m.id, `+matchTitleSQL+`, COALESCE(st.name, m.round, ''), m.kickoff_at, m.venue, m.status, ts.id
		FROM matches m LEFT JOIN teams ht ON ht.id=m.home_team_id LEFT JOIN teams at ON at.id=m.away_team_id
		LEFT JOIN stages st ON st.id=m.stage_id LEFT JOIN ticket_sales ts ON ts.match_id=m.id
		WHERE ts.id IS NOT NULL OR (m.status IN ('scheduled','postponed') AND (m.kickoff_at IS NULL OR m.kickoff_at > now() - interval '1 day'))
		ORDER BY (ts.id IS NULL), m.kickoff_at DESC NULLS LAST LIMIT 200`)
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	var list []saleRow
	for rows.Next() {
		var x saleRow
		var k sql.NullTime
		var sid sql.NullInt64
		if err := rows.Scan(&x.MatchID, &x.Title, &x.Stage, &k, &x.Venue, &x.MatchSt, &sid); err != nil {
			rows.Close()
			httpx.Fail(w, r, err)
			return
		}
		x.KickoffAt = nullTime(k)
		x.Status, x.Zones = "none", []zonePrice{}
		if sid.Valid {
			x.SaleID = &sid.Int64
		}
		list = append(list, x)
	}
	rows.Close()
	kpi := map[string]int64{}
	for i := range list {
		if list[i].SaleID == nil {
			continue
		}
		sale, err := s.saleByMatch(ctx, s.DB, list[i].MatchID, false)
		if err != nil {
			continue
		}
		list[i].Status, list[i].SaleFrom, list[i].SaleTo = sale.Status, sale.SaleFrom, sale.SaleTo
		if l, err := s.saleLayout(ctx, s.DB, sale); err == nil {
			if z, err := s.salePrices(ctx, s.DB, sale, l); err == nil {
				list[i].Zones = z
				for _, p := range z {
					list[i].Sold += p.Sold
					list[i].Capacity += p.Capacity
				}
			}
		}
		_ = s.DB.QueryRowContext(ctx, `SELECT COALESCE(sum(total - refunded),0) FROM ticket_orders WHERE sale_id=$1 AND status IN ('paid','refund_requested','partially_refunded')`, sale.ID).Scan(&list[i].Revenue)
		kpi["sold"] += int64(list[i].Sold)
		kpi["revenue"] += list[i].Revenue
	}
	_ = s.DB.QueryRowContext(ctx, `SELECT count(*) FROM tickets t JOIN ticket_orders o ON o.id=t.order_id
		WHERE t.status IN ('active','used') AND o.paid_at >= date_trunc('day', now() AT TIME ZONE 'Asia/Tashkent') AT TIME ZONE 'Asia/Tashkent'`).Scan(new(int64))
	var today, refunds int64
	_ = s.DB.QueryRowContext(ctx, `SELECT count(*) FROM tickets t JOIN ticket_orders o ON o.id=t.order_id
		WHERE t.status IN ('active','used') AND o.paid_at >= now() - interval '24 hours'`).Scan(&today)
	_ = s.DB.QueryRowContext(ctx, `SELECT count(*) FROM ticket_orders WHERE status='refund_requested'`).Scan(&refunds)
	kpi["today"], kpi["refund_requests"] = today, refunds
	journal, _ := s.orderJournal(r, 0, 8)
	if list == nil {
		list = []saleRow{}
	}
	httpx.JSON(w, 200, map[string]any{"items": list, "kpi": kpi, "journal": journal, "providers": s.providerStatus()})
}

func (s *Server) providerStatus() []map[string]any {
	return []map[string]any{
		{"key": "payme", "name": "Payme", "enabled": s.Cfg.PaymeMerchantID != "" && s.Cfg.PaymeKey != ""},
		{"key": "click", "name": "Click", "enabled": s.Cfg.ClickServiceID != "" && s.Cfg.ClickSecretKey != ""},
		{"key": "test", "name": "Test to‘lov", "enabled": s.Cfg.TestPayments},
	}
}

type orderRow struct {
	ID        int64            `json:"id"`
	Number    string           `json:"number"`
	CreatedAt time.Time        `json:"created_at"`
	PaidAt    *time.Time       `json:"paid_at"`
	Buyer     string           `json:"buyer_name"`
	Phone     string           `json:"phone"`
	Match     string           `json:"match"`
	MatchID   int64            `json:"match_id"`
	Items     []map[string]any `json:"items"`
	Total     int64            `json:"total"`
	Refunded  int64            `json:"refunded"`
	Provider  string           `json:"provider"`
	Status    string           `json:"status"`
	Source    string           `json:"source"`
	HoldUntil *time.Time       `json:"hold_until"`
}

func (s *Server) orderJournal(r *http.Request, matchID int64, limit int) ([]orderRow, error) {
	q := r.URL.Query()
	args := []any{}
	where := []string{"true"}
	if matchID > 0 {
		args = append(args, matchID)
		where = append(where, "ts.match_id=$"+strconv.Itoa(len(args)))
	}
	if st := q.Get("status"); st != "" && limit > 10 {
		if st == "refund" {
			where = append(where, "o.status IN ('refund_requested','partially_refunded','refunded')")
		} else {
			args = append(args, st)
			where = append(where, "o.status=$"+strconv.Itoa(len(args)))
		}
	}
	if term := strings.TrimSpace(q.Get("q")); term != "" && limit > 10 {
		args = append(args, "%"+strings.ToLower(term)+"%")
		n := strconv.Itoa(len(args))
		where = append(where, "(lower(o.number) LIKE $"+n+" OR lower(o.buyer_name) LIKE $"+n+" OR o.phone LIKE $"+n+
			" OR EXISTS (SELECT 1 FROM tickets t WHERE t.order_id=o.id AND lower(t.number) LIKE $"+n+"))")
	}
	page, _ := strconv.Atoi(q.Get("page"))
	if page < 1 || limit <= 10 {
		page = 1
	}
	args = append(args, limit, (page-1)*limit)
	rows, err := s.DB.QueryContext(r.Context(), `SELECT o.id, o.number, o.created_at, o.paid_at, o.buyer_name, o.phone,
		(SELECT `+matchTitleSQL+` FROM matches m LEFT JOIN teams ht ON ht.id=m.home_team_id LEFT JOIN teams at ON at.id=m.away_team_id WHERE m.id=ts.match_id),
		ts.match_id, o.total, o.refunded, o.provider, o.status, o.source, o.hold_until,
		COALESCE((SELECT json_agg(json_build_object('zone', zone_key, 'qty', c)) FROM
			(SELECT zone_key, count(*) c FROM tickets WHERE order_id=o.id GROUP BY zone_key) z), '[]')
		FROM ticket_orders o JOIN ticket_sales ts ON ts.id=o.sale_id
		WHERE `+strings.Join(where, " AND ")+` ORDER BY o.created_at DESC LIMIT $`+strconv.Itoa(len(args)-1)+` OFFSET $`+strconv.Itoa(len(args)), args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []orderRow{}
	for rows.Next() {
		var o orderRow
		var paid, hold sql.NullTime
		var items []byte
		if err := rows.Scan(&o.ID, &o.Number, &o.CreatedAt, &paid, &o.Buyer, &o.Phone, &o.Match, &o.MatchID, &o.Total, &o.Refunded,
			&o.Provider, &o.Status, &o.Source, &hold, &items); err != nil {
			return nil, err
		}
		o.PaidAt, o.HoldUntil = nullTime(paid), nullTime(hold)
		_ = json.Unmarshal(items, &o.Items)
		o.Phone = maskPhone(o.Phone)
		out = append(out, o)
	}
	return out, rows.Err()
}

func (s *Server) listTicketOrders(w http.ResponseWriter, r *http.Request) {
	mid, _ := strconv.ParseInt(r.URL.Query().Get("match_id"), 10, 64)
	items, err := s.orderJournal(r, mid, 50)
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	counts := map[string]int{}
	args := []any{}
	cond := "true"
	if mid > 0 {
		args = append(args, mid)
		cond = "ts.match_id=$1"
	}
	crows, err := s.DB.QueryContext(r.Context(), `SELECT o.status, count(*) FROM ticket_orders o JOIN ticket_sales ts ON ts.id=o.sale_id WHERE `+cond+` GROUP BY o.status`, args...)
	if err == nil {
		for crows.Next() {
			var st string
			var n int
			_ = crows.Scan(&st, &n)
			counts[st] = n
			counts["all"] += n
		}
		crows.Close()
	}
	httpx.JSON(w, 200, map[string]any{"items": items, "counts": counts})
}

// ---------- one sale ----------

type saleView struct {
	Match   map[string]any   `json:"match"`
	Sale    *ticketSale      `json:"sale"`
	Zones   []zonePrice      `json:"zones"`
	Layout  *layoutView      `json:"layout"`
	Revenue int64            `json:"revenue"`
	Daily   []map[string]any `json:"daily"`
	Entry   map[string]int   `json:"entry"`
	Gates   []string         `json:"gates"`
}

func (s *Server) matchSummary(r *http.Request, id int64) (map[string]any, error) {
	var title, stage, venue, status string
	var k sql.NullTime
	err := s.DB.QueryRowContext(r.Context(), `SELECT `+matchTitleSQL+`, COALESCE(st.name, m.round, ''), m.kickoff_at, m.venue, m.status
		FROM matches m LEFT JOIN teams ht ON ht.id=m.home_team_id LEFT JOIN teams at ON at.id=m.away_team_id
		LEFT JOIN stages st ON st.id=m.stage_id WHERE m.id=$1`, id).Scan(&title, &stage, &k, &venue, &status)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, httpx.ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return map[string]any{"id": id, "title": title, "stage": stage, "kickoff_at": nullTime(k), "venue": venue, "status": status}, nil
}

func (s *Server) getTicketSale(w http.ResponseWriter, r *http.Request) {
	id, err := idParam(r, "id")
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	v, err := s.saleView(r, id)
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	httpx.JSON(w, 200, v)
}

func (s *Server) saleView(r *http.Request, matchID int64) (*saleView, error) {
	ctx := r.Context()
	m, err := s.matchSummary(r, matchID)
	if err != nil {
		return nil, err
	}
	v := &saleView{Match: m, Zones: []zonePrice{}, Daily: []map[string]any{}, Entry: map[string]int{}, Gates: []string{}}
	sale, err := s.saleByMatch(ctx, s.DB, matchID, false)
	if errors.Is(err, httpx.ErrNotFound) {
		return v, nil
	}
	if err != nil {
		return nil, err
	}
	v.Sale = sale
	if sale.LayoutID != nil {
		if v.Layout, err = s.layoutByID(r, *sale.LayoutID); err != nil {
			return nil, err
		}
		l, err := s.saleLayout(ctx, s.DB, sale)
		if err != nil {
			return nil, err
		}
		if v.Zones, err = s.salePrices(ctx, s.DB, sale, l); err != nil {
			return nil, err
		}
		seen := map[string]bool{}
		for _, st := range l.Stands {
			for _, sec := range st.Sections {
				if sec.Gate != "" && !seen[sec.Gate] {
					seen[sec.Gate] = true
					v.Gates = append(v.Gates, sec.Gate)
				}
			}
		}
	}
	_ = s.DB.QueryRowContext(ctx, `SELECT COALESCE(sum(total - refunded),0) FROM ticket_orders WHERE sale_id=$1 AND status IN ('paid','refund_requested','partially_refunded')`, sale.ID).Scan(&v.Revenue)
	drows, err := s.DB.QueryContext(ctx, `SELECT to_char(d, 'DD.MM'), COALESCE(c,0) FROM generate_series((now() AT TIME ZONE 'Asia/Tashkent')::date - 6, (now() AT TIME ZONE 'Asia/Tashkent')::date, '1 day') d
		LEFT JOIN (SELECT (o.paid_at AT TIME ZONE 'Asia/Tashkent')::date day, count(t.id) c FROM ticket_orders o JOIN tickets t ON t.order_id=o.id
			WHERE o.sale_id=$1 AND o.paid_at IS NOT NULL GROUP BY 1) x ON x.day = d ORDER BY d`, sale.ID)
	if err == nil {
		for drows.Next() {
			var d string
			var c int
			_ = drows.Scan(&d, &c)
			v.Daily = append(v.Daily, map[string]any{"day": d, "count": c})
		}
		drows.Close()
	}
	var entered, active, bound, document, pendingAct, rejected int
	_ = s.DB.QueryRowContext(ctx, `SELECT count(*) FILTER (WHERE status='used'), count(*) FILTER (WHERE status IN ('active','used')),
		count(*) FILTER (WHERE status IN ('active','used') AND face_status='bound'), count(*) FILTER (WHERE status IN ('active','used') AND face_status='document'),
		count(*) FILTER (WHERE status='active' AND transfer_sent_at IS NOT NULL AND activated_at IS NULL)
		FROM tickets WHERE sale_id=$1`, sale.ID).Scan(&entered, &active, &bound, &document, &pendingAct)
	_ = s.DB.QueryRowContext(ctx, `SELECT count(*) FROM ticket_scans WHERE sale_id=$1 AND result IN ('used','stale','invalid','face_mismatch','rejected','wrong_match','cancelled')`, sale.ID).Scan(&rejected)
	v.Entry = map[string]int{"entered": entered, "active": active, "face_bound": bound, "document": document, "awaiting": pendingAct, "rejected": rejected}
	return v, nil
}

type saleIn struct {
	LayoutID       *int64     `json:"layout_id"`
	SaleFrom       *time.Time `json:"sale_from"`
	SaleTo         *time.Time `json:"sale_to"`
	ClearFrom      bool       `json:"clear_sale_from"`
	ClearTo        bool       `json:"clear_sale_to"`
	HoldMinutes    *int       `json:"hold_minutes"`
	MaxPerOrder    *int       `json:"max_per_order"`
	RefundHours    *int       `json:"refund_hours"`
	ServiceFee     *int64     `json:"service_fee"`
	TelegramDeliv  *bool      `json:"telegram_delivery"`
	BoxOffice      *bool      `json:"box_office"`
	DynamicQR      *bool      `json:"dynamic_qr"`
	SingleScan     *bool      `json:"single_scan"`
	FaceMode       *string    `json:"face_mode"`
	FaceCheck      *string    `json:"face_check"`
	FaceThreshold  *int       `json:"face_threshold"`
	ActivationHrs  *int       `json:"activation_hours"`
	TransferOK     *bool      `json:"transfer_allowed"`
	NoFaceEntry    *bool      `json:"no_face_entry"`
	FaceRetainDays *int       `json:"face_retention_days"`
}

func inRange(p *int, lo, hi int, field string, bad map[string]any) {
	if p != nil && (*p < lo || *p > hi) {
		bad[field] = "Qiymat " + strconv.Itoa(lo) + "–" + strconv.Itoa(hi) + " oralig‘ida bo‘lsin"
	}
}

func (s *Server) putTicketSale(w http.ResponseWriter, r *http.Request) {
	matchID, err := idParam(r, "id")
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	var in saleIn
	if err := httpx.Decode(r, &in); err != nil {
		httpx.Fail(w, r, err)
		return
	}
	bad := map[string]any{}
	inRange(in.HoldMinutes, 3, 60, "hold_minutes", bad)
	inRange(in.MaxPerOrder, 1, 50, "max_per_order", bad)
	inRange(in.RefundHours, 0, 720, "refund_hours", bad)
	inRange(in.FaceThreshold, 50, 99, "face_threshold", bad)
	inRange(in.ActivationHrs, 0, 72, "activation_hours", bad)
	inRange(in.FaceRetainDays, 1, 30, "face_retention_days", bad)
	if in.FaceMode != nil && *in.FaceMode != "off" && *in.FaceMode != "vip" && *in.FaceMode != "all" {
		bad["face_mode"] = "off, vip yoki all"
	}
	if in.FaceCheck != nil && *in.FaceCheck != "auto" && *in.FaceCheck != "manual" {
		bad["face_check"] = "auto yoki manual"
	}
	if in.FaceCheck != nil && *in.FaceCheck == "auto" && s.Cfg.FaceServiceURL == "" {
		bad["face_check"] = "Yuzni avtomatik solishtirish servisi ulanmagan (FACE_SERVICE_URL) — «Nazoratchiga rasm» rejimini tanlang"
	}
	if in.ServiceFee != nil && *in.ServiceFee < 0 {
		bad["service_fee"] = "Manfiy bo‘lmaydi"
	}
	if in.SaleFrom != nil && in.SaleTo != nil && !in.SaleTo.After(*in.SaleFrom) {
		bad["sale_to"] = "Tugash vaqti boshlanishdan keyin bo‘lsin"
	}
	if len(bad) > 0 {
		httpx.Fail(w, r, httpx.Validation(bad))
		return
	}
	ctx := r.Context()
	tx, err := s.DB.BeginTx(ctx, nil)
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	defer tx.Rollback()
	if _, err := s.matchSummary(r, matchID); err != nil {
		httpx.Fail(w, r, err)
		return
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO ticket_sales(match_id) VALUES ($1) ON CONFLICT (match_id) DO NOTHING`, matchID); err != nil {
		httpx.Fail(w, r, err)
		return
	}
	sale, err := s.saleByMatch(ctx, tx, matchID, true)
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	if in.LayoutID != nil && (sale.LayoutID == nil || *sale.LayoutID != *in.LayoutID) {
		var st string
		var doc []byte
		if err := tx.QueryRowContext(ctx, `SELECT status, doc FROM venue_layouts WHERE id=$1`, *in.LayoutID).Scan(&st, &doc); err != nil {
			httpx.Fail(w, r, httpx.Validation(map[string]any{"layout_id": "Sxema topilmadi"}))
			return
		}
		if st != "published" {
			httpx.Fail(w, r, httpx.Validation(map[string]any{"layout_id": "Faqat nashr qilingan versiyani tanlash mumkin"}))
			return
		}
		nl, err := tickets.Parse(doc)
		if err != nil {
			httpx.Fail(w, r, httpx.BadRequest(err.Error()))
			return
		}
		// tickets already sold must fit the new schema
		rows, err := tx.QueryContext(ctx, `SELECT zone_key, COALESCE(seat_id,'') FROM tickets WHERE sale_id=$1 AND status IN ('pending','active','used')`, sale.ID)
		if err != nil {
			httpx.Fail(w, r, err)
			return
		}
		for rows.Next() {
			var zk, seat string
			_ = rows.Scan(&zk, &seat)
			if (seat != "" && (!nl.IsSellable(seat) || nl.SeatZone(seat) != zk)) || len(nl.ZoneSections(zk)) == 0 {
				rows.Close()
				httpx.Fail(w, r, httpx.NewError(409, "sold", "Yangi sxemada sotilgan chiptalarning zona yoki o‘rinlari yo‘q"))
				return
			}
		}
		rows.Close()
	}
	nt := func(t *time.Time, clear bool) any {
		if clear {
			return "clear"
		}
		if t == nil {
			return nil
		}
		return t.UTC().Format(time.RFC3339)
	}
	_, err = tx.ExecContext(ctx, `UPDATE ticket_sales SET
		layout_id=COALESCE($2, layout_id),
		sale_from=CASE WHEN $3::text='clear' THEN NULL WHEN $3::text IS NULL THEN sale_from ELSE $3::timestamptz END,
		sale_to=CASE WHEN $4::text='clear' THEN NULL WHEN $4::text IS NULL THEN sale_to ELSE $4::timestamptz END,
		hold_minutes=COALESCE($5,hold_minutes), max_per_order=COALESCE($6,max_per_order), refund_hours=COALESCE($7,refund_hours),
		service_fee=COALESCE($8,service_fee), telegram_delivery=COALESCE($9,telegram_delivery), box_office=COALESCE($10,box_office),
		dynamic_qr=COALESCE($11,dynamic_qr), single_scan=COALESCE($12,single_scan), face_mode=COALESCE($13,face_mode),
		face_check=COALESCE($14,face_check), face_threshold=COALESCE($15,face_threshold), activation_hours=COALESCE($16,activation_hours),
		transfer_allowed=COALESCE($17,transfer_allowed), no_face_entry=COALESCE($18,no_face_entry),
		face_retention_days=COALESCE($19,face_retention_days), updated_at=now() WHERE id=$1`,
		sale.ID, in.LayoutID, nt(in.SaleFrom, in.ClearFrom), nt(in.SaleTo, in.ClearTo), in.HoldMinutes, in.MaxPerOrder, in.RefundHours,
		in.ServiceFee, in.TelegramDeliv, in.BoxOffice, in.DynamicQR, in.SingleScan, in.FaceMode, in.FaceCheck, in.FaceThreshold,
		in.ActivationHrs, in.TransferOK, in.NoFaceEntry, in.FaceRetainDays)
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	if err := tx.Commit(); err != nil {
		httpx.Fail(w, r, err)
		return
	}
	s.audit(r, "update", "ticket_sale", sale.ID, in)
	s.web.notify()
	s.getTicketSale(w, r)
}

func (s *Server) putZonePrice(w http.ResponseWriter, r *http.Request) {
	matchID, err := idParam(r, "id")
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	zone := chi.URLParam(r, "zone")
	var in struct {
		Title    *string   `json:"title"`
		Subtitle *string   `json:"subtitle"`
		Price    *int64    `json:"price"`
		Enabled  *bool     `json:"enabled"`
		Named    *bool     `json:"named"`
		Perks    *[]string `json:"perks"`
		Gate     *string   `json:"gate"`
	}
	if err := httpx.Decode(r, &in); err != nil {
		httpx.Fail(w, r, err)
		return
	}
	if in.Price != nil && (*in.Price < 0 || *in.Price > 100_000_000) {
		httpx.Fail(w, r, httpx.Validation(map[string]any{"price": "Narx noto‘g‘ri"}))
		return
	}
	sale, err := s.saleByMatch(r.Context(), s.DB, matchID, false)
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	l, err := s.saleLayout(r.Context(), s.DB, sale)
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	var zk *tickets.Zone
	for i := range l.Zones {
		if l.Zones[i].Key == zone {
			zk = &l.Zones[i]
		}
	}
	if zk == nil {
		httpx.Fail(w, r, httpx.ErrNotFound)
		return
	}
	var perks any
	if in.Perks != nil {
		clean := []string{}
		for _, p := range *in.Perks {
			if p = strings.TrimSpace(p); p != "" && len(clean) < 12 {
				clean = append(clean, p)
			}
		}
		perks = pq.Array(clean)
	}
	_, err = s.DB.ExecContext(r.Context(), `INSERT INTO ticket_zone_prices(sale_id, zone_key, title, named, sort) VALUES ($1,$2,$3,$4,
		(SELECT COALESCE(max(sort),0)+1 FROM ticket_zone_prices WHERE sale_id=$1)) ON CONFLICT (sale_id, zone_key) DO NOTHING`,
		sale.ID, zone, zk.Name, zk.Kind == "vip")
	if err == nil {
		_, err = s.DB.ExecContext(r.Context(), `UPDATE ticket_zone_prices SET title=COALESCE($3,title), subtitle=COALESCE($4,subtitle),
			price=COALESCE($5,price), enabled=COALESCE($6,enabled), named=COALESCE($7,named), perks=COALESCE($8,perks), gate=COALESCE($9,gate)
			WHERE sale_id=$1 AND zone_key=$2`, sale.ID, zone, in.Title, in.Subtitle, in.Price, in.Enabled, in.Named, perks, in.Gate)
	}
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	s.audit(r, "update", "ticket_zone", sale.ID, map[string]any{"zone": zone, "price": in.Price})
	s.web.notify()
	s.getTicketSale(w, r)
}

func (s *Server) setSaleStatus(w http.ResponseWriter, r *http.Request) {
	matchID, err := idParam(r, "id")
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	var in struct {
		Status string `json:"status"`
	}
	if err := httpx.Decode(r, &in); err != nil {
		httpx.Fail(w, r, err)
		return
	}
	if in.Status != "open" && in.Status != "paused" && in.Status != "closed" && in.Status != "draft" {
		httpx.Fail(w, r, httpx.BadRequest("status: open, paused, closed"))
		return
	}
	sale, err := s.saleByMatch(r.Context(), s.DB, matchID, false)
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	if in.Status == "open" {
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
		ok := false
		for _, p := range prices {
			if p.Enabled && p.Price > 0 && p.Capacity > 0 {
				ok = true
			}
		}
		if !ok {
			httpx.Fail(w, r, httpx.BadRequest("Kamida bitta zonaga narx qo‘ying"))
			return
		}
		if len(s.enabledProviders()) == 0 {
			httpx.Fail(w, r, httpx.BadRequest("To‘lov tizimi ulanmagan (Payme yoki Click) — sotuvni ochib bo‘lmaydi"))
			return
		}
	}
	if _, err := s.DB.ExecContext(r.Context(), `UPDATE ticket_sales SET status=$2, updated_at=now(),
		opened_at=CASE WHEN $2='open' AND opened_at IS NULL THEN now() ELSE opened_at END,
		opened_by=CASE WHEN $2='open' AND opened_by IS NULL THEN $3 ELSE opened_by END WHERE id=$1`, sale.ID, in.Status, userIDPtr(r)); err != nil {
		httpx.Fail(w, r, err)
		return
	}
	s.audit(r, "status", "ticket_sale", sale.ID, map[string]any{"status": in.Status})
	s.web.notify()
	s.getTicketSale(w, r)
}

func (s *Server) enabledProviders() []string {
	var out []string
	for _, p := range s.providerStatus() {
		if p["enabled"].(bool) {
			out = append(out, p["key"].(string))
		}
	}
	return out
}

func (s *Server) deleteSaleFaces(w http.ResponseWriter, r *http.Request) {
	matchID, err := idParam(r, "id")
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	res, err := s.DB.ExecContext(r.Context(), `DELETE FROM ticket_faces f USING tickets t, ticket_sales ts
		WHERE f.ticket_id=t.id AND t.sale_id=ts.id AND ts.match_id=$1`, matchID)
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	n, _ := res.RowsAffected()
	s.audit(r, "delete_faces", "ticket_sale", matchID, map[string]any{"count": n})
	httpx.JSON(w, 200, map[string]any{"deleted": n})
}

// ---------- one order ----------

type ticketView struct {
	ID          int64      `json:"id"`
	Number      string     `json:"number"`
	ZoneKey     string     `json:"zone_key"`
	ZoneName    string     `json:"zone_name"`
	ZoneKind    string     `json:"zone_kind"`
	Section     string     `json:"section"`
	Row         string     `json:"row"`
	Seat        *int       `json:"seat"`
	Gate        string     `json:"gate"`
	Price       int64      `json:"price"`
	Holder      string     `json:"holder_name"`
	Status      string     `json:"status"`
	FaceStatus  string     `json:"face_status"`
	ActivatedAt *time.Time `json:"activated_at"`
	TransferAt  *time.Time `json:"transfer_sent_at"`
	UsedAt      *time.Time `json:"used_at"`
	UsedGate    string     `json:"used_gate"`
	HolderToken string     `json:"holder_token,omitempty"`
	Perks       []string   `json:"perks"`
}

func (s *Server) orderTickets(r *http.Request, orderID int64, l *tickets.Layout, prices []zonePrice, withToken bool) ([]ticketView, error) {
	rows, err := s.DB.QueryContext(r.Context(), `SELECT id, number, zone_key, section_key, row_label, seat_no, gate, price, holder_name, status,
		face_status, activated_at, transfer_sent_at, used_at, used_gate, holder_token FROM tickets WHERE order_id=$1 ORDER BY id`, orderID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	perks := map[string][]string{}
	for _, p := range prices {
		perks[p.ZoneKey] = p.Perks
	}
	out := []ticketView{}
	for rows.Next() {
		var t ticketView
		var seat sql.NullInt64
		var act, tr, used sql.NullTime
		var tok string
		if err := rows.Scan(&t.ID, &t.Number, &t.ZoneKey, &t.Section, &t.Row, &seat, &t.Gate, &t.Price, &t.Holder, &t.Status,
			&t.FaceStatus, &act, &tr, &used, &t.UsedGate, &tok); err != nil {
			return nil, err
		}
		if seat.Valid {
			n := int(seat.Int64)
			t.Seat = &n
		}
		t.ActivatedAt, t.TransferAt, t.UsedAt = nullTime(act), nullTime(tr), nullTime(used)
		if l != nil {
			t.ZoneName, t.ZoneKind = zoneName(l, t.ZoneKey), zoneKind(l, t.ZoneKey)
		}
		t.Perks = perks[t.ZoneKey]
		if t.Perks == nil {
			t.Perks = []string{}
		}
		if withToken {
			t.HolderToken = tok
		}
		out = append(out, t)
	}
	return out, rows.Err()
}

func (s *Server) getTicketOrder(w http.ResponseWriter, r *http.Request) {
	id, err := idParam(r, "id")
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	var o orderRow
	var email, txn, card, reason string
	var paid, hold sql.NullTime
	var saleID int64
	var telegram bool
	err = s.DB.QueryRowContext(r.Context(), `SELECT o.id, o.number, o.created_at, o.paid_at, o.buyer_name, o.phone, o.email, o.telegram,
		ts.match_id, ts.id, o.total, o.refunded, o.provider, o.provider_txn, o.card_mask, o.status, o.source, o.hold_until, o.cancel_reason
		FROM ticket_orders o JOIN ticket_sales ts ON ts.id=o.sale_id WHERE o.id=$1`, id).Scan(&o.ID, &o.Number, &o.CreatedAt, &paid, &o.Buyer,
		&o.Phone, &email, &telegram, &o.MatchID, &saleID, &o.Total, &o.Refunded, &o.Provider, &txn, &card, &o.Status, &o.Source, &hold, &reason)
	if errors.Is(err, sql.ErrNoRows) {
		httpx.Fail(w, r, httpx.ErrNotFound)
		return
	}
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	o.PaidAt, o.HoldUntil = nullTime(paid), nullTime(hold)
	sale, _ := s.saleByMatch(r.Context(), s.DB, o.MatchID, false)
	var l *tickets.Layout
	var prices []zonePrice
	if sale != nil {
		if l, err = s.saleLayout(r.Context(), s.DB, sale); err == nil {
			prices, _ = s.salePrices(r.Context(), s.DB, sale, l)
		}
	}
	tks, err := s.orderTickets(r, id, l, prices, false)
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	m, _ := s.matchSummary(r, o.MatchID)
	history := []map[string]any{{"at": o.CreatedAt, "text": "Buyurtma yaratildi", "kind": "info"}}
	if o.PaidAt != nil {
		history = append(history, map[string]any{"at": o.PaidAt, "text": "To‘lov qabul qilindi — " + o.Provider, "kind": "ok"})
	}
	rrows, err := s.DB.QueryContext(r.Context(), `SELECT r.created_at, r.amount, r.reason, r.status, COALESCE(u.name,'') FROM ticket_refunds r
		LEFT JOIN users u ON u.id=r.created_by WHERE r.order_id=$1 ORDER BY r.created_at`, id)
	if err == nil {
		for rrows.Next() {
			var at time.Time
			var amount int64
			var why, st, who string
			_ = rrows.Scan(&at, &amount, &why, &st, &who)
			history = append(history, map[string]any{"at": at, "text": "Qaytarish " + strconv.FormatInt(amount, 10) + " so‘m — " + why + " (" + who + ")", "kind": "refund", "status": st})
		}
		rrows.Close()
	}
	srows, err := s.DB.QueryContext(r.Context(), `SELECT sc.created_at, sc.result, sc.gate, t.number FROM ticket_scans sc JOIN tickets t ON t.id=sc.ticket_id
		WHERE t.order_id=$1 ORDER BY sc.created_at`, id)
	if err == nil {
		for srows.Next() {
			var at time.Time
			var res, gate, num string
			_ = srows.Scan(&at, &res, &gate, &num)
			history = append(history, map[string]any{"at": at, "text": "Skan " + num + " · " + gate + " · " + res, "kind": "scan"})
		}
		srows.Close()
	}
	httpx.JSON(w, 200, map[string]any{"order": o, "email": email, "telegram": telegram, "provider_txn": txn, "card_mask": card,
		"cancel_reason": reason, "tickets": tks, "match": m, "history": history,
		"refund_deadline": refundDeadline(sale, m)})
}

func refundDeadline(sale *ticketSale, m map[string]any) *time.Time {
	if sale == nil || m == nil {
		return nil
	}
	k, _ := m["kickoff_at"].(*time.Time)
	if k == nil {
		return nil
	}
	t := k.Add(-time.Duration(sale.RefundHours) * time.Hour)
	return &t
}

// refundTicketOrder cancels chosen tickets of an order. Cash / test orders are
// refunded at once; card payments are recorded as «requested» until the money
// is returned in the payment system's merchant cabinet.
func (s *Server) refundTicketOrder(w http.ResponseWriter, r *http.Request) {
	id, err := idParam(r, "id")
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	var in struct {
		TicketIDs []int64 `json:"ticket_ids"`
		Reason    string  `json:"reason"`
	}
	if err := httpx.Decode(r, &in); err != nil {
		httpx.Fail(w, r, err)
		return
	}
	if len(in.TicketIDs) == 0 {
		httpx.Fail(w, r, httpx.BadRequest("Qaytariladigan chiptalarni tanlang"))
		return
	}
	ctx := r.Context()
	tx, err := s.DB.BeginTx(ctx, nil)
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	defer tx.Rollback()
	var status, provider string
	var total, refunded int64
	if err := tx.QueryRowContext(ctx, `SELECT status, provider, total, refunded FROM ticket_orders WHERE id=$1 FOR UPDATE`, id).Scan(&status, &provider, &total, &refunded); err != nil {
		httpx.Fail(w, r, httpx.ErrNotFound)
		return
	}
	if status != "paid" && status != "refund_requested" && status != "partially_refunded" {
		httpx.Fail(w, r, httpx.BadRequest("Bu buyurtmani qaytarib bo‘lmaydi"))
		return
	}
	var amount int64
	var ids []int64
	rows, err := tx.QueryContext(ctx, `UPDATE tickets SET status='refunded' WHERE order_id=$1 AND id = ANY($2) AND status='active' RETURNING id, price`, id, pq.Array(in.TicketIDs))
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	for rows.Next() {
		var tid, p int64
		_ = rows.Scan(&tid, &p)
		ids = append(ids, tid)
		amount += p
	}
	rows.Close()
	if len(ids) == 0 {
		httpx.Fail(w, r, httpx.BadRequest("Tanlangan chiptalar faol emas (ishlatilgan yoki allaqachon qaytarilgan)"))
		return
	}
	var left int
	_ = tx.QueryRowContext(ctx, `SELECT count(*) FROM tickets WHERE order_id=$1 AND status IN ('active','used')`, id).Scan(&left)
	newStatus := "partially_refunded"
	if left == 0 {
		newStatus = "refunded"
		var fee int64
		_ = tx.QueryRowContext(ctx, `SELECT service_fee FROM ticket_orders WHERE id=$1`, id).Scan(&fee)
		amount += fee
	}
	rstatus := "requested"
	if provider == "cash" || provider == "test" {
		rstatus = "done"
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO ticket_refunds(order_id, ticket_ids, amount, reason, status, created_by) VALUES ($1,$2,$3,$4,$5,$6)`,
		id, pq.Array(ids), amount, strings.TrimSpace(in.Reason), rstatus, userIDPtr(r)); err != nil {
		httpx.Fail(w, r, err)
		return
	}
	if _, err := tx.ExecContext(ctx, `UPDATE ticket_orders SET status=$2, refunded=refunded+$3, updated_at=now() WHERE id=$1`, id, newStatus, amount); err != nil {
		httpx.Fail(w, r, err)
		return
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM ticket_faces WHERE ticket_id = ANY($1)`, pq.Array(ids)); err != nil {
		httpx.Fail(w, r, err)
		return
	}
	if err := tx.Commit(); err != nil {
		httpx.Fail(w, r, err)
		return
	}
	s.audit(r, "refund", "ticket_order", id, map[string]any{"tickets": ids, "amount": amount, "reason": in.Reason})
	note := ""
	if rstatus == "requested" {
		note = "Pulni " + provider + " kabinetida qaytaring — chiptalar bekor qilindi, o‘rinlar sotuvga qaytdi"
	}
	httpx.JSON(w, 200, map[string]any{"refunded": amount, "tickets": ids, "status": newStatus, "refund_status": rstatus, "note": note})
}

func (s *Server) resendTicketOrder(w http.ResponseWriter, r *http.Request) {
	id, err := idParam(r, "id")
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	var st string
	if err := s.DB.QueryRowContext(r.Context(), `SELECT status FROM ticket_orders WHERE id=$1`, id).Scan(&st); err != nil {
		httpx.Fail(w, r, httpx.ErrNotFound)
		return
	}
	if st != "paid" && st != "partially_refunded" {
		httpx.Fail(w, r, httpx.BadRequest("To‘lanmagan buyurtma"))
		return
	}
	if s.sms == nil || !s.sms.Enabled() {
		httpx.Fail(w, r, httpx.BadRequest("SMS yuborish sozlanmagan"))
		return
	}
	s.afterPaid(id)
	s.audit(r, "resend", "ticket_order", id, nil)
	httpx.JSON(w, 200, map[string]any{"ok": true})
}

func (s *Server) boxOfficeOrder(w http.ResponseWriter, r *http.Request) {
	var in struct {
		MatchID int64       `json:"match_id"`
		Items   []orderItem `json:"items"`
		Name    string      `json:"buyer_name"`
		Phone   string      `json:"phone"`
	}
	if err := httpx.Decode(r, &in); err != nil {
		httpx.Fail(w, r, err)
		return
	}
	phone, ok := auth.NormalizePhone(in.Phone)
	if !ok || strings.TrimSpace(in.Name) == "" {
		httpx.Fail(w, r, httpx.Validation(map[string]any{"phone": "Ism va telefon kerak"}))
		return
	}
	sale, err := s.saleByMatch(r.Context(), s.DB, in.MatchID, false)
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	if !sale.BoxOffice {
		httpx.Fail(w, r, httpx.BadRequest("Bu match uchun kassada sotuv yoqilmagan"))
		return
	}
	co, err := s.createOrder(r.Context(), newOrder{MatchID: in.MatchID, Items: in.Items, Name: strings.TrimSpace(in.Name), Phone: phone,
		Provider: "cash", Source: "box_office", By: userIDPtr(r)})
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	s.audit(r, "box_office", "ticket_order", co.ID, map[string]any{"total": co.Total})
	s.afterPaid(co.ID)
	httpx.JSON(w, 201, co)
}

func (s *Server) listTicketScans(w http.ResponseWriter, r *http.Request) {
	mid, _ := strconv.ParseInt(r.URL.Query().Get("match_id"), 10, 64)
	onlyBad := r.URL.Query().Get("suspicious") == "1"
	cond := ""
	if onlyBad {
		cond = " AND sc.result NOT IN ('ok','face_ok','document')"
	}
	rows, err := s.DB.QueryContext(r.Context(), `SELECT sc.id, sc.created_at, sc.result, sc.gate, sc.score, sc.detail, COALESCE(t.number,''),
		COALESCE(u.name,'') FROM ticket_scans sc JOIN ticket_sales ts ON ts.id=sc.sale_id LEFT JOIN tickets t ON t.id=sc.ticket_id
		LEFT JOIN users u ON u.id=sc.scanner_id WHERE ts.match_id=$1`+cond+` ORDER BY sc.created_at DESC LIMIT 200`, mid)
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	defer rows.Close()
	out := []map[string]any{}
	for rows.Next() {
		var id int64
		var at time.Time
		var res, gate, detail, num, who string
		var score sql.NullInt64
		if err := rows.Scan(&id, &at, &res, &gate, &score, &detail, &num, &who); err != nil {
			httpx.Fail(w, r, err)
			return
		}
		x := map[string]any{"id": id, "at": at, "result": res, "gate": gate, "detail": detail, "ticket": num, "scanner": who}
		if score.Valid {
			x["score"] = score.Int64
		}
		out = append(out, x)
	}
	httpx.JSON(w, 200, map[string]any{"items": out})
}
