package api

import (
	"bytes"
	"database/sql"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/sanedidi/unitedmfl/backend/internal/auth"
	"github.com/sanedidi/unitedmfl/backend/internal/httpx"
	"github.com/sanedidi/unitedmfl/backend/internal/tickets"
)

// Stadium constructor (admin → Stadionlar): venues, layout versions and the
// library of reusable stands and sections.

func (s *Server) mountStadiums(r chi.Router) {
	r.Group(func(r chi.Router) {
		r.Use(s.can(auth.PermStadiums))
		r.Post("/venues", s.createVenue)
		r.Patch("/venues/{id}", s.patchVenue)
		r.Put("/venues/{id}/draft", s.saveDraft)
		r.Get("/layout-library", s.layoutLibrary)
		r.Post("/layout-templates", s.createTemplate)
		r.Patch("/layout-templates/{id}", s.patchTemplate)
		r.Delete("/layout-templates/{id}", s.deleteTemplate)
	})
	r.Group(func(r chi.Router) { // drafts: discarding, restoring and publishing are editing
		r.Use(s.can(edit(auth.PermStadiums)))
		r.Delete("/venues/{id}/draft", s.discardDraft)
		r.Post("/venues/{id}/draft/restore/{layoutID}", s.restoreDraft)
		r.Post("/venues/{id}/publish", s.publishDraft)
	})
	r.Group(func(r chi.Router) { // read: also for ticket managers choosing a schema
		r.Use(s.canAny(auth.PermStadiums, auth.PermTickets))
		r.Get("/venues", s.listVenues)
		r.Get("/venues/{id}", s.getVenue)
		r.Get("/layouts/{id}", s.getLayout)
		r.Get("/layouts/{id}/diff", s.diffLayout)
	})
}

func urlID(r *http.Request, name string) (int64, error) {
	id, err := strconv.ParseInt(chi.URLParam(r, name), 10, 64)
	if err != nil || id <= 0 {
		return 0, httpx.ErrNotFound
	}
	return id, nil
}

func userIDPtr(r *http.Request) *int64 {
	if c := claimsFrom(r.Context()); c != nil {
		return &c.UserID
	}
	return nil
}

type layoutVersion struct {
	ID          int64      `json:"id"`
	Version     int        `json:"version"`
	Status      string     `json:"status"`
	Seats       int        `json:"seats"`
	Note        string     `json:"note"`
	CreatedAt   time.Time  `json:"created_at"`
	UpdatedAt   time.Time  `json:"updated_at"`
	PublishedAt *time.Time `json:"published_at"`
	CreatedBy   string     `json:"created_by"`
	Matches     int        `json:"matches"` // sales sold on this version
}

type venueView struct {
	ID        int64           `json:"id"`
	Name      string          `json:"name"`
	City      string          `json:"city"`
	Archived  bool            `json:"archived"`
	UpdatedAt time.Time       `json:"updated_at"`
	Published *layoutVersion  `json:"published"` // latest published
	Draft     *layoutVersion  `json:"draft"`
	Stats     *tickets.Stats  `json:"stats"`   // of the draft, else of the published version
	Preview   json.RawMessage `json:"preview"` // the doc for the card thumbnail
	Versions  []layoutVersion `json:"versions,omitempty"`
}

const layoutCols = `l.id, l.version, l.status, l.seats, l.note, l.created_at, l.updated_at, l.published_at,
	COALESCE(u.name,''), (SELECT count(*) FROM ticket_sales ts WHERE ts.layout_id = l.id)`

func scanVersion(sc interface{ Scan(...any) error }, v *layoutVersion) error {
	var pub sql.NullTime
	if err := sc.Scan(&v.ID, &v.Version, &v.Status, &v.Seats, &v.Note, &v.CreatedAt, &v.UpdatedAt, &pub, &v.CreatedBy, &v.Matches); err != nil {
		return err
	}
	v.PublishedAt = nullTime(pub)
	return nil
}

func (s *Server) venueVersions(r *http.Request, venueID int64) ([]layoutVersion, error) {
	rows, err := s.DB.QueryContext(r.Context(), `SELECT `+layoutCols+` FROM venue_layouts l
		LEFT JOIN users u ON u.id = l.created_by WHERE l.venue_id=$1 ORDER BY l.version DESC`, venueID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []layoutVersion{}
	for rows.Next() {
		var v layoutVersion
		if err := scanVersion(rows, &v); err != nil {
			return nil, err
		}
		out = append(out, v)
	}
	return out, rows.Err()
}

func (s *Server) fillVenue(r *http.Request, v *venueView, withVersions bool) error {
	vers, err := s.venueVersions(r, v.ID)
	if err != nil {
		return err
	}
	for i := range vers {
		x := vers[i]
		if x.Status == "draft" && v.Draft == nil {
			v.Draft = &x
		}
		if x.Status == "published" && v.Published == nil {
			v.Published = &x
		}
	}
	var pick *layoutVersion
	if v.Draft != nil {
		pick = v.Draft
	} else if v.Published != nil {
		pick = v.Published
	}
	if pick != nil {
		var doc []byte
		if err := s.DB.QueryRowContext(r.Context(), `SELECT doc FROM venue_layouts WHERE id=$1`, pick.ID).Scan(&doc); err != nil {
			return err
		}
		if l, err := tickets.Parse(doc); err == nil {
			st := l.Stats()
			v.Stats = &st
		}
		v.Preview = doc
	}
	if withVersions {
		v.Versions = vers
	}
	return nil
}

func (s *Server) listVenues(w http.ResponseWriter, r *http.Request) {
	rows, err := s.DB.QueryContext(r.Context(), `SELECT id, name, city, archived, updated_at FROM venues ORDER BY archived, name`)
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	var list []venueView
	for rows.Next() {
		var v venueView
		if err := rows.Scan(&v.ID, &v.Name, &v.City, &v.Archived, &v.UpdatedAt); err != nil {
			rows.Close()
			httpx.Fail(w, r, err)
			return
		}
		list = append(list, v)
	}
	rows.Close()
	for i := range list {
		if err := s.fillVenue(r, &list[i], false); err != nil {
			httpx.Fail(w, r, err)
			return
		}
	}
	if list == nil {
		list = []venueView{}
	}
	httpx.JSON(w, 200, map[string]any{"items": list})
}

func (s *Server) loadVenue(r *http.Request, id int64) (*venueView, error) {
	var v venueView
	err := s.DB.QueryRowContext(r.Context(), `SELECT id, name, city, archived, updated_at FROM venues WHERE id=$1`, id).
		Scan(&v.ID, &v.Name, &v.City, &v.Archived, &v.UpdatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, httpx.ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return &v, s.fillVenue(r, &v, true)
}

func (s *Server) getVenue(w http.ResponseWriter, r *http.Request) {
	id, err := urlID(r, "id")
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	v, err := s.loadVenue(r, id)
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	httpx.JSON(w, 200, v)
}

// emptyLayout is the start of a blank venue: just the pitch and two zones.
var emptyLayout = []byte(`{"pitch":{"x":0,"y":0,"w":300,"h":190},"zones":[{"key":"oddiy","name":"Oddiy zona","kind":"oddiy","color":"#9AA1AB"},{"key":"vip","name":"VIP zona","kind":"vip","color":"#7AC70C"}],"stands":[],"gates":[]}`)

type createVenueIn struct {
	Name     string  `json:"name"`
	City     string  `json:"city"`
	From     string  `json:"from"` // empty | layout | templates
	LayoutID int64   `json:"layout_id"`
	Template []int64 `json:"template_ids"`
	Copy     struct {
		Zones   bool `json:"zones"`
		Blocked bool `json:"blocked"`
		Gates   bool `json:"gates"`
		Links   bool `json:"links"`
	} `json:"copy"`
}

func (s *Server) createVenue(w http.ResponseWriter, r *http.Request) {
	var in createVenueIn
	if err := httpx.Decode(r, &in); err != nil {
		httpx.Fail(w, r, err)
		return
	}
	in.Name = strings.TrimSpace(in.Name)
	if in.Name == "" || len(in.Name) > 120 {
		httpx.Fail(w, r, httpx.Validation(map[string]any{"name": "Nomini kiriting"}))
		return
	}
	doc := emptyLayout
	var parent *int64
	switch in.From {
	case "layout":
		var src []byte
		if err := s.DB.QueryRowContext(r.Context(), `SELECT doc FROM venue_layouts WHERE id=$1`, in.LayoutID).Scan(&src); err != nil {
			httpx.Fail(w, r, httpx.BadRequest("Manba sxema topilmadi"))
			return
		}
		l, err := tickets.Parse(src)
		if err != nil {
			httpx.Fail(w, r, httpx.BadRequest(err.Error()))
			return
		}
		copyOptions(l, in.Copy.Zones, in.Copy.Blocked, in.Copy.Gates, in.Copy.Links)
		doc, _ = json.Marshal(l)
		parent = &in.LayoutID
	case "templates":
		l, _ := tickets.Parse(emptyLayout)
		for _, tid := range in.Template {
			var kind string
			var tdoc, tz []byte
			if err := s.DB.QueryRowContext(r.Context(), `SELECT kind, doc, zones FROM layout_templates WHERE id=$1`, tid).Scan(&kind, &tdoc, &tz); err != nil {
				continue
			}
			mergeTemplate(l, kind, tdoc, tz, tid, in.Copy.Links)
		}
		if err := l.Normalize(); err != nil {
			httpx.Fail(w, r, httpx.BadRequest(err.Error()))
			return
		}
		doc, _ = json.Marshal(l)
	}
	l, err := tickets.Parse(doc)
	if err != nil {
		httpx.Fail(w, r, httpx.BadRequest(err.Error()))
		return
	}
	tx, err := s.DB.BeginTx(r.Context(), nil)
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	defer tx.Rollback()
	var id int64
	if err := tx.QueryRowContext(r.Context(), `INSERT INTO venues(name, city) VALUES ($1,$2) RETURNING id`, in.Name, strings.TrimSpace(in.City)).Scan(&id); err != nil {
		httpx.Fail(w, r, err)
		return
	}
	if _, err := tx.ExecContext(r.Context(), `INSERT INTO venue_layouts(venue_id, version, status, doc, seats, parent_id, created_by)
		VALUES ($1,1,'draft',$2,$3,$4,$5)`, id, doc, l.Stats().Seats, parent, userIDPtr(r)); err != nil {
		httpx.Fail(w, r, err)
		return
	}
	if err := tx.Commit(); err != nil {
		httpx.Fail(w, r, err)
		return
	}
	s.audit(r, "create", "venue", id, map[string]any{"name": in.Name, "from": in.From})
	v, err := s.loadVenue(r, id)
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	httpx.JSON(w, 201, v)
}

// copyOptions strips what the admin chose not to copy into a new venue.
func copyOptions(l *tickets.Layout, zones, blocked, gates, links bool) {
	if !gates {
		l.Gates = []tickets.Gate{}
	}
	for i := range l.Stands {
		st := &l.Stands[i]
		if !links {
			st.TemplateID, st.TemplateV = nil, 0
		}
		for j := range st.Sections {
			sec := &st.Sections[j]
			if !zones {
				sec.Zone = ""
				for k := range sec.Rows {
					sec.Rows[k].ZoneSeats = nil
				}
			}
			if !gates {
				sec.Gate = ""
			}
			if !blocked {
				for k := range sec.Rows {
					sec.Rows[k].Blocked = []int{}
				}
			}
		}
	}
	if !zones {
		l.Zones = []tickets.Zone{}
	}
}

// mergeTemplate appends a library stand/section to a layout (new venue from templates).
func mergeTemplate(l *tickets.Layout, kind string, doc, zones []byte, id int64, link bool) {
	var zs []tickets.Zone
	_ = json.Unmarshal(zones, &zs)
	for _, z := range zs {
		found := false
		for _, have := range l.Zones {
			if have.Key == z.Key {
				found = true
			}
		}
		if !found {
			l.Zones = append(l.Zones, z)
		}
	}
	var st tickets.Stand
	if kind == "section" {
		var sec tickets.Section
		if json.Unmarshal(doc, &sec) != nil {
			return
		}
		st = tickets.Stand{Name: sec.Name, Sections: []tickets.Section{sec}}
	} else if json.Unmarshal(doc, &st) != nil {
		return
	}
	// keep section keys unique
	used := map[string]bool{}
	for _, s := range l.Stands {
		for _, sec := range s.Sections {
			used[strings.ToLower(sec.Key)] = true
		}
	}
	for i := range st.Sections {
		k := st.Sections[i].Key
		for n := 2; used[strings.ToLower(k)]; n++ {
			k = st.Sections[i].Key + "-" + strconv.Itoa(n)
		}
		st.Sections[i].Key = k
		used[strings.ToLower(k)] = true
	}
	st.Key = "s" + strconv.Itoa(len(l.Stands)+1)
	if link && kind == "stand" {
		st.TemplateID = &id
	}
	l.Stands = append(l.Stands, st)
}

func (s *Server) patchVenue(w http.ResponseWriter, r *http.Request) {
	id, err := urlID(r, "id")
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	var in struct {
		Name     *string `json:"name"`
		City     *string `json:"city"`
		Archived *bool   `json:"archived"`
	}
	if err := httpx.Decode(r, &in); err != nil {
		httpx.Fail(w, r, err)
		return
	}
	if in.Name != nil && strings.TrimSpace(*in.Name) == "" {
		httpx.Fail(w, r, httpx.Validation(map[string]any{"name": "Nomini kiriting"}))
		return
	}
	res, err := s.DB.ExecContext(r.Context(), `UPDATE venues SET name=COALESCE($2,name), city=COALESCE($3,city),
		archived=COALESCE($4,archived), updated_at=now() WHERE id=$1`, id, in.Name, in.City, in.Archived)
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	if n, _ := res.RowsAffected(); n == 0 {
		httpx.Fail(w, r, httpx.ErrNotFound)
		return
	}
	s.getVenue(w, r)
}

type layoutView struct {
	ID           int64           `json:"id"`
	VenueID      int64           `json:"venue_id"`
	VenueName    string          `json:"venue_name"`
	Version      int             `json:"version"`
	Status       string          `json:"status"`
	Note         string          `json:"note"`
	Doc          json.RawMessage `json:"doc"`
	Stats        tickets.Stats   `json:"stats"`
	UpdatedAt    time.Time       `json:"updated_at"`
	Warnings     []string        `json:"warnings"`
	SoldSeats    []string        `json:"sold_seats"` // numbered seats with tickets (can't be removed)
	SoldSections []string        `json:"sold_sections"`
}

func (s *Server) layoutByID(r *http.Request, id int64) (*layoutView, error) {
	var v layoutView
	var doc []byte
	err := s.DB.QueryRowContext(r.Context(), `SELECT l.id, l.venue_id, v.name, l.version, l.status, l.note, l.doc, l.updated_at
		FROM venue_layouts l JOIN venues v ON v.id = l.venue_id WHERE l.id=$1`, id).
		Scan(&v.ID, &v.VenueID, &v.VenueName, &v.Version, &v.Status, &v.Note, &doc, &v.UpdatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, httpx.ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	v.Doc = doc
	if l, err := tickets.Parse(doc); err == nil {
		v.Stats = l.Stats()
		v.Warnings = layoutWarnings(l)
	}
	v.SoldSeats, v.SoldSections, _, err = s.soldOnVenue(r, v.VenueID)
	return &v, err
}

// soldOnVenue lists what live tickets occupy on any version of the venue:
// the constructor keeps these seats and sections.
func (s *Server) soldOnVenue(r *http.Request, venueID int64) ([]string, []string, map[string]string, error) {
	rows, err := s.DB.QueryContext(r.Context(), `SELECT DISTINCT COALESCE(t.seat_id,''), t.section_key, t.zone_key FROM tickets t
		JOIN ticket_sales ts ON ts.id = t.sale_id JOIN venue_layouts l ON l.id = ts.layout_id
		JOIN matches m ON m.id = ts.match_id
		WHERE l.venue_id=$1 AND t.status IN ('pending','active') AND (m.kickoff_at IS NULL OR m.kickoff_at > now() - interval '1 day')`, venueID)
	if err != nil {
		return nil, nil, nil, err
	}
	defer rows.Close()
	seats, secs := []string{}, []string{}
	zoneOf := map[string]string{}
	seenSec := map[string]bool{}
	for rows.Next() {
		var seat, sec, zone string
		if err := rows.Scan(&seat, &sec, &zone); err != nil {
			return nil, nil, nil, err
		}
		if seat != "" {
			seats = append(seats, seat)
			zoneOf[seat] = zone
		}
		// free-seating tickets list every section of their zone ("A1, A2, …")
		for _, k := range strings.Split(sec, ",") {
			if k = strings.TrimSpace(k); k != "" && !seenSec[k] {
				seenSec[k] = true
				secs = append(secs, k)
			}
		}
	}
	return seats, secs, zoneOf, rows.Err()
}

func layoutWarnings(l *tickets.Layout) []string {
	var out []string
	for _, st := range l.Stands {
		for _, sec := range st.Sections {
			if sec.Zone == "" {
				out = append(out, sec.Key+" sektori zonaga biriktirilmagan")
			}
			if sec.Gate == "" {
				out = append(out, sec.Key+" sektoriga kirish biriktirilmagan")
			}
			if len(sec.Rows) == 0 {
				out = append(out, sec.Key+" sektorida qator yo‘q")
			}
		}
	}
	if out == nil {
		out = []string{}
	}
	return out
}

func (s *Server) getLayout(w http.ResponseWriter, r *http.Request) {
	id, err := urlID(r, "id")
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	v, err := s.layoutByID(r, id)
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	httpx.JSON(w, 200, v)
}

func (s *Server) diffLayout(w http.ResponseWriter, r *http.Request) {
	id, err := urlID(r, "id")
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	with, _ := strconv.ParseInt(r.URL.Query().Get("with"), 10, 64)
	var a, b []byte
	if err := s.DB.QueryRowContext(r.Context(), `SELECT doc FROM venue_layouts WHERE id=$1`, id).Scan(&a); err != nil {
		httpx.Fail(w, r, httpx.ErrNotFound)
		return
	}
	if err := s.DB.QueryRowContext(r.Context(), `SELECT doc FROM venue_layouts WHERE id=$1`, with).Scan(&b); err != nil {
		httpx.Fail(w, r, httpx.ErrNotFound)
		return
	}
	la, err1 := tickets.Parse(a)
	lb, err2 := tickets.Parse(b)
	if err1 != nil || err2 != nil {
		httpx.Fail(w, r, httpx.BadRequest("sxema buzilgan"))
		return
	}
	// "with" is the newer one (the draft)
	d := tickets.Diff(la, lb)
	sa, sb := la.Stats(), lb.Stats()
	httpx.JSON(w, 200, map[string]any{"sections": d, "seats_delta": sb.Seats - sa.Seats})
}

// saveDraft stores the edited document (autosave). Creates the draft from
// the latest published version when there is none.
func (s *Server) saveDraft(w http.ResponseWriter, r *http.Request) {
	venueID, err := urlID(r, "id")
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	var in struct {
		Doc  json.RawMessage `json:"doc"`
		Note *string         `json:"note"`
		Base *time.Time      `json:"base"` // updated_at the editor started from (conflict guard)
	}
	r.Body = http.MaxBytesReader(w, r.Body, 8<<20)
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		httpx.Fail(w, r, httpx.BadRequest("JSON noto‘g‘ri"))
		return
	}
	l, err := tickets.Parse(in.Doc)
	if err != nil {
		httpx.Fail(w, r, httpx.NewError(422, "layout", err.Error()))
		return
	}
	// sold seats and sections must survive the edit
	sold, soldSecs, soldZone, err := s.soldOnVenue(r, venueID)
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	for _, sec := range soldSecs {
		if l.Section(sec) == nil {
			httpx.Fail(w, r, httpx.NewError(409, "sold", sec+" sektorida sotilgan chiptalar bor — uni o‘chirib bo‘lmaydi"))
			return
		}
	}
	for _, seat := range sold {
		if !l.IsSellable(seat) {
			httpx.Fail(w, r, httpx.NewError(409, "sold", seat+" o‘rni sotilgan — uni o‘chirib yoki bloklab bo‘lmaydi"))
			return
		}
		if z := soldZone[seat]; z != "" && l.SeatZone(seat) != z {
			httpx.Fail(w, r, httpx.NewError(409, "sold", seat+" o‘rni sotilgan — uning zonasini o‘zgartirib bo‘lmaydi"))
			return
		}
	}
	doc, _ := json.Marshal(l)
	tx, err := s.DB.BeginTx(r.Context(), nil)
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	defer tx.Rollback()
	var draftID int64
	var updated time.Time
	err = tx.QueryRowContext(r.Context(), `SELECT id, updated_at FROM venue_layouts WHERE venue_id=$1 AND status='draft' FOR UPDATE`, venueID).Scan(&draftID, &updated)
	if errors.Is(err, sql.ErrNoRows) {
		var next int
		var parent sql.NullInt64
		if err := tx.QueryRowContext(r.Context(), `SELECT COALESCE(max(version),0)+1,
			(SELECT id FROM venue_layouts WHERE venue_id=$1 AND status='published' ORDER BY version DESC LIMIT 1)
			FROM venue_layouts WHERE venue_id=$1`, venueID).Scan(&next, &parent); err != nil {
			httpx.Fail(w, r, err)
			return
		}
		err = tx.QueryRowContext(r.Context(), `INSERT INTO venue_layouts(venue_id, version, status, doc, seats, note, parent_id, created_by)
			VALUES ($1,$2,'draft',$3,$4,COALESCE($5,''),$6,$7) RETURNING id`, venueID, next, doc, l.Stats().Seats, in.Note, parent, userIDPtr(r)).Scan(&draftID)
	} else if err == nil {
		if in.Base != nil && updated.Sub(*in.Base) > time.Second {
			httpx.Fail(w, r, httpx.NewError(409, "conflict", "Sxemani boshqa oynada kimdir o‘zgartirdi — sahifani yangilang"))
			return
		}
		_, err = tx.ExecContext(r.Context(), `UPDATE venue_layouts SET doc=$2, seats=$3, note=COALESCE($4,note), updated_at=now() WHERE id=$1`,
			draftID, doc, l.Stats().Seats, in.Note)
	}
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	_, _ = tx.ExecContext(r.Context(), `UPDATE venues SET updated_at=now() WHERE id=$1`, venueID)
	if err := tx.Commit(); err != nil {
		httpx.Fail(w, r, err)
		return
	}
	v, err := s.layoutByID(r, draftID)
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	httpx.JSON(w, 200, v)
}

func (s *Server) discardDraft(w http.ResponseWriter, r *http.Request) {
	venueID, err := urlID(r, "id")
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	var pub int
	_ = s.DB.QueryRowContext(r.Context(), `SELECT count(*) FROM venue_layouts WHERE venue_id=$1 AND status='published'`, venueID).Scan(&pub)
	if pub == 0 {
		httpx.Fail(w, r, httpx.BadRequest("Stadionda nashr qilingan versiya yo‘q — qoralamani o‘chirib bo‘lmaydi"))
		return
	}
	if _, err := s.DB.ExecContext(r.Context(), `DELETE FROM venue_layouts WHERE venue_id=$1 AND status='draft'`, venueID); err != nil {
		httpx.Fail(w, r, err)
		return
	}
	s.audit(r, "discard_draft", "venue", venueID, nil)
	w.WriteHeader(204)
}

// restoreDraft replaces the draft with a copy of another version («Tiklash»).
func (s *Server) restoreDraft(w http.ResponseWriter, r *http.Request) {
	venueID, err := urlID(r, "id")
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	layoutID, err := urlID(r, "layoutID")
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	var doc []byte
	var version int
	if err := s.DB.QueryRowContext(r.Context(), `SELECT doc, version FROM venue_layouts WHERE id=$1 AND venue_id=$2`, layoutID, venueID).Scan(&doc, &version); err != nil {
		httpx.Fail(w, r, httpx.ErrNotFound)
		return
	}
	body, _ := json.Marshal(map[string]any{"doc": json.RawMessage(doc), "note": "v" + strconv.Itoa(version) + " dan tiklandi"})
	r.Body = ioNopCloser(body)
	s.audit(r, "restore", "venue", venueID, map[string]any{"from_layout": layoutID})
	s.saveDraft(w, r)
}

func (s *Server) publishDraft(w http.ResponseWriter, r *http.Request) {
	venueID, err := urlID(r, "id")
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	var in struct {
		Note string `json:"note"`
	}
	_ = json.NewDecoder(r.Body).Decode(&in)
	var id int64
	var doc []byte
	if err := s.DB.QueryRowContext(r.Context(), `SELECT id, doc FROM venue_layouts WHERE venue_id=$1 AND status='draft'`, venueID).Scan(&id, &doc); err != nil {
		httpx.Fail(w, r, httpx.BadRequest("Nashr qilinadigan qoralama yo‘q"))
		return
	}
	l, err := tickets.Parse(doc)
	if err != nil {
		httpx.Fail(w, r, httpx.NewError(422, "layout", err.Error()))
		return
	}
	if l.Stats().Sellable == 0 {
		httpx.Fail(w, r, httpx.BadRequest("Sxemada sotiladigan o‘rin yo‘q"))
		return
	}
	for _, st := range l.Stands {
		for _, sec := range st.Sections {
			if sec.Zone == "" {
				httpx.Fail(w, r, httpx.BadRequest(sec.Key+" sektori zonaga biriktirilmagan"))
				return
			}
		}
	}
	if _, err := s.DB.ExecContext(r.Context(), `UPDATE venue_layouts SET status='published', published_at=now(), updated_at=now(),
		note = CASE WHEN $2 <> '' THEN $2 ELSE note END WHERE id=$1`, id, strings.TrimSpace(in.Note)); err != nil {
		httpx.Fail(w, r, err)
		return
	}
	s.audit(r, "publish", "venue_layout", id, nil)
	v, err := s.loadVenue(r, venueID)
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	httpx.JSON(w, 200, v)
}

// ---------- library ----------

type templateView struct {
	ID          int64           `json:"id"`
	Name        string          `json:"name"`
	Description string          `json:"description"`
	Kind        string          `json:"kind"`
	Doc         json.RawMessage `json:"doc"`
	Zones       json.RawMessage `json:"zones"`
	Seats       int             `json:"seats"`
	Version     int             `json:"version"`
	Visibility  string          `json:"visibility"`
	Owner       string          `json:"owner"`
	Mine        bool            `json:"mine"`
	UpdatedAt   time.Time       `json:"updated_at"`
	LinkedIn    int             `json:"linked_in"` // drafts/versions holding a linked copy
}

type libraryStand struct {
	VenueID   int64           `json:"venue_id"`
	VenueName string          `json:"venue_name"`
	LayoutID  int64           `json:"layout_id"`
	Version   int             `json:"version"`
	Status    string          `json:"status"`
	Stand     json.RawMessage `json:"stand"`
	Zones     json.RawMessage `json:"zones"`
	Seats     int             `json:"seats"`
	Name      string          `json:"name"`
}

func (s *Server) layoutLibrary(w http.ResponseWriter, r *http.Request) {
	uid := int64(0)
	if c := claimsFrom(r.Context()); c != nil {
		uid = c.UserID
	}
	rows, err := s.DB.QueryContext(r.Context(), `SELECT t.id, t.name, t.description, t.kind, t.doc, t.zones, t.seats, t.version,
		t.visibility, COALESCE(u.name,''), COALESCE(t.owner_id,0)=$1, t.updated_at,
		(SELECT count(*) FROM venue_layouts l WHERE l.status='draft' AND l.doc::text LIKE '%"template_id": '||t.id||',%')
		FROM layout_templates t LEFT JOIN users u ON u.id = t.owner_id
		WHERE t.visibility='all' OR t.owner_id=$1 ORDER BY t.updated_at DESC`, uid)
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	tpl := []templateView{}
	for rows.Next() {
		var t templateView
		var doc, zones []byte
		if err := rows.Scan(&t.ID, &t.Name, &t.Description, &t.Kind, &doc, &zones, &t.Seats, &t.Version, &t.Visibility, &t.Owner, &t.Mine, &t.UpdatedAt, &t.LinkedIn); err != nil {
			rows.Close()
			httpx.Fail(w, r, err)
			return
		}
		t.Doc, t.Zones = doc, zones
		tpl = append(tpl, t)
	}
	rows.Close()
	// stands of other layouts: the latest version of every venue
	exclude, _ := strconv.ParseInt(r.URL.Query().Get("venue_id"), 10, 64)
	lrows, err := s.DB.QueryContext(r.Context(), `SELECT DISTINCT ON (l.venue_id) l.venue_id, v.name, l.id, l.version, l.status, l.doc
		FROM venue_layouts l JOIN venues v ON v.id = l.venue_id WHERE NOT v.archived
		ORDER BY l.venue_id, (l.status='published') DESC, l.version DESC`)
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	defer lrows.Close()
	stands := []libraryStand{}
	for lrows.Next() {
		var ls libraryStand
		var doc []byte
		if err := lrows.Scan(&ls.VenueID, &ls.VenueName, &ls.LayoutID, &ls.Version, &ls.Status, &doc); err != nil {
			httpx.Fail(w, r, err)
			return
		}
		if ls.VenueID == exclude {
			continue
		}
		l, err := tickets.Parse(doc)
		if err != nil {
			continue
		}
		zones, _ := json.Marshal(l.Zones)
		for _, st := range l.Stands {
			one := tickets.Layout{Stands: []tickets.Stand{st}}
			b, _ := json.Marshal(st)
			x := ls
			x.Stand, x.Zones, x.Name, x.Seats = b, zones, st.Name, one.Stats().Seats
			stands = append(stands, x)
		}
	}
	httpx.JSON(w, 200, map[string]any{"templates": tpl, "stands": stands})
}

type templateIn struct {
	Name        *string          `json:"name"`
	Description *string          `json:"description"`
	Kind        *string          `json:"kind"`
	Doc         *json.RawMessage `json:"doc"`
	Zones       *json.RawMessage `json:"zones"`
	Visibility  *string          `json:"visibility"`
}

// templateSeats validates a template document and counts its seats.
func templateSeats(kind string, doc []byte) (int, error) {
	var l tickets.Layout
	if kind == "section" {
		var sec tickets.Section
		if err := json.Unmarshal(doc, &sec); err != nil {
			return 0, err
		}
		l.Stands = []tickets.Stand{{Key: "t", Sections: []tickets.Section{sec}}}
	} else {
		var st tickets.Stand
		if err := json.Unmarshal(doc, &st); err != nil {
			return 0, err
		}
		l.Stands = []tickets.Stand{st}
	}
	for i := range l.Stands[0].Sections { // zones are validated when the template is placed
		l.Stands[0].Sections[i].Zone = ""
	}
	if err := l.Normalize(); err != nil {
		return 0, err
	}
	return l.Stats().Seats, nil
}

func (s *Server) createTemplate(w http.ResponseWriter, r *http.Request) {
	var in templateIn
	r.Body = http.MaxBytesReader(w, r.Body, 4<<20)
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil || in.Name == nil || in.Doc == nil {
		httpx.Fail(w, r, httpx.BadRequest("nom va sxema kerak"))
		return
	}
	kind, vis := "stand", "all"
	if in.Kind != nil && *in.Kind == "section" {
		kind = "section"
	}
	if in.Visibility != nil && *in.Visibility == "private" {
		vis = "private"
	}
	seats, err := templateSeats(kind, *in.Doc)
	if err != nil {
		httpx.Fail(w, r, httpx.NewError(422, "layout", err.Error()))
		return
	}
	zones := json.RawMessage("[]")
	if in.Zones != nil {
		zones = *in.Zones
	}
	desc := ""
	if in.Description != nil {
		desc = strings.TrimSpace(*in.Description)
	}
	name := strings.TrimSpace(*in.Name)
	if name == "" {
		httpx.Fail(w, r, httpx.Validation(map[string]any{"name": "Shablon nomini kiriting"}))
		return
	}
	var id int64
	if err := s.DB.QueryRowContext(r.Context(), `INSERT INTO layout_templates(name, description, kind, doc, zones, seats, visibility, owner_id)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`, name, desc, kind, []byte(*in.Doc), []byte(zones), seats, vis, userIDPtr(r)).Scan(&id); err != nil {
		httpx.Fail(w, r, err)
		return
	}
	s.audit(r, "create", "layout_template", id, map[string]any{"name": name})
	httpx.JSON(w, 201, map[string]any{"id": id, "version": 1})
}

func (s *Server) patchTemplate(w http.ResponseWriter, r *http.Request) {
	id, err := urlID(r, "id")
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	var in templateIn
	r.Body = http.MaxBytesReader(w, r.Body, 4<<20)
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		httpx.Fail(w, r, httpx.BadRequest("JSON noto‘g‘ri"))
		return
	}
	var kind string
	var owner sql.NullInt64
	if err := s.DB.QueryRowContext(r.Context(), `SELECT kind, owner_id FROM layout_templates WHERE id=$1`, id).Scan(&kind, &owner); err != nil {
		httpx.Fail(w, r, httpx.ErrNotFound)
		return
	}
	if c := claimsFrom(r.Context()); c != nil && owner.Valid && owner.Int64 != c.UserID && c.Role != auth.RoleAdmin {
		httpx.Fail(w, r, httpx.NewError(403, "forbidden", "Faqat shablon egasi o‘zgartira oladi"))
		return
	}
	var doc []byte
	seats := -1
	if in.Doc != nil {
		if seats, err = templateSeats(kind, *in.Doc); err != nil {
			httpx.Fail(w, r, httpx.NewError(422, "layout", err.Error()))
			return
		}
		doc = *in.Doc
	}
	var zones []byte
	if in.Zones != nil {
		zones = *in.Zones
	}
	var ver int
	err = s.DB.QueryRowContext(r.Context(), `UPDATE layout_templates SET name=COALESCE($2,name), description=COALESCE($3,description),
		visibility=COALESCE($4,visibility), doc=COALESCE($5,doc), zones=COALESCE($6,zones),
		seats=CASE WHEN $7 >= 0 THEN $7 ELSE seats END,
		version = version + CASE WHEN $5::jsonb IS NULL THEN 0 ELSE 1 END, updated_at=now()
		WHERE id=$1 RETURNING version`, id, in.Name, in.Description, in.Visibility, nullBytes(doc), nullBytes(zones), seats).Scan(&ver)
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	s.audit(r, "update", "layout_template", id, nil)
	httpx.JSON(w, 200, map[string]any{"id": id, "version": ver})
}

func nullBytes(b []byte) any {
	if b == nil {
		return nil
	}
	return b
}

func (s *Server) deleteTemplate(w http.ResponseWriter, r *http.Request) {
	id, err := urlID(r, "id")
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	c := claimsFrom(r.Context())
	res, err := s.DB.ExecContext(r.Context(), `DELETE FROM layout_templates WHERE id=$1 AND (owner_id IS NULL OR owner_id=$2 OR $3)`,
		id, c.UserID, c.Role == auth.RoleAdmin)
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	if n, _ := res.RowsAffected(); n == 0 {
		httpx.Fail(w, r, httpx.ErrNotFound)
		return
	}
	s.audit(r, "delete", "layout_template", id, nil)
	w.WriteHeader(204)
}

func ioNopCloser(b []byte) io.ReadCloser { return io.NopCloser(bytes.NewReader(b)) }
