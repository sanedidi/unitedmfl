package api

import (
	"context"
	"crypto/md5"
	"crypto/subtle"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
)

// Payment providers for match tickets: Payme (Merchant API, JSON-RPC) and
// Click (Shop API, prepare/complete). Both call us back; the order is paid
// only after their «perform»/«complete». Amounts: Payme in tiyin, Click in so‘m.

func (s *Server) mountPayments(r chi.Router) {
	r.Post("/pay/payme", s.paymeRPC)
	r.Post("/pay/click/prepare", s.clickPrepare)
	r.Post("/pay/click/complete", s.clickComplete)
}

func (s *Server) payLog(ctx context.Context, provider string, orderID int64, method string, req, resp any) {
	var oid any
	if orderID > 0 {
		oid = orderID
	}
	_, _ = s.DB.ExecContext(ctx, `INSERT INTO ticket_payment_log(provider, order_id, method, request, response) VALUES ($1,$2,$3,$4,$5)`,
		provider, oid, method, mustJSON(req), mustJSON(resp))
}

func (s *Server) paymeCheckoutURL(orderID, total int64, ret string) string {
	params := fmt.Sprintf("m=%s;ac.order_id=%d;a=%d;c=%s", s.Cfg.PaymeMerchantID, orderID, total*100, ret)
	return s.Cfg.PaymeCheckoutURL + "/" + base64.StdEncoding.EncodeToString([]byte(params))
}

func (s *Server) clickCheckoutURL(orderID, total int64, ret string) string {
	q := url.Values{}
	q.Set("service_id", s.Cfg.ClickServiceID)
	q.Set("merchant_id", s.Cfg.ClickMerchantID)
	q.Set("amount", strconv.FormatInt(total, 10))
	q.Set("transaction_param", strconv.FormatInt(orderID, 10))
	q.Set("return_url", ret)
	return "https://my.click.uz/services/pay?" + q.Encode()
}

// ---------- Payme ----------

type paymeState struct {
	ID          string `json:"id"`
	Time        int64  `json:"time"`
	CreateTime  int64  `json:"create_time"`
	PerformTime int64  `json:"perform_time"`
	CancelTime  int64  `json:"cancel_time"`
	State       int    `json:"state"`
	Reason      *int   `json:"reason"`
}

type rpcErr struct {
	Code    int               `json:"code"`
	Message map[string]string `json:"message"`
	Data    string            `json:"data,omitempty"`
}

func perr(code int, uz string, data string) *rpcErr {
	return &rpcErr{Code: code, Message: map[string]string{"uz": uz, "ru": uz, "en": uz}, Data: data}
}

func (s *Server) paymeRPC(w http.ResponseWriter, r *http.Request) {
	var req struct {
		ID     any             `json:"id"`
		Method string          `json:"method"`
		Params json.RawMessage `json:"params"`
	}
	reply := func(result any, e *rpcErr) {
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		out := map[string]any{"jsonrpc": "2.0", "id": req.ID}
		if e != nil {
			out["error"] = e
		} else {
			out["result"] = result
		}
		_ = json.NewEncoder(w).Encode(out)
	}
	body, _ := io.ReadAll(io.LimitReader(r.Body, 1<<20))
	if err := json.Unmarshal(body, &req); err != nil {
		reply(nil, perr(-32700, "Parse error", ""))
		return
	}
	user, pass, ok := r.BasicAuth()
	if !ok || s.Cfg.PaymeKey == "" || user != "Paycom" || subtle.ConstantTimeCompare([]byte(pass), []byte(s.Cfg.PaymeKey)) != 1 {
		reply(nil, perr(-32504, "Ruxsat yo‘q", ""))
		return
	}
	var p struct {
		ID      string         `json:"id"`
		Time    int64          `json:"time"`
		Amount  int64          `json:"amount"`
		Account map[string]any `json:"account"`
		Reason  *int           `json:"reason"`
		From    int64          `json:"from"`
		To      int64          `json:"to"`
	}
	_ = json.Unmarshal(req.Params, &p)
	ctx := r.Context()
	var result any
	var e *rpcErr
	var orderID int64
	switch req.Method {
	case "CheckPerformTransaction":
		orderID, e = s.paymeCheckOrder(ctx, p.Account, p.Amount)
		if e == nil {
			result = map[string]any{"allow": true}
		}
	case "CreateTransaction":
		orderID, result, e = s.paymeCreate(ctx, p.ID, p.Time, p.Amount, p.Account)
	case "PerformTransaction":
		orderID, result, e = s.paymePerform(ctx, p.ID)
	case "CancelTransaction":
		orderID, result, e = s.paymeCancel(ctx, p.ID, p.Reason)
	case "CheckTransaction":
		var st paymeState
		orderID, st, e = s.paymeFind(ctx, p.ID)
		if e == nil {
			result = map[string]any{"create_time": st.CreateTime, "perform_time": st.PerformTime, "cancel_time": st.CancelTime,
				"transaction": strconv.FormatInt(orderID, 10), "state": st.State, "reason": st.Reason}
		}
	case "GetStatement":
		result, e = s.paymeStatement(ctx, p.From, p.To)
	default:
		e = perr(-32601, "Metod topilmadi", req.Method)
	}
	s.payLog(ctx, "payme", orderID, req.Method, json.RawMessage(body), map[string]any{"result": result, "error": e})
	reply(result, e)
}

func accountOrder(acc map[string]any) int64 {
	switch v := acc["order_id"].(type) {
	case string:
		id, _ := strconv.ParseInt(v, 10, 64)
		return id
	case float64:
		return int64(v)
	}
	return 0
}

func (s *Server) paymeCheckOrder(ctx context.Context, acc map[string]any, amount int64) (int64, *rpcErr) {
	id := accountOrder(acc)
	var status string
	var total int64
	var hold sql.NullTime
	if err := s.DB.QueryRowContext(ctx, `SELECT status, total, hold_until FROM ticket_orders WHERE id=$1`, id).Scan(&status, &total, &hold); err != nil {
		return 0, perr(-31050, "Buyurtma topilmadi", "order_id")
	}
	if total*100 != amount {
		return id, perr(-31001, "Summa noto‘g‘ri", "")
	}
	if status != "pending" || (hold.Valid && time.Now().After(hold.Time)) {
		return id, perr(-31051, "Buyurtmani to‘lab bo‘lmaydi", "order_id")
	}
	return id, nil
}

func (s *Server) paymeFind(ctx context.Context, txn string) (int64, paymeState, *rpcErr) {
	var id int64
	var raw []byte
	err := s.DB.QueryRowContext(ctx, `SELECT id, provider_state FROM ticket_orders WHERE provider='payme' AND provider_txn=$1`, txn).Scan(&id, &raw)
	var st paymeState
	if err != nil || txn == "" {
		return 0, st, perr(-31003, "Tranzaksiya topilmadi", "")
	}
	_ = json.Unmarshal(raw, &st)
	return id, st, nil
}

func (s *Server) savePayme(ctx context.Context, q queryer, orderID int64, st paymeState) error {
	_, err := q.ExecContext(ctx, `UPDATE ticket_orders SET provider='payme', provider_txn=$2, provider_state=$3, updated_at=now() WHERE id=$1`,
		orderID, st.ID, mustJSON(st))
	return err
}

func (s *Server) paymeCreate(ctx context.Context, txn string, t, amount int64, acc map[string]any) (int64, any, *rpcErr) {
	if id, st, e := s.paymeFind(ctx, txn); e == nil {
		if st.State != 1 {
			return id, nil, perr(-31008, "Tranzaksiyani bajarib bo‘lmaydi", "")
		}
		return id, map[string]any{"create_time": st.CreateTime, "transaction": strconv.FormatInt(id, 10), "state": st.State}, nil
	}
	id, e := s.paymeCheckOrder(ctx, acc, amount)
	if e != nil {
		return id, nil, e
	}
	var cur string
	var raw []byte
	_ = s.DB.QueryRowContext(ctx, `SELECT provider_txn, provider_state FROM ticket_orders WHERE id=$1`, id).Scan(&cur, &raw)
	var other paymeState
	_ = json.Unmarshal(raw, &other)
	if cur != "" && cur != txn && other.State == 1 {
		return id, nil, perr(-31050, "Buyurtma boshqa tranzaksiyada kutilmoqda", "order_id")
	}
	st := paymeState{ID: txn, Time: t, CreateTime: time.Now().UnixMilli(), State: 1}
	if err := s.savePayme(ctx, s.DB, id, st); err != nil {
		return id, nil, perr(-32400, "Ichki xato", "")
	}
	return id, map[string]any{"create_time": st.CreateTime, "transaction": strconv.FormatInt(id, 10), "state": 1}, nil
}

func (s *Server) paymePerform(ctx context.Context, txn string) (int64, any, *rpcErr) {
	id, st, e := s.paymeFind(ctx, txn)
	if e != nil {
		return 0, nil, e
	}
	if st.State == 2 {
		return id, map[string]any{"transaction": strconv.FormatInt(id, 10), "perform_time": st.PerformTime, "state": 2}, nil
	}
	if st.State != 1 {
		return id, nil, perr(-31008, "Tranzaksiyani bajarib bo‘lmaydi", "")
	}
	tx, err := s.DB.BeginTx(ctx, nil)
	if err != nil {
		return id, nil, perr(-32400, "Ichki xato", "")
	}
	defer tx.Rollback()
	ok, err := s.markPaid(ctx, tx, id, "payme", txn, "")
	if err != nil || !ok {
		st.State, st.CancelTime = -1, time.Now().UnixMilli()
		r := 4
		st.Reason = &r
		_ = s.savePayme(ctx, s.DB, id, st)
		return id, nil, perr(-31008, "Buyurtma muddati tugagan", "")
	}
	st.State, st.PerformTime = 2, time.Now().UnixMilli()
	if err := s.savePayme(ctx, tx, id, st); err != nil || tx.Commit() != nil {
		return id, nil, perr(-32400, "Ichki xato", "")
	}
	s.afterPaid(id)
	return id, map[string]any{"transaction": strconv.FormatInt(id, 10), "perform_time": st.PerformTime, "state": 2}, nil
}

func (s *Server) paymeCancel(ctx context.Context, txn string, reason *int) (int64, any, *rpcErr) {
	id, st, e := s.paymeFind(ctx, txn)
	if e != nil {
		return 0, nil, e
	}
	if st.State == 1 || st.State == 2 {
		tx, err := s.DB.BeginTx(ctx, nil)
		if err != nil {
			return id, nil, perr(-32400, "Ichki xato", "")
		}
		defer tx.Rollback()
		if st.State == 1 {
			st.State = -1
			_, err = tx.ExecContext(ctx, `UPDATE ticket_orders SET status='cancelled', cancel_reason='payme', updated_at=now() WHERE id=$1 AND status='pending'`, id)
			if err == nil {
				_, err = tx.ExecContext(ctx, `UPDATE tickets SET status='cancelled' WHERE order_id=$1 AND status='pending'`, id)
			}
		} else {
			var used int
			_ = tx.QueryRowContext(ctx, `SELECT count(*) FROM tickets WHERE order_id=$1 AND status='used'`, id).Scan(&used)
			if used > 0 {
				return id, nil, perr(-31007, "Chipta ishlatilgan — bekor qilib bo‘lmaydi", "")
			}
			st.State = -2
			_, err = tx.ExecContext(ctx, `UPDATE ticket_orders SET status='refunded', refunded=total, updated_at=now() WHERE id=$1`, id)
			if err == nil {
				_, err = tx.ExecContext(ctx, `UPDATE tickets SET status='refunded' WHERE order_id=$1 AND status='active'`, id)
			}
			if err == nil {
				_, err = tx.ExecContext(ctx, `INSERT INTO ticket_refunds(order_id, ticket_ids, amount, reason, status, provider_ref)
					SELECT $1, array_agg(id), (SELECT total FROM ticket_orders WHERE id=$1), 'Payme bekor qildi', 'done', $2 FROM tickets WHERE order_id=$1`, id, txn)
			}
		}
		if err != nil {
			return id, nil, perr(-32400, "Ichki xato", "")
		}
		st.CancelTime, st.Reason = time.Now().UnixMilli(), reason
		if err := s.savePayme(ctx, tx, id, st); err != nil || tx.Commit() != nil {
			return id, nil, perr(-32400, "Ichki xato", "")
		}
	}
	return id, map[string]any{"transaction": strconv.FormatInt(id, 10), "cancel_time": st.CancelTime, "state": st.State}, nil
}

func (s *Server) paymeStatement(ctx context.Context, from, to int64) (any, *rpcErr) {
	rows, err := s.DB.QueryContext(ctx, `SELECT id, total, provider_state FROM ticket_orders WHERE provider='payme' AND provider_txn <> ''
		AND (provider_state->>'time')::bigint BETWEEN $1 AND $2 ORDER BY (provider_state->>'time')::bigint`, from, to)
	if err != nil {
		return nil, perr(-32400, "Ichki xato", "")
	}
	defer rows.Close()
	out := []map[string]any{}
	for rows.Next() {
		var id, total int64
		var raw []byte
		if err := rows.Scan(&id, &total, &raw); err != nil {
			return nil, perr(-32400, "Ichki xato", "")
		}
		var st paymeState
		_ = json.Unmarshal(raw, &st)
		out = append(out, map[string]any{"id": st.ID, "time": st.Time, "amount": total * 100, "account": map[string]any{"order_id": strconv.FormatInt(id, 10)},
			"create_time": st.CreateTime, "perform_time": st.PerformTime, "cancel_time": st.CancelTime, "transaction": strconv.FormatInt(id, 10),
			"state": st.State, "reason": st.Reason})
	}
	return map[string]any{"transactions": out}, nil
}

// ---------- Click ----------

type clickReq struct {
	ClickTransID      string
	ServiceID         string
	MerchantTransID   string
	MerchantPrepareID string
	Amount            string
	Action            string
	Error             string
	SignTime          string
	SignString        string
}

func readClick(r *http.Request) clickReq {
	_ = r.ParseForm()
	f := r.PostForm
	return clickReq{f.Get("click_trans_id"), f.Get("service_id"), f.Get("merchant_trans_id"), f.Get("merchant_prepare_id"),
		f.Get("amount"), f.Get("action"), f.Get("error"), f.Get("sign_time"), f.Get("sign_string")}
}

func (s *Server) clickSignOK(c clickReq, complete bool) bool {
	base := c.ClickTransID + c.ServiceID + s.Cfg.ClickSecretKey + c.MerchantTransID
	if complete {
		base += c.MerchantPrepareID
	}
	base += c.Amount + c.Action + c.SignTime
	sum := md5.Sum([]byte(base))
	return s.Cfg.ClickSecretKey != "" && subtle.ConstantTimeCompare([]byte(hex.EncodeToString(sum[:])), []byte(strings.ToLower(c.SignString))) == 1
}

func (s *Server) clickReply(w http.ResponseWriter, r *http.Request, c clickReq, orderID int64, method string, extra map[string]any, code int, note string) {
	out := map[string]any{"click_trans_id": c.ClickTransID, "merchant_trans_id": c.MerchantTransID, "error": code, "error_note": note}
	for k, v := range extra {
		out[k] = v
	}
	s.payLog(r.Context(), "click", orderID, method, r.PostForm, out)
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	_ = json.NewEncoder(w).Encode(out)
}

func (s *Server) clickOrder(ctx context.Context, c clickReq) (int64, string, int64, int, string) {
	id, _ := strconv.ParseInt(c.MerchantTransID, 10, 64)
	var status string
	var total int64
	var hold sql.NullTime
	if err := s.DB.QueryRowContext(ctx, `SELECT status, total, hold_until FROM ticket_orders WHERE id=$1`, id).Scan(&status, &total, &hold); err != nil {
		return id, "", 0, -5, "Buyurtma topilmadi"
	}
	amount, err := strconv.ParseFloat(c.Amount, 64)
	if err != nil || int64(amount+0.5) != total {
		return id, status, total, -2, "Summa noto‘g‘ri"
	}
	if status == "paid" {
		return id, status, total, -4, "Allaqachon to‘langan"
	}
	if status != "pending" || (hold.Valid && time.Now().After(hold.Time.Add(5*time.Minute))) {
		return id, status, total, -9, "Buyurtma bekor qilingan"
	}
	return id, status, total, 0, "Success"
}

func (s *Server) clickPrepare(w http.ResponseWriter, r *http.Request) {
	c := readClick(r)
	if !s.clickSignOK(c, false) {
		s.clickReply(w, r, c, 0, "prepare", nil, -1, "SIGN CHECK FAILED")
		return
	}
	if c.Action != "0" {
		s.clickReply(w, r, c, 0, "prepare", nil, -3, "Action not found")
		return
	}
	id, _, _, code, note := s.clickOrder(r.Context(), c)
	if code == 0 {
		_, _ = s.DB.ExecContext(r.Context(), `UPDATE ticket_orders SET provider='click', provider_txn=$2, updated_at=now() WHERE id=$1`, id, c.ClickTransID)
	}
	s.clickReply(w, r, c, id, "prepare", map[string]any{"merchant_prepare_id": id}, code, note)
}

func (s *Server) clickComplete(w http.ResponseWriter, r *http.Request) {
	c := readClick(r)
	if !s.clickSignOK(c, true) {
		s.clickReply(w, r, c, 0, "complete", nil, -1, "SIGN CHECK FAILED")
		return
	}
	if c.Action != "1" {
		s.clickReply(w, r, c, 0, "complete", nil, -3, "Action not found")
		return
	}
	id, status, _, code, note := s.clickOrder(r.Context(), c)
	if code == -4 && status == "paid" {
		s.clickReply(w, r, c, id, "complete", map[string]any{"merchant_confirm_id": id}, -4, note)
		return
	}
	if code != 0 {
		s.clickReply(w, r, c, id, "complete", nil, code, note)
		return
	}
	if c.MerchantPrepareID != c.MerchantTransID {
		s.clickReply(w, r, c, id, "complete", nil, -6, "Transaction not found")
		return
	}
	if e, _ := strconv.Atoi(c.Error); e < 0 { // Click reports a failed payment
		_, _ = s.DB.ExecContext(r.Context(), `UPDATE ticket_orders SET status='cancelled', cancel_reason='click', updated_at=now() WHERE id=$1 AND status='pending'`, id)
		_, _ = s.DB.ExecContext(r.Context(), `UPDATE tickets SET status='cancelled' WHERE order_id=$1 AND status='pending'`, id)
		s.clickReply(w, r, c, id, "complete", nil, -9, "Transaction cancelled")
		return
	}
	ok, err := s.markPaid(r.Context(), s.DB, id, "click", c.ClickTransID, "")
	if err != nil || !ok {
		s.clickReply(w, r, c, id, "complete", nil, -9, "Transaction cancelled")
		return
	}
	s.afterPaid(id)
	s.clickReply(w, r, c, id, "complete", map[string]any{"merchant_confirm_id": id}, 0, "Success")
}

// ---------- background ----------

// StartTicketWorker expires unpaid holds and deletes face data after its retention.
func (s *Server) StartTicketWorker(ctx context.Context) {
	go func() {
		t := time.NewTicker(time.Minute)
		defer t.Stop()
		for {
			s.ticketTick(ctx)
			select {
			case <-ctx.Done():
				return
			case <-t.C:
			}
		}
	}()
}

func (s *Server) ticketTick(ctx context.Context) {
	// a Payme/Click transaction in progress keeps the hold a little longer
	rows, err := s.DB.QueryContext(ctx, `UPDATE ticket_orders SET status='expired', updated_at=now()
		WHERE status='pending' AND hold_until < now() - CASE WHEN provider_txn <> '' THEN interval '15 minutes' ELSE interval '0' END
		RETURNING id`)
	if err != nil {
		if !errors.Is(err, context.Canceled) {
			slog.Warn("ticket expire", "err", err)
		}
		return
	}
	var ids []int64
	for rows.Next() {
		var id int64
		_ = rows.Scan(&id)
		ids = append(ids, id)
	}
	rows.Close()
	for _, id := range ids {
		_, _ = s.DB.ExecContext(ctx, `UPDATE tickets SET status='cancelled' WHERE order_id=$1 AND status='pending'`, id)
	}
	if _, err := s.DB.ExecContext(ctx, `DELETE FROM ticket_faces WHERE delete_after < now()`); err != nil {
		slog.Warn("ticket faces cleanup", "err", err)
	}
}
