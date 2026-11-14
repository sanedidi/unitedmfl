// Command ai runs the AI service: OpenAI / Gemini connections, image-generation
// settings, prompt improvement and image generation. Internal network only.
package main

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/sanedidi/unitedmfl/backend/internal/aisvc"
	"github.com/sanedidi/unitedmfl/backend/internal/db"
)

func env(k, def string) string {
	if v := strings.TrimSpace(os.Getenv(k)); v != "" {
		return v
	}
	return def
}

func main() {
	slog.SetDefault(slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo})))
	if err := run(); err != nil {
		slog.Error("fatal", "err", err)
		os.Exit(1)
	}
}

func run() error {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	conn, err := db.Open(ctx, env("DATABASE_URL", "postgres://unitedmfl:unitedmfl@localhost:5432/unitedmfl?sslmode=disable"))
	if err != nil {
		return err
	}
	defer conn.Close()
	if err := aisvc.Migrate(ctx, conn); err != nil {
		return err
	}
	token := env("AI_INTERNAL_TOKEN", "")
	if len(token) < 16 {
		return errors.New("AI_INTERNAL_TOKEN must be at least 16 characters")
	}
	svc, err := aisvc.New(aisvc.Options{
		DB: conn, MasterKey: env("AI_MASTER_KEY", ""), Token: token,
		OpenAIURL: env("OPENAI_API_URL", ""), GeminiURL: env("GEMINI_API_URL", ""),
		CWebP: env("CWEBP", "cwebp"),
	})
	if err != nil {
		return err
	}
	addr := env("AI_ADDR", ":8090")
	srv := &http.Server{Addr: addr, Handler: svc.Routes(), ReadHeaderTimeout: 10 * time.Second, IdleTimeout: 120 * time.Second}
	errCh := make(chan error, 1)
	go func() {
		slog.Info("ai service listening", "addr", addr)
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			errCh <- err
		}
	}()
	select {
	case err := <-errCh:
		return err
	case <-ctx.Done():
	}
	sctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	return srv.Shutdown(sctx)
}
