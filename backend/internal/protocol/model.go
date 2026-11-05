// Package protocol extracts structured match data from official match protocols
// (UFA/PFL layout: "Boshlang‘ich tarkib" + "O‘yin qaydnomasi") in PDF or image form.
package protocol

// Word is a positioned token. Coordinates are normalised to a page width of 600 units.
type Word struct {
	Page int     `json:"page"`
	X0   float64 `json:"x0"`
	Y0   float64 `json:"y0"`
	X1   float64 `json:"x1"`
	Y1   float64 `json:"y1"`
	Text string  `json:"text"`
}

func (w Word) CX() float64 { return (w.X0 + w.X1) / 2 }
func (w Word) CY() float64 { return (w.Y0 + w.Y1) / 2 }

// Side of the pitch in the protocol: home is the left column.
const (
	Home = "home"
	Away = "away"
)

// TeamScore holds a team's result block.
type TeamScore struct {
	Name    string `json:"name"`
	Total   *int   `json:"total"`
	Half1   *int   `json:"half1"`
	Half2   *int   `json:"half2"`
	Extra   *int   `json:"extra"`
	Penalty *int   `json:"penalty"`
}

// PlayerRow is one lineup row with the raw G/S/Q/A cells of the report sheet.
type PlayerRow struct {
	Side     string `json:"side"`
	Number   int    `json:"number"`
	Position string `json:"position"` // DR/HM/YH/HJ as printed
	Name     string `json:"name"`
	Captain  bool   `json:"captain"`
	Starter  bool   `json:"starter"`
	G        string `json:"g,omitempty"`
	S        string `json:"s,omitempty"`
	Q        string `json:"q,omitempty"`
	A        string `json:"a,omitempty"`
	PlayerID *int64 `json:"player_id,omitempty"` // filled during mapping
}

// Event is a derived match event, editable in the admin before applying.
type Event struct {
	Side          string `json:"side"`
	Type          string `json:"type"` // goal, yellow, red, sub
	Minute        int    `json:"minute"`
	Extra         int    `json:"extra"`
	Raw           string `json:"raw"`
	Player        string `json:"player"`
	Number        int    `json:"number"`
	Related       string `json:"related,omitempty"` // sub: player going off
	RelatedNumber int    `json:"related_number,omitempty"`
	Uncertain     bool   `json:"uncertain,omitempty"`
}

// Official is a match or team official.
type Official struct {
	Side string `json:"side,omitempty"`
	Role string `json:"role"`
	Name string `json:"name"`
}

// Extracted is the full structured result of a protocol.
type Extracted struct {
	Tournament     string      `json:"tournament"`
	Stage          string      `json:"stage"`
	Date           string      `json:"date"` // DD.MM.YYYY
	Time           string      `json:"time"` // HH:MM
	Venue          string      `json:"venue"`
	Attendance     *int        `json:"attendance"`
	AddedTime1     *int        `json:"added_time_1h"`
	AddedTime2     *int        `json:"added_time_2h"`
	Home           TeamScore   `json:"home"`
	Away           TeamScore   `json:"away"`
	Players        []PlayerRow `json:"players"`
	Events         []Event     `json:"events"`
	ShootoutMarks  []string    `json:"shootout_marks"` // "home #27 MARTIN BOAKYE" for rows marked "T"
	Officials      []Official  `json:"officials"`
	TeamOfficials  []Official  `json:"team_officials"`
	HasLineupSheet bool        `json:"has_lineup_sheet"`
	HasReportSheet bool        `json:"has_report_sheet"`
}

// Issue is a validation finding shown in the review screen.
type Issue struct {
	Severity string `json:"severity"` // error | warning | info
	Code     string `json:"code"`
	Message  string `json:"message"`
	Ref      string `json:"ref,omitempty"`
}

// Blocking reports whether any issue prevents applying the protocol.
func Blocking(issues []Issue) bool {
	for _, i := range issues {
		if i.Severity == "error" {
			return true
		}
	}
	return false
}
