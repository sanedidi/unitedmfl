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

// Roles from the admin design (Rollar va huquqlar).
const (
	RoleAdmin    = "admin"
	RoleEditor   = "editor"
	RoleOperator = "operator"
	RoleShop     = "shop"
)

// Permissions — one per admin section/action.
const (
	PermDashboard   = "dashboard"
	PermMatchesRead = "matches:read"
	PermMatchesEdit = "matches:edit"
	PermLive        = "live"
	PermProtocols   = "protocols"
	PermTeams       = "teams"
	PermStandings   = "standings"
	PermSeasons     = "seasons"
	PermNews        = "news"
	PermBanners     = "banners"
	PermVideos      = "videos"
	PermMerch       = "merch"
	PermRequests    = "requests"
	PermUsers       = "users"
	PermUploads     = "uploads"
)

var rolePerms = map[string][]string{
	RoleEditor:   {PermDashboard, PermMatchesRead, PermTeams, PermNews, PermBanners, PermVideos, PermRequests, PermUploads},
	RoleOperator: {PermDashboard, PermMatchesRead, PermMatchesEdit, PermLive, PermProtocols, PermUploads},
	RoleShop:     {PermDashboard, PermMerch, PermRequests, PermUploads},
}

// ValidRole reports whether r is a known role.
func ValidRole(r string) bool {
	switch r {
	case RoleAdmin, RoleEditor, RoleOperator, RoleShop:
		return true
	}
	return false
}

// Can reports whether role has permission perm. Administrators can do everything.
func Can(role, perm string) bool {
	if role == RoleAdmin {
		return true
	}
	for _, p := range rolePerms[role] {
		if p == perm {
			return true
		}
	}
	return false
}

// PermissionsFor returns the permission list of a role (used by the admin UI).
func PermissionsFor(role string) []string {
	if role == RoleAdmin {
		return []string{PermDashboard, PermMatchesRead, PermMatchesEdit, PermLive, PermProtocols, PermTeams,
			PermStandings, PermSeasons, PermNews, PermBanners, PermVideos, PermMerch, PermRequests, PermUsers, PermUploads}
	}
	return append([]string(nil), rolePerms[role]...)
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
