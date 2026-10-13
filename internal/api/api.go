// Package api exposes the JSON HTTP API under /api.
package api

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/ermos/sumigo/internal/content"
	"github.com/ermos/sumigo/internal/github"
	"github.com/ermos/sumigo/internal/store"
)

const (
	sessionCookie = "sumigo_session"
	sessionTTL    = 30 * 24 * time.Hour
)

type API struct {
	Store *store.Store
	// NewGitHub builds a client for a repo; replaceable in tests.
	NewGitHub func(token, repo string) *github.Client
	// SecureCookie sets the Secure flag on the session cookie (enable behind HTTPS).
	SecureCookie bool

	configs sync.Map // site ID -> cachedConfig
}

type ctxKey struct{}

func userFrom(r *http.Request) *store.User { return r.Context().Value(ctxKey{}).(*store.User) }

// Handler returns the API routes.
func (a *API) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /api/login", a.login)
	mux.HandleFunc("POST /api/logout", a.logout)

	auth := func(pattern string, h http.HandlerFunc) { mux.Handle(pattern, a.requireUser(h, false)) }
	admin := func(pattern string, h http.HandlerFunc) { mux.Handle(pattern, a.requireUser(h, true)) }

	auth("GET /api/me", func(w http.ResponseWriter, r *http.Request) { writeJSON(w, userFrom(r)) })

	admin("GET /api/users", a.listUsers)
	admin("POST /api/users", a.saveUser)
	admin("PUT /api/users/{id}", a.saveUser)
	admin("DELETE /api/users/{id}", a.deleteUser)

	auth("GET /api/sites", a.listSites)
	admin("POST /api/sites", a.saveSite)
	auth("GET /api/sites/{site}", a.getSite)
	admin("PUT /api/sites/{site}", a.saveSite)
	admin("DELETE /api/sites/{site}", a.deleteSite)
	admin("GET /api/sites/{site}/access", a.getAccess)
	admin("PUT /api/sites/{site}/access", a.setAccess)
	admin("POST /api/sites/{site}/check", a.checkSite)

	auth("GET /api/sites/{site}/collections/{col}/entries", a.listEntries)
	auth("POST /api/sites/{site}/collections/{col}/entries", a.saveEntry)
	auth("GET /api/sites/{site}/collections/{col}/entries/{slug}", a.getEntry)
	auth("PUT /api/sites/{site}/collections/{col}/entries/{slug}", a.saveEntry)
	auth("DELETE /api/sites/{site}/collections/{col}/entries/{slug}", a.deleteEntry)
	auth("GET /api/sites/{site}/media", a.listMedia)
	auth("POST /api/sites/{site}/media", a.uploadMedia)
	auth("GET /api/sites/{site}/media/{name}", a.getMedia)
	auth("GET /api/sites/{site}/pulls", a.listPulls)
	auth("POST /api/sites/{site}/pulls/{number}/merge", a.mergePull)
	return mux
}

func (a *API) requireUser(next http.HandlerFunc, adminOnly bool) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		c, err := r.Cookie(sessionCookie)
		if err != nil {
			httpError(w, http.StatusUnauthorized, "not logged in")
			return
		}
		u, err := a.Store.UserBySession(c.Value)
		if err != nil {
			httpError(w, http.StatusUnauthorized, "not logged in")
			return
		}
		if adminOnly && !u.IsAdmin {
			httpError(w, http.StatusForbidden, "admin only")
			return
		}
		next(w, r.WithContext(context.WithValue(r.Context(), ctxKey{}, u)))
	})
}

// --- helpers

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(v)
}

func httpError(w http.ResponseWriter, status int, msg string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]string{"error": msg})
}

// fail maps an error to an HTTP response, hiding internal details.
func fail(w http.ResponseWriter, err error) {
	var gh *github.Error
	switch {
	case errors.Is(err, store.ErrNotFound) || github.IsNotFound(err):
		httpError(w, http.StatusNotFound, "not found")
	case errors.As(err, &gh):
		httpError(w, http.StatusBadGateway, gh.Error())
	default:
		log.Printf("api error: %v", err)
		httpError(w, http.StatusInternalServerError, "internal error")
	}
}

func readJSON(w http.ResponseWriter, r *http.Request, v any) bool {
	r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
	if err := json.NewDecoder(r.Body).Decode(v); err != nil {
		httpError(w, http.StatusBadRequest, "invalid JSON body")
		return false
	}
	return true
}

func pathID(r *http.Request, name string) int64 {
	id, _ := strconv.ParseInt(r.PathValue(name), 10, 64)
	return id
}

// --- auth

func (a *API) login(w http.ResponseWriter, r *http.Request) {
	var in struct{ Email, Password string }
	if !readJSON(w, r, &in) {
		return
	}
	u, err := a.Store.Authenticate(strings.TrimSpace(in.Email), in.Password)
	if errors.Is(err, store.ErrNotFound) {
		httpError(w, http.StatusUnauthorized, "invalid credentials")
		return
	}
	if err != nil {
		fail(w, err)
		return
	}
	token, err := a.Store.CreateSession(u.ID, sessionTTL)
	if err != nil {
		fail(w, err)
		return
	}
	http.SetCookie(w, &http.Cookie{
		Name: sessionCookie, Value: token, Path: "/", MaxAge: int(sessionTTL.Seconds()),
		HttpOnly: true, Secure: a.SecureCookie, SameSite: http.SameSiteStrictMode,
	})
	writeJSON(w, u)
}

func (a *API) logout(w http.ResponseWriter, r *http.Request) {
	if c, err := r.Cookie(sessionCookie); err == nil {
		_ = a.Store.DeleteSession(c.Value)
	}
	http.SetCookie(w, &http.Cookie{Name: sessionCookie, Path: "/", MaxAge: -1})
	w.WriteHeader(http.StatusNoContent)
}

// --- users (admin)

func (a *API) listUsers(w http.ResponseWriter, _ *http.Request) {
	users, err := a.Store.ListUsers()
	if err != nil {
		fail(w, err)
		return
	}
	writeJSON(w, users)
}

func (a *API) saveUser(w http.ResponseWriter, r *http.Request) {
	var in struct {
		store.User
		Password string `json:"password"`
	}
	if !readJSON(w, r, &in) {
		return
	}
	u := in.User
	u.ID = pathID(r, "id")
	u.Email = strings.TrimSpace(u.Email)
	if u.Email == "" || u.Name == "" {
		httpError(w, http.StatusBadRequest, "email and name are required")
		return
	}
	var err error
	if u.ID == 0 {
		if len(in.Password) < 8 {
			httpError(w, http.StatusBadRequest, "password must be at least 8 characters")
			return
		}
		err = a.Store.CreateUser(&u, in.Password)
	} else {
		if u.ID == userFrom(r).ID && !u.IsAdmin {
			httpError(w, http.StatusBadRequest, "you cannot remove your own admin role")
			return
		}
		if in.Password != "" && len(in.Password) < 8 {
			httpError(w, http.StatusBadRequest, "password must be at least 8 characters")
			return
		}
		err = a.Store.UpdateUser(&u, in.Password)
	}
	if err != nil {
		if strings.Contains(err.Error(), "UNIQUE") {
			httpError(w, http.StatusConflict, "email already used")
			return
		}
		fail(w, err)
		return
	}
	writeJSON(w, u)
}

func (a *API) deleteUser(w http.ResponseWriter, r *http.Request) {
	id := pathID(r, "id")
	if id == userFrom(r).ID {
		httpError(w, http.StatusBadRequest, "you cannot delete yourself")
		return
	}
	if err := a.Store.DeleteUser(id); err != nil {
		fail(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// --- sites

func (a *API) listSites(w http.ResponseWriter, r *http.Request) {
	sites, err := a.Store.ListSites(userFrom(r))
	if err != nil {
		fail(w, err)
		return
	}
	writeJSON(w, sites)
}

// getSite returns the site with its config read from the repository.
func (a *API) getSite(w http.ResponseWriter, r *http.Request) {
	sc, ok := a.site(w, r, store.RoleViewer)
	if !ok {
		return
	}
	out := struct {
		*store.Site
		Config      *content.Config `json:"config"`
		ConfigError string          `json:"config_error,omitempty"`
	}{Site: sc.site}
	if sc.gh == nil {
		out.ConfigError = "no GitHub token configured"
	} else if cfg, err := a.config(r.Context(), sc, false); err != nil {
		out.ConfigError = err.Error()
	} else {
		out.Config = cfg
	}
	writeJSON(w, out)
}

func (a *API) saveSite(w http.ResponseWriter, r *http.Request) {
	var st store.Site
	if !readJSON(w, r, &st) {
		return
	}
	st.ID = pathID(r, "site")
	if st.Name == "" || strings.Count(st.Repo, "/") != 1 {
		httpError(w, http.StatusBadRequest, "name and repo (owner/name) are required")
		return
	}
	if st.Branch == "" {
		st.Branch = "main"
	}
	if st.Workflow != "pr" {
		st.Workflow = "direct"
	}
	if err := a.Store.SaveSite(&st); err != nil {
		fail(w, err)
		return
	}
	a.configs.Delete(st.ID)
	st.Role = store.RolePublisher
	writeJSON(w, st)
}

func (a *API) deleteSite(w http.ResponseWriter, r *http.Request) {
	if err := a.Store.DeleteSite(pathID(r, "site")); err != nil {
		fail(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (a *API) getAccess(w http.ResponseWriter, r *http.Request) {
	list, err := a.Store.ListAccess(pathID(r, "site"))
	if err != nil {
		fail(w, err)
		return
	}
	writeJSON(w, list)
}

func (a *API) setAccess(w http.ResponseWriter, r *http.Request) {
	var list []store.Access
	if !readJSON(w, r, &list) {
		return
	}
	if err := a.Store.SetAccess(pathID(r, "site"), list); err != nil {
		httpError(w, http.StatusBadRequest, err.Error())
		return
	}
	writeJSON(w, list)
}

func (a *API) checkSite(w http.ResponseWriter, r *http.Request) {
	sc, ok := a.site(w, r, store.RolePublisher)
	if !ok {
		return
	}
	if _, err := sc.gh.BranchSHA(r.Context(), sc.site.Branch); err != nil {
		httpError(w, http.StatusBadGateway, "cannot read branch "+sc.site.Branch+": "+err.Error())
		return
	}
	cfg, err := a.config(r.Context(), sc, true)
	if err != nil {
		httpError(w, http.StatusBadGateway, err.Error())
		return
	}
	writeJSON(w, map[string]int{"collections": len(cfg.Collections)})
}
