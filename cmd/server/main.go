package main

import (
	"context"
	"log"
	"net/http"
	"os"
	"strconv"

	"wager-exchange/internal/api"
	"wager-exchange/internal/db"
	"wager-exchange/internal/engine"
	"wager-exchange/internal/ws"
)

func main() {
	// Load env (dotenv-style: only if not already set)
	loadEnvFile(".env")

	dsn := envOrDefault("DATABASE_URL", "postgres://postgres:postgres@localhost:5433/wager_exchange?sslmode=disable")
	jwtSecret := envOrDefault("JWT_SECRET", "dev-secret-at-least-32-characters!!")
	port := envOrDefault("PORT", "4000")
	feeBps, _ := strconv.Atoi(envOrDefault("TAKER_FEE_BPS", "100"))

	// DB
	store, err := db.Open(dsn)
	if err != nil {
		log.Fatalf("db open: %v", err)
	}
	log.Println("[main] connected to database")

	// Migrations
	if err := store.Migrate("migrations"); err != nil {
		log.Fatalf("migrate: %v", err)
	}
	log.Println("[main] migrations applied")

	// Seed platform_fee_wallet row
	store.DB.Exec(`INSERT INTO platform_fee_wallet (id, balance_cents) VALUES (1, 0) ON CONFLICT DO NOTHING`)

	// WS Hub
	hub := ws.NewHub()

	// Engine manager
	mgr := engine.NewManager(store, hub.Publish, feeBps)
	if err := mgr.Boot(context.Background()); err != nil {
		log.Fatalf("engine boot: %v", err)
	}

	// HTTP
	srv := api.NewServer(store, mgr, hub, jwtSecret, feeBps)
	router := srv.Router()

	log.Printf("[main] listening on :%s", port)
	if err := http.ListenAndServe(":"+port, router); err != nil {
		log.Fatalf("server: %v", err)
	}
}

func envOrDefault(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func loadEnvFile(path string) {
	data, err := os.ReadFile(path)
	if err != nil {
		return
	}
	for _, line := range splitLines(string(data)) {
		line = trimSpace(line)
		if line == "" || line[0] == '#' {
			continue
		}
		parts := splitFirst(line, '=')
		if len(parts) != 2 {
			continue
		}
		key := trimSpace(parts[0])
		val := trimSpace(parts[1])
		if os.Getenv(key) == "" {
			os.Setenv(key, val)
		}
	}
}

func splitLines(s string) []string {
	var lines []string
	start := 0
	for i := 0; i < len(s); i++ {
		if s[i] == '\n' {
			line := s[start:i]
			if len(line) > 0 && line[len(line)-1] == '\r' {
				line = line[:len(line)-1]
			}
			lines = append(lines, line)
			start = i + 1
		}
	}
	if start < len(s) {
		lines = append(lines, s[start:])
	}
	return lines
}

func trimSpace(s string) string {
	i := 0
	for i < len(s) && (s[i] == ' ' || s[i] == '\t') {
		i++
	}
	j := len(s)
	for j > i && (s[j-1] == ' ' || s[j-1] == '\t') {
		j--
	}
	return s[i:j]
}

func splitFirst(s string, sep byte) []string {
	for i := 0; i < len(s); i++ {
		if s[i] == sep {
			return []string{s[:i], s[i+1:]}
		}
	}
	return []string{s}
}
