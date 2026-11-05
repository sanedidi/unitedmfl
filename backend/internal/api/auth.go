package api

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"net/mail"
	"strconv"
	"strings"
	"time"

	"github.com/sanedidi/unitedmfl/backend/internal/auth"
	"github.com/sanedidi/unitedmfl/backend/internal/httpx"
)

type ctxKey int

const claimsKey ctxKey = 1

func claimsFrom(ctx context.Context) *auth.Claims {
	c, _ := ctx.Value(claimsKey).(*auth.Claims)
	return c
}

func (s *Server) requireAuth(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := r.Header.Get("Authorization")
		if !strings.HasPrefix(h, "Bearer ") {
			httpx.Fail(w, r, httpx.ErrUnauthorized)
			return
		}
		c, err := s.Tokens.Parse(strings.TrimPrefix(h, "Bearer "))
		if err != nil {
			httpx.Fail(w, r, httpx.ErrUnauthorized)
			return
		}
		// blocked users lose access immediately
		var status string
		if err := s.DB.QueryRowContext(r.Context(), `SELECT status FROM users WHERE id=$1`, c.UserID).Scan(&status); err != nil || status != "active" {
			httpx.Fail(w, r, httpx.ErrUnauthorized)
			return
		}
		next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), claimsKey, c)))
	})
}

func (s *Server) can(perm string) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			c := claimsFrom(r.Context())
			if c == nil || !auth.Can(c.Role, perm) {
				httpx.Fail(w, r, httpx.ErrForbidden)
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}

// audit records an admin action; failures are logged, never returned.
func (s *Server) audit(r *http.Request, action, entity string, id int64, data any) {
	var uid *int64
	if c := claimsFrom(r.Context()); c != nil {
		uid = &c.UserID
	}
	if m, ok := data.(map[string]any); ok {
		delete(m, "password")
	}
	b, _ := json.Marshal(data)
	if data == nil {
		b = []byte("{}")
	}
	if _, err := s.DB.ExecContext(r.Context(), `INSERT INTO audit_log(user_id, action, entity, entity_id, data) VALUES ($1,$2,$3,$4,$5)`, uid, action, entity, id, b); err != nil {
		slog.Warn("audit failed", "err", err)
	}
	// every audited action is a content change (login is not audited)
	s.web.notify()
}

type tokenResponse struct {
	AccessToken  string    `json:"access_token"`
	ExpiresAt    time.Time `json:"expires_at"`
	RefreshToken string    `json:"refresh_token"`
	User         userDTO   `json:"user"`
}

type userDTO struct {
	ID          int64    `json:"id"`
	Name        string   `json:"name"`
	Email       string   `json:"email"`
	Role        string   `json:"role"`
	Permissions []string `json:"permissions"`
}

func (s *Server) issueTokens(ctx context.Context, id int64, name, email, role string) (*tokenResponse, error) {
	access, exp, err := s.Tokens.Sign(id, role, name)
	if err != nil {
		return nil, err
	}
	refresh, hash, err := auth.NewRefreshToken()
	if err != nil {
		return nil, err
	}
	if _, err := s.DB.ExecContext(ctx, `INSERT INTO refresh_tokens(user_id, token_hash, expires_at) VALUES ($1,$2,$3)`, id, hash, time.Now().Add(s.Cfg.RefreshTTL)); err != nil {
		return nil, err
	}
	return &tokenResponse{AccessToken: access, ExpiresAt: exp, RefreshToken: refresh,
		User: userDTO{ID: id, Name: name, Email: email, Role: role, Permissions: auth.PermissionsFor(role)}}, nil
}

func (s *Server) login(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Email    string `json:"email"`
		Password string `json:"password"`
	}
	if err := httpx.Decode(r, &in); err != nil {
		httpx.Fail(w, r, err)
		return
	}
	var id int64
	var name, hash, role, status string
	err := s.DB.QueryRowContext(r.Context(), `SELECT id, name, password_hash, role, status FROM users WHERE lower(email)=lower($1)`, strings.TrimSpace(in.Email)).
		Scan(&id, &name, &hash, &role, &status)
	if errors.Is(err, sql.ErrNoRows) || (err == nil && !auth.CheckPassword(hash, in.Password)) {
		httpx.Fail(w, r, httpx.NewError(http.StatusUnauthorized, "invalid_credentials", "Email yoki parol noto‘g‘ri"))
		return
	}
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	if status != "active" {
		httpx.Fail(w, r, httpx.NewError(http.StatusForbidden, "blocked", "Hisob bloklangan"))
		return
	}
	_, _ = s.DB.ExecContext(r.Context(), `UPDATE users SET last_login_at=now() WHERE id=$1`, id)
	resp, err := s.issueTokens(r.Context(), id, name, strings.ToLower(in.Email), role)
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	httpx.JSON(w, 200, resp)
}

func (s *Server) refresh(w http.ResponseWriter, r *http.Request) {
	var in struct {
		RefreshToken string `json:"refresh_token"`
	}
	if err := httpx.Decode(r, &in); err != nil {
		httpx.Fail(w, r, err)
		return
	}
	tx, err := s.DB.BeginTx(r.Context(), nil)
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	defer tx.Rollback()
	var tokenID, uid int64
	var name, email, role, status string
	err = tx.QueryRowContext(r.Context(), `SELECT t.id, u.id, u.name, u.email, u.role, u.status FROM refresh_tokens t JOIN users u ON u.id=t.user_id
		WHERE t.token_hash=$1 AND t.revoked_at IS NULL AND t.expires_at > now() FOR UPDATE OF t`, auth.HashToken(in.RefreshToken)).
		Scan(&tokenID, &uid, &name, &email, &role, &status)
	if err != nil || status != "active" {
		httpx.Fail(w, r, httpx.ErrUnauthorized)
		return
	}
	if _, err := tx.ExecContext(r.Context(), `UPDATE refresh_tokens SET revoked_at=now() WHERE id=$1`, tokenID); err != nil {
		httpx.Fail(w, r, err)
		return
	}
	if err := tx.Commit(); err != nil {
		httpx.Fail(w, r, err)
		return
	}
	resp, err := s.issueTokens(r.Context(), uid, name, email, role)
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	httpx.JSON(w, 200, resp)
}

func (s *Server) logout(w http.ResponseWriter, r *http.Request) {
	var in struct {
		RefreshToken string `json:"refresh_token"`
	}
	_ = httpx.Decode(r, &in)
	_, _ = s.DB.ExecContext(r.Context(), `UPDATE refresh_tokens SET revoked_at=now() WHERE token_hash=$1 AND revoked_at IS NULL`, auth.HashToken(in.RefreshToken))
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) me(w http.ResponseWriter, r *http.Request) {
	c := claimsFrom(r.Context())
	var email string
	_ = s.DB.QueryRowContext(r.Context(), `SELECT email FROM users WHERE id=$1`, c.UserID).Scan(&email)
	httpx.JSON(w, 200, userDTO{ID: c.UserID, Name: c.Name, Email: email, Role: c.Role, Permissions: auth.PermissionsFor(c.Role)})
}

// EnsureAdmin creates the first administrator from env vars when the users table is empty.
func EnsureAdmin(ctx context.Context, db *sql.DB, name, email, password string) error {
	var n int
	if err := db.QueryRowContext(ctx, `SELECT count(*) FROM users`).Scan(&n); err != nil {
		return err
	}
	if n > 0 {
		return nil
	}
	if email == "" || password == "" {
		slog.Warn("no users exist; set ADMIN_EMAIL and ADMIN_PASSWORD to create the first administrator")
		return nil
	}
	hash, err := auth.HashPassword(password)
	if err != nil {
		return err
	}
	_, err = db.ExecContext(ctx, `INSERT INTO users(name, email, password_hash, role) VALUES ($1, lower($2), $3, 'admin')`, name, email, hash)
	if err == nil {
		slog.Info("first administrator created", "email", email)
	}
	return err
}

// ---------- users ----------

func (s *Server) listUsers(w http.ResponseWriter, r *http.Request) {
	var raw []byte
	err := s.DB.QueryRowContext(r.Context(), `SELECT coalesce(json_agg(u ORDER BY u.id), '[]') FROM
		(SELECT id, name, email, role, status, last_login_at, created_at FROM users) u`).Scan(&raw)
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	writeRaw(w, 200, raw)
}

type userInput struct {
	Name     *string `json:"name"`
	Email    *string `json:"email"`
	Password *string `json:"password"`
	Role     *string `json:"role"`
	Status   *string `json:"status"`
}

func (s *Server) createUser(w http.ResponseWriter, r *http.Request) {
	var in userInput
	if err := httpx.Decode(r, &in); err != nil {
		httpx.Fail(w, r, err)
		return
	}
	errs := map[string]any{}
	if in.Name == nil || strings.TrimSpace(*in.Name) == "" {
		errs["name"] = "majburiy"
	}
	if in.Email == nil {
		errs["email"] = "majburiy"
	} else if _, err := mail.ParseAddress(*in.Email); err != nil {
		errs["email"] = "email noto‘g‘ri"
	}
	if in.Role == nil || !auth.ValidRole(*in.Role) {
		errs["role"] = "rol noto‘g‘ri (admin, editor, operator, shop)"
	}
	if in.Password == nil {
		errs["password"] = "majburiy"
	}
	if len(errs) > 0 {
		httpx.Fail(w, r, httpx.Validation(errs))
		return
	}
	hash, err := auth.HashPassword(*in.Password)
	if err != nil {
		httpx.Fail(w, r, httpx.Validation(map[string]any{"password": err.Error()}))
		return
	}
	var id int64
	err = s.DB.QueryRowContext(r.Context(), `INSERT INTO users(name, email, password_hash, role) VALUES ($1, lower($2), $3, $4) RETURNING id`,
		strings.TrimSpace(*in.Name), strings.TrimSpace(*in.Email), hash, *in.Role).Scan(&id)
	if err != nil {
		httpx.Fail(w, r, dbError(err))
		return
	}
	s.audit(r, "create", "user", id, map[string]any{"email": *in.Email, "role": *in.Role})
	httpx.JSON(w, http.StatusCreated, map[string]any{"id": id})
}

func (s *Server) patchUser(w http.ResponseWriter, r *http.Request) {
	id, err := idParam(r, "id")
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	var in userInput
	if err := httpx.Decode(r, &in); err != nil {
		httpx.Fail(w, r, err)
		return
	}
	me := claimsFrom(r.Context())
	if id == me.UserID && ((in.Role != nil && *in.Role != auth.RoleAdmin) || (in.Status != nil && *in.Status != "active")) {
		httpx.Fail(w, r, httpx.BadRequest("O‘z rolingiz yoki holatingizni o‘zgartira olmaysiz"))
		return
	}
	sets := []string{}
	args := []any{}
	add := func(col string, v any) { args = append(args, v); sets = append(sets, col+"=$"+itoa(len(args))) }
	if in.Name != nil {
		add("name", strings.TrimSpace(*in.Name))
	}
	if in.Email != nil {
		if _, err := mail.ParseAddress(*in.Email); err != nil {
			httpx.Fail(w, r, httpx.Validation(map[string]any{"email": "email noto‘g‘ri"}))
			return
		}
		add("email", strings.ToLower(strings.TrimSpace(*in.Email)))
	}
	if in.Role != nil {
		if !auth.ValidRole(*in.Role) {
			httpx.Fail(w, r, httpx.Validation(map[string]any{"role": "rol noto‘g‘ri"}))
			return
		}
		add("role", *in.Role)
	}
	if in.Status != nil {
		if *in.Status != "active" && *in.Status != "blocked" {
			httpx.Fail(w, r, httpx.Validation(map[string]any{"status": "active yoki blocked"}))
			return
		}
		add("status", *in.Status)
	}
	if in.Password != nil {
		hash, err := auth.HashPassword(*in.Password)
		if err != nil {
			httpx.Fail(w, r, httpx.Validation(map[string]any{"password": err.Error()}))
			return
		}
		add("password_hash", hash)
	}
	if len(sets) == 0 {
		httpx.Fail(w, r, httpx.BadRequest("O‘zgartirish uchun maydon yo‘q"))
		return
	}
	args = append(args, id)
	res, err := s.DB.ExecContext(r.Context(), `UPDATE users SET `+strings.Join(sets, ",")+`, updated_at=now() WHERE id=$`+itoa(len(args)), args...)
	if err != nil {
		httpx.Fail(w, r, dbError(err))
		return
	}
	if n, _ := res.RowsAffected(); n == 0 {
		httpx.Fail(w, r, httpx.ErrNotFound)
		return
	}
	if in.Status != nil && *in.Status == "blocked" || in.Password != nil {
		_, _ = s.DB.ExecContext(r.Context(), `UPDATE refresh_tokens SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL`, id)
	}
	s.audit(r, "update", "user", id, map[string]any{"fields": sets})
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) deleteUser(w http.ResponseWriter, r *http.Request) {
	id, err := idParam(r, "id")
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	if id == claimsFrom(r.Context()).UserID {
		httpx.Fail(w, r, httpx.BadRequest("O‘zingizni o‘chira olmaysiz"))
		return
	}
	var admins int
	_ = s.DB.QueryRowContext(r.Context(), `SELECT count(*) FROM users WHERE role='admin' AND status='active' AND id<>$1`, id).Scan(&admins)
	if admins == 0 {
		httpx.Fail(w, r, httpx.BadRequest("Oxirgi administratorni o‘chirib bo‘lmaydi"))
		return
	}
	if _, err := s.DB.ExecContext(r.Context(), `DELETE FROM users WHERE id=$1`, id); err != nil {
		httpx.Fail(w, r, dbError(err))
		return
	}
	s.audit(r, "delete", "user", id, nil)
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) listRoles(w http.ResponseWriter, r *http.Request) {
	out := []map[string]any{}
	for _, role := range []string{auth.RoleAdmin, auth.RoleEditor, auth.RoleOperator, auth.RoleShop} {
		out = append(out, map[string]any{"role": role, "permissions": auth.PermissionsFor(role)})
	}
	httpx.JSON(w, 200, out)
}

func (s *Server) listAudit(w http.ResponseWriter, r *http.Request) {
	limit, offset := pageParams(r)
	var raw []byte
	err := s.DB.QueryRowContext(r.Context(), `SELECT coalesce(json_agg(a), '[]') FROM (
		SELECT l.id, l.action, l.entity, l.entity_id, l.data, l.created_at, u.name AS user_name
		FROM audit_log l LEFT JOIN users u ON u.id=l.user_id ORDER BY l.id DESC LIMIT $1 OFFSET $2) a`, limit, offset).Scan(&raw)
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	writeRaw(w, 200, raw)
}

func itoa(i int) string { return strconv.Itoa(i) }
