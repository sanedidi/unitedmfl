package api

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/sanedidi/unitedmfl/backend/internal/httpx"
)

// Team kits: a team's jersey photo; the AI service dresses every player and
// coaching-staff photo in it. Originals stay in photo_url; the site shows
// kit_approved_url once an admin approves the generated picture.

// displayPhoto is the SQL expression for the photo the site shows.
const displayPhoto = `COALESCE(NULLIF(p.kit_approved_url, ''), p.photo_url)`

// Tables with people dressed in the kit (same kit_* columns in both).
const (
	tPlayers = "players"
	tStaff   = "team_staff"
)

var kitTables = []string{tPlayers, tStaff}

// staffRoles names coaching-staff roles for the prompt and the admin.
var staffRoles = map[string]string{
	"head_coach": "Bosh murabbiy", "assistant": "Yordamchi murabbiy", "gk_coach": "Darvozabonlar murabbiyi",
	"fitness": "Fitnes murabbiyi", "doctor": "Shifokor", "manager": "Menejer", "other": "Shtab a’zosi",
}

type kitSettings struct {
	AutoOnKit    bool   `json:"auto_on_kit"`
	AutoOnPlayer bool   `json:"auto_on_player"`
	Describe     bool   `json:"describe"`
	Quality      string `json:"quality"`
}

type kitWorker struct {
	wake    chan struct{}
	mu      sync.Mutex
	running map[string]context.CancelFunc // "table:id" → cancel
}

func kitKey(tbl string, id int64) string { return fmt.Sprintf("%s:%d", tbl, id) }

func (k *kitWorker) kick() {
	select {
	case k.wake <- struct{}{}:
	default:
	}
}

func (k *kitWorker) set(key string, c context.CancelFunc) {
	k.mu.Lock()
	if c == nil {
		delete(k.running, key)
	} else {
		k.running[key] = c
	}
	k.mu.Unlock()
}

func (k *kitWorker) cancel(keys []string) {
	k.mu.Lock()
	defer k.mu.Unlock()
	for _, key := range keys {
		if c, ok := k.running[key]; ok {
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

// teamKitChanged: a new or replaced kit gets a description and dresses the squad and staff.
func teamKitChanged(s *Server, id int64, old, cur map[string]any) {
	kit := str(cur, "kit_url")
	if kit == str(old, "kit_url") {
		return
	}
	if kit == "" { // kit removed: stop pending work, keep approved pictures until changed
		s.kit.cancel(s.kitStopTeam(context.Background(), id))
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

// kitPhotoChanged builds the hook for players / staff: a new original photo
// (or a move to another team) re-dresses the person.
func kitPhotoChanged(tbl string) func(s *Server, id int64, old, cur map[string]any) {
	return func(s *Server, id int64, old, cur map[string]any) {
		photo := str(cur, "photo_url")
		ctx := context.Background()
		if photo == str(old, "photo_url") && num(cur, "team_id") == num(old, "team_id") {
			// a new number matters only when the kit shows numbers
			if old == nil || num(cur, "number") == num(old, "number") {
				return
			}
			var shows bool
			_ = s.DB.QueryRowContext(ctx, `SELECT kit_has_number FROM teams WHERE id=$1`, num(cur, "team_id")).Scan(&shows)
			if !shows {
				return
			}
		}
		// the approved picture belongs to the old photo / team: never show it again
		_, _ = s.DB.ExecContext(ctx, `UPDATE `+tbl+` SET kit_approved_url='', kit_photo_url='', kit_hint='', kit_error='', kit_analysis=NULL,
			kit_status='', kit_updated_at=now() WHERE id=$1`, id)
		s.kit.cancel([]string{kitKey(tbl, id)})
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
			res, err := s.DB.ExecContext(ctx, `UPDATE `+tbl+` p SET kit_status='queued', kit_updated_at=now()
				FROM teams t WHERE p.id=$1 AND t.id=p.team_id AND t.kit_url<>'' AND p.photo_url<>''`, id)
			if err == nil {
				if n, _ := res.RowsAffected(); n > 0 {
					s.kit.kick()
				}
			}
		}()
	}
}

func playerPhotoChanged(s *Server, id int64, old, cur map[string]any) {
	kitPhotoChanged(tPlayers)(s, id, old, cur)
}

func staffPhotoChanged(s *Server, id int64, old, cur map[string]any) {
	kitPhotoChanged(tStaff)(s, id, old, cur)
}

// kitQueueTeam queues the team's players and staff; people without a photo are marked skipped.
func (s *Server) kitQueueTeam(ctx context.Context, team int64, includeApproved bool) (int64, error) {
	cond := `AND kit_status NOT IN ('approved', 'running')`
	if includeApproved {
		cond = `AND kit_status <> 'running'`
	}
	var total int64
	for _, tbl := range kitTables {
		res, err := s.DB.ExecContext(ctx, `UPDATE `+tbl+` SET kit_status = CASE WHEN photo_url='' THEN 'skipped' ELSE 'queued' END,
			kit_error='', kit_updated_at=now() WHERE team_id=$1 AND EXISTS (SELECT 1 FROM teams WHERE id=$1 AND kit_url<>'') `+cond, team)
		if err != nil {
			return total, err
		}
		n, _ := res.RowsAffected()
		total += n
	}
	s.kit.kick()
	return total, nil
}

// kitStopTeam cancels queued and running work; returns worker keys to cancel.
func (s *Server) kitStopTeam(ctx context.Context, team int64) []string {
	var keys []string
	for _, tbl := range kitTables {
		rows, err := s.DB.QueryContext(ctx, `UPDATE `+tbl+` SET kit_status='cancelled', kit_updated_at=now()
			WHERE team_id=$1 AND kit_status IN ('queued','running') RETURNING id`, team)
		if err != nil {
			continue
		}
		for rows.Next() {
			var id int64
			if rows.Scan(&id) == nil {
				keys = append(keys, kitKey(tbl, id))
			}
		}
		rows.Close()
	}
	return keys
}

// kitDescribe asks the AI service to describe the team's kit and stores it.
func (s *Server) kitDescribe(ctx context.Context, team int64) (kitDescription, error) {
	var none kitDescription
	var name, kit string
	if err := s.DB.QueryRowContext(ctx, `SELECT name, kit_url FROM teams WHERE id=$1`, team).Scan(&name, &kit); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return none, httpx.ErrNotFound
		}
		return none, err
	}
	if kit == "" {
		return none, httpx.Validation(map[string]any{"kit_url": "Avval forma rasmini yuklang va saqlang"})
	}
	assets, warnings := s.loadAssets(ctx, []aiAsset{{Kind: "url", URL: kit, Label: "forma"}})
	if len(assets) == 0 {
		return none, httpx.BadRequest(strings.Join(warnings, "; "))
	}
	raw, err := s.aiCall(ctx, http.MethodPost, "/v1/kit/describe", map[string]any{"kit": assets[0], "team": name})
	if err != nil {
		return none, err
	}
	var out kitDescription
	if err := json.Unmarshal(raw, &out); err != nil {
		return out, err
	}
	_, err = s.DB.ExecContext(ctx, `UPDATE teams SET kit_description=$2, kit_has_number=$4, kit_number_style=$5, kit_desc_version=$6, updated_at=now() WHERE id=$1 AND kit_url=$3`,
		team, out.Description, kit, out.NumberVisible, out.NumberStyle, kitDescVersion)
	return out, err
}

// kitDescVersion: descriptions older than this are written again once (number detection).
const kitDescVersion = 2

// redescribeOldKits refreshes kit descriptions written by an older version.
func (s *Server) redescribeOldKits(ctx context.Context) {
	cfg, _, ok := s.kitConfig(ctx)
	if !ok || !cfg.Describe {
		return
	}
	rows, err := s.DB.QueryContext(ctx, `SELECT id FROM teams WHERE kit_url<>'' AND kit_desc_version < $1`, kitDescVersion)
	if err != nil {
		return
	}
	var ids []int64
	for rows.Next() {
		var id int64
		if rows.Scan(&id) == nil {
			ids = append(ids, id)
		}
	}
	rows.Close()
	for _, id := range ids {
		c, cancel := context.WithTimeout(ctx, 3*time.Minute)
		if _, err := s.kitDescribe(c, id); err != nil {
			slog.Warn("kit re-describe failed", "team", id, "err", err)
		} else {
			slog.Info("kit re-described", "team", id)
		}
		cancel()
	}
}

type kitDescription struct {
	Description   string `json:"kit_description"`
	NumberVisible bool   `json:"kit_has_number"`
	NumberStyle   string `json:"kit_number_style"`
}

func (d *kitDescription) UnmarshalJSON(b []byte) error {
	var v struct {
		Description   string `json:"description"`
		NumberVisible bool   `json:"number_visible"`
		NumberStyle   string `json:"number_style"`
	}
	if err := json.Unmarshal(b, &v); err != nil {
		return err
	}
	d.Description, d.NumberVisible, d.NumberStyle = v.Description, v.NumberVisible, v.NumberStyle
	return nil
}

// playerNumberRequired: when the team kit shows a number, a player must have one.
func playerNumberRequired(ctx context.Context, s *Server, body map[string]any, creating bool) error {
	team, hasTeam := body["team_id"]
	number, hasNumber := body["number"]
	if !creating && !(hasTeam && hasNumber) {
		return nil // partial update (e.g. bulk photos)
	}
	if !hasTeam || team == nil || (hasNumber && number != nil) {
		return nil
	}
	var needs bool
	_ = s.DB.QueryRowContext(ctx, `SELECT kit_has_number FROM teams WHERE id=$1`, fmt.Sprint(team)).Scan(&needs)
	if needs {
		return httpx.Validation(map[string]any{"number": "Raqam majburiy: jamoa formasida o‘yinchi raqami bor"})
	}
	return nil
}

// ---------- worker ----------

// StartKitWorker processes queued people in the background (two at a time).
func (s *Server) StartKitWorker(ctx context.Context) {
	for _, tbl := range kitTables {
		_, _ = s.DB.ExecContext(ctx, `UPDATE `+tbl+` SET kit_status='queued' WHERE kit_status='running'`)
	}
	go s.redescribeOldKits(ctx)
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
	tbl                       string
	id                        int64
	name, role, photo, hint   string
	team, kitURL, description string
	number, numberStyle       string
	kitHasNumber              bool
}

// kitClaim takes the oldest queued person of one table.
func (s *Server) kitClaim(ctx context.Context, tbl string) (kitJob, error) {
	j := kitJob{tbl: tbl}
	role, number := `''`, `coalesce(p.number::text, '')`
	if tbl == tStaff {
		role, number = `p.role`, `''`
	}
	err := s.DB.QueryRowContext(ctx, `UPDATE `+tbl+` p SET kit_status='running', kit_error='', kit_updated_at=now()
		FROM teams t
		WHERE p.id = (SELECT id FROM `+tbl+` WHERE kit_status='queued' ORDER BY kit_updated_at NULLS FIRST, id LIMIT 1 FOR UPDATE SKIP LOCKED)
		  AND t.id = p.team_id
		RETURNING p.id, p.full_name, `+role+`, `+number+`, p.photo_url, p.kit_hint, t.name, t.kit_url, t.kit_description, t.kit_has_number, t.kit_number_style`).
		Scan(&j.id, &j.name, &j.role, &j.number, &j.photo, &j.hint, &j.team, &j.kitURL, &j.description, &j.kitHasNumber, &j.numberStyle)
	return j, err
}

// kitNext claims and processes one queued person; false when the queues are empty.
func (s *Server) kitNext(ctx context.Context) bool {
	if ctx.Err() != nil || s.Cfg.AIServiceURL == "" {
		return false
	}
	var j kitJob
	found := false
	for _, tbl := range kitTables {
		var err error
		j, err = s.kitClaim(ctx, tbl)
		if err == nil {
			found = true
			break
		}
		if !errors.Is(err, sql.ErrNoRows) {
			slog.Warn("kit claim failed", "table", tbl, "err", err)
			return false
		}
	}
	if !found {
		// queued people without a team would never be claimed
		for _, tbl := range kitTables {
			_, _ = s.DB.ExecContext(ctx, `UPDATE `+tbl+` SET kit_status='cancelled' WHERE kit_status='queued' AND team_id IS NULL`)
		}
		return false
	}
	key := kitKey(j.tbl, j.id)
	jctx, cancel := context.WithTimeout(ctx, 10*time.Minute)
	s.kit.set(key, cancel)
	defer func() { cancel(); s.kit.set(key, nil) }()
	status, url, errMsg, analysis, model := s.kitProcess(jctx, j)
	if errors.Is(jctx.Err(), context.DeadlineExceeded) {
		status, errMsg = "error", "Vaqt tugadi — qayta urinib ko‘ring"
	}
	// a stop by the admin already set «cancelled»: the running-only update below leaves it
	_, err := s.DB.ExecContext(ctx, `UPDATE `+j.tbl+` SET kit_status=$2, kit_photo_url=CASE WHEN $3<>'' THEN $3 ELSE kit_photo_url END,
		kit_error=$4, kit_analysis=$5, kit_model=$6, kit_updated_at=now()
		WHERE id=$1 AND kit_status='running' AND photo_url=$7`, j.id, status, url, errMsg, nullJSON(analysis), model, j.photo)
	if err != nil {
		slog.Warn("kit save failed", "table", j.tbl, "id", j.id, "err", err)
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
	if j.tbl == tPlayers && j.kitHasNumber && j.number == "" {
		return "error", "", "Raqam kiritilmagan — jamoa formasida o‘yinchi raqami bor. Raqamni kiriting va saqlang.", nil, ""
	}
	assets, warnings := s.loadAssets(ctx, []aiAsset{{Kind: "url", URL: j.photo, Label: "photo"}, {Kind: "url", URL: j.kitURL, Label: "kit"}})
	if len(assets) != 2 {
		return "error", "", "Rasmni o‘qib bo‘lmadi: " + strings.Join(warnings, "; "), nil, ""
	}
	person := j.name
	if j.tbl == tStaff {
		role := staffRoles[j.role]
		if role == "" {
			role = staffRoles["other"]
		}
		person = fmt.Sprintf("%s %s (coaching staff of the team)", role, j.name)
	}
	raw, err := s.aiCall(ctx, http.MethodPost, "/v1/kit/dress", map[string]any{
		"photo": assets[0], "kit": assets[1], "team": j.team, "player": person, "description": j.description, "hint": j.hint,
		"number_on_kit": j.kitHasNumber, "number_style": j.numberStyle, "number": j.number, "staff": j.tbl == tStaff,
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

type kitPerson struct {
	ID          int64           `json:"id"`
	Kind        string          `json:"kind"` // player | staff
	FullName    string          `json:"full_name"`
	Number      *int64          `json:"number"`
	Role        string          `json:"role,omitempty"`
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

func kitPersonSelect(tbl string) string {
	extra := `p.number, ''`
	if tbl == tStaff {
		extra = `NULL::bigint, p.role`
	}
	return `SELECT p.id, p.full_name, ` + extra + `, p.team_id, p.photo_url, p.kit_photo_url, p.kit_approved_url, p.kit_status, p.kit_error,
	p.kit_hint, p.kit_analysis, p.kit_model, p.kit_updated_at, coalesce(t.kit_url,'')<>''
	FROM ` + tbl + ` p LEFT JOIN teams t ON t.id=p.team_id`
}

func scanKitPerson(tbl string, row interface{ Scan(...any) error }) (kitPerson, error) {
	p := kitPerson{Kind: "player"}
	if tbl == tStaff {
		p.Kind = "staff"
	}
	var number, team sql.NullInt64
	var analysis []byte
	var upd sql.NullTime
	err := row.Scan(&p.ID, &p.FullName, &number, &p.Role, &team, &p.PhotoURL, &p.KitPhotoURL, &p.ApprovedURL, &p.Status, &p.Error, &p.Hint, &analysis, &p.Model, &upd, &p.TeamKit)
	if number.Valid {
		p.Number = &number.Int64
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
	r.Get("/players/{id}/kit", s.kitPersonView(tPlayers))
	r.Post("/players/{id}/kit/{action}", s.kitPersonAction(tPlayers))
	r.Get("/team-staff/{id}/kit", s.kitPersonView(tStaff))
	r.Post("/team-staff/{id}/kit/{action}", s.kitPersonAction(tStaff))
}

func (s *Server) kitList(ctx context.Context, tbl string, team int64) ([]kitPerson, error) {
	order := `p.number NULLS LAST, p.full_name`
	if tbl == tStaff {
		order = `p.ord, p.id`
	}
	rows, err := s.DB.QueryContext(ctx, kitPersonSelect(tbl)+` WHERE p.team_id=$1
		ORDER BY CASE p.kit_status WHEN 'review' THEN 0 WHEN 'multi' THEN 1 WHEN 'error' THEN 2 WHEN 'running' THEN 3 WHEN 'queued' THEN 4 ELSE 5 END, `+order, team)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	list := []kitPerson{}
	for rows.Next() {
		p, err := scanKitPerson(tbl, rows)
		if err != nil {
			return nil, err
		}
		list = append(list, p)
	}
	return list, rows.Err()
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
		HasNumber   bool   `json:"kit_has_number"`
		NumberStyle string `json:"kit_number_style"`
	}
	err = s.DB.QueryRowContext(r.Context(), `SELECT id, name, kit_url, kit_description, kit_has_number, kit_number_style FROM teams WHERE id=$1`, id).
		Scan(&team.ID, &team.Name, &team.KitURL, &team.Description, &team.HasNumber, &team.NumberStyle)
	if errors.Is(err, sql.ErrNoRows) {
		httpx.Fail(w, r, httpx.ErrNotFound)
		return
	}
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	players, err := s.kitList(r.Context(), tPlayers, id)
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	staff, err := s.kitList(r.Context(), tStaff, id)
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	counts := map[string]int{}
	for _, p := range players {
		if p.Number == nil {
			counts["no_number"]++
		}
	}
	for _, p := range append(append([]kitPerson{}, players...), staff...) {
		counts[p.Status]++
		if p.ApprovedURL != "" {
			counts["on_site"]++
		}
	}
	cfg, model, ok := s.kitConfig(r.Context())
	httpx.JSON(w, http.StatusOK, map[string]any{"team": team, "players": players, "staff": staff, "counts": counts,
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
	httpx.JSON(w, http.StatusOK, desc)
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
			keys := s.kitStopTeam(r.Context(), id)
			s.kit.cancel(keys)
			n = int64(len(keys))
		case "approve":
			for _, tbl := range kitTables {
				res, e := s.DB.ExecContext(r.Context(), `UPDATE `+tbl+` SET kit_status='approved', kit_approved_url=kit_photo_url, kit_updated_at=now()
					WHERE team_id=$1 AND kit_status='review' AND kit_photo_url<>''`, id)
				if e != nil {
					err = e
					break
				}
				c, _ := res.RowsAffected()
				n += c
			}
		}
		if err != nil {
			httpx.Fail(w, r, err)
			return
		}
		s.audit(r, "kit_"+action, "team", id, map[string]any{"people": n})
		httpx.JSON(w, http.StatusOK, map[string]int64{"players": n})
	}
}

func (s *Server) loadKitPerson(ctx context.Context, tbl string, id int64) (kitPerson, error) {
	p, err := scanKitPerson(tbl, s.DB.QueryRowContext(ctx, kitPersonSelect(tbl)+` WHERE p.id=$1`, id))
	if errors.Is(err, sql.ErrNoRows) {
		return p, httpx.ErrNotFound
	}
	return p, err
}

func (s *Server) kitPersonView(tbl string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id, err := idParam(r, "id")
		if err != nil {
			httpx.Fail(w, r, err)
			return
		}
		p, err := s.loadKitPerson(r.Context(), tbl, id)
		if err != nil {
			httpx.Fail(w, r, err)
			return
		}
		httpx.JSON(w, http.StatusOK, p)
	}
}

func (s *Server) kitPersonAction(tbl string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
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
		p, err := s.loadKitPerson(r.Context(), tbl, id)
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
			q = `UPDATE ` + tbl + ` SET kit_status='approved', kit_approved_url=kit_photo_url, kit_updated_at=now() WHERE id=$1`
		case "reject":
			q = `UPDATE ` + tbl + ` SET kit_status='rejected', kit_updated_at=now() WHERE id=$1 AND kit_status='review'`
		case "revert": // back to the original photo on the site
			q = `UPDATE ` + tbl + ` SET kit_approved_url='', kit_status=CASE WHEN kit_status='approved' THEN 'rejected' ELSE kit_status END, kit_updated_at=now() WHERE id=$1`
		case "regenerate":
			if s.Cfg.AIServiceURL == "" {
				httpx.Fail(w, r, errAIOff)
				return
			}
			if !p.TeamKit || p.PhotoURL == "" {
				httpx.Fail(w, r, httpx.NewError(http.StatusConflict, "no_kit", "Jamoa formasi yoki rasm yo‘q"))
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
			q = `UPDATE ` + tbl + ` SET kit_status='queued', kit_error='', kit_hint=CASE WHEN $2<>'' THEN $2 ELSE kit_hint END, kit_updated_at=now() WHERE id=$1`
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
		entity := "player"
		if tbl == tStaff {
			entity = "team_staff"
		}
		s.audit(r, "kit_"+action, entity, id, nil)
		p, err = s.loadKitPerson(r.Context(), tbl, id)
		if err != nil {
			httpx.Fail(w, r, err)
			return
		}
		httpx.JSON(w, http.StatusOK, p)
	}
}
