// Package auth implements password hashing, JWT access tokens, refresh tokens and RBAC.
package auth

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"golang.org/x/crypto/bcrypt"
)

// RoleAdmin is the built-in administrator role: it can do everything and cannot be
// changed. Every other role lives in the roles table (see Roles) and is edited in
// the admin panel (Rollar va huquqlar).
const RoleAdmin = "admin"

// Permissions — one per admin page, plus a few extra actions inside a page.
const (
	PermDashboard   = "dashboard"
	PermMatchesRead = "matches:read"
	PermMatchesEdit = "matches:edit"
	PermLive        = "live"
	PermProtocols   = "protocols"
	PermTeams       = "teams"
	PermGroups      = "groups"
	PermPlayers     = "players"
	PermStandings   = "standings"
	PermSeasons     = "seasons"
	PermNews        = "news"
	PermBanners     = "banners"
	PermVideos      = "videos"
	PermInstagram   = "instagram"
	PermMerch       = "merch"
	PermRequests    = "requests"
	PermUsers       = "users"
	PermRoles       = "roles"
	PermAudit       = "audit"
	// PermUploads is not a page: every role that has any page besides the gate
	// scanner may upload images (see Roles.Can).
	PermUploads = "uploads"
	// team self-registration: links and applications
	PermApplications = "applications"
	// deleting sent or approved applications (and the team an approval created);
	// drafts and rejected applications only need PermApplications
	PermApplicationsDelete = "applications:delete"
	// homepage layout builder (draft, publish, versions)
	PermHomepage = "homepage"
	// sponsors and partners (Kontent → Hamkorlar)
	PermPartners = "partners"

	// tickets: sales, orders, refunds, entry security; stadiums: the layout constructor;
	// scan: the gate scanner
	PermTickets  = "tickets"
	PermStadiums = "stadiums"
	PermScan     = "scan"

	// service connections and settings
	PermAI          = "ai"
	PermStickers    = "stickers"
	PermWildberries = "wildberries"
)

// Extra is an additional action inside a page (shown as a sub-checkbox).
type Extra struct {
	Key   string `json:"key"`
	Label string `json:"label"`
}

// Page is one admin page that a role may open.
type Page struct {
	Key    string  `json:"key"`
	Label  string  `json:"label"`
	Hint   string  `json:"hint"`
	Extras []Extra `json:"extras,omitempty"`
}

// PageGroup mirrors a group of the admin side menu.
type PageGroup struct {
	Label string `json:"label"`
	Pages []Page `json:"pages"`
}

// Catalog lists every page in the order of the admin side menu.
var Catalog = []PageGroup{
	{"Asosiy", []Page{{Key: PermDashboard, Label: "Dashboard", Hint: "Statistika va sayt tashriflari"}}},
	{"Turnir", []Page{
		{Key: PermMatchesRead, Label: "Matchlar", Hint: "Ro‘yxat va match kartasi", Extras: []Extra{{PermMatchesEdit, "Tahrirlash ham mumkin"}}},
		{Key: PermProtocols, Label: "Protokollar", Hint: "Yuklash va tasdiqlash"},
		{Key: PermLive, Label: "Live-pult", Hint: "Match davomida voqealar, Telegram bot"},
		{Key: PermTeams, Label: "Jamoalar", Hint: "Jamoalar, forma va jamoa kabinetlari"},
		{Key: PermApplications, Label: "Arizalar", Hint: "Ro‘yxatdan o‘tish arizalari", Extras: []Extra{{PermApplicationsDelete, "Arizalarni o‘chirish ham mumkin"}}},
		{Key: PermGroups, Label: "Guruhlar", Hint: "Guruhlar tarkibi"},
		{Key: PermPlayers, Label: "O‘yinchilar", Hint: "O‘yinchilar bazasi"},
		{Key: PermStandings, Label: "Turnir jadvali", Hint: "Jadvalni tuzatish"},
		{Key: PermSeasons, Label: "Mavsumlar", Hint: "Mavsum va bosqichlar"},
	}},
	{"Kontent", []Page{
		{Key: PermHomepage, Label: "Bosh sahifa", Hint: "Bloklar konstruktori"},
		{Key: PermNews, Label: "Yangiliklar", Hint: "Maqolalar"},
		{Key: PermBanners, Label: "Hero-bannerlar", Hint: "Bosh sahifa bannerlari"},
		{Key: PermVideos, Label: "Videolar", Hint: "Video va yuklash"},
		{Key: PermPartners, Label: "Hamkorlar", Hint: "Homiylar va hamkorlar"},
		{Key: PermInstagram, Label: "Instagram", Hint: "Postlar lentasi"},
	}},
	{"Do‘kon va aloqa", []Page{
		{Key: PermTickets, Label: "Chiptalar", Hint: "Sotuv, buyurtmalar, qaytarish"},
		{Key: PermStadiums, Label: "Stadionlar", Hint: "Stadion konstruktori"},
		{Key: PermScan, Label: "Kirish nazorati", Hint: "Chiptalarni skanerlash"},
		{Key: PermMerch, Label: "Merch", Hint: "Mahsulotlar"},
		{Key: PermRequests, Label: "Murojaatlar", Hint: "Saytdan xabarlar"},
	}},
	{"Tizim", []Page{
		{Key: PermAI, Label: "AI-servis", Hint: "OpenAI va Gemini ulanishi"},
		{Key: PermStickers, Label: "Telegram stikerlar", Hint: "Stiker paketlari"},
		{Key: PermWildberries, Label: "Wildberries", Hint: "Do‘kon ulanishi"},
		{Key: PermUsers, Label: "Foydalanuvchilar", Hint: "Admin foydalanuvchilari"},
		{Key: PermRoles, Label: "Rollar va huquqlar", Hint: "Rollar va sahifalarga kirish"},
		{Key: PermAudit, Label: "Audit jurnali", Hint: "Kim nima qildi"},
	}},
}

// AllPermissions returns every page and extra permission from the catalog.
func AllPermissions() []string {
	var out []string
	for _, g := range Catalog {
		for _, p := range g.Pages {
			out = append(out, p.Key)
			for _, e := range p.Extras {
				out = append(out, e.Key)
			}
		}
	}
	return out
}

// KnownPermission reports whether p is a page or extra from the catalog.
func KnownPermission(p string) bool {
	for _, k := range AllPermissions() {
		if k == p {
			return true
		}
	}
	return false
}

// extraOwner maps an extra permission to the page it belongs to.
func extraOwner(p string) string {
	for _, g := range Catalog {
		for _, pg := range g.Pages {
			for _, e := range pg.Extras {
				if e.Key == p {
					return pg.Key
				}
			}
		}
	}
	return ""
}

// NormalizePermissions drops unknown and duplicate keys, drops extras whose page
// is not granted and returns the rest in catalog order.
func NormalizePermissions(in []string) (out []string, unknown []string) {
	set := map[string]bool{}
	for _, p := range in {
		if !KnownPermission(p) {
			unknown = append(unknown, p)
			continue
		}
		set[p] = true
	}
	for _, p := range AllPermissions() {
		if !set[p] {
			continue
		}
		if o := extraOwner(p); o != "" && !set[o] {
			continue
		}
		out = append(out, p)
	}
	return out, unknown
}

// NormalizePhone keeps digits only. A local Uzbek number (9 digits) gets the 998
// country code, so «+998 90 123-45-67», «998901234567» and «90 123 45 67» match.
// It returns "" for an empty input and ok=false for something that is not a phone.
func NormalizePhone(s string) (phone string, ok bool) {
	var b []byte
	for _, r := range s {
		if r >= '0' && r <= '9' {
			b = append(b, byte(r))
		}
	}
	d := string(b)
	if d == "" {
		return "", strings.TrimSpace(s) == ""
	}
	if len(d) == 9 {
		d = "998" + d
	}
	if len(d) < 10 || len(d) > 15 {
		return "", false
	}
	return d, true
}

// HashPassword hashes a password with bcrypt.
func HashPassword(pw string) (string, error) {
	if len(pw) < 8 {
		return "", errors.New("parol kamida 8 belgidan iborat bo‘lishi kerak")
	}
	b, err := bcrypt.GenerateFromPassword([]byte(pw), 12)
	return string(b), err
}

// CheckPassword compares a bcrypt hash with a password.
func CheckPassword(hash, pw string) bool {
	return bcrypt.CompareHashAndPassword([]byte(hash), []byte(pw)) == nil
}

// Claims carried by the access token.
type Claims struct {
	UserID int64  `json:"uid"`
	Role   string `json:"role"`
	Name   string `json:"name"`
	jwt.RegisteredClaims
}

// Issuer signs and verifies access tokens.
type Issuer struct {
	secret []byte
	ttl    time.Duration
}

func NewIssuer(secret []byte, ttl time.Duration) *Issuer { return &Issuer{secret: secret, ttl: ttl} }

// Sign creates an access token.
func (i *Issuer) Sign(uid int64, role, name string) (string, time.Time, error) {
	exp := time.Now().Add(i.ttl)
	tok := jwt.NewWithClaims(jwt.SigningMethodHS256, Claims{
		UserID: uid, Role: role, Name: name,
		RegisteredClaims: jwt.RegisteredClaims{
			ExpiresAt: jwt.NewNumericDate(exp),
			IssuedAt:  jwt.NewNumericDate(time.Now()),
			Issuer:    "unitedmfl",
		},
	})
	s, err := tok.SignedString(i.secret)
	return s, exp, err
}

// Parse validates an access token.
func (i *Issuer) Parse(s string) (*Claims, error) {
	c := &Claims{}
	_, err := jwt.ParseWithClaims(s, c, func(t *jwt.Token) (any, error) {
		if t.Method != jwt.SigningMethodHS256 {
			return nil, fmt.Errorf("unexpected signing method")
		}
		return i.secret, nil
	}, jwt.WithIssuer("unitedmfl"))
	if err != nil {
		return nil, err
	}
	return c, nil
}

// NewRefreshToken returns a random opaque token and its SHA-256 hash for storage.
func NewRefreshToken() (token, hash string, err error) {
	b := make([]byte, 32)
	if _, err = rand.Read(b); err != nil {
		return "", "", err
	}
	token = base64.RawURLEncoding.EncodeToString(b)
	return token, HashToken(token), nil
}

// HashToken hashes an opaque token.
func HashToken(t string) string {
	s := sha256.Sum256([]byte(t))
	return hex.EncodeToString(s[:])
}
