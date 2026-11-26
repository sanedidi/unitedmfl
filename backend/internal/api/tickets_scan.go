package api

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/sanedidi/unitedmfl/backend/internal/auth"
	"github.com/sanedidi/unitedmfl/backend/internal/httpx"
	"github.com/sanedidi/unitedmfl/backend/internal/tickets"
)

// Gate scanner (role «nazoratchi»): the controller scans the QR, the server
// checks the signature, the dynamic window and single use; a ticket bound to
// a face waits for the face check (photo by eye, or the face service).

func (s *Server) mountScanner(r chi.Router) {
	r.Group(func(r chi.Router) {
		r.Use(s.can(auth.PermScan))
		r.Get("/scan/matches", s.scanMatches)
		r.Post("/scan", s.scanTicket)
		r.Get("/scan/check/{token}/photo", s.scanPhoto)
		r.Post("/scan/check/{token}/face", s.scanFace)
		r.Post("/scan/check/{token}/decision", s.scanDecision)
	})
}

// pending face checks (in memory: a check lives 3 minutes)
type faceCheck struct {
	TicketID  int64
	SaleID    int64
	Gate      string
	ScannerID int64
	Expires   time.Time
	Score     *int
}

var faceChecks = struct {
	sync.Mutex
	m map[string]*faceCheck
}{m: map[string]*faceCheck{}}

func putCheck(c *faceCheck) string {
	tok := randToken(16)
	faceChecks.Lock()
	defer faceChecks.Unlock()
	now := time.Now()
	for k, v := range faceChecks.m {
		if now.After(v.Expires) {
			delete(faceChecks.m, k)
		}
	}
	faceChecks.m[tok] = c
	return tok
}

func getCheck(tok string, scanner int64) (*faceCheck, error) {
	faceChecks.Lock()
	defer faceChecks.Unlock()
	c, ok := faceChecks.m[tok]
	if !ok || time.Now().After(c.Expires) || c.ScannerID != scanner {
		return nil, httpx.NewError(410, "expired", "Tekshiruv muddati tugadi — chiptani qayta skan qiling")
	}
	return c, nil
}

func dropCheck(tok string) {
	faceChecks.Lock()
	delete(faceChecks.m, tok)
	faceChecks.Unlock()
}

func (s *Server) scanMatches(w http.ResponseWriter, r *http.Request) {
	rows, err := s.DB.QueryContext(r.Context(), `SELECT ts.match_id FROM ticket_sales ts JOIN matches m ON m.id=ts.match_id
		WHERE ts.status <> 'draft' AND ts.layout_id IS NOT NULL AND (m.kickoff_at IS NULL OR m.kickoff_at BETWEEN now() - interval '12 hours' AND now() + interval '3 days')
		ORDER BY m.kickoff_at NULLS LAST`)
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	var ids []int64
	for rows.Next() {
		var id int64
		_ = rows.Scan(&id)
		ids = append(ids, id)
	}
	rows.Close()
	out := []map[string]any{}
	for _, id := range ids {
		v, err := s.saleView(r, id)
		if err != nil || v.Sale == nil {
			continue
		}
		out = append(out, map[string]any{"match": v.Match, "gates": v.Gates, "entry": v.Entry, "face_mode": v.Sale.FaceMode,
			"face_check": v.Sale.FaceCheck, "dynamic_qr": v.Sale.DynamicQR})
	}
	httpx.JSON(w, 200, map[string]any{"items": out})
}

type scanResult struct {
	Result     string         `json:"result"`
	Message    string         `json:"message"`
	Ticket     map[string]any `json:"ticket,omitempty"`
	CheckToken string         `json:"check_token,omitempty"`
	FaceCheck  string         `json:"face_check,omitempty"` // auto | manual
	Score      *int           `json:"score,omitempty"`
	Threshold  int            `json:"threshold,omitempty"`
	UsedAt     *time.Time     `json:"used_at,omitempty"`
	UsedGate   string         `json:"used_gate,omitempty"`
	UsedBy     string         `json:"used_by,omitempty"`
	WrongGate  string         `json:"wrong_gate,omitempty"` // the ticket's gate when scanned at another one
	Entered    int            `json:"entered"`
	Total      int            `json:"total"`
}

func (s *Server) logScan(ctx context.Context, saleID int64, ticketID *int64, gate string, scanner int64, result string, score *int, detail string) {
	_, _ = s.DB.ExecContext(ctx, `INSERT INTO ticket_scans(sale_id, ticket_id, gate, scanner_id, result, score, detail) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
		saleID, ticketID, gate, scanner, result, score, detail)
}

func (s *Server) entryCounters(ctx context.Context, saleID int64, res *scanResult) {
	_ = s.DB.QueryRowContext(ctx, `SELECT count(*) FILTER (WHERE status='used'), count(*) FILTER (WHERE status IN ('active','used'))
		FROM tickets WHERE sale_id=$1`, saleID).Scan(&res.Entered, &res.Total)
}

func (s *Server) scanTicket(w http.ResponseWriter, r *http.Request) {
	var in struct {
		MatchID int64  `json:"match_id"`
		Gate    string `json:"gate"`
		Code    string `json:"code"`
	}
	if err := httpx.Decode(r, &in); err != nil {
		httpx.Fail(w, r, err)
		return
	}
	ctx := r.Context()
	scanner := claimsFrom(ctx).UserID
	sale, err := s.saleByMatch(ctx, s.DB, in.MatchID, false)
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	l, err := s.saleLayout(ctx, s.DB, sale)
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	res := scanResult{}
	finish := func(result, msg string, tid *int64, detail string) {
		res.Result, res.Message = result, msg
		s.logScan(ctx, sale.ID, tid, in.Gate, scanner, result, res.Score, detail)
		s.entryCounters(ctx, sale.ID, &res)
		httpx.JSON(w, 200, res)
	}
	p, ok := tickets.ParseCode(in.Code)
	if !ok {
		finish("invalid", "Bu United MFL chiptasi emas", nil, strings.TrimSpace(in.Code))
		return
	}
	var tid, saleID int64
	var number, zone, section, row, gate, holder, status, faceStatus, usedGate, usedBy string
	var seat sql.NullInt64
	var secret []byte
	var usedAt sql.NullTime
	err = s.DB.QueryRowContext(ctx, `SELECT t.id, t.sale_id, t.number, t.zone_key, t.section_key, t.row_label, t.seat_no, t.gate, t.holder_name,
		t.status, t.face_status, t.qr_secret, t.used_at, t.used_gate, COALESCE(u.name,'') FROM tickets t LEFT JOIN users u ON u.id=t.used_by
		WHERE upper(t.number)=upper($1)`, p.Number).Scan(&tid, &saleID, &number, &zone, &section, &row, &seat, &gate, &holder,
		&status, &faceStatus, &secret, &usedAt, &usedGate, &usedBy)
	if errors.Is(err, sql.ErrNoRows) {
		finish("invalid", "Chipta topilmadi", nil, p.Number)
		return
	}
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	kind := zoneKind(l, zone)
	res.Ticket = map[string]any{"number": number, "zone": zone, "zone_name": zoneName(l, zone), "zone_kind": kind,
		"section": section, "row": row, "gate": gate, "holder_name": holder, "face_status": faceStatus}
	if seat.Valid {
		res.Ticket["seat"] = seat.Int64
	}
	if saleID != sale.ID {
		finish("wrong_match", "Chipta boshqa match uchun", &tid, "")
		return
	}
	manual := p.Window == -1
	if !manual {
		switch tickets.Verify(secret, p, sale.DynamicQR, time.Now()) {
		case tickets.BadSignature:
			finish("invalid", "QR-kod soxta yoki buzilgan", &tid, "signature")
			return
		case tickets.Stale:
			ago := time.Since(time.Unix(p.Window*int64(tickets.Window/time.Second), 0)).Round(time.Minute)
			finish("stale", fmt.Sprintf("QR eskirgan — kod %d daqiqa oldin yaratilgan (skrinshot). Jonli QR ko‘rsatishni so‘rang", int(ago.Minutes())), &tid, "")
			return
		case tickets.Static:
			finish("stale", "Bu statik QR — saytdagi jonli QR ko‘rsatilishi kerak", &tid, "static")
			return
		}
	}
	switch status {
	case "used":
		res.UsedAt, res.UsedGate, res.UsedBy = nullTime(usedAt), usedGate, usedBy
		if !sale.SingleScan {
			finish("ok", "Qayta kirish ruxsat etilgan", &tid, "reentry")
			return
		}
		finish("used", "Chipta allaqachon ishlatilgan", &tid, "")
		return
	case "cancelled", "refunded":
		finish("cancelled", "Chipta bekor qilingan (qaytarilgan)", &tid, status)
		return
	case "pending":
		finish("cancelled", "Chipta to‘lanmagan", &tid, status)
		return
	}
	if gate != "" && in.Gate != "" && !strings.EqualFold(gate, in.Gate) {
		res.WrongGate = gate
	}
	needFace := faceRequired(sale, kind)
	if needFace || manual {
		if needFace && faceStatus == "none" && !sale.NoFaceEntry {
			finish("not_activated", "Chipta yuz bilan faollashtirilmagan — kassaga yo‘naltiring", &tid, "")
			return
		}
		mode := sale.FaceCheck
		result, msg := "face", "Yuzni tekshiring"
		switch {
		case faceStatus == "bound" && mode == "auto" && s.Cfg.FaceServiceURL != "":
			msg = "Mehmondan kameraga qarashni so‘rang"
		case faceStatus == "bound":
			mode, msg = "manual", "Chiptadagi rasm bilan solishtiring"
		default: // document (or a manually typed number): check the ID
			mode, result, msg = "document", "document", "Hujjatni tekshiring: ism chiptadagi bilan bir xil bo‘lsin"
		}
		res.FaceCheck, res.Threshold = mode, sale.FaceThreshold
		res.CheckToken = putCheck(&faceCheck{TicketID: tid, SaleID: sale.ID, Gate: in.Gate, ScannerID: scanner, Expires: time.Now().Add(3 * time.Minute)})
		detail := ""
		if manual {
			detail = "manual number"
		}
		res.Result, res.Message = result, msg
		s.entryCounters(ctx, sale.ID, &res)
		_ = detail
		httpx.JSON(w, 200, res)
		return
	}
	if ok, err := s.enter(ctx, tid, in.Gate, scanner); err != nil {
		httpx.Fail(w, r, err)
		return
	} else if !ok {
		finish("used", "Chipta hozirgina ishlatildi", &tid, "race")
		return
	}
	finish("ok", "Kirish mumkin", &tid, "")
}

// enter marks the ticket used exactly once.
func (s *Server) enter(ctx context.Context, ticketID int64, gate string, scanner int64) (bool, error) {
	res, err := s.DB.ExecContext(ctx, `UPDATE tickets SET status='used', used_at=now(), used_gate=$2, used_by=$3 WHERE id=$1 AND status='active'`,
		ticketID, gate, scanner)
	if err != nil {
		return false, err
	}
	n, _ := res.RowsAffected()
	return n == 1, nil
}

func (s *Server) scanPhoto(w http.ResponseWriter, r *http.Request) {
	c, err := getCheck(chi.URLParam(r, "token"), claimsFrom(r.Context()).UserID)
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	var enc []byte
	if err := s.DB.QueryRowContext(r.Context(), `SELECT photo_enc FROM ticket_faces WHERE ticket_id=$1`, c.TicketID).Scan(&enc); err != nil {
		httpx.Fail(w, r, httpx.ErrNotFound)
		return
	}
	img, err := s.openFace(enc)
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	w.Header().Set("Content-Type", "image/jpeg")
	w.Header().Set("Cache-Control", "no-store, private")
	_, _ = w.Write(img)
}

// scanFace compares the camera frame with the bound selfie via the face service.
func (s *Server) scanFace(w http.ResponseWriter, r *http.Request) {
	tok := chi.URLParam(r, "token")
	scanner := claimsFrom(r.Context()).UserID
	c, err := getCheck(tok, scanner)
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	if s.Cfg.FaceServiceURL == "" {
		httpx.Fail(w, r, httpx.BadRequest("Yuz servisi ulanmagan"))
		return
	}
	frame, err := io.ReadAll(io.LimitReader(r.Body, 4<<20))
	if err != nil || len(frame) == 0 {
		httpx.Fail(w, r, httpx.BadRequest("Kadr kerak"))
		return
	}
	frame, err = normalizeSelfie(frame)
	if err != nil {
		httpx.Fail(w, r, httpx.BadRequest("Kadrni o‘qib bo‘lmadi"))
		return
	}
	var enc []byte
	if err := s.DB.QueryRowContext(r.Context(), `SELECT photo_enc FROM ticket_faces WHERE ticket_id=$1`, c.TicketID).Scan(&enc); err != nil {
		httpx.Fail(w, r, httpx.ErrNotFound)
		return
	}
	ref, err := s.openFace(enc)
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	score, err := s.faceVerify(r.Context(), ref, frame)
	if err != nil {
		httpx.Fail(w, r, httpx.NewError(502, "face_service", err.Error()))
		return
	}
	var threshold int
	_ = s.DB.QueryRowContext(r.Context(), `SELECT face_threshold FROM ticket_sales WHERE id=$1`, c.SaleID).Scan(&threshold)
	res := scanResult{Score: &score, Threshold: threshold, CheckToken: tok, FaceCheck: "auto"}
	if score >= threshold {
		ok, err := s.enter(r.Context(), c.TicketID, c.Gate, scanner)
		if err != nil {
			httpx.Fail(w, r, err)
			return
		}
		dropCheck(tok)
		res.Result, res.Message = "face_ok", "Yuz mos keldi"
		if !ok {
			res.Result, res.Message = "used", "Chipta hozirgina ishlatildi"
		}
	} else {
		res.Result, res.Message = "face_mismatch", "Yuz mos kelmadi"
	}
	s.logScan(r.Context(), c.SaleID, &c.TicketID, c.Gate, scanner, res.Result, &score, "")
	s.entryCounters(r.Context(), c.SaleID, &res)
	httpx.JSON(w, 200, res)
}

// scanDecision: the controller's final word after the photo or document check.
func (s *Server) scanDecision(w http.ResponseWriter, r *http.Request) {
	tok := chi.URLParam(r, "token")
	scanner := claimsFrom(r.Context()).UserID
	c, err := getCheck(tok, scanner)
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	var in struct {
		Decision string `json:"decision"` // accept | document | reject
		Note     string `json:"note"`
	}
	if err := httpx.Decode(r, &in); err != nil {
		httpx.Fail(w, r, err)
		return
	}
	res := scanResult{}
	switch in.Decision {
	case "accept", "document":
		ok, err := s.enter(r.Context(), c.TicketID, c.Gate, scanner)
		if err != nil {
			httpx.Fail(w, r, err)
			return
		}
		res.Result, res.Message = "face_ok", "Kirish mumkin"
		if in.Decision == "document" {
			res.Result = "document"
		}
		if !ok {
			res.Result, res.Message = "used", "Chipta hozirgina ishlatildi"
		}
	case "reject":
		res.Result, res.Message = "rejected", "Rad etildi — chipta bloklanmadi, egasi kira oladi"
	default:
		httpx.Fail(w, r, httpx.BadRequest("decision: accept, document, reject"))
		return
	}
	dropCheck(tok)
	s.logScan(r.Context(), c.SaleID, &c.TicketID, c.Gate, scanner, res.Result, nil, strings.TrimSpace(in.Note))
	s.entryCounters(r.Context(), c.SaleID, &res)
	httpx.JSON(w, 200, res)
}

// ---------- face service client ----------
//
// FACE_SERVICE_URL points at a small service on our own server in Uzbekistan
// (biometrics must stay in the country):
//
//	POST /detect {"image": base64 jpeg}            → {"faces": n, "quality": 0..1}
//	POST /verify {"a": base64 jpeg, "b": base64}   → {"score": 0..100}

func (s *Server) faceCall(ctx context.Context, path string, body any, out any) error {
	b, _ := json.Marshal(body)
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, http.MethodPost, s.Cfg.FaceServiceURL+path, bytes.NewReader(b))
	req.Header.Set("Content-Type", "application/json")
	if s.Cfg.AIInternalToken != "" {
		req.Header.Set("Authorization", "Bearer "+s.Cfg.AIInternalToken)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return errors.New("yuz servisi javob bermadi")
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return errors.New("yuz servisi xatosi: " + strconv.Itoa(resp.StatusCode))
	}
	return json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(out)
}

// faceTemplate validates a selfie: exactly one face, good enough quality.
func (s *Server) faceTemplate(ctx context.Context, jpg []byte) ([]byte, error) {
	var out struct {
		Faces   int     `json:"faces"`
		Quality float64 `json:"quality"`
	}
	if err := s.faceCall(ctx, "/detect", map[string]string{"image": base64.StdEncoding.EncodeToString(jpg)}, &out); err != nil {
		return nil, err
	}
	if out.Faces == 0 {
		return nil, errors.New("Rasmda yuz topilmadi — yorug‘ joyda qayta oling")
	}
	if out.Faces > 1 {
		return nil, errors.New("Rasmda bir nechta yuz bor — faqat o‘zingiz tushing")
	}
	if out.Quality > 0 && out.Quality < 0.35 {
		return nil, errors.New("Rasm sifati past — ko‘zoynak va niqobsiz, yorug‘ joyda qayta oling")
	}
	return mustJSON(out), nil
}

func (s *Server) faceVerify(ctx context.Context, a, b []byte) (int, error) {
	var out struct {
		Score float64 `json:"score"`
	}
	if err := s.faceCall(ctx, "/verify", map[string]string{"a": base64.StdEncoding.EncodeToString(a), "b": base64.StdEncoding.EncodeToString(b)}, &out); err != nil {
		return 0, err
	}
	sc := int(out.Score + 0.5)
	return min(max(sc, 0), 100), nil
}
