package aisvc

import (
	"crypto/subtle"
	"encoding/json"
	"net/http"

	"github.com/go-chi/chi/v5"

	"github.com/sanedidi/unitedmfl/backend/internal/httpx"
)

// Routes exposes the service over HTTP (internal network only).
func (s *Service) Routes() http.Handler {
	r := chi.NewRouter()
	r.Use(httpx.Recover, httpx.Logger)
	r.Get("/healthz", func(w http.ResponseWriter, _ *http.Request) {
		httpx.JSON(w, http.StatusOK, map[string]string{"status": "ok"})
	})
	r.Route("/v1", func(r chi.Router) {
		r.Use(s.internalOnly)
		r.Get("/providers", func(w http.ResponseWriter, r *http.Request) {
			list, err := s.Providers(r.Context())
			reply(w, r, map[string]any{"providers": list}, err)
		})
		r.Put("/providers/{p}", func(w http.ResponseWriter, r *http.Request) {
			var in ProviderInput
			if err := httpx.Decode(r, &in); err != nil {
				httpx.Fail(w, r, err)
				return
			}
			v, err := s.SaveProvider(r.Context(), chi.URLParam(r, "p"), in)
			reply(w, r, v, err)
		})
		r.Post("/providers/{p}/test", func(w http.ResponseWriter, r *http.Request) {
			v, err := s.TestProvider(r.Context(), chi.URLParam(r, "p"))
			reply(w, r, v, err)
		})
		r.Delete("/providers/{p}", func(w http.ResponseWriter, r *http.Request) {
			if err := s.DeleteProvider(r.Context(), chi.URLParam(r, "p")); err != nil {
				httpx.Fail(w, r, err)
				return
			}
			w.WriteHeader(http.StatusNoContent)
		})
		r.Get("/settings", func(w http.ResponseWriter, r *http.Request) {
			st, err := s.Settings(r.Context())
			reply(w, r, st, err)
		})
		r.Put("/settings", func(w http.ResponseWriter, r *http.Request) {
			var st Settings
			if err := httpx.Decode(r, &st); err != nil {
				httpx.Fail(w, r, err)
				return
			}
			out, err := s.SaveSettings(r.Context(), st)
			reply(w, r, out, err)
		})
		r.Post("/improve", func(w http.ResponseWriter, r *http.Request) {
			var in ImproveInput
			if err := httpx.Decode(r, &in); err != nil {
				httpx.Fail(w, r, err)
				return
			}
			out, err := s.Improve(r.Context(), in)
			reply(w, r, out, err)
		})
		r.Post("/images", func(w http.ResponseWriter, r *http.Request) {
			// assets travel inline (base64), so this body is larger than httpx.Decode allows
			var in ImagesInput
			if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 120<<20)).Decode(&in); err != nil {
				httpx.Fail(w, r, httpx.BadRequest("JSON noto‘g‘ri: "+err.Error()))
				return
			}
			out, err := s.Images(r.Context(), in)
			reply(w, r, out, err)
		})
		r.Post("/kit/describe", func(w http.ResponseWriter, r *http.Request) {
			var in DescribeInput
			if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 60<<20)).Decode(&in); err != nil {
				httpx.Fail(w, r, httpx.BadRequest("JSON noto‘g‘ri: "+err.Error()))
				return
			}
			out, err := s.Describe(r.Context(), in)
			reply(w, r, out, err)
		})
		r.Post("/kit/dress", func(w http.ResponseWriter, r *http.Request) {
			var in DressInput
			if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 120<<20)).Decode(&in); err != nil {
				httpx.Fail(w, r, httpx.BadRequest("JSON noto‘g‘ri: "+err.Error()))
				return
			}
			out, err := s.Dress(r.Context(), in)
			reply(w, r, out, err)
		})
	})
	return r
}

func reply(w http.ResponseWriter, r *http.Request, v any, err error) {
	if err != nil {
		httpx.Fail(w, r, asHTTP(err))
		return
	}
	httpx.JSON(w, http.StatusOK, v)
}

func (s *Service) internalOnly(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got := r.Header.Get("X-Internal-Token")
		if s.token == "" || subtle.ConstantTimeCompare([]byte(got), []byte(s.token)) != 1 {
			httpx.Fail(w, r, httpx.NewError(http.StatusUnauthorized, "unauthorized", "internal token required"))
			return
		}
		next.ServeHTTP(w, r)
	})
}
