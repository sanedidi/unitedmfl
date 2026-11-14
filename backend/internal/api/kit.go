package api

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/sanedidi/unitedmfl/backend/internal/httpx"
)

// Team kits: a team's jersey photo; the AI service dresses every player photo in
// it. Originals stay in players.photo_url; the site shows kit_approved_url once
// an admin approves the generated picture.

// displayPhoto is the SQL expression for the photo the site shows.
const displayPhoto = `COALESCE(NULLIF(p.kit_approved_url, ''), p.photo_url)`

type kitSettings struct {
	AutoOnKit    bool   `json:"auto_on_kit"`
	AutoOnPlayer bool   `json:"auto_on_player"`
	Describe     bool   `json:"describe"`
	Quality      string `json:"quality"`
}

type kitWorker struct {
	wake    chan struct{}
	mu      sync.Mutex
	running map[int64]context.CancelFunc // player id → cancel
}

func (k *kitWorker) kick() {
	select {
	case k.wake <- struct{}{}:
	default:
	}
}

func (k *kitWorker) set(id int64, c context.CancelFunc) {
	k.mu.Lock()
	if c == nil {
		delete(k.running, id)
	} else {
		k.running[id] = c
	}
	k.mu.Unlock()
}

func (k *kitWorker) cancel(ids []int64) {
	k.mu.Lock()
	defer k.mu.Unlock()
	for _, id := range ids {
		if c, ok := k.running[id]; ok {
			c()
		}
	}
}

// kitConfig reads the kit part of the AI settings; ok=false when the AI service is off.
func (s *Server) kitConfig(ctx context.Context) (kitSettings, string, bool) {
	if s.Cfg.AIServiceURL == "" {
		return kitSettings{}, "", false
	}
	raw, err := s.aiCall(ctx, http.MethodGet, "/v1/settings", nil)
	if err != nil {
		return kitSettings{}, "", false
	}
	var st struct {
		Provider   string            `json:"provider"`
		ImageModel map[string]string `json:"image_model"`
		Kit        kitSettings       `json:"kit"`
	}
	if json.Unmarshal(raw, &st) != nil {
		return kitSettings{}, "", false
	}
	return st.Kit, st.ImageModel[st.Provider], true
}

func str(m map[string]any, k string) string {
	v, _ := m[k].(string)
	return v
}

func num(m map[string]any, k string) int64 {
	v, _ := m[k].(float64)
	return int64(v)
}

// teamKitChanged: a new or replaced kit gets a description and dresses the squad.
func teamKitChanged(s *Server, id int64, old, cur map[string]any) {
	kit := str(cur, "kit_url")
	if kit == str(old, "kit_url") {
		return
	}
	if kit == "" { // kit removed: stop pending work, keep approved pictures until changed
		ids := s.kitStopTeam(context.Background(), id)
		s.kit.cancel(ids)
		return
	}
	descEdited := old != nil && str(cur, "kit_description") != str(old, "kit_description")
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
		defer cancel()
		cfg, _, ok := s.kitConfig(ctx)
		if !ok {
			return
		}
		if cfg.Describe && !descEdited {
			if _, err := s.kitDescribe(ctx, id); err != nil {
				slog.Warn("kit describe failed", "team", id, "err", err)
			}
		}
		if cfg.AutoOnKit {
			if _, err := s.kitQueueTeam(ctx, id, false); err != nil {
				slog.Warn("kit queue failed", "team", id, "err", err)
			}
		}
	}()
}

// playerPhotoChanged: a new original photo (or a move to another team) re-dresses the player.
func playerPhotoChanged(s *Server, id int64, old, cur map[string]any) {
	photo := str(cur, "photo_url")
	if photo == str(old, "photo_url") && num(cur, "team_id") == num(old, "team_id") {
		return
	}
	ctx := context.Background()
	// the approved picture belongs to the old photo / team: never show it again
	_, _ = s.DB.ExecContext(ctx, `UPDATE players SET kit_approved_url='', kit_photo_url='', kit_hint='', kit_error='', kit_analysis=NULL,
		kit_status='', kit_updated_at=now() WHERE id=$1`, id)
	s.kit.cancel([]int64{id})
	if photo == "" || num(cur, "team_id") == 0 {
		return
	}
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		cfg, _, ok := s.kitConfig(ctx)
		if !ok || !cfg.AutoOnPlayer {
			return
		}
		res, err := s.DB.ExecContext(ctx, `UPDATE players p SET kit_status='queued', kit_updated_at=now()
			FROM teams t WHERE p.id=$1 AND t.id=p.team_id AND t.kit_url<>'' AND p.photo_url<>''`, id)
		if n, _ := res.RowsAffected(); err == nil && n > 0 {
			s.kit.kick()
		}
	}()
}

// kitQueueTeam queues every player of the team; players without a photo are marked skipped.
func (s *Server) kitQueueTeam(ctx context.Context, team int64, includeApproved bool) (int64, error) {
	cond := `AND kit_status NOT IN ('approved', 'running')`
	if includeApproved {
		cond = `AND kit_status <> 'running'`
	}
	res, err := s.DB.ExecContext(ctx, `UPDATE players SET kit_status = CASE WHEN photo_url='' THEN 'skipped' ELSE 'queued' END,
		kit_error='', kit_updated_at=now() WHERE team_id=$1 AND EXISTS (SELECT 1 FROM teams WHERE id=$1 AND kit_url<>'') `+cond, team)
	if err != nil {
		return 0, err
	}
	n, _ := res.RowsAffected()
	s.kit.kick()
	return n, nil
}

func (s *Server) kitStopTeam(ctx context.Context, team int64) []int64 {
	rows, err := s.DB.QueryContext(ctx, `UPDATE players SET kit_status='cancelled', kit_updated_at=now()
		WHERE team_id=$1 AND kit_status IN ('queued','running') RETURNING id`, team)
	if err != nil {
		return nil
	}
	defer rows.Close()
	var ids []int64
	for rows.Next() {
		var id int64
		if rows.Scan(&id) == nil {
			ids = append(ids, id)
		}
	}
	return ids
}

// kitDescribe asks the AI service to describe the team's kit and stores it.
func (s *Server) kitDescribe(ctx context.Context, team int64) (string, error) {
	var name, kit string
	if err := s.DB.QueryRowContext(ctx, `SELECT name, kit_url FROM teams WHERE id=$1`, team).Scan(&name, &kit); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return "", httpx.ErrNotFound
		}
		return "", err
	}
	if kit == "" {
		return "", httpx.Validation(map[string]any{"kit_url": "Avval forma rasmini yuklang va saqlang"})
	}
	assets, warnings := s.loadAssets(ctx, []aiAsset{{Kind: "url", URL: kit, Label: "forma"}})
	if len(assets) == 0 {
		return "", httpx.BadRequest(strings.Join(warnings, "; "))
	}
	raw, err := s.aiCall(ctx, http.MethodPost, "/v1/kit/describe", map[string]any{"kit": assets[0], "team": name})
	if err != nil {
		return "", err
	}
	var out struct {
		Description string `json:"description"`
	}
	if err := json.Unmarshal(raw, &out); err != nil {
		return "", err
	}
	_, err = s.DB.ExecContext(ctx, `UPDATE teams SET kit_description=$2, updated_at=now() WHERE id=$1 AND kit_url=$3`, team, out.Description, kit)
	return out.Description, err
}

// ---------- worker ----------

// StartKitWorker processes queued players in the background (two at a time).
func (s *Server) StartKitWorker(ctx context.Context) {
	_, _ = s.DB.ExecContext(ctx, `UPDATE players SET kit_status='queued' WHERE kit_status='running'`)
	for i := 0; i < 2; i++ {
		go func() {
			tick := time.NewTicker(10 * time.Second)
			defer tick.Stop()
			for {
				for s.kitNext(ctx) {
				}
				select {
				case <-ctx.Done():
					return
				case <-s.kit.wake:
				case <-tick.C:
				}
			}
		}()
	}
	s.kit.kick()
}

type kitJob struct {
	id                        int64
	name, photo, hint         string
	team, kitURL, description string
}

// kitNext claims and processes one queued player; false when the queue is empty.
func (s *Server) kitNext(ctx context.Context) bool {
	if ctx.Err() != nil || s.Cfg.AIServiceURL == "" {
		return false
	}
	var j kitJob
	err := s.DB.QueryRowContext(ctx, `UPDATE players p SET kit_status='running', kit_error='', kit_updated_at=now()
		FROM teams t
		WHERE p.id = (SELECT id FROM players WHERE kit_status='queued' ORDER BY kit_updated_at NULLS FIRST, id LIMIT 1 FOR UPDATE SKIP LOCKED)
		  AND t.id = p.team_id
		RETURNING p.id, p.full_name, p.photo_url, p.kit_hint, t.name, t.kit_url, t.kit_description`).
		Scan(&j.id, &j.name, &j.photo, &j.hint, &j.team, &j.kitURL, &j.description)
	if errors.Is(err, sql.ErrNoRows) {
		// a queued player without a team would block nothing but should not stay queued
		_, _ = s.DB.ExecContext(ctx, `UPDATE players SET kit_status='cancelled' WHERE kit_status='queued' AND team_id IS NULL`)
		return false
	}
	if err != nil {
		slog.Warn("kit claim failed", "err", err)
		return false
	}
	jctx, cancel := context.WithTimeout(ctx, 10*time.Minute)
	s.kit.set(j.id, cancel)
	defer func() { cancel(); s.kit.set(j.id, nil) }()
	status, url, errMsg, analysis, model := s.kitProcess(jctx, j)
	if errors.Is(jctx.Err(), context.DeadlineExceeded) {
		status, errMsg = "error", "Vaqt tugadi — qayta urinib ko‘ring"
	}
	// a stop by the admin already set «cancelled»: the running-only update below leaves it
	_, err = s.DB.ExecContext(ctx, `UPDATE players SET kit_status=$2, kit_photo_url=CASE WHEN $3<>'' THEN $3 ELSE kit_photo_url END,
		kit_error=$4, kit_analysis=$5, kit_model=$6, kit_updated_at=now()
		WHERE id=$1 AND kit_status='running' AND photo_url=$7`, j.id, status, url, errMsg, nullJSON(analysis), model, j.photo)
	if err != nil {
		slog.Warn("kit save failed", "player", j.id, "err", err)
	}
	return true
}

func nullJSON(b json.RawMessage) any {
	if len(b) == 0 || string(b) == "null" {
		return nil
	}
	return []byte(b)
}

func (s *Server) kitProcess(ctx context.Context, j kitJob) (status, url, errMsg string, analysis json.RawMessage, model string) {
	if j.kitURL == "" {
		return "cancelled", "", "", nil, ""
	}
	if j.photo == "" {
		return "skipped", "", "", nil, ""
	}
	assets, warnings := s.loadAssets(ctx, []aiAsset{{Kind: "url", URL: j.photo, Label: "photo"}, {Kind: "url", URL: j.kitURL, Label: "kit"}})
	if len(assets) != 2 {
		return "error", "", "Rasmni o‘qib bo‘lmadi: " + strings.Join(warnings, "; "), nil, ""
	}
	raw, err := s.aiCall(ctx, http.MethodPost, "/v1/kit/dress", map[string]any{
		"photo": assets[0], "kit": assets[1], "team": j.team, "player": j.name, "description": j.description, "hint": j.hint,
	})
	if err != nil {
		var he *httpx.Error
		if errors.As(err, &he) {
			return "error", "", he.Message, nil, ""
		}
		return "error", "", err.Error(), nil, ""
	}
	var res struct {
		Status   string          `json:"status"`
		Image    *aiImagesImage  `json:"image"`
		Analysis json.RawMessage `json:"analysis"`
		Model    string          `json:"model"`
	}
	if err := json.Unmarshal(raw, &res); err != nil {
		return "error", "", "AI-servis javobi noto‘g‘ri", nil, ""
	}
	switch res.Status {
	case "multi":
		return "multi", "", "Rasmda bir nechta odam — kim ekanini belgilang", res.Analysis, ""
	case "noface":
		return "error", "", "Yuz ko‘rinmaydi yoki juda kichik — boshqa rasm yuklang", res.Analysis, ""
	}
	if res.Image == nil || len(res.Image.Data) == 0 {
		return "error", "", "AI-servis rasm qaytarmadi", res.Analysis, ""
	}
	u, err := s.saveAIImage(res.Image.Mime, res.Image.Data)
	if err != nil {
		return "error", "", "Rasmni saqlab bo‘lmadi", res.Analysis, ""
	}
	return "review", u, "", res.Analysis, res.Model
}

// aiImagesImage is one picture from the AI service (base64 data in JSON).
type aiImagesImage struct {
	Mime   string `json:"mime"`
	Data   []byte `json:"data"`
	Width  int    `json:"width"`
	Height int    `json:"height"`
}

// ---------- HTTP ----------

type kitPlayer struct {
	ID          int64           `json:"id"`
	FullName    string          `json:"full_name"`
	Number      *int64          `json:"number"`
	TeamID      *int64          `json:"team_id"`
	PhotoURL    string          `json:"photo_url"`
	KitPhotoURL string          `json:"kit_photo_url"`
	ApprovedURL string          `json:"kit_approved_url"`
	Status      string          `json:"kit_status"`
	Error       string          `json:"kit_error"`
	Hint        string          `json:"kit_hint"`
	Analysis    json.RawMessage `json:"kit_analysis"`
	Model       string          `json:"kit_model"`
	UpdatedAt   *time.Time      `json:"kit_updated_at"`
	TeamKit     bool            `json:"team_has_kit"`
}

const kitPlayerCols = `p.id, p.full_name, p.number, p.team_id, p.photo_url, p.kit_photo_url, p.kit_approved_url, p.kit_status, p.kit_error,
	p.kit_hint, p.kit_analysis, p.kit_model, p.kit_updated_at, coalesce(t.kit_url,'')<>''`

func scanKitPlayer(row interface{ Scan(...any) error }) (kitPlayer, error) {
	var p kitPlayer
	var num, team sql.NullInt64
	var analysis []byte
	var upd sql.NullTime
	err := row.Scan(&p.ID, &p.FullName, &num, &team, &p.PhotoURL, &p.KitPhotoURL, &p.ApprovedURL, &p.Status, &p.Error, &p.Hint, &analysis, &p.Model, &upd, &p.TeamKit)
	if num.Valid {
		p.Number = &num.Int64
	}
	if team.Valid {
		p.TeamID = &team.Int64
	}
	if len(analysis) > 0 {
		p.Analysis = analysis
	}
	if upd.Valid {
		p.UpdatedAt = &upd.Time
	}
	return p, err
}

func (s *Server) mountKits(r chi.Router) {
	r.Get("/teams/{id}/kit", s.kitTeamView)
	r.Post("/teams/{id}/kit/describe", s.kitTeamDescribe)
	r.Post("/teams/{id}/kit/run", s.kitTeamAction("run"))
	r.Post("/teams/{id}/kit/stop", s.kitTeamAction("stop"))
	r.Post("/teams/{id}/kit/approve", s.kitTeamAction("approve"))
	r.Get("/players/{id}/kit", s.kitPlayerView)
	r.Post("/players/{id}/kit/{action}", s.kitPlayerAction)
}

func (s *Server) kitTeamView(w http.ResponseWriter, r *http.Request) {
	id, err := idParam(r, "id")
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	var team struct {
		ID          int64  `json:"id"`
		Name        string `json:"name"`
		KitURL      string `json:"kit_url"`
		Description string `json:"kit_description"`
	}
	err = s.DB.QueryRowContext(r.Context(), `SELECT id, name, kit_url, kit_description FROM teams WHERE id=$1`, id).Scan(&team.ID, &team.Name, &team.KitURL, &team.Description)
	if errors.Is(err, sql.ErrNoRows) {
		httpx.Fail(w, r, httpx.ErrNotFound)
		return
	}
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	rows, err := s.DB.QueryContext(r.Context(), `SELECT `+kitPlayerCols+` FROM players p LEFT JOIN teams t ON t.id=p.team_id
		WHERE p.team_id=$1 ORDER BY CASE p.kit_status WHEN 'review' THEN 0 WHEN 'multi' THEN 1 WHEN 'error' THEN 2 WHEN 'running' THEN 3 WHEN 'queued' THEN 4 ELSE 5 END,
		p.number NULLS LAST, p.full_name`, id)
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	defer rows.Close()
	players := []kitPlayer{}
	counts := map[string]int{}
	for rows.Next() {
		p, err := scanKitPlayer(rows)
		if err != nil {
			httpx.Fail(w, r, err)
			return
		}
		players = append(players, p)
		counts[p.Status]++
		if p.ApprovedURL != "" {
			counts["on_site"]++
		}
	}
	cfg, model, ok := s.kitConfig(r.Context())
	httpx.JSON(w, http.StatusOK, map[string]any{"team": team, "players": players, "counts": counts,
		"ai": map[string]any{"on": ok, "model": model, "quality": cfg.Quality, "auto_on_kit": cfg.AutoOnKit, "auto_on_player": cfg.AutoOnPlayer}})
}

func (s *Server) kitTeamDescribe(w http.ResponseWriter, r *http.Request) {
	id, err := idParam(r, "id")
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 3*time.Minute)
	defer cancel()
	desc, err := s.kitDescribe(ctx, id)
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	s.audit(r, "kit_describe", "team", id, nil)
	httpx.JSON(w, http.StatusOK, map[string]string{"kit_description": desc})
}

func (s *Server) kitTeamAction(action string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id, err := idParam(r, "id")
		if err != nil {
			httpx.Fail(w, r, err)
			return
		}
		var n int64
		switch action {
		case "run":
			if s.Cfg.AIServiceURL == "" {
				httpx.Fail(w, r, errAIOff)
				return
			}
			var kit string
			_ = s.DB.QueryRowContext(r.Context(), `SELECT kit_url FROM teams WHERE id=$1`, id).Scan(&kit)
			if kit == "" {
				httpx.Fail(w, r, httpx.Validation(map[string]any{"kit_url": "Avval forma rasmini yuklang va saqlang"}))
				return
			}
			n, err = s.kitQueueTeam(r.Context(), id, true)
		case "stop":
			ids := s.kitStopTeam(r.Context(), id)
			s.kit.cancel(ids)
			n = int64(len(ids))
		case "approve":
			var res sql.Result
			res, err = s.DB.ExecContext(r.Context(), `UPDATE players SET kit_status='approved', kit_approved_url=kit_photo_url, kit_updated_at=now()
				WHERE team_id=$1 AND kit_status='review' AND kit_photo_url<>''`, id)
			if err == nil {
				n, _ = res.RowsAffected()
			}
		}
		if err != nil {
			httpx.Fail(w, r, err)
			return
		}
		s.audit(r, "kit_"+action, "team", id, map[string]any{"players": n})
		httpx.JSON(w, http.StatusOK, map[string]int64{"players": n})
	}
}

func (s *Server) loadKitPlayer(ctx context.Context, id int64) (kitPlayer, error) {
	p, err := scanKitPlayer(s.DB.QueryRowContext(ctx, `SELECT `+kitPlayerCols+` FROM players p LEFT JOIN teams t ON t.id=p.team_id WHERE p.id=$1`, id))
	if errors.Is(err, sql.ErrNoRows) {
		return p, httpx.ErrNotFound
	}
	return p, err
}

func (s *Server) kitPlayerView(w http.ResponseWriter, r *http.Request) {
	id, err := idParam(r, "id")
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	p, err := s.loadKitPlayer(r.Context(), id)
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, p)
}

func (s *Server) kitPlayerAction(w http.ResponseWriter, r *http.Request) {
	id, err := idParam(r, "id")
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	var in struct {
		Hint string `json:"hint"`
	}
	if r.ContentLength != 0 {
		if err := httpx.Decode(r, &in); err != nil {
			httpx.Fail(w, r, err)
			return
		}
	}
	p, err := s.loadKitPlayer(r.Context(), id)
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	action := chi.URLParam(r, "action")
	var q string
	var args []any
	switch action {
	case "approve":
		if p.KitPhotoURL == "" || (p.Status != "review" && p.Status != "rejected") {
			httpx.Fail(w, r, httpx.NewError(http.StatusConflict, "not_ready", "Tasdiqlash uchun tayyor rasm yo‘q"))
			return
		}
		q = `UPDATE players SET kit_status='approved', kit_approved_url=kit_photo_url, kit_updated_at=now() WHERE id=$1`
	case "reject":
		q = `UPDATE players SET kit_status='rejected', kit_updated_at=now() WHERE id=$1 AND kit_status='review'`
	case "revert": // back to the original photo on the site
		q = `UPDATE players SET kit_approved_url='', kit_status=CASE WHEN kit_status='approved' THEN 'rejected' ELSE kit_status END, kit_updated_at=now() WHERE id=$1`
	case "regenerate":
		if s.Cfg.AIServiceURL == "" {
			httpx.Fail(w, r, errAIOff)
			return
		}
		if !p.TeamKit || p.PhotoURL == "" {
			httpx.Fail(w, r, httpx.NewError(http.StatusConflict, "no_kit", "Jamoa formasi yoki o‘yinchi rasmi yo‘q"))
			return
		}
		if p.Status == "running" {
			httpx.Fail(w, r, httpx.NewError(http.StatusConflict, "running", "Rasm hozir yaratilmoqda"))
			return
		}
		hint := strings.TrimSpace(in.Hint)
		if len([]rune(hint)) > 300 {
			httpx.Fail(w, r, httpx.Validation(map[string]any{"hint": "300 belgidan oshmasin"}))
			return
		}
		q = `UPDATE players SET kit_status='queued', kit_error='', kit_hint=CASE WHEN $2<>'' THEN $2 ELSE kit_hint END, kit_updated_at=now() WHERE id=$1`
		args = append(args, hint)
	default:
		httpx.Fail(w, r, httpx.ErrNotFound)
		return
	}
	if _, err := s.DB.ExecContext(r.Context(), q, append([]any{id}, args...)...); err != nil {
		httpx.Fail(w, r, err)
		return
	}
	if action == "regenerate" {
		s.kit.kick()
	}
	s.audit(r, "kit_"+action, "player", id, nil)
	p, err = s.loadKitPlayer(r.Context(), id)
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, p)
}
