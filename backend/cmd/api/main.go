// Command api runs the United MFL backend.
package main

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/sanedidi/unitedmfl/backend/internal/api"
	"github.com/sanedidi/unitedmfl/backend/internal/config"
	"github.com/sanedidi/unitedmfl/backend/internal/db"
	"github.com/sanedidi/unitedmfl/backend/internal/tgbot"
)

func main() {
	slog.SetDefault(slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo})))
	if err := run(); err != nil {
		slog.Error("fatal", "err", err)
		os.Exit(1)
	}
}

func run() error {
	cfg, err := config.Load()
	if err != nil {
		return err
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	conn, err := db.Open(ctx, cfg.DatabaseURL)
	if err != nil {
		return err
	}
	defer conn.Close()
	if err := db.Migrate(ctx, conn); err != nil {
		return err
	}
	if err := api.EnsureAdmin(ctx, conn, cfg.AdminName, cfg.AdminEmail, cfg.AdminPassword); err != nil {
		return err
	}

	server := api.New(conn, cfg)
	server.ResetStaleAIJobs(ctx)
	// dresses players in their team kit (AI service), two at a time
	server.StartKitWorker(ctx)
	// copy hero images from the old site into /uploads (no-op once done)
	go server.MirrorRemoteImages(ctx)
	// Instagram feed for /media (no-op until a token is connected in the admin)
	go server.RunInstagramSync(ctx)

	handler := server.Routes()
	// Telegram Live-pult: runs inside the API and calls the same handlers in-process
	if cfg.TelegramToken != "" {
		bot := tgbot.New(tgbot.Options{Token: cfg.TelegramToken, APIURL: cfg.TelegramAPIURL, DB: conn, Tokens: server.Tokens, API: handler})
		go bot.Run(ctx)
	} else {
		slog.Info("telegram bot disabled: TELEGRAM_BOT_TOKEN is empty")
	}

	srv := &http.Server{
		Addr:              cfg.Addr,
		Handler:           handler,
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       60 * time.Second,
		IdleTimeout:       120 * time.Second,
		// no WriteTimeout: Server-Sent Events keep connections open
	}
	errCh := make(chan error, 1)
	go func() {
		slog.Info("listening", "addr", cfg.Addr, "env", cfg.Env)
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			errCh <- err
		}
	}()
	select {
	case err := <-errCh:
		return err
	case <-ctx.Done():
	}
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	slog.Info("shutting down")
	return srv.Shutdown(shutdownCtx)
}
