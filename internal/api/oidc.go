package api

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"log"
	"net/http"
	"net/url"
	"slices"
	"strings"
	"time"

	"github.com/coreos/go-oidc/v3/oidc"
	"golang.org/x/oauth2"

	"github.com/ermos/sumigo/internal/store"
)

// Login with an OpenID Connect provider. The callback is served on the domain the login started from,
// so each custom domain must be registered as a redirect URI at the provider.

const oidcCookie = "sumigo_oidc"

func (a *API) getOIDC(w http.ResponseWriter, _ *http.Request) {
	o, err := a.Store.OIDC()
	if err != nil {
		fail(w, err)
		return
	}
	o.ClientSecret = ""
	writeJSON(w, o)
}

func (a *API) saveOIDC(w http.ResponseWriter, r *http.Request) {
	var in store.OIDCSettings
	if !readJSON(w, r, &in) {
		return
	}
	cur, err := a.Store.OIDC()
	if err != nil {
		fail(w, err)
		return
	}
	if in.ClientSecret == "" {
		in.ClientSecret = cur.ClientSecret
	}
	in.Issuer = strings.TrimRight(strings.TrimSpace(in.Issuer), "/")
	if in.Enabled {
		if u, err := url.Parse(in.Issuer); err != nil || u.Scheme == "" || u.Host == "" || in.ClientID == "" {
			httpError(w, http.StatusBadRequest, "oidc_incomplete", "issuer URL and client ID are required")
			return
		}
		// Discovery now, so a typo shows in the admin instead of on the login page.
		if _, err := a.oidcProvider(r.Context(), in.Issuer); err != nil {
			httpError(w, http.StatusBadGateway, "oidc_discovery", err.Error(), params{"detail": err.Error()})
			return
		}
	}
	if err := a.Store.SaveOIDC(in); err != nil {
		fail(w, err)
		return
	}
	a.getOIDC(w, r)
}

// authConfig tells the login page whether to show the single sign-on button.
func (a *API) authConfig(w http.ResponseWriter, _ *http.Request) {
	o, err := a.Store.OIDC()
	if err != nil {
		fail(w, err)
		return
	}
	writeJSON(w, map[string]any{"oidc": o.Enabled, "label": o.Label})
}

// oidcProvider runs the discovery of an issuer once, then serves it from memory.
func (a *API) oidcProvider(ctx context.Context, issuer string) (*oidc.Provider, error) {
	if p, ok := a.providers.Load(issuer); ok {
		return p.(*oidc.Provider), nil
	}
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	p, err := oidc.NewProvider(ctx, issuer)
	if err != nil {
		return nil, err
	}
	a.providers.Store(issuer, p)
	return p, nil
}

func (a *API) oidcConfig(r *http.Request) (*oidc.Provider, *oauth2.Config, store.OIDCSettings, error) {
	o, err := a.Store.OIDC()
	if err != nil || !o.Enabled {
		return nil, nil, o, errors.Join(err, errors.New("single sign-on is off"))
	}
	p, err := a.oidcProvider(r.Context(), o.Issuer)
	if err != nil {
		return nil, nil, o, err
	}
	scopes := []string{oidc.ScopeOpenID, "profile", "email"}
	if o.AdminGroup != "" {
		scopes = append(scopes, "groups")
	}
	return p, &oauth2.Config{
		ClientID: o.ClientID, ClientSecret: o.ClientSecret, Endpoint: p.Endpoint(), Scopes: scopes,
		RedirectURL: a.origin(r) + "/api/auth/oidc/callback",
	}, o, nil
}

// origin is the URL the browser reached the instance on: https behind a TLS reverse proxy.
func (a *API) origin(r *http.Request) string {
	scheme := "http"
	if a.SecureCookie || r.TLS != nil || r.Header.Get("X-Forwarded-Proto") == "https" {
		scheme = "https"
	}
	return scheme + "://" + r.Host
}

func randomString() string {
	b := make([]byte, 24)
	_, _ = rand.Read(b)
	return base64.RawURLEncoding.EncodeToString(b)
}

// oidcLogin sends the browser to the provider. state, nonce and the PKCE verifier wait in a short-lived cookie.
func (a *API) oidcLogin(w http.ResponseWriter, r *http.Request) {
	_, cfg, _, err := a.oidcConfig(r)
	if err != nil {
		log.Printf("oidc login: %v", err)
		loginError(w, r, "oidc_unavailable")
		return
	}
	state, nonce, verifier := randomString(), randomString(), oauth2.GenerateVerifier()
	// Lax, not Strict: the provider sends the browser back with a cross-site redirect.
	http.SetCookie(w, &http.Cookie{
		Name: oidcCookie, Value: state + "." + nonce + "." + verifier, Path: "/api/auth/oidc", MaxAge: 600,
		HttpOnly: true, Secure: a.SecureCookie, SameSite: http.SameSiteLaxMode,
	})
	http.Redirect(w, r, cfg.AuthCodeURL(state, oidc.Nonce(nonce), oauth2.S256ChallengeOption(verifier)), http.StatusFound)
}

func (a *API) oidcCallback(w http.ResponseWriter, r *http.Request) {
	c, err := r.Cookie(oidcCookie)
	http.SetCookie(w, &http.Cookie{Name: oidcCookie, Path: "/api/auth/oidc", MaxAge: -1})
	q := r.URL.Query()
	parts := []string{}
	if err == nil {
		parts = strings.Split(c.Value, ".")
	}
	if q.Get("error") != "" || len(parts) != 3 || q.Get("state") != parts[0] {
		loginError(w, r, "oidc_failed")
		return
	}
	p, cfg, o, err := a.oidcConfig(r)
	if err != nil {
		log.Printf("oidc callback: %v", err)
		loginError(w, r, "oidc_unavailable")
		return
	}
	tok, err := cfg.Exchange(r.Context(), q.Get("code"), oauth2.VerifierOption(parts[2]))
	if err != nil {
		log.Printf("oidc exchange: %v", err)
		loginError(w, r, "oidc_failed")
		return
	}
	raw, _ := tok.Extra("id_token").(string)
	idt, err := p.Verifier(&oidc.Config{ClientID: o.ClientID}).Verify(r.Context(), raw)
	if err != nil || idt.Nonce != parts[1] {
		log.Printf("oidc id token: %v", err)
		loginError(w, r, "oidc_failed")
		return
	}
	var claims struct {
		Email         string   `json:"email"`
		EmailVerified *bool    `json:"email_verified"`
		Name          string   `json:"name"`
		Groups        []string `json:"groups"`
	}
	if err := idt.Claims(&claims); err != nil || claims.Email == "" || (claims.EmailVerified != nil && !*claims.EmailVerified) {
		loginError(w, r, "oidc_email")
		return
	}
	u, err := a.oidcUser(o, claims.Email, claims.Name, claims.Groups)
	if errors.Is(err, store.ErrNotFound) {
		loginError(w, r, "oidc_unknown_user")
		return
	}
	if err != nil {
		fail(w, err)
		return
	}
	if err := a.startSession(w, u); err != nil {
		fail(w, err)
		return
	}
	http.Redirect(w, r, "/", http.StatusFound)
}

// oidcUser finds the Sumigo user of an email, creates it when allowed, and syncs admin rights with the admin group.
func (a *API) oidcUser(o store.OIDCSettings, email, name string, groups []string) (*store.User, error) {
	u, err := a.Store.UserByEmail(email)
	if errors.Is(err, store.ErrNotFound) && o.AutoCreate {
		if name == "" {
			name = email
		}
		u = &store.User{Email: email, Name: name}
		// The password is random and never shown: this user logs in with the provider.
		err = a.Store.CreateUser(u, randomString())
	}
	if err != nil {
		return nil, err
	}
	if admin := slices.Contains(groups, o.AdminGroup); o.AdminGroup != "" && admin != u.IsAdmin {
		u.IsAdmin = admin
		err = a.Store.UpdateUser(u, "")
	}
	return u, err
}

// loginError sends the browser back to the login page, which shows the error code translated.
func loginError(w http.ResponseWriter, r *http.Request, code string) {
	http.Redirect(w, r, "/?login_error="+code, http.StatusFound)
}
