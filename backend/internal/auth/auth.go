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
	PermMatchesRead = "matches" // the Matchlar page (a bare page key means «view»)
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

// Actions a role may have on a page. A bare page key ("news") means view.
const (
	ActView   = "view"
	ActCreate = "create"
	ActEdit   = "edit"
	ActDelete = "delete"
)

// ActionLabels names the actions in the admin UI, in matrix column order.
var ActionLabels = []struct {
	Key   string `json:"key"`
	Label string `json:"label"`
}{{ActView, "Ko‘rish"}, {ActCreate, "Yaratish"}, {ActEdit, "Tahrirlash"}, {ActDelete, "O‘chirish"}}

// Page is one admin page that a role may open, with the actions it has.
type Page struct {
	Key     string   `json:"key"`
	Label   string   `json:"label"`
	Hint    string   `json:"hint"`
	Actions []string `json:"actions"`
}

// PageGroup mirrors a group of the admin side menu.
type PageGroup struct {
	Label string `json:"label"`
	Pages []Page `json:"pages"`
}

var (
	aV    = []string{ActView}
	aVE   = []string{ActView, ActEdit}
	aVCE  = []string{ActView, ActCreate, ActEdit}
	aVED  = []string{ActView, ActEdit, ActDelete}
	aVCED = []string{ActView, ActCreate, ActEdit, ActDelete}
)

// Catalog lists every page in the order of the admin side menu.
var Catalog = []PageGroup{
	{"Asosiy", []Page{{PermDashboard, "Dashboard", "Statistika va tashriflar", aV}}},
	{"Turnir", []Page{
		{PermMatchesRead, "Matchlar", "Taqvim, natijalar, tarkiblar", aVCED},
		{PermProtocols, "Protokollar", "Yuklash va tasdiqlash", aVCE},
		{PermLive, "Live-pult", "Voqea kiritish — tahrirlash", aVE},
		{PermTeams, "Jamoalar", "Jamoa, forma, kabinet", aVCED},
		{PermApplications, "Arizalar", "Havolalar va arizalar", aVCED},
		{PermGroups, "Guruhlar", "Guruhlar tarkibi", aVCED},
		{PermPlayers, "O‘yinchilar", "O‘yinchilar bazasi", aVCED},
		{PermStandings, "Turnir jadvali", "Jadvalni tuzatish", aVE},
		{PermSeasons, "Mavsumlar", "Mavsum va bosqichlar", aVCED},
	}},
	{"Kontent", []Page{
		{PermHomepage, "Bosh sahifa", "Konstruktor, nashr", aVE},
		{PermNews, "Yangiliklar", "Maqolalar", aVCED},
		{PermBanners, "Hero-bannerlar", "Bannerlar", aVCED},
		{PermVideos, "Videolar", "Video va yuklash", aVCED},
		{PermPartners, "Hamkorlar", "Homiylar", aVCED},
		{PermInstagram, "Instagram", "Ulash, postlarni yashirish", aVE},
	}},
	{"Do‘kon va aloqa", []Page{
		{PermTickets, "Chiptalar", "Sotuv, buyurtmalar, qaytarish", aVCE},
		{PermStadiums, "Stadionlar", "Stadion konstruktori", aVCED},
		{PermScan, "Kirish nazorati", "Skanerlash", aV},
		{PermMerch, "Merch", "Mahsulotlar", aVCED},
		{PermRequests, "Murojaatlar", "Javob berish, o‘chirish", aVED},
	}},
	{"Tizim", []Page{
		{PermAI, "AI-servis", "Ulanish va sozlamalar", aVE},
		{PermStickers, "Telegram stikerlar", "Stiker paketlari", aVE},
		{PermWildberries, "Wildberries", "Do‘kon ulanishi", aVE},
		{PermUsers, "Foydalanuvchilar", "Admin xodimlari", aVCED},
		{PermRoles, "Rollar va huquqlar", "Rollar", aVCED},
		{PermAudit, "Audit jurnali", "Faqat ko‘rish", aV},
	}},
}

// FindPage returns the catalog page with key.
func FindPage(key string) (Page, bool) {
	for _, g := range Catalog {
		for _, p := range g.Pages {
			if p.Key == key {
				return p, true
			}
		}
	}
	return Page{}, false
}

func has(list []string, v string) bool {
	for _, x := range list {
		if x == v {
			return true
		}
	}
	return false
}

// Key builds a permission key such as "news:create".
func Key(page, action string) string { return page + ":" + action }

// SplitKey splits "news:create" into page and action; a bare key means view.
func SplitKey(k string) (page, action string) {
	if i := strings.LastIndexByte(k, ':'); i >= 0 {
		return k[:i], k[i+1:]
	}
	return k, ActView
}

// Normalize turns a permission into its full key: "news" → "news:view".
func Normalize(k string) string {
	p, a := SplitKey(k)
	return Key(p, a)
}

// PageAction is the permission an action on a page needs. When the page has no
// such action (publishing on Bosh sahifa is a POST, but the page only has
// view and edit) the action counts as editing, and on a view-only page as viewing.
func PageAction(page, action string) string {
	pg, ok := FindPage(page)
	if !ok || has(pg.Actions, action) {
		return Key(page, action)
	}
	if action != ActView && has(pg.Actions, ActEdit) {
		return Key(page, ActEdit)
	}
	return Key(page, ActView)
}

// AllPermissions returns every page action from the catalog.
func AllPermissions() []string {
	var out []string
	for _, g := range Catalog {
		for _, p := range g.Pages {
			for _, a := range p.Actions {
				out = append(out, Key(p.Key, a))
			}
		}
	}
	return out
}

// KnownPermission reports whether p is a page action from the catalog.
func KnownPermission(p string) bool {
	page, action := SplitKey(p)
	pg, ok := FindPage(page)
	return ok && has(pg.Actions, action)
}

// Describe names a permission for messages: "Yangiliklar — o‘chirish".
func Describe(k string) string {
	page, action := SplitKey(k)
	label := page
	if pg, ok := FindPage(page); ok {
		label = pg.Label
	}
	for _, a := range ActionLabels {
		if a.Key == action {
			return label + " — " + strings.ToLower(a.Label)
		}
	}
	return label
}

// NormalizePermissions drops unknown and duplicate keys, adds «view» to every
// page that has another action and returns the rest in catalog order.
func NormalizePermissions(in []string) (out []string, unknown []string) {
	set := map[string]bool{}
	for _, p := range in {
		if !KnownPermission(p) {
			unknown = append(unknown, p)
			continue
		}
		set[p] = true
		page, _ := SplitKey(p)
		set[Key(page, ActView)] = true
	}
	for _, p := range AllPermissions() {
		if set[p] {
			out = append(out, p)
		}
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
