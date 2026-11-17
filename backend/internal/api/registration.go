package api

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"database/sql"
	"encoding/base32"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"image"
	_ "image/jpeg" // logo/photo size check
	_ "image/png"
	"io"
	"log/slog"
	"math/big"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/sanedidi/unitedmfl/backend/internal/auth"
	"github.com/sanedidi/unitedmfl/backend/internal/httpx"
	"github.com/sanedidi/unitedmfl/backend/internal/roster"
	"github.com/sanedidi/unitedmfl/backend/internal/sms"
	"github.com/sanedidi/unitedmfl/backend/internal/xlsx"
)

// Team self-registration. The registration site (register/) is a separate SPA:
//   /            → GET /register/home (the default link, or «closed»)
//   /{code}      → GET /register/links/{code}, then POST …/applications
//   /a/{token}   → the application: wizard while it is a draft, status page after
// The token is the representative's secret; there are no accounts.

// ---------- links ----------

type regLink struct {
	ID              int64
	Code            string
	Title           string
	SeasonID        *int64
	StageID         *int64
	Kind            string
	IsActive        bool
	IsDefault       bool
	OpensAt         *time.Time
	ClosesAt        *time.Time
	MaxTeams        *int
	MinPlayers      int
	MaxPlayers      int
	MinAge          *int
	RequireLogo     bool
	RequirePhoto    bool
	RequireMedical  bool
	RequirePhone    bool
	CheckDuplicates bool
	Heading         string
	Description     string
	RulesURL        string
	SeasonName      string
	StageName       string
	Approved        int // approved applications (taken places)
	Sent            int // applications sent (not draft/rejected)
	Drafts          int
	CreatedAt       time.Time
	UpdatedAt       time.Time
}

const linkSelect = `SELECT l.id, l.code, l.title, l.season_id, l.stage_id, l.kind, l.is_active, l.is_default, l.opens_at, l.closes_at,
	l.max_teams, l.min_players, l.max_players, l.min_age, l.require_logo, l.require_photo, l.require_medical, l.require_phone,
	l.check_duplicates, l.heading, l.description, l.rules_url, coalesce(se.name, ''), coalesce(st.name, ''),
	(SELECT count(*) FROM team_applications a WHERE a.link_id = l.id AND a.status = 'approved'),
	(SELECT count(*) FROM team_applications a WHERE a.link_id = l.id AND a.status NOT IN ('draft', 'rejected')),
	(SELECT count(*) FROM team_applications a WHERE a.link_id = l.id AND a.status = 'draft'),
	l.created_at, l.updated_at
	FROM registration_links l LEFT JOIN seasons se ON se.id = l.season_id LEFT JOIN stages st ON st.id = l.stage_id`

func scanLink(row interface{ Scan(...any) error }) (*regLink, error) {
	l := &regLink{}
	err := row.Scan(&l.ID, &l.Code, &l.Title, &l.SeasonID, &l.StageID, &l.Kind, &l.IsActive, &l.IsDefault, &l.OpensAt, &l.ClosesAt,
		&l.MaxTeams, &l.MinPlayers, &l.MaxPlayers, &l.MinAge, &l.RequireLogo, &l.RequirePhoto, &l.RequireMedical, &l.RequirePhone,
		&l.CheckDuplicates, &l.Heading, &l.Description, &l.RulesURL, &l.SeasonName, &l.StageName, &l.Approved, &l.Sent, &l.Drafts,
		&l.CreatedAt, &l.UpdatedAt)
	return l, err
}

func (s *Server) linkByCode(ctx context.Context, code string) (*regLink, error) {
	l, err := scanLink(s.DB.QueryRowContext(ctx, linkSelect+` WHERE l.code = $1`, strings.ToUpper(strings.TrimSpace(code))))
	if errors.Is(err, sql.ErrNoRows) {
		return nil, httpx.ErrNotFound
	}
	return l, err
}

func (s *Server) linkByID(ctx context.Context, id int64) (*regLink, error) {
	l, err := scanLink(s.DB.QueryRowContext(ctx, linkSelect+` WHERE l.id = $1`, id))
	if errors.Is(err, sql.ErrNoRows) {
		return nil, httpx.ErrNotFound
	}
	return l, err
}

// Link states shown on the registration site.
const (
	linkOpen   = "open"
	linkPaused = "paused" // closed in the admin
	linkSoon   = "soon"   // opens_at in the future
	linkClosed = "closed" // closes_at passed
	linkFull   = "full"   // max_teams approved
	linkUsed   = "used"   // single-use link already used
)

func (l *regLink) state(now time.Time) string {
	switch {
	case !l.IsActive:
		return linkPaused
	case l.OpensAt != nil && now.Before(*l.OpensAt):
		return linkSoon
	case l.ClosesAt != nil && now.After(*l.ClosesAt):
		return linkClosed
	case l.MaxTeams != nil && l.Approved >= *l.MaxTeams:
		return linkFull
	case l.Kind == "single" && l.Sent > 0:
		return linkUsed
	}
	return linkOpen
}

func (l *regLink) slotsLeft() *int {
	if l.MaxTeams == nil {
		return nil
	}
	n := max(*l.MaxTeams-l.Approved, 0)
	return &n
}

// publicLink is what the registration site may see (no internal title).
func (s *Server) publicLink(l *regLink) map[string]any {
	return map[string]any{
		"code": l.Code, "kind": l.Kind, "state": l.state(time.Now()),
		"heading": l.Heading, "description": l.Description, "rules_url": l.RulesURL,
		"season": l.SeasonName, "stage": l.StageName,
		"opens_at": l.OpensAt, "closes_at": l.ClosesAt,
		"max_teams": l.MaxTeams, "slots_left": l.slotsLeft(),
		"requirements": map[string]any{
			"min_players": l.MinPlayers, "max_players": l.MaxPlayers, "min_age": l.MinAge,
			"logo": l.RequireLogo, "photo": l.RequirePhoto, "medical": l.RequireMedical,
			"phone": s.otpRequired(l),
		},
	}
}

// otpRequired: phone verification is asked only when an SMS sender is configured.
func (s *Server) otpRequired(l *regLink) bool { return l != nil && l.RequirePhone && s.sms.Enabled() }

// ---------- applications ----------

type teamInfo struct {
	Name      string   `json:"name"`
	ShortName string   `json:"short_name"`
	City      string   `json:"city"`
	Colors    []string `json:"colors"`
	CrestURL  string   `json:"crest_url"`
	CrestW    int      `json:"crest_w"`
	CrestH    int      `json:"crest_h"`
	About     string   `json:"about"`
	Instagram string   `json:"instagram"`
}

type repInfo struct {
	Name       string `json:"name"`
	Role       string `json:"role"`
	Phone      string `json:"phone"`
	Telegram   string `json:"telegram"`
	Email      string `json:"email"`
	Authorized bool   `json:"authorized"`
}

type consentsInfo struct {
	Rules    bool `json:"rules"`
	Players  bool `json:"players"`
	Personal bool `json:"personal"`
}

type appComment struct {
	Section string `json:"section"` // team | rep | roster
	Text    string `json:"text"`
}

type application struct {
	ID              int64
	LinkID          *int64
	Token           string
	Status          string
	Team            teamInfo
	Rep             repInfo
	Players         []roster.Player
	Staff           []roster.Staff
	Consents        consentsInfo
	RepPhone        string
	PhoneVerifiedAt *time.Time
	Comments        []appComment
	ChangesDeadline *time.Time
	RejectReason    string
	InternalNote    string
	TeamID          *int64
	SubmittedAt     *time.Time
	DecidedAt       *time.Time
	CreatedAt       time.Time
	UpdatedAt       time.Time
}

const appCols = `id, link_id, token, status, team, rep, players, staff, consents, rep_phone, phone_verified_at, comments,
	changes_deadline, reject_reason, internal_note, team_id, submitted_at, decided_at, created_at, updated_at`

const appSelect = `SELECT ` + appCols + ` FROM team_applications`

func scanApp(row interface{ Scan(...any) error }) (*application, error) {
	a := &application{}
	var team, rep, players, staff, consents, comments []byte
	if err := row.Scan(&a.ID, &a.LinkID, &a.Token, &a.Status, &team, &rep, &players, &staff, &consents, &a.RepPhone, &a.PhoneVerifiedAt,
		&comments, &a.ChangesDeadline, &a.RejectReason, &a.InternalNote, &a.TeamID, &a.SubmittedAt, &a.DecidedAt, &a.CreatedAt, &a.UpdatedAt); err != nil {
		return nil, err
	}
	_ = json.Unmarshal(team, &a.Team)
	_ = json.Unmarshal(rep, &a.Rep)
	_ = json.Unmarshal(players, &a.Players)
	_ = json.Unmarshal(staff, &a.Staff)
	_ = json.Unmarshal(consents, &a.Consents)
	_ = json.Unmarshal(comments, &a.Comments)
	if a.Players == nil {
		a.Players = []roster.Player{}
	}
	if a.Staff == nil {
		a.Staff = []roster.Staff{}
	}
	if a.Comments == nil {
		a.Comments = []appComment{}
	}
	if a.Team.Colors == nil {
		a.Team.Colors = []string{}
	}
	return a, nil
}

func (a *application) number() string { return fmt.Sprintf("UMF-%04d", a.ID) }

func (s *Server) appByToken(ctx context.Context, token string) (*application, *regLink, error) {
	s.expireApplications(ctx)
	a, err := scanApp(s.DB.QueryRowContext(ctx, appSelect+` WHERE token = $1`, token))
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil, httpx.ErrNotFound
	}
	if err != nil {
		return nil, nil, err
	}
	var l *regLink
	if a.LinkID != nil {
		if l, err = s.linkByID(ctx, *a.LinkID); err != nil && !errors.Is(err, httpx.ErrNotFound) {
			return nil, nil, err
		}
	}
	return a, l, nil
}

// expireApplications rejects applications whose correction deadline passed.
func (s *Server) expireApplications(ctx context.Context) {
	rows, err := s.DB.QueryContext(ctx, `UPDATE team_applications SET status = 'rejected', decided_at = now(), updated_at = now(),
		reject_reason = 'Tuzatish muddati o‘tdi' WHERE status = 'changes' AND changes_deadline < now() RETURNING id`)
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
		s.appEvent(ctx, id, "expired", "Tuzatish muddati o‘tdi", nil)
	}
}

func (s *Server) appEvent(ctx context.Context, appID int64, kind, note string, userID *int64) {
	if _, err := s.DB.ExecContext(ctx, `INSERT INTO application_events (application_id, kind, note, user_id) VALUES ($1, $2, $3, $4)`, appID, kind, note, userID); err != nil {
		slog.Warn("application event", "err", err)
	}
}

// editable tells which sections the representative may change now.
func editable(a *application, l *regLink, now time.Time) map[string]bool {
	out := map[string]bool{"team": false, "rep": false, "roster": false}
	switch a.Status {
	case "draft":
		if l != nil && l.state(now) == linkOpen {
			out["team"], out["rep"], out["roster"] = true, true, true
		}
	case "changes":
		if a.ChangesDeadline == nil || now.Before(*a.ChangesDeadline) {
			for _, c := range a.Comments {
				if _, ok := out[c.Section]; ok {
					out[c.Section] = true
				}
			}
		}
	}
	return out
}

func anyEditable(m map[string]bool) bool { return m["team"] || m["rep"] || m["roster"] }

// ---------- checks ----------

type appCheck struct {
	Level   string `json:"level"`   // error | warn
	Section string `json:"section"` // team | rep | roster | submit
	Code    string `json:"code"`
	Text    string `json:"text"`
	Index   *int   `json:"index,omitempty"` // player index for roster checks
	Staff   bool   `json:"staff,omitempty"` // Index points into staff
}

type dupMatch struct {
	PlayerID int64  `json:"player_id"`
	FullName string `json:"full_name"`
	Number   *int   `json:"number"`
	TeamID   *int64 `json:"team_id"`
	TeamName string `json:"team_name"`
}

// checkEnv is what checks need from the database.
type checkEnv struct {
	OTPRequired bool
	NameTaken   bool // team name is used by a league team
	ShortTaken  bool
	NamePending string // another pending application uses this name
	Players     map[string][]dupMatch
	Now         time.Time
}

var (
	reHexColor = regexp.MustCompile(`^#[0-9A-Fa-f]{6}$`)
	reShort    = regexp.MustCompile(`^[A-Z]{2,4}$`)
	reEmail    = regexp.MustCompile(`^[^@\s]+@[^@\s]+\.[^@\s]+$`)
)

func idx(i int) *int { return &i }

// checkApplication validates the whole application. Errors block sending
// (and approval); warnings are shown to the representative and the admin.
func checkApplication(a *application, l *regLink, env checkEnv) []appCheck {
	out := []appCheck{}
	add := func(level, section, code, text string, i *int) {
		out = append(out, appCheck{Level: level, Section: section, Code: code, Text: text, Index: i})
	}
	t := a.Team
	switch n := len([]rune(strings.TrimSpace(t.Name))); {
	case n == 0:
		add("error", "team", "team.name", "Jamoa nomini yozing", nil)
	case n < 2:
		add("error", "team", "team.name", "Jamoa nomi juda qisqa", nil)
	case env.NameTaken:
		add("error", "team", "team.name", "Bu nom ligadagi boshqa jamoada band", nil)
	case env.NamePending != "":
		add("warn", "team", "team.name", "Shu nomli boshqa ariza ham bor ("+env.NamePending+") — admin hal qiladi", nil)
	}
	// the short code is optional; when given it must be valid and free
	switch {
	case t.ShortName == "":
	case !reShort.MatchString(t.ShortName):
		add("error", "team", "team.short_name", "Qisqa kod — 2–4 lotin harfi", nil)
	case env.ShortTaken:
		add("error", "team", "team.short_name", "Bu qisqa kod boshqa jamoada band", nil)
	}
	if strings.TrimSpace(t.Instagram) == "" {
		add("error", "team", "team.instagram", "Jamoaning Instagram sahifasini yozing", nil)
	}
	if t.CrestURL == "" {
		if l == nil || l.RequireLogo {
			add("error", "team", "team.crest_url", "Logotipni yuklang", nil)
		}
	} else if t.CrestW > 0 && (t.CrestW < 512 || t.CrestH < 512) {
		add("warn", "team", "team.crest_url", fmt.Sprintf("Logotip kichik (%d×%d) — kamida 512×512 tavsiya etiladi", t.CrestW, t.CrestH), nil)
	}

	r := a.Rep
	if strings.TrimSpace(r.Name) == "" {
		add("error", "rep", "rep.name", "Vakilning ism va familiyasini yozing", nil)
	}
	if strings.TrimSpace(r.Phone) == "" {
		add("error", "rep", "rep.phone", "Telefon raqamini yozing", nil)
	} else if _, ok := auth.NormalizePhone(r.Phone); !ok {
		add("error", "rep", "rep.phone", "Telefon raqami noto‘g‘ri", nil)
	} else if env.OTPRequired && a.PhoneVerifiedAt == nil {
		add("error", "rep", "rep.phone", "Telefon raqamini SMS-kod bilan tasdiqlang", nil)
	}
	if strings.TrimSpace(r.Telegram) == "" {
		add("error", "rep", "rep.telegram", "Telegram manzilini yozing", nil)
	}
	if r.Email != "" && !reEmail.MatchString(r.Email) {
		add("error", "rep", "rep.email", "Email noto‘g‘ri", nil)
	}
	if !r.Authorized {
		add("error", "rep", "rep.authorized", "Jamoa nomidan ariza berishga vakolatingizni tasdiqlang", nil)
	}

	minP, maxP := 8, 21
	var minAge *int
	requirePhoto, requireMedical := false, false
	if l != nil {
		minP, maxP, minAge, requirePhoto, requireMedical = l.MinPlayers, l.MaxPlayers, l.MinAge, l.RequirePhoto, l.RequireMedical
	}
	gk, missingMedical := 0, 0
	for _, p := range a.Players {
		if p.Role == roster.RoleGoalkeeper {
			gk++
		}
	}
	// limits count the whole roster: players, media people and coaching staff
	total := len(a.Players) + len(a.Staff)
	if total < minP {
		add("error", "roster", "roster.min", fmt.Sprintf("Tarkibda kamida %d kishi bo‘lishi kerak (o‘yinchilar, media shaxslar, murabbiylar) — hozir %d", minP, total), nil)
	}
	if total > maxP {
		add("error", "roster", "roster.max", fmt.Sprintf("Tarkibda ko‘pi bilan %d kishi (o‘yinchilar, media shaxslar, murabbiylar) — hozir %d", maxP, total), nil)
	}
	if len(a.Players) > 0 && gk == 0 {
		add("error", "roster", "roster.gk", "Kamida bitta darvozabon belgilang", nil)
	}
	numbers := map[int]int{}
	for i, p := range a.Players {
		name := p.FullName()
		if name == "" {
			name = fmt.Sprintf("%d-o‘yinchi", i+1)
		}
		if strings.TrimSpace(p.FirstName) == "" || strings.TrimSpace(p.LastName) == "" {
			add("error", "roster", "player.name", name+": ism va familiya majburiy", idx(i))
		}
		if p.BirthDate == "" {
			add("error", "roster", "player.birth_date", name+": tug‘ilgan sanani yozing", idx(i))
		} else if age, ok := roster.Age(p.BirthDate, env.Now); ok && minAge != nil && age < *minAge {
			add("error", "roster", "player.age", fmt.Sprintf("%s: %d yosh — kamida %d yosh bo‘lishi kerak", name, age, *minAge), idx(i))
		}
		if p.Number == nil {
			add("error", "roster", "player.number", name+": raqamni yozing", idx(i))
		} else if j, dup := numbers[*p.Number]; dup {
			add("error", "roster", "player.number_dup", fmt.Sprintf("%d-raqam takrorlangan: %s va %s", *p.Number, a.Players[j].FullName(), name), idx(i))
		} else {
			numbers[*p.Number] = i
		}
		if strings.TrimSpace(p.JerseyName) == "" {
			add("error", "roster", "player.jersey", name+": futbolkadagi yozuvni kiriting", idx(i))
		}
		if p.KitSize == "" {
			add("error", "roster", "player.kit_size", name+": forma o‘lchamini tanlang", idx(i))
		}
		if requirePhoto && p.PhotoURL == "" {
			add("error", "roster", "player.photo", name+": foto yuklang", idx(i))
		}
		if p.Medical == nil || p.Medical.File == "" {
			if requireMedical {
				add("error", "roster", "player.medical", name+": tibbiy ruxsatnomani yuklang", idx(i))
			} else {
				missingMedical++
			}
		}
		if roster.LooksSwapped(p.FirstName, p.LastName) {
			add("warn", "roster", "player.swapped", fmt.Sprintf("«%s» — ism va familiya almashgan bo‘lishi mumkin", name), idx(i))
		}
		if env.Players != nil {
			for _, m := range env.Players[roster.NameKey(p.FirstName, p.LastName)] {
				where := "jamoasiz"
				if m.TeamName != "" {
					where = "«" + m.TeamName + "» tarkibida"
				}
				add("warn", "roster", "player.duplicate", fmt.Sprintf("%s: ligada shu ismli o‘yinchi bor — %s", name, where), idx(i))
				break
			}
		}
	}
	if missingMedical > 0 && len(a.Players) > 0 {
		add("warn", "roster", "roster.medical", fmt.Sprintf("Tibbiy ruxsatnoma: %d / %d yuklangan — birinchi matchgacha shart", len(a.Players)-missingMedical, len(a.Players)), nil)
	}
	head := 0
	for i, st := range a.Staff {
		if strings.TrimSpace(st.FirstName) == "" || strings.TrimSpace(st.LastName) == "" {
			c := appCheck{Level: "error", Section: "roster", Code: "staff.name", Text: fmt.Sprintf("%d-murabbiy: ism va familiya majburiy", i+1), Index: idx(i), Staff: true}
			out = append(out, c)
		}
		if st.Role == "head_coach" {
			head++
		}
	}
	if head == 0 {
		add("warn", "roster", "staff.head", "Bosh murabbiy ko‘rsatilmagan", nil)
	}
	c := a.Consents
	if !c.Rules || !c.Players || !c.Personal {
		add("error", "submit", "consents", "Yuborishdan oldin barcha roziliklarni belgilang", nil)
	}
	return out
}

func hasErrors(cs []appCheck) bool {
	for _, c := range cs {
		if c.Level == "error" {
			return true
		}
	}
	return false
}

// playerIndex maps a normalised name to active league players with that name.
func (s *Server) playerIndex(ctx context.Context) (map[string][]dupMatch, error) {
	rows, err := s.DB.QueryContext(ctx, `SELECT p.id, p.full_name, p.number, p.team_id, coalesce(t.name, '')
		FROM players p LEFT JOIN teams t ON t.id = p.team_id WHERE p.is_active`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string][]dupMatch{}
	for rows.Next() {
		var m dupMatch
		if err := rows.Scan(&m.PlayerID, &m.FullName, &m.Number, &m.TeamID, &m.TeamName); err != nil {
			return nil, err
		}
		k := roster.NameKey(m.FullName)
		out[k] = append(out[k], m)
	}
	return out, rows.Err()
}

// checkEnvFor loads what checkApplication needs for one application.
func (s *Server) checkEnvFor(ctx context.Context, a *application, l *regLink, idx map[string][]dupMatch) (checkEnv, error) {
	env := checkEnv{OTPRequired: s.otpRequired(l), Now: time.Now()}
	if a.Status == "approved" {
		return env, nil // the team exists now: comparing it with itself means nothing
	}
	if name := strings.TrimSpace(a.Team.Name); name != "" {
		_ = s.DB.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM teams WHERE lower(name) = lower($1))`, name).Scan(&env.NameTaken)
		var other sql.NullString
		_ = s.DB.QueryRowContext(ctx, `SELECT 'UMF-' || lpad(id::text, 4, '0') FROM team_applications
			WHERE id <> $1 AND lower(team->>'name') = lower($2) AND status IN ('submitted', 'review', 'changes') LIMIT 1`, a.ID, name).Scan(&other)
		env.NamePending = other.String
	}
	if a.Team.ShortName != "" {
		_ = s.DB.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM teams WHERE upper(short_name) = $1)`, a.Team.ShortName).Scan(&env.ShortTaken)
	}
	if l == nil || l.CheckDuplicates {
		if idx == nil {
			var err error
			if idx, err = s.playerIndex(ctx); err != nil {
				return env, err
			}
		}
		env.Players = idx
	}
	return env, nil
}

// ---------- representative view ----------

func (s *Server) repView(ctx context.Context, a *application, l *regLink) (map[string]any, error) {
	env, err := s.checkEnvFor(ctx, a, l, nil)
	if err != nil {
		return nil, err
	}
	now := time.Now()
	ed := editable(a, l, now)
	var link any
	if l != nil {
		link = s.publicLink(l)
	}
	var teamURL string
	if a.TeamID != nil && s.Cfg.SiteURL != "" {
		var slug string
		if s.DB.QueryRowContext(ctx, `SELECT slug FROM teams WHERE id = $1`, *a.TeamID).Scan(&slug) == nil {
			teamURL = s.Cfg.SiteURL + "/jamoalar/" + slug
		}
	}
	return map[string]any{
		"token": a.Token, "number": a.number(), "status": a.Status, "link": link,
		"team": a.Team, "rep": a.Rep, "players": a.Players, "staff": a.Staff, "consents": a.Consents,
		"phone_verified": a.PhoneVerifiedAt != nil, "otp_required": env.OTPRequired,
		"comments": a.Comments, "changes_deadline": a.ChangesDeadline, "reject_reason": a.RejectReason,
		"submitted_at": a.SubmittedAt, "decided_at": a.DecidedAt, "created_at": a.CreatedAt, "updated_at": a.UpdatedAt,
		"editable": ed, "can_submit": anyEditable(ed), "checks": checkApplication(a, l, env), "team_url": teamURL,
	}, nil
}

func (s *Server) writeRepView(w http.ResponseWriter, r *http.Request, status int, a *application, l *regLink) {
	v, err := s.repView(r.Context(), a, l)
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	httpx.JSON(w, status, v)
}

// ---------- public handlers ----------

func (s *Server) mountRegistration(r chi.Router) {
	r.Get("/register/home", s.regHome)
	r.Get("/register/template.xlsx", s.regTemplate)
	r.Get("/register/links/{code}", s.regLink)
	r.With(s.regCreateLimiter.Middleware).Post("/register/links/{code}/applications", s.regCreate)
	r.Route("/register/applications/{token}", func(r chi.Router) {
		r.Get("/", s.regGet)
		r.With(s.regSaveLimiter.Middleware).Put("/", s.regSave)
		r.With(s.regOTPLimiter.Middleware).Post("/otp/send", s.regOTPSend)
		r.With(s.regOTPLimiter.Middleware).Post("/otp/verify", s.regOTPVerify)
		r.With(s.regUploadLimiter.Middleware).Post("/files", s.regUpload)
		r.Get("/files/{file}", s.regFile)
		r.With(s.regUploadLimiter.Middleware).Post("/import", s.regImport)
		r.Post("/submit", s.regSubmit)
	})
}

// regHome: the root page of the registration site shows the default link (in
// whatever state it is), or «closed» when the admin has not chosen one.
func (s *Server) regHome(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	l, err := scanLink(s.DB.QueryRowContext(r.Context(), linkSelect+` WHERE l.is_default LIMIT 1`))
	if errors.Is(err, sql.ErrNoRows) {
		httpx.JSON(w, 200, map[string]any{"link": nil})
		return
	}
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	httpx.JSON(w, 200, map[string]any{"link": s.publicLink(l)})
}

func (s *Server) regLink(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	l, err := s.linkByCode(r.Context(), chi.URLParam(r, "code"))
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	httpx.JSON(w, 200, s.publicLink(l))
}

var closedMessages = map[string]string{
	linkPaused: "Ro‘yxatdan o‘tish hozircha yopiq",
	linkSoon:   "Ro‘yxatdan o‘tish hali boshlanmagan",
	linkClosed: "Arizalar qabuli yakunlangan",
	linkFull:   "Barcha joylar band",
	linkUsed:   "Bu havola allaqachon ishlatilgan",
}

func closedErr(state string) error {
	return &httpx.Error{Status: http.StatusConflict, Code: "registration_" + state, Message: closedMessages[state]}
}

func newToken() string {
	b := make([]byte, 20)
	_, _ = rand.Read(b)
	return strings.ToLower(strings.TrimRight(base32.StdEncoding.EncodeToString(b), "="))
}

func (s *Server) regCreate(w http.ResponseWriter, r *http.Request) {
	l, err := s.linkByCode(r.Context(), chi.URLParam(r, "code"))
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	if st := l.state(time.Now()); st != linkOpen {
		httpx.Fail(w, r, closedErr(st))
		return
	}
	a, err := scanApp(s.DB.QueryRowContext(r.Context(), `INSERT INTO team_applications (link_id, token, rep, ip)
		VALUES ($1, $2, '{"role":"captain"}', $3) RETURNING `+appCols,
		l.ID, newToken(), httpx.ClientIP(r)))
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	s.appEvent(r.Context(), a.ID, "created", "", nil)
	s.writeRepView(w, r, http.StatusCreated, a, l)
}

func (s *Server) regGet(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	a, l, err := s.appByToken(r.Context(), chi.URLParam(r, "token"))
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	s.writeRepView(w, r, 200, a, l)
}

// ---------- saving ----------

type appInput struct {
	Team     *teamInfo       `json:"team"`
	Rep      *repInfo        `json:"rep"`
	Players  []roster.Player `json:"players"`
	Staff    []roster.Staff  `json:"staff"`
	Consents *consentsInfo   `json:"consents"`
}

func clip(s string, n int) string {
	s = strings.TrimSpace(s)
	if r := []rune(s); len(r) > n {
		return string(r[:n])
	}
	return s
}

var reMedicalFile = regexp.MustCompile(`^[0-9a-f]{32}\.(pdf|jpg|png|webp)$`)

func ownImage(u string) string {
	u = strings.TrimSpace(u)
	if strings.HasPrefix(u, "/uploads/images/") && !strings.Contains(u, "..") && len(u) < 200 {
		return u
	}
	return ""
}

func (s *Server) sanitizeTeam(t teamInfo) teamInfo {
	out := teamInfo{Name: clip(t.Name, 80), City: clip(t.City, 80), About: clip(t.About, 500), Instagram: clip(t.Instagram, 100),
		CrestURL: ownImage(t.CrestURL), CrestW: t.CrestW, CrestH: t.CrestH, Colors: []string{}}
	out.ShortName = strings.ToUpper(clip(t.ShortName, 4))
	for _, c := range t.Colors {
		if reHexColor.MatchString(c) && len(out.Colors) < 2 {
			out.Colors = append(out.Colors, strings.ToUpper(c))
		}
	}
	if out.CrestURL == "" {
		out.CrestW, out.CrestH = 0, 0
	}
	return out
}

func sanitizeRep(r repInfo) repInfo {
	out := repInfo{Name: clip(r.Name, 120), Phone: clip(r.Phone, 32), Telegram: clip(r.Telegram, 64), Email: clip(r.Email, 120), Authorized: r.Authorized}
	switch r.Role {
	case "captain", "manager", "coach", "other":
		out.Role = r.Role
	default:
		out.Role = "captain"
	}
	return out
}

func (s *Server) sanitizePlayers(ps []roster.Player, appDir string) ([]roster.Player, error) {
	if len(ps) > 60 {
		return nil, httpx.BadRequest("Tarkibda 60 tadan ortiq odam bo‘lishi mumkin emas")
	}
	out := make([]roster.Player, 0, len(ps))
	for _, p := range ps {
		q := roster.Player{FirstName: clip(p.FirstName, 60), LastName: clip(p.LastName, 60), JerseyName: roster.JerseyName(clip(p.JerseyName, 20)),
			KitSize: roster.NormalizeSize(p.KitSize), Workplace: clip(p.Workplace, 120), PhotoURL: ownImage(p.PhotoURL), Role: p.Role}
		if d, ok := roster.ParseDate(p.BirthDate); ok {
			q.BirthDate = d
		}
		if p.Number != nil && *p.Number >= 0 && *p.Number <= 999 {
			n := *p.Number
			q.Number = &n
		}
		switch q.Role {
		case roster.RolePlayer, roster.RoleGoalkeeper, roster.RoleMedia:
		default:
			q.Role = roster.RolePlayer
		}
		if p.Medical != nil && reMedicalFile.MatchString(p.Medical.File) {
			if _, err := os.Stat(filepath.Join(appDir, p.Medical.File)); err == nil {
				q.Medical = &roster.File{File: p.Medical.File, Name: clip(p.Medical.Name, 120)}
			}
		}
		out = append(out, q)
	}
	return out, nil
}

func sanitizeStaff(ss []roster.Staff) ([]roster.Staff, error) {
	if len(ss) > 10 {
		return nil, httpx.BadRequest("Shtabda 10 tadan ortiq odam bo‘lishi mumkin emas")
	}
	out := make([]roster.Staff, 0, len(ss))
	for _, st := range ss {
		q := roster.Staff{FirstName: clip(st.FirstName, 60), LastName: clip(st.LastName, 60), KitSize: roster.NormalizeSize(st.KitSize), Phone: clip(st.Phone, 32), Role: st.Role}
		if d, ok := roster.ParseDate(st.BirthDate); ok {
			q.BirthDate = d
		}
		if !contains(roster.StaffRoles, q.Role) {
			q.Role = "head_coach"
		}
		out = append(out, q)
	}
	return out, nil
}

func (s *Server) appDir(id int64) string {
	return filepath.Join(s.Cfg.UploadDir, "applications", strconv.FormatInt(id, 10))
}

func (s *Server) regSave(w http.ResponseWriter, r *http.Request) {
	a, l, err := s.appByToken(r.Context(), chi.URLParam(r, "token"))
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	var in appInput
	if err := httpx.Decode(r, &in); err != nil {
		httpx.Fail(w, r, err)
		return
	}
	ed := editable(a, l, time.Now())
	if !anyEditable(ed) {
		if a.Status == "draft" && l != nil {
			httpx.Fail(w, r, closedErr(l.state(time.Now())))
			return
		}
		httpx.Fail(w, r, httpx.NewError(http.StatusConflict, "locked", "Arizani hozir o‘zgartirib bo‘lmaydi"))
		return
	}
	if in.Team != nil && ed["team"] {
		a.Team = s.sanitizeTeam(*in.Team)
	}
	if in.Rep != nil && ed["rep"] {
		rep := sanitizeRep(*in.Rep)
		phone, _ := auth.NormalizePhone(rep.Phone)
		if phone != a.RepPhone {
			a.PhoneVerifiedAt = nil // a new number has to be confirmed again
			a.RepPhone = phone
		}
		a.Rep = rep
	}
	if ed["roster"] {
		if in.Players != nil {
			if a.Players, err = s.sanitizePlayers(in.Players, s.appDir(a.ID)); err != nil {
				httpx.Fail(w, r, err)
				return
			}
		}
		if in.Staff != nil {
			if a.Staff, err = sanitizeStaff(in.Staff); err != nil {
				httpx.Fail(w, r, err)
				return
			}
		}
	}
	if in.Consents != nil {
		a.Consents = *in.Consents
	}
	if err := s.saveApp(r.Context(), a); err != nil {
		httpx.Fail(w, r, err)
		return
	}
	s.writeRepView(w, r, 200, a, l)
}

func (s *Server) saveApp(ctx context.Context, a *application) error {
	team, _ := json.Marshal(a.Team)
	rep, _ := json.Marshal(a.Rep)
	players, _ := json.Marshal(a.Players)
	staff, _ := json.Marshal(a.Staff)
	consents, _ := json.Marshal(a.Consents)
	return s.DB.QueryRowContext(ctx, `UPDATE team_applications SET team = $2, rep = $3, players = $4, staff = $5, consents = $6,
		rep_phone = $7, phone_verified_at = $8, updated_at = now() WHERE id = $1 RETURNING updated_at`,
		a.ID, team, rep, players, staff, consents, a.RepPhone, a.PhoneVerifiedAt).Scan(&a.UpdatedAt)
}

// ---------- phone verification ----------

const (
	otpTTL       = 10 * time.Minute
	otpResend    = 60 * time.Second
	otpMaxSends  = 5 // per hour
	otpMaxChecks = 5
)

func otpHash(token, code string) string {
	h := sha256.Sum256([]byte(token + ":" + code))
	return hex.EncodeToString(h[:])
}

func maskPhone(p string) string {
	if len(p) < 7 {
		return p
	}
	return "+" + p[:5] + " *** " + p[len(p)-4:len(p)-2] + " " + p[len(p)-2:]
}

// devSMS logs codes instead of sending them (development without Eskiz).
type devSMS struct{}

func (devSMS) Enabled() bool { return true }
func (devSMS) Send(_ context.Context, phone, text string) error {
	slog.Info("dev sms", "phone", phone, "text", text)
	return nil
}

func (s *Server) regOTPSend(w http.ResponseWriter, r *http.Request) {
	a, l, err := s.appByToken(r.Context(), chi.URLParam(r, "token"))
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	if !editable(a, l, time.Now())["rep"] {
		httpx.Fail(w, r, httpx.NewError(http.StatusConflict, "locked", "Arizani hozir o‘zgartirib bo‘lmaydi"))
		return
	}
	if !s.sms.Enabled() {
		httpx.Fail(w, r, httpx.NewError(http.StatusConflict, "sms_disabled", "SMS tasdiqlash o‘chirilgan"))
		return
	}
	var in struct {
		Phone string `json:"phone"`
	}
	if err := httpx.Decode(r, &in); err != nil {
		httpx.Fail(w, r, err)
		return
	}
	if in.Phone == "" {
		in.Phone = a.Rep.Phone
	}
	phone, ok := auth.NormalizePhone(in.Phone)
	if !ok || phone == "" {
		httpx.Fail(w, r, httpx.Validation(map[string]any{"phone": "Telefon raqami noto‘g‘ri"}))
		return
	}
	var sentAt time.Time
	var sends int
	err = s.DB.QueryRowContext(r.Context(), `SELECT sent_at, sends FROM registration_otps WHERE application_id = $1`, a.ID).Scan(&sentAt, &sends)
	if err == nil {
		if wait := otpResend - time.Since(sentAt); wait > 0 {
			httpx.JSON(w, http.StatusTooManyRequests, map[string]any{"error": httpx.NewError(429, "otp_wait", "Kodni qayta yuborish uchun biroz kuting"), "retry_after": int(wait.Seconds()) + 1})
			return
		}
		if time.Since(sentAt) > time.Hour {
			sends = 0
		}
		if sends >= otpMaxSends {
			httpx.Fail(w, r, httpx.NewError(http.StatusTooManyRequests, "otp_limit", "Kod juda ko‘p marta so‘raldi — 1 soatdan keyin urinib ko‘ring"))
			return
		}
	} else if !errors.Is(err, sql.ErrNoRows) {
		httpx.Fail(w, r, err)
		return
	}
	n, _ := rand.Int(rand.Reader, big.NewInt(1000000))
	code := fmt.Sprintf("%06d", n.Int64())
	if err := s.sms.Send(r.Context(), phone, fmt.Sprintf(s.Cfg.SMSCodeText, code)); err != nil {
		slog.Error("sms send", "err", err)
		httpx.Fail(w, r, httpx.NewError(http.StatusBadGateway, "sms_failed", "SMS yuborilmadi — birozdan so‘ng urinib ko‘ring"))
		return
	}
	if _, err := s.DB.ExecContext(r.Context(), `INSERT INTO registration_otps (application_id, phone, code_hash, expires_at, attempts, sends, sent_at)
		VALUES ($1, $2, $3, $4, 0, $5, now())
		ON CONFLICT (application_id) DO UPDATE SET phone = $2, code_hash = $3, expires_at = $4, attempts = 0, sends = $5, sent_at = now()`,
		a.ID, phone, otpHash(a.Token, code), time.Now().Add(otpTTL), sends+1); err != nil {
		httpx.Fail(w, r, err)
		return
	}
	// the number the code went to becomes the representative's number
	if phone != a.RepPhone || a.Rep.Phone != in.Phone {
		a.Rep.Phone, a.RepPhone, a.PhoneVerifiedAt = in.Phone, phone, nil
		if err := s.saveApp(r.Context(), a); err != nil {
			httpx.Fail(w, r, err)
			return
		}
	}
	out := map[string]any{"sent_to": maskPhone(phone), "retry_after": int(otpResend.Seconds()), "expires_in": int(otpTTL.Seconds())}
	if _, dev := s.sms.(devSMS); dev {
		out["dev_code"] = code // development only: there is no real SMS
	}
	httpx.JSON(w, 200, out)
}

func (s *Server) regOTPVerify(w http.ResponseWriter, r *http.Request) {
	a, l, err := s.appByToken(r.Context(), chi.URLParam(r, "token"))
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	var in struct {
		Code string `json:"code"`
	}
	if err := httpx.Decode(r, &in); err != nil {
		httpx.Fail(w, r, err)
		return
	}
	var phone, hash string
	var exp time.Time
	var attempts int
	err = s.DB.QueryRowContext(r.Context(), `SELECT phone, code_hash, expires_at, attempts FROM registration_otps WHERE application_id = $1`, a.ID).Scan(&phone, &hash, &exp, &attempts)
	if errors.Is(err, sql.ErrNoRows) || (err == nil && time.Now().After(exp)) {
		httpx.Fail(w, r, httpx.NewError(http.StatusConflict, "otp_expired", "Kod eskirgan — yangi kod so‘rang"))
		return
	}
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	if attempts >= otpMaxChecks {
		httpx.Fail(w, r, httpx.NewError(http.StatusTooManyRequests, "otp_attempts", "Urinishlar tugadi — yangi kod so‘rang"))
		return
	}
	code := strings.Map(func(r rune) rune {
		if r >= '0' && r <= '9' {
			return r
		}
		return -1
	}, in.Code)
	if subtle.ConstantTimeCompare([]byte(otpHash(a.Token, code)), []byte(hash)) != 1 {
		_, _ = s.DB.ExecContext(r.Context(), `UPDATE registration_otps SET attempts = attempts + 1 WHERE application_id = $1`, a.ID)
		httpx.Fail(w, r, httpx.Validation(map[string]any{"code": fmt.Sprintf("Kod noto‘g‘ri — yana %d urinish", otpMaxChecks-attempts-1)}))
		return
	}
	_, _ = s.DB.ExecContext(r.Context(), `DELETE FROM registration_otps WHERE application_id = $1`, a.ID)
	now := time.Now()
	a.PhoneVerifiedAt, a.RepPhone = &now, phone
	if err := s.saveApp(r.Context(), a); err != nil {
		httpx.Fail(w, r, err)
		return
	}
	s.appEvent(r.Context(), a.ID, "phone_verified", maskPhone(phone), nil)
	s.writeRepView(w, r, 200, a, l)
}

// ---------- files ----------

var medicalTypes = map[string]string{"application/pdf": ".pdf", "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp"}

func sniff(head []byte) string {
	mime := http.DetectContentType(head)
	if len(head) >= 12 && string(head[:4]) == "RIFF" && string(head[8:12]) == "WEBP" {
		mime = "image/webp"
	}
	return mime
}

func imageSize(path, mime string) (int, int) {
	if mime == "image/webp" {
		return webpSize(path)
	}
	f, err := os.Open(path)
	if err != nil {
		return 0, 0
	}
	defer f.Close()
	cfg, _, err := image.DecodeConfig(f)
	if err != nil {
		return 0, 0
	}
	return cfg.Width, cfg.Height
}

func (s *Server) regUpload(w http.ResponseWriter, r *http.Request) {
	a, l, err := s.appByToken(r.Context(), chi.URLParam(r, "token"))
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	if !anyEditable(editable(a, l, time.Now())) {
		httpx.Fail(w, r, httpx.NewError(http.StatusConflict, "locked", "Arizani hozir o‘zgartirib bo‘lmaydi"))
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, 11<<20)
	kind := r.FormValue("kind")
	file, hdr, err := r.FormFile("file")
	if err != nil {
		httpx.Fail(w, r, httpx.BadRequest("Fayl topilmadi yoki 10 MB dan katta"))
		return
	}
	defer file.Close()
	head := make([]byte, 512)
	n, _ := io.ReadFull(file, head)
	mime := sniff(head[:n])
	var dir, ext string
	switch kind {
	case "logo", "photo":
		img := photoKind(head[:n])
		if img != "jpg" && img != "png" && img != "webp" && img != "heic" {
			httpx.Fail(w, r, httpx.BadRequest("Faqat JPG, PNG yoki WebP rasm"))
			return
		}
		s.regUploadImage(w, r, io.MultiReader(bytes.NewReader(head[:n]), file), img)
		return
	case "medical":
		var ok bool
		if ext, ok = medicalTypes[mime]; !ok {
			httpx.Fail(w, r, httpx.BadRequest("Faqat PDF, JPG yoki PNG"))
			return
		}
		dir = s.appDir(a.ID)
		if err := os.MkdirAll(dir, 0o750); err != nil {
			httpx.Fail(w, r, err)
			return
		}
	default:
		httpx.Fail(w, r, httpx.BadRequest("kind: logo, photo yoki medical"))
		return
	}
	name := randomName(ext)
	full := filepath.Join(dir, name)
	dst, err := os.Create(full)
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	_, werr := dst.Write(head[:n])
	if werr == nil {
		_, werr = io.Copy(dst, file)
	}
	dst.Close()
	if werr != nil {
		os.Remove(full)
		httpx.Fail(w, r, httpx.BadRequest("Fayl 10 MB dan katta"))
		return
	}
	httpx.JSON(w, http.StatusCreated, roster.File{File: name, Name: clip(sanitizeFilename(hdr.Filename), 120)})
}

// regUploadImage stores a team logo or player photo from the registration site as WebP.
func (s *Server) regUploadImage(w http.ResponseWriter, r *http.Request, body io.Reader, kind string) {
	tmp, err := os.CreateTemp(s.imagesDir(), tmpUpPrefix+"*")
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	_, err = io.Copy(tmp, body)
	tmp.Close()
	if err != nil {
		os.Remove(tmp.Name())
		httpx.Fail(w, r, httpx.BadRequest("Fayl 10 MB dan katta"))
		return
	}
	name, err := s.storeImage(r.Context(), tmp.Name(), kind, "")
	if err != nil {
		slog.Warn("registration image convert", "err", err)
		httpx.Fail(w, r, httpx.BadRequest("Rasmni o‘qib bo‘lmadi — fayl buzilgan yoki format qo‘llab-quvvatlanmaydi"))
		return
	}
	full := filepath.Join(s.imagesDir(), name)
	wd, ht := imageSize(full, "image/"+strings.TrimPrefix(filepath.Ext(name), "."))
	httpx.JSON(w, http.StatusCreated, map[string]any{"url": s.Cfg.PublicBaseURL + "/uploads/images/" + name, "width": wd, "height": ht})
}

// regFile lets the representative open a medical file they uploaded.
func (s *Server) regFile(w http.ResponseWriter, r *http.Request) {
	a, _, err := s.appByToken(r.Context(), chi.URLParam(r, "token"))
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	s.serveAppFile(w, r, a.ID, chi.URLParam(r, "file"))
}

func (s *Server) serveAppFile(w http.ResponseWriter, r *http.Request, appID int64, name string) {
	if !reMedicalFile.MatchString(name) {
		httpx.Fail(w, r, httpx.ErrNotFound)
		return
	}
	full := filepath.Join(s.appDir(appID), name)
	if _, err := os.Stat(full); err != nil {
		httpx.Fail(w, r, httpx.ErrNotFound)
		return
	}
	w.Header().Set("Cache-Control", "private, no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Content-Disposition", `inline; filename="`+name+`"`)
	http.ServeFile(w, r, full)
}

// regImport reads a TARKIB.xlsx roster. Nothing is saved: the site merges the
// result into the form. A picture in the workbook is offered as the logo.
func (s *Server) regImport(w http.ResponseWriter, r *http.Request) {
	a, l, err := s.appByToken(r.Context(), chi.URLParam(r, "token"))
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	if !editable(a, l, time.Now())["roster"] {
		httpx.Fail(w, r, httpx.NewError(http.StatusConflict, "locked", "Tarkibni hozir o‘zgartirib bo‘lmaydi"))
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, 6<<20)
	file, _, err := r.FormFile("file")
	if err != nil {
		httpx.Fail(w, r, httpx.BadRequest("Fayl topilmadi yoki 5 MB dan katta"))
		return
	}
	defer file.Close()
	data, err := io.ReadAll(io.LimitReader(file, 6<<20))
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	wb, err := xlsx.Read(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		httpx.Fail(w, r, httpx.BadRequest("Faylni o‘qib bo‘lmadi: .xlsx formatidagi TARKIB faylini yuklang"))
		return
	}
	imp := roster.ParseTarkib(wb.Rows)
	if len(imp.Players)+len(imp.Staff) == 0 {
		httpx.Fail(w, r, httpx.BadRequest("Faylda o‘yinchilar topilmadi: ustunlar «ISM» va «FAMILIYA» bo‘lishi kerak"))
		return
	}
	out := map[string]any{"import": imp}
	for _, img := range wb.Images {
		switch photoKind(img.Data[:min(len(img.Data), 512)]) {
		case "jpg", "png", "webp":
		default:
			continue
		}
		name, err := s.storeImageBytes(r.Context(), img.Data, "")
		if err != nil || name == "" {
			continue
		}
		full := filepath.Join(s.imagesDir(), name)
		wd, ht := imageSize(full, "image/"+strings.TrimPrefix(filepath.Ext(name), "."))
		out["logo"] = map[string]any{"url": s.Cfg.PublicBaseURL + "/uploads/images/" + name, "width": wd, "height": ht}
		break
	}
	httpx.JSON(w, 200, out)
}

func (s *Server) regTemplate(w http.ResponseWriter, r *http.Request) {
	b, err := xlsx.Write(roster.ExportTarkib("", nil, nil))
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	writeXLSX(w, "TARKIB.xlsx", b)
}

func writeXLSX(w http.ResponseWriter, name string, b []byte) {
	w.Header().Set("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
	w.Header().Set("Content-Disposition", `attachment; filename="`+name+`"`)
	w.Header().Set("Cache-Control", "no-store")
	_, _ = w.Write(b)
}

// ---------- submit ----------

func (s *Server) regSubmit(w http.ResponseWriter, r *http.Request) {
	a, l, err := s.appByToken(r.Context(), chi.URLParam(r, "token"))
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	if !anyEditable(editable(a, l, time.Now())) {
		if a.Status == "draft" && l != nil {
			httpx.Fail(w, r, closedErr(l.state(time.Now())))
			return
		}
		httpx.Fail(w, r, httpx.NewError(http.StatusConflict, "locked", "Ariza allaqachon yuborilgan"))
		return
	}
	env, err := s.checkEnvFor(r.Context(), a, l, nil)
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	checks := checkApplication(a, l, env)
	if hasErrors(checks) {
		httpx.JSON(w, http.StatusUnprocessableEntity, map[string]any{"error": httpx.NewError(422, "invalid", "Arizada xatolar bor — ularni tuzating"), "checks": checks})
		return
	}
	if a.RepPhone != "" && a.LinkID != nil {
		var other sql.NullString
		_ = s.DB.QueryRowContext(r.Context(), `SELECT 'UMF-' || lpad(id::text, 4, '0') FROM team_applications WHERE link_id = $1 AND rep_phone = $2 AND id <> $3
			AND status IN ('submitted', 'review', 'changes', 'approved') LIMIT 1`, *a.LinkID, a.RepPhone, a.ID).Scan(&other)
		if other.Valid {
			httpx.Fail(w, r, httpx.NewError(http.StatusConflict, "duplicate_phone", "Shu telefon raqamidan ariza allaqachon yuborilgan ("+other.String+")"))
			return
		}
	}
	kind, note := "submitted", ""
	if a.Status == "changes" {
		kind = "resubmitted"
		var parts []string
		for _, c := range a.Comments {
			parts = append(parts, c.Text)
		}
		note = strings.Join(parts, "\n")
	}
	if err := s.DB.QueryRowContext(r.Context(), `UPDATE team_applications SET status = 'submitted', submitted_at = now(), comments = '[]',
		changes_deadline = NULL, updated_at = now() WHERE id = $1 RETURNING status, submitted_at, updated_at`, a.ID).Scan(&a.Status, &a.SubmittedAt, &a.UpdatedAt); err != nil {
		httpx.Fail(w, r, err)
		return
	}
	a.Comments, a.ChangesDeadline = []appComment{}, nil
	s.appEvent(r.Context(), a.ID, kind, note, nil)
	s.writeRepView(w, r, 200, a, l)
}

// newSMSSender: Eskiz when configured; in development a logger so the flow can be tried.
func newSMSSender(env, base, email, password, from string) sms.Sender {
	snd := sms.NewEskiz(base, email, password, from)
	if !snd.Enabled() && env != "production" {
		return devSMS{}
	}
	return snd
}
