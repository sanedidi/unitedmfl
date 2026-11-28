package api

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/go-chi/chi/v5"

	"github.com/sanedidi/unitedmfl/backend/internal/auth"
	"github.com/sanedidi/unitedmfl/backend/internal/httpx"
)

// Rollar va huquqlar: administrators create roles and tick which admin pages each
// role may open. The administrator role itself is fixed (every page).

func (s *Server) mountRoles(r chi.Router) {
	// the users page needs the role list for its role picker
	r.With(s.canAny(auth.PermRoles, auth.PermUsers)).Get("/roles", s.listRoles)
	r.Group(func(r chi.Router) {
		r.Use(s.can(auth.PermRoles))
		r.Get("/permissions", s.permissionCatalog)
		r.Post("/roles", s.createRole)
		r.Get("/roles/{id}", s.getRole)
		r.Patch("/roles/{id}", s.patchRole)
		r.Delete("/roles/{id}", s.deleteRole)
	})
}

type roleUser struct {
	ID     int64  `json:"id"`
	Name   string `json:"name"`
	Email  string `json:"email"`
	Status string `json:"status"`
}

type roleDTO struct {
	ID          int64      `json:"id"`
	Slug        string     `json:"slug"`
	Name        string     `json:"name"`
	Description string     `json:"description"`
	IsSystem    bool       `json:"is_system"`
	Permissions []string   `json:"permissions"`
	Pages       int        `json:"pages"` // pages the role opens (has view on)
	Users       int        `json:"users"`
	UpdatedAt   time.Time  `json:"updated_at"`
	UserList    []roleUser `json:"user_list,omitempty"`
}

func (s *Server) permissionCatalog(w http.ResponseWriter, r *http.Request) {
	total := 0
	for _, g := range auth.Catalog {
		total += len(g.Pages)
	}
	httpx.JSON(w, 200, map[string]any{"groups": auth.Catalog, "actions": auth.ActionLabels, "total": total})
}

// pageCount counts the pages a role may open (has «view» on).
func pageCount(perms []string) int {
	n := 0
	for _, x := range perms {
		if _, a := auth.SplitKey(x); a == auth.ActView {
			n++
		}
	}
	return n
}

// loadRoles reads roles (one when id > 0) with their permissions and user counts.
func (s *Server) loadRoles(ctx context.Context, id int64) ([]roleDTO, error) {
	rows, err := s.DB.QueryContext(ctx, `SELECT r.id, r.slug, r.name, r.description, r.is_system, r.updated_at,
			coalesce((SELECT array_to_string(array_agg(p.perm), ',') FROM role_permissions p WHERE p.role_id = r.id), ''),
			(SELECT count(*) FROM users u WHERE u.role = r.slug)
		FROM roles r WHERE $1 = 0 OR r.id = $1
		ORDER BY r.is_system DESC, r.id`, id)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []roleDTO{}
	for rows.Next() {
		var d roleDTO
		var perms string
		if err := rows.Scan(&d.ID, &d.Slug, &d.Name, &d.Description, &d.IsSystem, &d.UpdatedAt, &perms, &d.Users); err != nil {
			return nil, err
		}
		if d.IsSystem {
			d.Permissions = auth.AllPermissions()
		} else {
			list := []string{}
			if perms != "" {
				list = strings.Split(perms, ",")
			}
			d.Permissions, _ = auth.NormalizePermissions(list)
			if d.Permissions == nil {
				d.Permissions = []string{}
			}
		}
		d.Pages = pageCount(d.Permissions)
		out = append(out, d)
	}
	return out, rows.Err()
}

func (s *Server) listRoles(w http.ResponseWriter, r *http.Request) {
	list, err := s.loadRoles(r.Context(), 0)
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	httpx.JSON(w, 200, list)
}

func (s *Server) roleByID(ctx context.Context, id int64) (*roleDTO, error) {
	list, err := s.loadRoles(ctx, id)
	if err != nil {
		return nil, err
	}
	if len(list) == 0 {
		return nil, httpx.ErrNotFound
	}
	return &list[0], nil
}

func (s *Server) getRole(w http.ResponseWriter, r *http.Request) {
	id, err := idParam(r, "id")
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	d, err := s.roleByID(r.Context(), id)
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	rows, err := s.DB.QueryContext(r.Context(), `SELECT id, name, email, status FROM users WHERE role = $1 ORDER BY name`, d.Slug)
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	defer rows.Close()
	d.UserList = []roleUser{}
	for rows.Next() {
		var u roleUser
		if err := rows.Scan(&u.ID, &u.Name, &u.Email, &u.Status); err != nil {
			httpx.Fail(w, r, err)
			return
		}
		d.UserList = append(d.UserList, u)
	}
	httpx.JSON(w, 200, d)
}

type roleInput struct {
	Name        *string   `json:"name"`
	Description *string   `json:"description"`
	Permissions *[]string `json:"permissions"`
}

// clean validates the input; create requires a name.
func (in *roleInput) clean(create bool) (perms []string, err error) {
	errs := map[string]any{}
	if in.Name != nil {
		n := strings.Join(strings.Fields(*in.Name), " ")
		in.Name = &n
	}
	if (create && in.Name == nil) || (in.Name != nil && *in.Name == "") {
		errs["name"] = "majburiy"
	} else if in.Name != nil && utf8.RuneCountInString(*in.Name) > 60 {
		errs["name"] = "60 belgidan oshmasin"
	}
	if in.Description != nil {
		d := strings.TrimSpace(*in.Description)
		in.Description = &d
		if utf8.RuneCountInString(d) > 200 {
			errs["description"] = "200 belgidan oshmasin"
		}
	}
	if in.Permissions != nil {
		var unknown []string
		perms, unknown = auth.NormalizePermissions(*in.Permissions)
		if len(unknown) > 0 {
			errs["permissions"] = "noma’lum huquq: " + strings.Join(unknown, ", ")
		} else if len(perms) == 0 {
			errs["permissions"] = "kamida bitta sahifani belgilang"
		}
	} else if create {
		errs["permissions"] = "kamida bitta sahifani belgilang"
	}
	if len(errs) > 0 {
		return nil, httpx.Validation(errs)
	}
	return perms, nil
}

func setRolePermissions(ctx context.Context, tx *sql.Tx, id int64, perms []string) error {
	if _, err := tx.ExecContext(ctx, `DELETE FROM role_permissions WHERE role_id = $1`, id); err != nil {
		return err
	}
	for _, p := range perms {
		if _, err := tx.ExecContext(ctx, `INSERT INTO role_permissions (role_id, perm) VALUES ($1, $2)`, id, p); err != nil {
			return err
		}
	}
	return nil
}

func (s *Server) createRole(w http.ResponseWriter, r *http.Request) {
	var in roleInput
	if err := httpx.Decode(r, &in); err != nil {
		httpx.Fail(w, r, err)
		return
	}
	perms, err := in.clean(true)
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	desc := ""
	if in.Description != nil {
		desc = *in.Description
	}
	tx, err := s.DB.BeginTx(r.Context(), nil)
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	defer tx.Rollback()
	var id int64
	if err := tx.QueryRowContext(r.Context(), `INSERT INTO roles (name, description) VALUES ($1, $2) RETURNING id`, *in.Name, desc).Scan(&id); err != nil {
		httpx.Fail(w, r, dbError(err))
		return
	}
	if err := setRolePermissions(r.Context(), tx, id, perms); err != nil {
		httpx.Fail(w, r, err)
		return
	}
	if err := tx.Commit(); err != nil {
		httpx.Fail(w, r, err)
		return
	}
	s.Roles.Invalidate()
	s.audit(r, "create", "role", id, map[string]any{"name": *in.Name, "permissions": perms})
	d, err := s.roleByID(r.Context(), id)
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusCreated, d)
}

func (s *Server) patchRole(w http.ResponseWriter, r *http.Request) {
	id, err := idParam(r, "id")
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	var in roleInput
	if err := httpx.Decode(r, &in); err != nil {
		httpx.Fail(w, r, err)
		return
	}
	perms, err := in.clean(false)
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	cur, err := s.roleByID(r.Context(), id)
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	if cur.IsSystem {
		httpx.Fail(w, r, httpx.BadRequest("Administrator rolini o‘zgartirib bo‘lmaydi"))
		return
	}
	if me := claimsFrom(r.Context()); in.Permissions != nil && me != nil && me.Role == cur.Slug && !contains(perms, edit(auth.PermRoles)) {
		httpx.Fail(w, r, httpx.BadRequest("O‘z rolingizdan «Rollar va huquqlar» sahifasini tahrirlash huquqini olib bo‘lmaydi"))
		return
	}
	tx, err := s.DB.BeginTx(r.Context(), nil)
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	defer tx.Rollback()
	if _, err := tx.ExecContext(r.Context(), `UPDATE roles SET name = coalesce($2, name), description = coalesce($3, description), updated_at = now() WHERE id = $1`,
		id, in.Name, in.Description); err != nil {
		httpx.Fail(w, r, dbError(err))
		return
	}
	if in.Permissions != nil {
		if err := setRolePermissions(r.Context(), tx, id, perms); err != nil {
			httpx.Fail(w, r, err)
			return
		}
	}
	if err := tx.Commit(); err != nil {
		httpx.Fail(w, r, err)
		return
	}
	s.Roles.Invalidate()
	data := map[string]any{"name": cur.Name}
	if in.Name != nil && *in.Name != cur.Name {
		data["new_name"] = *in.Name
	}
	if in.Permissions != nil {
		data["permissions"] = perms
	}
	s.audit(r, "update", "role", id, data)
	d, err := s.roleByID(r.Context(), id)
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	httpx.JSON(w, 200, d)
}

// deleteRole removes a role; its users move to the role given as ?move_to=<id>.
func (s *Server) deleteRole(w http.ResponseWriter, r *http.Request) {
	id, err := idParam(r, "id")
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	cur, err := s.roleByID(r.Context(), id)
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	if cur.IsSystem {
		httpx.Fail(w, r, httpx.BadRequest("Administrator rolini o‘chirib bo‘lmaydi"))
		return
	}
	if me := claimsFrom(r.Context()); me != nil && me.Role == cur.Slug {
		httpx.Fail(w, r, httpx.BadRequest("O‘z rolingizni o‘chira olmaysiz"))
		return
	}
	var target *roleDTO
	if cur.Users > 0 {
		mv, _ := strconv.ParseInt(r.URL.Query().Get("move_to"), 10, 64)
		if mv <= 0 {
			httpx.Fail(w, r, httpx.NewError(http.StatusConflict, "role_in_use",
				fmt.Sprintf("Bu rolda %d ta foydalanuvchi bor — avval ularni boshqa rolga o‘tkazing", cur.Users)))
			return
		}
		if mv == id {
			httpx.Fail(w, r, httpx.Validation(map[string]any{"move_to": "boshqa rolni tanlang"}))
			return
		}
		if target, err = s.roleByID(r.Context(), mv); err != nil {
			if errors.Is(err, httpx.ErrNotFound) {
				err = httpx.Validation(map[string]any{"move_to": "rol topilmadi"})
			}
			httpx.Fail(w, r, err)
			return
		}
	}
	tx, err := s.DB.BeginTx(r.Context(), nil)
	if err != nil {
		httpx.Fail(w, r, err)
		return
	}
	defer tx.Rollback()
	moved := int64(0)
	if target != nil {
		res, err := tx.ExecContext(r.Context(), `UPDATE users SET role = $2, updated_at = now() WHERE role = $1`, cur.Slug, target.Slug)
		if err != nil {
			httpx.Fail(w, r, err)
			return
		}
		moved, _ = res.RowsAffected()
	}
	if _, err := tx.ExecContext(r.Context(), `DELETE FROM roles WHERE id = $1`, id); err != nil {
		httpx.Fail(w, r, dbError(err))
		return
	}
	if err := tx.Commit(); err != nil {
		httpx.Fail(w, r, err)
		return
	}
	s.Roles.Invalidate()
	data := map[string]any{"name": cur.Name, "moved_users": moved}
	if target != nil {
		data["move_to"] = target.Name
	}
	s.audit(r, "delete", "role", id, data)
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) roleExists(ctx context.Context, slug string) bool {
	var ok bool
	_ = s.DB.QueryRowContext(ctx, `SELECT EXISTS (SELECT 1 FROM roles WHERE slug = $1)`, slug).Scan(&ok)
	return ok
}
