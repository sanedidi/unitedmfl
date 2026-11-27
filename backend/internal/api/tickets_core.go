package api

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"github.com/lib/pq"

	"github.com/sanedidi/unitedmfl/backend/internal/httpx"
	"github.com/sanedidi/unitedmfl/backend/internal/tickets"
)

// Shared ticket logic: sale settings, order creation with seat holds,
// payment confirmation and delivery.

type ticketSale struct {
	ID             int64      `json:"id"`
	MatchID        int64      `json:"match_id"`
	LayoutID       *int64     `json:"layout_id"`
	Status         string     `json:"status"`
	SaleFrom       *time.Time `json:"sale_from"`
	SaleTo         *time.Time `json:"sale_to"`
	HoldMinutes    int        `json:"hold_minutes"`
	MaxPerOrder    int        `json:"max_per_order"`
	RefundHours    int        `json:"refund_hours"`
	ServiceFee     int64      `json:"service_fee"`
	TelegramDeliv  bool       `json:"telegram_delivery"`
	BoxOffice      bool       `json:"box_office"`
	DynamicQR      bool       `json:"dynamic_qr"`
	SingleScan     bool       `json:"single_scan"`
	FaceMode       string     `json:"face_mode"`
	FaceCheck      string     `json:"face_check"`
	FaceThreshold  int        `json:"face_threshold"`
	ActivationHrs  int        `json:"activation_hours"`
	TransferOK     bool       `json:"transfer_allowed"`
	NoFaceEntry    bool       `json:"no_face_entry"`
	FaceRetainDays int        `json:"face_retention_days"`
	OpenedAt       *time.Time `json:"opened_at"`
	UpdatedAt      time.Time  `json:"updated_at"`
}

const saleCols = `id, match_id, layout_id, status, sale_from, sale_to, hold_minutes, max_per_order, refund_hours, service_fee,
	telegram_delivery, box_office, dynamic_qr, single_scan, face_mode, face_check, face_threshold, activation_hours,
	transfer_allowed, no_face_entry, face_retention_days, opened_at, updated_at`

func scanSale(sc interface{ Scan(...any) error }) (*ticketSale, error) {
	var t ticketSale
	var layout sql.NullInt64
	var from, to, opened sql.NullTime
	if err := sc.Scan(&t.ID, &t.MatchID, &layout, &t.Status, &from, &to, &t.HoldMinutes, &t.MaxPerOrder, &t.RefundHours, &t.ServiceFee,
		&t.TelegramDeliv, &t.BoxOffice, &t.DynamicQR, &t.SingleScan, &t.FaceMode, &t.FaceCheck, &t.FaceThreshold, &t.ActivationHrs,
		&t.TransferOK, &t.NoFaceEntry, &t.FaceRetainDays, &opened, &t.UpdatedAt); err != nil {
		return nil, err
	}
	if layout.Valid {
		t.LayoutID = &layout.Int64
	}
	t.SaleFrom, t.SaleTo, t.OpenedAt = nullTime(from), nullTime(to), nullTime(opened)
	return &t, nil
}

func (s *Server) saleByMatch(ctx context.Context, q queryer, matchID int64, lock bool) (*ticketSale, error) {
	sqlq := `SELECT ` + saleCols + ` FROM ticket_sales WHERE match_id=$1`
	if lock {
		sqlq += ` FOR UPDATE`
	}
	t, err := scanSale(q.QueryRowContext(ctx, sqlq, matchID))
	if errors.Is(err, sql.ErrNoRows) {
		return nil, httpx.ErrNotFound
	}
	return t, err
}

type queryer interface {
	QueryRowContext(ctx context.Context, query string, args ...any) *sql.Row
	QueryContext(ctx context.Context, query string, args ...any) (*sql.Rows, error)
	ExecContext(ctx context.Context, query string, args ...any) (sql.Result, error)
}

func (s *Server) saleLayout(ctx context.Context, q queryer, sale *ticketSale) (*tickets.Layout, error) {
	if sale.LayoutID == nil {
		return nil, httpx.BadRequest("Matchga stadion sxemasi tanlanmagan")
	}
	var doc []byte
	if err := q.QueryRowContext(ctx, `SELECT doc FROM venue_layouts WHERE id=$1`, *sale.LayoutID).Scan(&doc); err != nil {
		return nil, err
	}
	return tickets.Parse(doc)
}

// ---------- zone prices ----------

type zonePrice struct {
	ZoneKey  string   `json:"zone_key"`
	Title    string   `json:"title"`
	Subtitle string   `json:"subtitle"`
	Price    int64    `json:"price"`
	Enabled  bool     `json:"enabled"`
	Named    bool     `json:"named"`
	Perks    []string `json:"perks"`
	Gate     string   `json:"gate"`
	Sort     int      `json:"sort"`
	// derived from the layout and the tickets
	Kind       string   `json:"kind"`
	Color      string   `json:"color"`
	Mode       string   `json:"mode"` // free | numbered
	Capacity   int      `json:"capacity"`
	Sold       int      `json:"sold"` // paid + used
	Held       int      `json:"held"` // pending (awaiting payment)
	Left       int      `json:"left"`
	Sections   []string `json:"sections"`
	Configured bool     `json:"configured"`
}

// salePrices merges the layout zones with the saved prices and live counters.
func (s *Server) salePrices(ctx context.Context, q queryer, sale *ticketSale, l *tickets.Layout) ([]zonePrice, error) {
	saved := map[string]zonePrice{}
	rows, err := q.QueryContext(ctx, `SELECT zone_key, title, subtitle, price, enabled, named, perks, gate, sort
		FROM ticket_zone_prices WHERE sale_id=$1`, sale.ID)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var z zonePrice
		if err := rows.Scan(&z.ZoneKey, &z.Title, &z.Subtitle, &z.Price, &z.Enabled, &z.Named, pq.Array(&z.Perks), &z.Gate, &z.Sort); err != nil {
			rows.Close()
			return nil, err
		}
		z.Configured = true
		saved[z.ZoneKey] = z
	}
	rows.Close()
	counts := map[string][2]int{}
	crow, err := q.QueryContext(ctx, `SELECT zone_key, count(*) FILTER (WHERE status IN ('active','used')), count(*) FILTER (WHERE status='pending')
		FROM tickets WHERE sale_id=$1 GROUP BY zone_key`, sale.ID)
	if err != nil {
		return nil, err
	}
	for crow.Next() {
		var k string
		var a, b int
		if err := crow.Scan(&k, &a, &b); err != nil {
			crow.Close()
			return nil, err
		}
		counts[k] = [2]int{a, b}
	}
	crow.Close()
	stats := l.Stats()
	out := []zonePrice{}
	for i, z := range l.Zones {
		p, ok := saved[z.Key]
		if !ok {
			p = zonePrice{ZoneKey: z.Key, Title: z.Name, Enabled: true, Named: z.Kind == "vip", Perks: []string{}, Sort: i}
		}
		if p.Title == "" {
			p.Title = z.Name
		}
		if p.Perks == nil {
			p.Perks = []string{}
		}
		if p.Gate == "" {
			p.Gate = l.FirstGate(z.Key)
		}
		p.Kind, p.Color, p.Mode = z.Kind, z.Color, l.ZoneMode(z.Key)
		p.Capacity = stats.ByZone[z.Key]
		c := counts[z.Key]
		p.Sold, p.Held = c[0], c[1]
		p.Left = max(p.Capacity-p.Sold-p.Held, 0)
		p.Sections = l.ZoneSections(z.Key)
		if p.Sections == nil {
			p.Sections = []string{}
		}
		out = append(out, p)
	}
	return out, nil
}

// ---------- orders ----------

type orderItem struct {
	Zone    string   `json:"zone"`
	Qty     int      `json:"qty"`
	Holders []string `json:"holders"` // names for named zones (VIP), one per ticket
	Seats   []string `json:"seats"`   // optional explicit seat ids (box office)
}

type newOrder struct {
	MatchID  int64
	Items    []orderItem
	Name     string
	Phone    string
	Email    string
	Telegram bool
	Provider string
	Source   string // site | box_office
	By       *int64
}

type createdOrder struct {
	ID        int64     `json:"id"`
	Number    string    `json:"number"`
	Token     string    `json:"access_token"`
	Total     int64     `json:"total"`
	HoldUntil time.Time `json:"hold_until"`
}

func randToken(n int) string {
	b := make([]byte, n)
	_, _ = rand.Read(b)
	return base64.RawURLEncoding.EncodeToString(b)
}

var errSoldOut = httpx.NewError(409, "sold_out", "Tanlangan zonada chiptalar yetarli emas")

// createOrder holds the seats and creates a pending order (or a paid one for
// the box office) in a single transaction.
func (s *Server) createOrder(ctx context.Context, in newOrder) (*createdOrder, error) {
	tx, err := s.DB.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	sale, err := s.saleByMatch(ctx, tx, in.MatchID, true) // serialises orders of one match
	if err != nil {
		return nil, err
	}
	now := time.Now()
	if in.Source != "box_office" {
		if sale.Status != "open" || (sale.SaleFrom != nil && now.Before(*sale.SaleFrom)) || (sale.SaleTo != nil && now.After(*sale.SaleTo)) {
			return nil, httpx.NewError(409, "closed", "Bu match uchun chipta sotuvi yopiq")
		}
	}
	l, err := s.saleLayout(ctx, tx, sale)
	if err != nil {
		return nil, err
	}
	prices, err := s.salePrices(ctx, tx, sale, l)
	if err != nil {
		return nil, err
	}
	byZone := map[string]zonePrice{}
	for _, p := range prices {
		byZone[p.ZoneKey] = p
	}
	var kickoff sql.NullTime
	_ = tx.QueryRowContext(ctx, `SELECT kickoff_at FROM matches WHERE id=$1`, in.MatchID).Scan(&kickoff)
	type planned struct {
		zone   zonePrice
		seat   *tickets.Seat
		holder string
	}
	var plan []planned
	total, count := int64(0), 0
	for _, it := range in.Items {
		if it.Qty <= 0 {
			continue
		}
		z, ok := byZone[it.Zone]
		if !ok || !z.Enabled || z.Price <= 0 && in.Source != "box_office" {
			return nil, httpx.BadRequest("Zona sotuvda emas: " + it.Zone)
		}
		count += it.Qty
		if z.Left < it.Qty {
			return nil, errSoldOut
		}
		holders := make([]string, it.Qty)
		for i := range holders {
			if i < len(it.Holders) {
				holders[i] = strings.TrimSpace(it.Holders[i])
			}
			if holders[i] == "" && z.Named && i == 0 {
				holders[i] = strings.TrimSpace(in.Name)
			}
		}
		if z.Mode == "numbered" {
			seats, err := s.pickSeats(ctx, tx, sale, l, it)
			if err != nil {
				return nil, err
			}
			for i := range seats {
				plan = append(plan, planned{z, &seats[i], holders[i]})
			}
		} else {
			for i := 0; i < it.Qty; i++ {
				plan = append(plan, planned{z, nil, holders[i]})
			}
		}
		total += z.Price * int64(it.Qty)
	}
	if count == 0 {
		return nil, httpx.BadRequest("Chipta tanlanmagan")
	}
	if count > sale.MaxPerOrder && in.Source != "box_office" {
		return nil, httpx.BadRequest(fmt.Sprintf("Bitta buyurtmada %d tadan ko‘p chipta bo‘lmaydi", sale.MaxPerOrder))
	}
	fee := sale.ServiceFee * int64(count)
	total += fee
	status, hold := "pending", now.Add(time.Duration(sale.HoldMinutes)*time.Minute)
	if in.Source == "box_office" {
		status = "paid"
	}
	co := &createdOrder{Token: randToken(24), Total: total, HoldUntil: hold}
	err = tx.QueryRowContext(ctx, `INSERT INTO ticket_orders(number, sale_id, buyer_name, phone, email, telegram, status, total, service_fee,
		provider, source, access_token, hold_until, paid_at, created_by)
		VALUES ('tmp-'||$11, $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, CASE WHEN $6='paid' THEN now() END, $13) RETURNING id`,
		sale.ID, in.Name, in.Phone, in.Email, in.Telegram, status, total, fee, in.Provider, in.Source, co.Token, hold, in.By).Scan(&co.ID)
	if err != nil {
		return nil, err
	}
	co.Number = fmt.Sprintf("UMFL-%06d", co.ID)
	if _, err := tx.ExecContext(ctx, `UPDATE ticket_orders SET number=$2 WHERE id=$1`, co.ID, co.Number); err != nil {
		return nil, err
	}
	tstatus := "pending"
	if status == "paid" {
		tstatus = "active"
	}
	md := "0000"
	if kickoff.Valid {
		md = kickoff.Time.In(tashkent).Format("0102")
	}
	for _, p := range plan {
		var seatID any
		sec, row, gate := "", "", p.zone.Gate
		var seatNo any
		if p.seat != nil {
			seatID, sec, row, seatNo = p.seat.ID, p.seat.Section, p.seat.Row, p.seat.N
			if g := l.Section(sec); g != nil && g.Gate != "" {
				gate = g.Gate
			}
		} else if secs := p.zone.Sections; len(secs) > 0 {
			sec = strings.Join(secs, ", ")
			if len(sec) > 40 {
				sec = secs[0] + "…"
			}
		}
		var tid int64
		err := tx.QueryRowContext(ctx, `INSERT INTO tickets(order_id, sale_id, number, zone_key, seat_id, section_key, row_label, seat_no, gate, price,
			holder_name, status, qr_secret, holder_token) VALUES ($1,$2,'tmp-'||$12,$3,$4,$5,$6,$7,$8,$9,$10,$11,$13,$12) RETURNING id`,
			co.ID, sale.ID, p.zone.ZoneKey, seatID, sec, row, seatNo, gate, p.zone.Price, p.holder, tstatus, randToken(18), tickets.NewSecret()).Scan(&tid)
		if err != nil {
			var pe *pq.Error
			if errors.As(err, &pe) && pe.Code == "23505" {
				return nil, errSoldOut
			}
			return nil, err
		}
		tag := strings.ToUpper(p.zone.ZoneKey)
		if len(tag) > 6 {
			tag = tag[:6]
		}
		if _, err := tx.ExecContext(ctx, `UPDATE tickets SET number=$2 WHERE id=$1`, tid, fmt.Sprintf("UMFL-%s-%s-%05d", md, tag, tid)); err != nil {
			return nil, err
		}
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return co, nil
}

// pickSeats chooses the best free seats of a numbered zone (or checks the
// explicit ones), next to each other when possible.
func (s *Server) pickSeats(ctx context.Context, q queryer, sale *ticketSale, l *tickets.Layout, it orderItem) ([]tickets.Seat, error) {
	taken := map[string]bool{}
	rows, err := q.QueryContext(ctx, `SELECT seat_id FROM tickets WHERE sale_id=$1 AND seat_id IS NOT NULL AND status IN ('pending','active','used')`, sale.ID)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return nil, err
		}
		taken[id] = true
	}
	rows.Close()
	if len(it.Seats) > 0 {
		if len(it.Seats) != it.Qty {
			return nil, httpx.BadRequest("O‘rinlar soni chiptalar soniga teng emas")
		}
		var out []tickets.Seat
		for _, id := range it.Seats {
			sec, row, n, _ := tickets.ParseSeatID(id)
			if !l.IsSellable(id) || taken[id] || l.Section(sec) == nil || l.SeatZone(id) != it.Zone {
				return nil, httpx.NewError(409, "seat_taken", id+" o‘rni band yoki mavjud emas")
			}
			taken[id] = true
			out = append(out, tickets.Seat{ID: id, Section: sec, Row: row, N: n})
		}
		return out, nil
	}
	var free []tickets.Seat
	for _, st := range l.SellableSeats(it.Zone) {
		if !taken[st.ID] {
			free = append(free, st)
		}
	}
	if len(free) < it.Qty {
		return nil, errSoldOut
	}
	// prefer a run of adjacent seats in one row (best rows first)
	byRow := map[string][]tickets.Seat{}
	var order []string
	for _, st := range free {
		k := st.Section + ":" + st.Row
		if _, ok := byRow[k]; !ok {
			order = append(order, k)
		}
		byRow[k] = append(byRow[k], st)
	}
	for _, k := range order {
		seats := byRow[k]
		nums := map[int]tickets.Seat{}
		lo, hi := 1<<30, 0
		for _, st := range seats {
			nums[st.N] = st
			lo, hi = min(lo, st.N), max(hi, st.N)
		}
		sec, _, _, _ := tickets.ParseSeatID(seats[0].ID)
		mid := float64(lo+hi) / 2
		if s := l.Section(sec); s != nil {
			for _, r := range s.Rows {
				if r.Label == seats[0].Row {
					mid = float64(r.Seats+1) / 2
				}
			}
		}
		var best []tickets.Seat
		bestD := 1e9
		for start := lo; start+it.Qty-1 <= hi; start++ {
			run := []tickets.Seat{}
			for n := start; n < start+it.Qty; n++ {
				if x, ok := nums[n]; ok {
					run = append(run, x)
				}
			}
			if len(run) != it.Qty {
				continue
			}
			c := float64(2*start+it.Qty-1) / 2
			if d := abs64(c - mid); d < bestD {
				best, bestD = run, d
			}
		}
		if best != nil {
			return best, nil
		}
	}
	return free[:it.Qty], nil
}

// markPaid turns a pending order into a paid one and activates its tickets.
// Idempotent; returns false when the order can't be paid any more.
func (s *Server) markPaid(ctx context.Context, q queryer, orderID int64, provider, txn, cardMask string) (bool, error) {
	res, err := q.ExecContext(ctx, `UPDATE ticket_orders SET status='paid', paid_at=now(), provider=$2, provider_txn=$3,
		card_mask=CASE WHEN $4 <> '' THEN $4 ELSE card_mask END, updated_at=now()
		WHERE id=$1 AND status='pending'`, orderID, provider, txn, cardMask)
	if err != nil {
		return false, err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		var st string
		_ = q.QueryRowContext(ctx, `SELECT status FROM ticket_orders WHERE id=$1`, orderID).Scan(&st)
		return st == "paid", nil
	}
	if _, err := q.ExecContext(ctx, `UPDATE tickets SET status='active' WHERE order_id=$1 AND status='pending'`, orderID); err != nil {
		return false, err
	}
	return true, nil
}

// afterPaid notifies the buyer (SMS with the order link).
func (s *Server) afterPaid(orderID int64) {
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		var phone, token, number string
		if err := s.DB.QueryRowContext(ctx, `SELECT phone, access_token, number FROM ticket_orders WHERE id=$1`, orderID).Scan(&phone, &token, &number); err != nil {
			return
		}
		if s.sms == nil || !s.sms.Enabled() || s.Cfg.SiteURL == "" {
			return
		}
		text := fmt.Sprintf("United MFL: %s buyurtma to‘landi. Chiptalaringiz: %s/chiptalar/%s", number, s.Cfg.SiteURL, token)
		if err := s.sms.Send(ctx, phone, text); err != nil {
			slog.Warn("ticket sms", "order", orderID, "err", err)
		}
	}()
}

// ---------- face photos ----------

func (s *Server) faceAEAD() cipher.AEAD {
	key := sha256.Sum256(append([]byte("ticket-faces:"), stickerSecret(s.Cfg)...))
	block, _ := aes.NewCipher(key[:])
	aead, _ := cipher.NewGCM(block)
	return aead
}

func (s *Server) sealFace(b []byte) []byte {
	a := s.faceAEAD()
	nonce := make([]byte, a.NonceSize())
	_, _ = rand.Read(nonce)
	return a.Seal(nonce, nonce, b, nil)
}

func (s *Server) openFace(b []byte) ([]byte, error) {
	a := s.faceAEAD()
	if len(b) < a.NonceSize() {
		return nil, errors.New("short")
	}
	return a.Open(nil, b[:a.NonceSize()], b[a.NonceSize():], nil)
}

// faceRequired: does this ticket need a bound face under the sale settings?
func faceRequired(sale *ticketSale, zoneKind string) bool {
	return sale.FaceMode == "all" || (sale.FaceMode == "vip" && zoneKind == "vip")
}

func zoneKind(l *tickets.Layout, key string) string {
	for _, z := range l.Zones {
		if z.Key == key {
			return z.Kind
		}
	}
	return "oddiy"
}

func zoneName(l *tickets.Layout, key string) string {
	for _, z := range l.Zones {
		if z.Key == key {
			return z.Name
		}
	}
	return key
}

func mustJSON(v any) []byte {
	b, _ := json.Marshal(v)
	return b
}

func abs64(f float64) float64 {
	if f < 0 {
		return -f
	}
	return f
}
