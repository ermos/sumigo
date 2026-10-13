package main

import (
	"context"
	"errors"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/ermos/sumigo/internal/api"
	"github.com/ermos/sumigo/internal/github"
	"github.com/ermos/sumigo/internal/store"
	"github.com/ermos/sumigo/web"
)

func env(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func main() {
	secret := os.Getenv("SECRET_KEY")
	if len(secret) < 16 {
		log.Fatal("SECRET_KEY must be set (16+ chars); it encrypts GitHub tokens at rest")
	}
	st, err := store.Open(env("DATABASE_PATH", "articlecms.db"), secret)
	if err != nil {
		log.Fatal(err)
	}
	defer func() { _ = st.Close() }()

	if err := bootstrapAdmin(st); err != nil {
		log.Fatal(err)
	}

	a := &api.API{Store: st, NewGitHub: github.New, SecureCookie: os.Getenv("SECURE_COOKIE") == "true"}
	mux := http.NewServeMux()
	mux.Handle("/api/", a.Handler())
	mux.HandleFunc("GET /ping", func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write([]byte("pong")) })
	mux.Handle("/", web.Handler())

	srv := &http.Server{Addr: ":" + env("PORT", "8080"), Handler: mux, ReadHeaderTimeout: 10 * time.Second}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	go func() {
		log.Printf("listening on %s", srv.Addr)
		if err := srv.ListenAndServe(); !errors.Is(err, http.ErrServerClosed) {
			log.Fatal(err)
		}
	}()
	<-ctx.Done()
	shutdown, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	_ = srv.Shutdown(shutdown)
}

// bootstrapAdmin creates the first admin from ADMIN_EMAIL / ADMIN_PASSWORD when no user exists.
func bootstrapAdmin(st *store.Store) error {
	n, err := st.CountUsers()
	if err != nil || n > 0 {
		return err
	}
	email, password := os.Getenv("ADMIN_EMAIL"), os.Getenv("ADMIN_PASSWORD")
	if email == "" || len(password) < 8 {
		return errors.New("no user yet: set ADMIN_EMAIL and ADMIN_PASSWORD (8+ chars) to create the first admin")
	}
	log.Printf("creating admin %s", email)
	return st.CreateUser(&store.User{Email: email, Name: env("ADMIN_NAME", "Admin"), IsAdmin: true}, password)
}
