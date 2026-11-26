// Package tickets holds the stadium layout model (constructor), the seat
// arithmetic and the dynamic QR codes of match tickets.
package tickets

import (
	"encoding/json"
	"fmt"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

// Layout is the stadium schema edited in the admin constructor.
// Stand → section → row → seat. Seats are not stored one by one: a row keeps
// its seat count and the numbers removed or blocked inside it.
type Layout struct {
	Pitch  Rect    `json:"pitch"`
	Zones  []Zone  `json:"zones"`
	Stands []Stand `json:"stands"`
	Gates  []Gate  `json:"gates"`
}

type Rect struct {
	X float64 `json:"x"`
	Y float64 `json:"y"`
	W float64 `json:"w"`
	H float64 `json:"h"`
}

// Zone is a ticket kind on the site (Oddiy, VIP, Mehmonlar…). Prices are per match.
type Zone struct {
	Key   string `json:"key"`
	Name  string `json:"name"`
	Kind  string `json:"kind"` // oddiy | vip
	Color string `json:"color"`
}

type Gate struct {
	Key  string  `json:"key"`
	Name string  `json:"name"`
	X    float64 `json:"x"`
	Y    float64 `json:"y"`
}

type Stand struct {
	Key        string    `json:"key"`
	Name       string    `json:"name"`
	Position   string    `json:"position"` // N S W E NE NW SE SW
	Shape      string    `json:"shape"`    // straight | arc | corner
	X          float64   `json:"x"`
	Y          float64   `json:"y"`
	Rotation   float64   `json:"rotation"`
	TemplateID *int64    `json:"template_id,omitempty"` // linked copy of a library template
	TemplateV  int       `json:"template_version,omitempty"`
	Sections   []Section `json:"sections"`
}

type Section struct {
	Key        string  `json:"key"` // unique in the layout: D1, VIP, F2…
	Name       string  `json:"name"`
	Zone       string  `json:"zone"`
	Gate       string  `json:"gate"`
	SeatMode   string  `json:"seat_mode"` // free | numbered
	Numbering  string  `json:"numbering"` // ltr | rtl
	AisleAfter []int   `json:"aisle_after"`
	X          float64 `json:"x"` // relative to the stand
	Y          float64 `json:"y"`
	Rotation   float64 `json:"rotation"`
	Rows       []Row   `json:"rows"`
}

type Row struct {
	Label   string `json:"label"`
	Seats   int    `json:"seats"`
	Removed []int  `json:"removed"` // no seat at this number (empty cell)
	Blocked []int  `json:"blocked"` // seat exists but is not sold (camera, service)
}

// Limits keep a broken document from eating the database.
const (
	MaxStands   = 64
	MaxSections = 400
	MaxRows     = 200
	MaxSeats    = 400 // per row
	MaxTotal    = 120000
)

var reKey = regexp.MustCompile(`^[A-Za-z0-9_\-]{1,24}$`)

// Parse decodes and validates a layout document.
func Parse(raw []byte) (*Layout, error) {
	var l Layout
	dec := json.NewDecoder(strings.NewReader(string(raw)))
	if err := dec.Decode(&l); err != nil {
		return nil, fmt.Errorf("sxema JSON noto‘g‘ri: %w", err)
	}
	if err := l.Normalize(); err != nil {
		return nil, err
	}
	return &l, nil
}

// Normalize fills defaults, sorts number lists and validates the document.
func (l *Layout) Normalize() error {
	zones := map[string]bool{}
	for i := range l.Zones {
		z := &l.Zones[i]
		z.Key = strings.TrimSpace(z.Key)
		if !reKey.MatchString(z.Key) {
			return fmt.Errorf("zona kaliti noto‘g‘ri: %q", z.Key)
		}
		if zones[z.Key] {
			return fmt.Errorf("zona takrorlangan: %s", z.Key)
		}
		zones[z.Key] = true
		if z.Kind != "vip" {
			z.Kind = "oddiy"
		}
		if strings.TrimSpace(z.Name) == "" {
			z.Name = z.Key
		}
	}
	if len(l.Stands) > MaxStands {
		return fmt.Errorf("tribunalar juda ko‘p (%d)", len(l.Stands))
	}
	seen := map[string]bool{}
	nSections, total := 0, 0
	for si := range l.Stands {
		st := &l.Stands[si]
		if strings.TrimSpace(st.Key) == "" {
			st.Key = fmt.Sprintf("s%d", si+1)
		}
		if st.Shape == "" {
			st.Shape = "straight"
		}
		for ki := range st.Sections {
			sec := &st.Sections[ki]
			nSections++
			sec.Key = strings.TrimSpace(sec.Key)
			if !reKey.MatchString(sec.Key) {
				return fmt.Errorf("sektor kaliti noto‘g‘ri: %q", sec.Key)
			}
			if seen[strings.ToLower(sec.Key)] {
				return fmt.Errorf("sektor nomi takrorlangan: %s", sec.Key)
			}
			seen[strings.ToLower(sec.Key)] = true
			if sec.Name == "" {
				sec.Name = sec.Key
			}
			if sec.Zone != "" && !zones[sec.Zone] {
				return fmt.Errorf("%s sektori noma’lum zonada: %s", sec.Key, sec.Zone)
			}
			if sec.SeatMode != "free" {
				sec.SeatMode = "numbered"
			}
			if sec.Numbering != "rtl" {
				sec.Numbering = "ltr"
			}
			if len(sec.Rows) > MaxRows {
				return fmt.Errorf("%s: qatorlar juda ko‘p", sec.Key)
			}
			labels := map[string]bool{}
			for ri := range sec.Rows {
				row := &sec.Rows[ri]
				row.Label = strings.TrimSpace(row.Label)
				if row.Label == "" {
					row.Label = strconv.Itoa(ri + 1)
				}
				if labels[row.Label] {
					return fmt.Errorf("%s: qator takrorlangan: %s", sec.Key, row.Label)
				}
				labels[row.Label] = true
				if row.Seats < 0 || row.Seats > MaxSeats {
					return fmt.Errorf("%s, %s-qator: o‘rinlar soni noto‘g‘ri", sec.Key, row.Label)
				}
				row.Removed = cleanNums(row.Removed, row.Seats)
				row.Blocked = cleanNums(row.Blocked, row.Seats)
				row.Blocked = minus(row.Blocked, row.Removed)
				total += row.Seats - len(row.Removed)
			}
			sec.AisleAfter = cleanNums(sec.AisleAfter, maxSeats(sec))
		}
	}
	if nSections > MaxSections {
		return fmt.Errorf("sektorlar juda ko‘p (%d)", nSections)
	}
	if total > MaxTotal {
		return fmt.Errorf("o‘rinlar juda ko‘p (%d)", total)
	}
	return nil
}

func maxSeats(s *Section) int {
	m := 0
	for _, r := range s.Rows {
		if r.Seats > m {
			m = r.Seats
		}
	}
	return m
}

func cleanNums(in []int, max int) []int {
	set := map[int]bool{}
	out := []int{}
	for _, n := range in {
		if n >= 1 && n <= max && !set[n] {
			set[n] = true
			out = append(out, n)
		}
	}
	sort.Ints(out)
	return out
}

func minus(a, b []int) []int {
	out := []int{}
	for _, x := range a {
		if !contains(b, x) {
			out = append(out, x)
		}
	}
	return out
}

func contains(a []int, x int) bool {
	for _, y := range a {
		if y == x {
			return true
		}
	}
	return false
}

// Stats is a capacity summary.
type Stats struct {
	Seats    int            `json:"seats"`    // existing seats
	Sellable int            `json:"sellable"` // minus blocked
	Blocked  int            `json:"blocked"`
	Removed  int            `json:"removed"`
	Sections int            `json:"sections"`
	Stands   int            `json:"stands"`
	ByZone   map[string]int `json:"by_zone"` // sellable per zone ("" — no zone)
}

func (l *Layout) Stats() Stats {
	st := Stats{ByZone: map[string]int{}, Stands: len(l.Stands)}
	for _, s := range l.Stands {
		for _, sec := range s.Sections {
			st.Sections++
			for _, r := range sec.Rows {
				n := r.Seats - len(r.Removed)
				st.Seats += n
				st.Removed += len(r.Removed)
				st.Blocked += len(r.Blocked)
				st.Sellable += n - len(r.Blocked)
				st.ByZone[sec.Zone] += n - len(r.Blocked)
			}
		}
	}
	return st
}

// Section finds a section by key.
func (l *Layout) Section(key string) *Section {
	for i := range l.Stands {
		for j := range l.Stands[i].Sections {
			if strings.EqualFold(l.Stands[i].Sections[j].Key, key) {
				return &l.Stands[i].Sections[j]
			}
		}
	}
	return nil
}

// Seat is one sellable place.
type Seat struct {
	ID      string `json:"id"` // SECTION:ROW:N
	Section string `json:"section"`
	Row     string `json:"row"`
	N       int    `json:"n"`
}

func SeatID(section, row string, n int) string { return fmt.Sprintf("%s:%s:%d", section, row, n) }

// ParseSeatID splits SECTION:ROW:N.
func ParseSeatID(id string) (section, row string, n int, ok bool) {
	p := strings.Split(id, ":")
	if len(p) != 3 {
		return "", "", 0, false
	}
	n, err := strconv.Atoi(p[2])
	if err != nil || n < 1 {
		return "", "", 0, false
	}
	return p[0], p[1], n, true
}

// SellableSeats lists the seats of numbered sections in a zone, best first:
// rows from the pitch side, then from the middle of the row outwards.
func (l *Layout) SellableSeats(zone string) []Seat {
	var out []Seat
	for _, s := range l.Stands {
		for _, sec := range s.Sections {
			if sec.Zone != zone || sec.SeatMode != "numbered" {
				continue
			}
			for _, r := range sec.Rows {
				mid := float64(r.Seats+1) / 2
				nums := []int{}
				for n := 1; n <= r.Seats; n++ {
					if !contains(r.Removed, n) && !contains(r.Blocked, n) {
						nums = append(nums, n)
					}
				}
				sort.SliceStable(nums, func(i, j int) bool {
					di, dj := abs(float64(nums[i])-mid), abs(float64(nums[j])-mid)
					if di != dj {
						return di < dj
					}
					return nums[i] < nums[j]
				})
				for _, n := range nums {
					out = append(out, Seat{ID: SeatID(sec.Key, r.Label, n), Section: sec.Key, Row: r.Label, N: n})
				}
			}
		}
	}
	return out
}

// IsSellable reports whether a seat id exists in the layout and is not blocked.
func (l *Layout) IsSellable(id string) bool {
	sk, rl, n, ok := ParseSeatID(id)
	if !ok {
		return false
	}
	sec := l.Section(sk)
	if sec == nil || sec.SeatMode != "numbered" {
		return false
	}
	for _, r := range sec.Rows {
		if r.Label == rl {
			return n <= r.Seats && !contains(r.Removed, n) && !contains(r.Blocked, n)
		}
	}
	return false
}

// FreeCapacity is the sellable capacity of free-seating sections in a zone.
func (l *Layout) FreeCapacity(zone string) int {
	c := 0
	for _, s := range l.Stands {
		for _, sec := range s.Sections {
			if sec.Zone == zone && sec.SeatMode == "free" {
				for _, r := range sec.Rows {
					c += r.Seats - len(r.Removed) - len(r.Blocked)
				}
			}
		}
	}
	return c
}

// ZoneSections lists the section keys of a zone.
func (l *Layout) ZoneSections(zone string) []string {
	var out []string
	for _, s := range l.Stands {
		for _, sec := range s.Sections {
			if sec.Zone == zone {
				out = append(out, sec.Key)
			}
		}
	}
	return out
}

// ZoneMode is "numbered" if any section of the zone has numbered seats.
func (l *Layout) ZoneMode(zone string) string {
	for _, s := range l.Stands {
		for _, sec := range s.Sections {
			if sec.Zone == zone && sec.SeatMode == "numbered" {
				return "numbered"
			}
		}
	}
	return "free"
}

// FirstGate returns the gate of the first section of a zone.
func (l *Layout) FirstGate(zone string) string {
	for _, s := range l.Stands {
		for _, sec := range s.Sections {
			if sec.Zone == zone && sec.Gate != "" {
				return sec.Gate
			}
		}
	}
	return ""
}

func abs(f float64) float64 {
	if f < 0 {
		return -f
	}
	return f
}

// Diff compares two layouts section by section (versions screen).
type SectionDiff struct {
	Key    string `json:"key"`
	Change string `json:"change"` // added | removed | changed
	Seats  int    `json:"seats"`  // seat delta (new − old)
	Note   string `json:"note"`
}

func Diff(old, cur *Layout) []SectionDiff {
	type info struct {
		seats int
		zone  string
		gate  string
		mode  string
	}
	collect := func(l *Layout) map[string]info {
		m := map[string]info{}
		for _, s := range l.Stands {
			for _, sec := range s.Sections {
				n := 0
				for _, r := range sec.Rows {
					n += r.Seats - len(r.Removed)
				}
				m[sec.Key] = info{n, sec.Zone, sec.Gate, sec.SeatMode}
			}
		}
		return m
	}
	a, b := collect(old), collect(cur)
	var out []SectionDiff
	for k, v := range b {
		o, ok := a[k]
		if !ok {
			out = append(out, SectionDiff{Key: k, Change: "added", Seats: v.seats})
			continue
		}
		var notes []string
		if o.zone != v.zone {
			notes = append(notes, "zona")
		}
		if o.gate != v.gate {
			notes = append(notes, "kirish")
		}
		if o.mode != v.mode {
			notes = append(notes, "o‘rin turi")
		}
		if o.seats != v.seats || len(notes) > 0 {
			out = append(out, SectionDiff{Key: k, Change: "changed", Seats: v.seats - o.seats, Note: strings.Join(notes, ", ")})
		}
	}
	for k, v := range a {
		if _, ok := b[k]; !ok {
			out = append(out, SectionDiff{Key: k, Change: "removed", Seats: -v.seats})
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Key < out[j].Key })
	return out
}
