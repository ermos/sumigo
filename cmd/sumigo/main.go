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

	"github.com/ermos/sumigo/internal/ai"
	"github.com/ermos/sumigo/internal/api"
	"github.com/ermos/sumigo/internal/forge"
	"github.com/ermos/sumigo/internal/store"
	"github.com/ermos/sumigo/web"
)

// version is the release tag, set at build time with -ldflags "-X main.version=v1.2.3".
var version = "dev"

func env(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func main() {
	secret := os.Getenv("SECRET_KEY")
	if len(secret) < 16 {
		log.Fatal("SECRET_KEY must be set (16+ chars); it encrypts the access tokens of sites at rest")
	}
	st, err := store.Open(env("DATABASE_PATH", "sumigo.db"), secret)
	if err != nil {
		log.Fatal(err)
	}
	defer func() { _ = st.Close() }()

	a := &api.API{Store: st, NewForge: forge.New, NewAI: ai.New, SecureCookie: os.Getenv("SECURE_COOKIE") != "false"}
	if err := a.PrepareSetup(); err != nil {
		log.Fatal(err)
	}
	mux := http.NewServeMux()
	mux.Handle("/api/", a.Handler())
	mux.HandleFunc("GET /ping", func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write([]byte("pong")) })
	mux.Handle("/", web.Handler())

	// ReadTimeout bounds slow uploads (10MB of media). No WriteTimeout: an AI answer takes up to 3 minutes.
	srv := &http.Server{
		Addr: ":" + env("PORT", "8080"), Handler: mux,
		ReadHeaderTimeout: 10 * time.Second, ReadTimeout: time.Minute, IdleTimeout: 2 * time.Minute,
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	go a.RunScheduler(ctx, time.Minute)
	go func() {
		log.Printf("sumigo %s listening on %s", version, srv.Addr)
		if err := srv.ListenAndServe(); !errors.Is(err, http.ErrServerClosed) {
			log.Fatal(err)
		}
	}()
	<-ctx.Done()
	shutdown, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	_ = srv.Shutdown(shutdown)
}
