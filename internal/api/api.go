// Package api exposes the JSON HTTP API under /api.
package api

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/ermos/sumigo/internal/ai"
	"github.com/ermos/sumigo/internal/content"
	"github.com/ermos/sumigo/internal/forge"
	"github.com/ermos/sumigo/internal/store"
)

const (
	sessionCookie = "sumigo_session"
	sessionTTL    = 30 * 24 * time.Hour
)

type API struct {
	Store *store.Store
	// NewForge builds the client of a site repo (see forge.New); replaceable in tests.
	NewForge func(kind, baseURL, token, repo string) forge.Forge
	// NewAI builds the AI assistant client; replaceable in tests.
	NewAI func(ai.Config) *ai.Client
	// SecureCookie sets the Secure flag on the session cookie (enable behind HTTPS).
	SecureCookie bool

	configs   sync.Map // site ID -> cachedConfig
	providers sync.Map // OIDC issuer -> *oidc.Provider
}

type ctxKey struct{}

func userFrom(r *http.Request) *store.User { return r.Context().Value(ctxKey{}).(*store.User) }

// Handler returns the API routes.
func (a *API) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /api/login", a.login)
	mux.HandleFunc("POST /api/logout", a.logout)
	mux.HandleFunc("GET /api/auth/config", a.authConfig)
	mux.HandleFunc("GET /api/auth/oidc", a.oidcLogin)
	mux.HandleFunc("GET /api/auth/oidc/callback", a.oidcCallback)
	mux.HandleFunc("GET /api/domain", a.currentDomain)
	mux.HandleFunc("GET /api/domains/check", a.checkDomain)

	auth := func(pattern string, h http.HandlerFunc) { mux.Handle(pattern, a.requireUser(h, false)) }
	admin := func(pattern string, h http.HandlerFunc) { mux.Handle(pattern, a.requireUser(h, true)) }

	auth("GET /api/me", func(w http.ResponseWriter, r *http.Request) { writeJSON(w, userFrom(r)) })
	auth("POST /api/me/password", a.changePassword)

	admin("GET /api/settings/ai", a.getAI)
	admin("PUT /api/settings/ai", a.saveAI)
	admin("GET /api/settings/oidc", a.getOIDC)
	admin("PUT /api/settings/oidc", a.saveOIDC)

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
	admin("GET /api/sites/{site}/domains", a.getDomains)
	admin("GET /api/sites/{site}/setup", a.proposeSetup)
	admin("GET /api/sites/{site}/config", a.getConfigFile)
	admin("PUT /api/sites/{site}/config", a.saveConfigFile)
	admin("POST /api/config/check", a.checkConfigFile)
	admin("POST /api/sites/{site}/setup", a.applySetup)

	auth("GET /api/sites/{site}/collections/{col}/entries", a.listEntries)
	auth("POST /api/sites/{site}/collections/{col}/entries", a.saveEntry)
	auth("GET /api/sites/{site}/collections/{col}/entries/{slug}", a.getEntry)
	auth("PUT /api/sites/{site}/collections/{col}/entries/{slug}", a.saveEntry)
	auth("DELETE /api/sites/{site}/collections/{col}/entries/{slug}", a.deleteEntry)
	auth("GET /api/sites/{site}/collections/{col}/entries/{slug}/history", a.entryHistory)
	auth("GET /api/sites/{site}/collections/{col}/entries/{slug}/history/{sha}", a.entryVersion)
	auth("POST /api/sites/{site}/collections/{col}/ai", a.assist)
	auth("GET /api/sites/{site}/collections/{col}/autosave", a.autosave)
	auth("PUT /api/sites/{site}/collections/{col}/autosave", a.autosave)
	auth("DELETE /api/sites/{site}/collections/{col}/autosave", a.autosave)
	auth("GET /api/sites/{site}/media", a.listMedia)
	auth("POST /api/sites/{site}/media", a.uploadMedia)
	auth("GET /api/sites/{site}/media/{name}", a.getMedia)
	auth("DELETE /api/sites/{site}/media/{name}", a.deleteMedia)
	auth("GET /api/sites/{site}/pulls", a.listPulls)
	auth("POST /api/sites/{site}/pulls/{number}/merge", a.mergePull)
	auth("PUT /api/sites/{site}/pulls/{number}/schedule", a.schedulePull)
	auth("DELETE /api/sites/{site}/pulls/{number}/schedule", a.unschedulePull)
	return a.cors(mux)
}

func (a *API) requireUser(next http.HandlerFunc, adminOnly bool) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		c, err := r.Cookie(sessionCookie)
		if err != nil {
			httpError(w, http.StatusUnauthorized, "not_logged_in", "not logged in")
			return
		}
		u, err := a.Store.UserBySession(c.Value)
		if err != nil {
			httpError(w, http.StatusUnauthorized, "not_logged_in", "not logged in")
			return
		}
		// A temporary password only opens the page to choose a new one.
		if u.MustChangePassword && r.Pattern != "GET /api/me" && r.Pattern != "POST /api/me/password" {
			httpError(w, http.StatusForbidden, "password_change_required", "choose a new password first")
			return
		}
		if adminOnly && !u.IsAdmin {
			httpError(w, http.StatusForbidden, "admin_only", "admin only")
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

// params fills the placeholders of an error message in the web app translations.
type params map[string]string

// httpError writes {"error", "code", "params"}: the web app translates code and params,
// error stays readable for API clients and logs.
func httpError(w http.ResponseWriter, status int, code, msg string, p ...params) {
	body := struct {
		Error  string `json:"error"`
		Code   string `json:"code"`
		Params params `json:"params,omitempty"`
	}{Error: msg, Code: code}
	if len(p) > 0 {
		body.Params = p[0]
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

// fail maps an error to an HTTP response, hiding internal details.
func fail(w http.ResponseWriter, err error) {
	var gh *forge.Error
	switch {
	case errors.Is(err, store.ErrNotFound) || forge.IsNotFound(err):
		httpError(w, http.StatusNotFound, "not_found", "not found")
	case errors.As(err, &gh):
		httpError(w, http.StatusBadGateway, "forge", gh.Error(), params{"detail": gh.Error()})
	default:
		log.Printf("api error: %v", err)
		httpError(w, http.StatusInternalServerError, "internal", "internal error")
	}
}

func readJSON(w http.ResponseWriter, r *http.Request, v any) bool {
	r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
	if err := json.NewDecoder(r.Body).Decode(v); err != nil {
		httpError(w, http.StatusBadRequest, "invalid_json", "invalid JSON body")
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
		httpError(w, http.StatusUnauthorized, "invalid_credentials", "invalid credentials")
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
	writeJSON(w, u)
}

// startSession logs u in on this browser.
func (a *API) startSession(w http.ResponseWriter, u *store.User) error {
	token, err := a.Store.CreateSession(u.ID, sessionTTL)
	if err != nil {
		return err
	}
	http.SetCookie(w, &http.Cookie{
		Name: sessionCookie, Value: token, Path: "/", MaxAge: int(sessionTTL.Seconds()),
		HttpOnly: true, Secure: a.SecureCookie, SameSite: http.SameSiteStrictMode,
	})
	return nil
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
		// Temporary generates a one-time password, shown once to the admin; the user replaces it at login.
		Temporary bool `json:"temporary"`
	}
	if !readJSON(w, r, &in) {
		return
	}
	u := in.User
	u.ID = pathID(r, "id")
	u.MustChangePassword = in.Temporary
	if in.Temporary {
		in.Password = temporaryPassword()
	}
	u.Email = strings.TrimSpace(u.Email)
	if u.Email == "" || u.Name == "" {
		httpError(w, http.StatusBadRequest, "email_name_required", "email and name are required")
		return
	}
	var err error
	if u.ID == 0 {
		if len(in.Password) < 8 {
			httpError(w, http.StatusBadRequest, "password_too_short", "password must be at least 8 characters")
			return
		}
		err = a.Store.CreateUser(&u, in.Password)
	} else {
		if u.ID == userFrom(r).ID && !u.IsAdmin {
			httpError(w, http.StatusBadRequest, "own_admin_role", "you cannot remove your own admin role")
			return
		}
		if in.Password != "" && len(in.Password) < 8 {
			httpError(w, http.StatusBadRequest, "password_too_short", "password must be at least 8 characters")
			return
		}
		err = a.Store.UpdateUser(&u, in.Password)
	}
	if err != nil {
		if strings.Contains(err.Error(), "UNIQUE") {
			httpError(w, http.StatusConflict, "email_used", "email already used")
			return
		}
		fail(w, err)
		return
	}
	if !in.Temporary {
		writeJSON(w, u)
		return
	}
	writeJSON(w, struct {
		store.User
		TemporaryPassword string `json:"temporary_password"`
	}{u, in.Password})
}

// temporaryPassword is easy to read out or type: no 0/O, 1/l/I.
func temporaryPassword() string {
	const alphabet = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789"
	b := make([]byte, 12)
	_, _ = rand.Read(b)
	for i := range b {
		b[i] = alphabet[int(b[i])%len(alphabet)]
	}
	return string(b)
}

// changePassword sets the password of the logged in user. The current one is asked, except to replace a temporary one
// (the user just typed it to log in).
func (a *API) changePassword(w http.ResponseWriter, r *http.Request) {
	var in struct{ Current, Password string }
	if !readJSON(w, r, &in) {
		return
	}
	u := userFrom(r)
	if !u.MustChangePassword {
		if _, err := a.Store.Authenticate(u.Email, in.Current); err != nil {
			httpError(w, http.StatusBadRequest, "wrong_password", "current password is wrong")
			return
		}
	}
	if len(in.Password) < 8 {
		httpError(w, http.StatusBadRequest, "password_too_short", "password must be at least 8 characters")
		return
	}
	u.MustChangePassword = false
	if err := a.Store.UpdateUser(u, in.Password); err != nil {
		fail(w, err)
		return
	}
	writeJSON(w, u)
}

func (a *API) deleteUser(w http.ResponseWriter, r *http.Request) {
	id := pathID(r, "id")
	if id == userFrom(r).ID {
		httpError(w, http.StatusBadRequest, "delete_self", "you cannot delete yourself")
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
		// ConfigMissing offers the onboarding: the repository has no sumigo.yml yet.
		ConfigMissing bool `json:"config_missing,omitempty"`
		// AI is true when the editor can use the assistant: on for the instance and the site.
		AI bool `json:"ai"`
	}{Site: sc.site}
	_, out.AI = a.aiReady(sc.site)
	if sc.gh == nil {
		out.ConfigError = "no access token configured"
	} else if cfg, err := a.config(r.Context(), sc, false); err != nil {
		out.ConfigError = err.Error()
		out.ConfigMissing = errors.Is(err, errNoConfig)
	} else {
		out.Config = cfg
	}
	writeJSON(w, out)
}

func (a *API) saveSite(w http.ResponseWriter, r *http.Request) {
	var in struct {
		store.Site
		// Domains replaces the custom domains of the site; left as is when absent.
		Domains *[]string `json:"domains"`
	}
	if !readJSON(w, r, &in) {
		return
	}
	st := in.Site
	st.ID = pathID(r, "site")
	st.Repo = strings.Trim(st.Repo, "/")
	// GitLab nests projects in subgroups: group/subgroup/name.
	if st.Name == "" || !strings.Contains(st.Repo, "/") || (st.Forge != forge.KindGitLab && strings.Count(st.Repo, "/") != 1) {
		httpError(w, http.StatusBadRequest, "name_repo_required", "name and repo (owner/name, or group/subgroup/name on GitLab) are required")
		return
	}
	switch st.Forge {
	case forge.KindGitHub, forge.KindGitLab, forge.KindGitea:
	default:
		st.Forge = forge.KindGitHub
	}
	st.ForgeURL = strings.TrimRight(st.ForgeURL, "/")
	if u, err := url.Parse(st.ForgeURL); err != nil || (st.ForgeURL != "" && (u.Scheme != "https" && u.Scheme != "http" || u.Host == "")) || (st.Forge == forge.KindGitea && st.ForgeURL == "") {
		httpError(w, http.StatusBadRequest, "invalid_forge_url", "invalid instance URL (https://git.example.com), required for Gitea and Forgejo")
		return
	}
	if st.Branch == "" {
		st.Branch = "main"
	}
	if st.Workflow != "pr" {
		st.Workflow = "direct"
	}
	// Domains are checked before anything is saved, so a rejected domain never leaves a half-created site.
	var domains []string
	if in.Domains != nil {
		var ok bool
		if domains, ok = a.parseDomains(w, *in.Domains, st.ID); !ok {
			return
		}
	}
	if err := a.Store.SaveSite(&st); err != nil {
		fail(w, err)
		return
	}
	if in.Domains != nil {
		if err := a.Store.SetDomains(st.ID, domains); err != nil {
			fail(w, err)
			return
		}
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
		httpError(w, http.StatusBadRequest, "invalid_access", err.Error(), params{"detail": err.Error()})
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
		httpError(w, http.StatusBadGateway, "branch_unreadable", "cannot read branch "+sc.site.Branch+": "+err.Error(), params{"branch": sc.site.Branch, "detail": err.Error()})
		return
	}
	cfg, err := a.config(r.Context(), sc, true)
	if err != nil {
		httpError(w, http.StatusBadGateway, "config", err.Error(), params{"detail": err.Error()})
		return
	}
	writeJSON(w, map[string]int{"collections": len(cfg.Collections)})
}
