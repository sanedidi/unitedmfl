// Package api wires HTTP handlers for the public site and the admin panel.
package api

import (
	"database/sql"
	"net/http"
	"os"
	"path/filepath"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/sanedidi/unitedmfl/backend/internal/auth"
	"github.com/sanedidi/unitedmfl/backend/internal/config"
	"github.com/sanedidi/unitedmfl/backend/internal/httpx"
	"github.com/sanedidi/unitedmfl/backend/internal/live"
)

// Server holds dependencies.
type Server struct {
	DB     *sql.DB
	Cfg    *config.Config
	Tokens *auth.Issuer
	Hub    *live.Hub

	web            *webNotifier
	loginLimiter   *httpx.RateLimiter
	contactLimiter *httpx.RateLimiter
	viewLimiter    *httpx.RateLimiter
}

func New(db *sql.DB, cfg *config.Config) *Server {
	return &Server{
		DB: db, Cfg: cfg,
		Tokens:         auth.NewIssuer(cfg.JWTSecret, cfg.AccessTTL),
		Hub:            live.NewHub(),
		web:            newWebNotifier(cfg.WebRevalidateURL, cfg.RevalidateSecret),
		loginLimiter:   httpx.NewRateLimiter(10, 10*time.Minute),
		contactLimiter: httpx.NewRateLimiter(5, 10*time.Minute),
		viewLimiter:    httpx.NewRateLimiter(1, 30*time.Minute), // one view per IP per article per 30 min
	}
}

func (s *Server) imagesDir() string    { return filepath.Join(s.Cfg.UploadDir, "images") }
func (s *Server) protocolsDir() string { return filepath.Join(s.Cfg.UploadDir, "protocols") }

// Routes builds the router.
func (s *Server) Routes() http.Handler {
	_ = os.MkdirAll(s.imagesDir(), 0o755)
	_ = os.MkdirAll(s.protocolsDir(), 0o750)

	r := chi.NewRouter()
	r.Use(httpx.Recover, httpx.Logger, httpx.SecurityHeaders, httpx.CORS(s.Cfg.CORSOrigins))

	r.Get("/healthz", s.health)
	r.Handle("/uploads/images/*", http.StripPrefix("/uploads/images/", noDirListing(http.FileServer(http.Dir(s.imagesDir())))))

	r.Route("/api/v1", func(r chi.Router) {
		// ---------- public site ----------
		r.Get("/seasons", s.listSeasons)
		r.Get("/teams", s.publicTeams)
		r.Get("/teams/{slug}", s.publicTeam)
		r.Get("/players", s.publicPlayers)
		r.Get("/players/{id}", s.publicPlayer)
		r.Get("/matches", s.publicMatches)
		r.Get("/matches/{id}", s.publicMatch)
		r.Get("/matches/{id}/protocol.pdf", s.publicProtocolPDF)
		r.Get("/standings", s.publicStandings)
		r.Get("/stats/leaders", s.publicLeaders)
		r.Get("/news", s.publicNews)
		r.Get("/news/{slug}", s.publicNewsItem)
		r.Post("/news/{slug}/view", s.newsView)
		r.Get("/banners", s.publicBanners)
		r.Get("/videos", s.publicVideos)
		r.Get("/products", s.publicProducts)
		r.Get("/products/{slug}", s.publicProduct)
		r.Get("/sitemap", s.publicSitemap)
		r.With(s.contactLimiter.Middleware).Post("/contact", s.createContact)
		r.Get("/live/{id}", s.liveStream)

		// ---------- auth ----------
		r.With(s.loginLimiter.Middleware).Post("/auth/login", s.login)
		r.Post("/auth/refresh", s.refresh)
		r.Post("/auth/logout", s.logout)

		// ---------- admin ----------
		r.Route("/admin", func(r chi.Router) {
			r.Use(s.requireAuth)
			r.Get("/me", s.me)
			r.With(s.can(auth.PermDashboard)).Get("/dashboard", s.dashboard)
			r.With(s.can(auth.PermUploads)).Post("/uploads", s.uploadImage)

			r.Group(func(r chi.Router) {
				r.Use(s.can(auth.PermMatchesRead))
				r.Get("/matches", s.adminMatches)
				r.Get("/matches/{id}", s.adminMatch)
			})
			r.Group(func(r chi.Router) {
				r.Use(s.can(auth.PermMatchesEdit))
				r.Post("/matches", s.crud(matchesRes).create)
				r.Patch("/matches/{id}", s.patchMatch)
				r.Delete("/matches/{id}", s.crud(matchesRes).delete)
				r.Put("/matches/{id}/lineups", s.putLineups)
			})
			r.Group(func(r chi.Router) {
				r.Use(s.can(auth.PermLive))
				r.Post("/matches/{id}/period", s.setPeriod)
				r.Post("/matches/{id}/events", s.addEvent)
				r.Patch("/matches/{id}/events/{eventID}", s.patchEvent)
				r.Delete("/matches/{id}/events/{eventID}", s.deleteEvent)
			})
			r.Group(func(r chi.Router) {
				r.Use(s.can(auth.PermProtocols))
				r.Get("/protocols", s.listProtocols)
				r.Post("/protocols", s.uploadProtocol)
				r.Get("/protocols/{id}", s.getProtocol)
				r.Get("/protocols/{id}/file", s.protocolFile)
				r.Put("/protocols/{id}/extracted", s.updateProtocolExtracted)
				r.Post("/protocols/{id}/rederive", s.rederiveProtocol)
				r.Post("/protocols/{id}/reprocess", s.reprocessProtocol)
				r.Post("/protocols/{id}/apply", s.applyProtocol)
				r.Post("/protocols/{id}/reject", s.rejectProtocol)
			})
			s.mountCRUD(r, auth.PermTeams, "/teams", teamsRes)
			s.mountCRUD(r, auth.PermTeams, "/players", playersRes)
			s.mountCRUD(r, auth.PermSeasons, "/seasons", seasonsRes)
			s.mountCRUD(r, auth.PermSeasons, "/stages", stagesRes)
			s.mountCRUD(r, auth.PermStandings, "/standing-adjustments", adjustmentsRes)
			r.With(s.can(auth.PermStandings)).Get("/standings", s.publicStandings)
			s.mountCRUD(r, auth.PermNews, "/news", newsRes)
			s.mountCRUD(r, auth.PermBanners, "/banners", bannersRes)
			r.With(s.can(auth.PermBanners)).Put("/banners/order", s.reorderBanners)
			s.mountCRUD(r, auth.PermVideos, "/videos", videosRes)
			s.mountCRUD(r, auth.PermMerch, "/products", productsRes)
			s.mountCRUD(r, auth.PermMerch, "/product-variants", variantsRes)
			r.Group(func(r chi.Router) {
				r.Use(s.can(auth.PermRequests))
				r.Get("/requests", s.crud(requestsRes).list)
				r.Get("/requests/{id}", s.crud(requestsRes).get)
				r.Patch("/requests/{id}", s.crud(requestsRes).patch)
				r.Delete("/requests/{id}", s.crud(requestsRes).delete)
			})
			r.Group(func(r chi.Router) {
				r.Use(s.can(auth.PermUsers))
				r.Get("/users", s.listUsers)
				r.Post("/users", s.createUser)
				r.Patch("/users/{id}", s.patchUser)
				r.Delete("/users/{id}", s.deleteUser)
				r.Get("/roles", s.listRoles)
				r.Get("/audit", s.listAudit)
			})
		})
	})
	return r
}

func (s *Server) health(w http.ResponseWriter, r *http.Request) {
	if err := s.DB.PingContext(r.Context()); err != nil {
		httpx.JSON(w, http.StatusServiceUnavailable, map[string]string{"status": "db_down"})
		return
	}
	httpx.JSON(w, 200, map[string]string{"status": "ok"})
}

func noDirListing(h http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "" || r.URL.Path[len(r.URL.Path)-1] == '/' {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
		h.ServeHTTP(w, r)
	})
}
