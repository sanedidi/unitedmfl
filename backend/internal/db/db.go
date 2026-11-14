// Package db opens the PostgreSQL connection and applies embedded migrations.
package db

import (
	"context"
	"database/sql"
	"embed"
	"fmt"
	"io/fs"
	"log/slog"
	"sort"
	"strings"
	"time"

	_ "github.com/lib/pq" // postgres driver
)

//go:embed migrations/*.sql
var migrationsFS embed.FS

// Open connects to Postgres and verifies the connection.
func Open(ctx context.Context, dsn string) (*sql.DB, error) {
	conn, err := sql.Open("postgres", dsn)
	if err != nil {
		return nil, err
	}
	conn.SetMaxOpenConns(20)
	conn.SetMaxIdleConns(10)
	conn.SetConnMaxLifetime(30 * time.Minute)

	var lastErr error
	for i := 0; i < 30; i++ { // wait for the database container to come up
		pingCtx, cancel := context.WithTimeout(ctx, 2*time.Second)
		lastErr = conn.PingContext(pingCtx)
		cancel()
		if lastErr == nil {
			return conn, nil
		}
		time.Sleep(time.Second)
	}
	return nil, fmt.Errorf("db ping: %w", lastErr)
}

// Migrate applies every embedded migration that has not been applied yet.
func Migrate(ctx context.Context, conn *sql.DB) error {
	return MigrateFS(ctx, conn, migrationsFS, "migrations", "schema_migrations")
}

// MigrateFS applies the *.sql files in dir of fsys in name order, recording
// each applied version in table. Separate services keep separate tables.
func MigrateFS(ctx context.Context, conn *sql.DB, fsys fs.FS, dir, table string) error {
	if _, err := conn.ExecContext(ctx, `CREATE TABLE IF NOT EXISTS `+table+` (
		version TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`); err != nil {
		return err
	}
	files, err := fs.Glob(fsys, dir+"/*.sql")
	if err != nil {
		return err
	}
	sort.Strings(files)
	for _, f := range files {
		version := strings.TrimSuffix(strings.TrimPrefix(f, dir+"/"), ".sql")
		var exists bool
		if err := conn.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM `+table+` WHERE version=$1)`, version).Scan(&exists); err != nil {
			return err
		}
		if exists {
			continue
		}
		body, err := fs.ReadFile(fsys, f)
		if err != nil {
			return err
		}
		tx, err := conn.BeginTx(ctx, nil)
		if err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, string(body)); err != nil {
			_ = tx.Rollback()
			return fmt.Errorf("migration %s: %w", version, err)
		}
		if _, err := tx.ExecContext(ctx, `INSERT INTO `+table+`(version) VALUES ($1)`, version); err != nil {
			_ = tx.Rollback()
			return err
		}
		if err := tx.Commit(); err != nil {
			return err
		}
		slog.Info("migration applied", "version", version, "table", table)
	}
	return nil
}
