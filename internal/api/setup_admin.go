package api

import (
	"crypto/rand"
	"crypto/subtle"
	"fmt"
	"log"
	"net/http"
	"strings"

	"github.com/ermos/sumigo/internal/store"
)

// First run: with no user at all, the server prints a setup code in its logs. Whoever can read the logs
// (the person who deployed it) enters it on the setup page and creates the first account, an admin.

// PrepareSetup generates the setup code when the instance has no user yet. It lives in memory only:
// a restart prints a new one.
func (a *API) PrepareSetup() error {
	n, err := a.Store.CountUsers()
	if err != nil || n > 0 {
		return err
	}
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	b[6], b[8] = b[6]&0x0f|0x40, b[8]&0x3f|0x80 // UUID version 4
	code := fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:])
	a.setupMu.Lock()
	a.setupCode = code
	a.setupMu.Unlock()
	log.Printf("no user yet: open the web app and enter this setup code to create the admin account: %s", code)
	return nil
}

// setupStatus tells the web app to show the setup page instead of the login.
func (a *API) setupStatus(w http.ResponseWriter, _ *http.Request) {
	a.setupMu.Lock()
	defer a.setupMu.Unlock()
	writeJSON(w, map[string]bool{"needed": a.setupCode != ""})
}

// setup creates the first account, an admin, with the setup code from the logs, then logs it in.
func (a *API) setup(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Code      string `json:"code"`
		FirstName string `json:"first_name"`
		LastName  string `json:"last_name"`
		Email     string `json:"email"`
		Password  string `json:"password"`
	}
	if !readJSON(w, r, &in) {
		return
	}
	// One setup at a time, and only once.
	a.setupMu.Lock()
	defer a.setupMu.Unlock()
	if a.setupCode == "" {
		httpError(w, http.StatusConflict, "setup_done", "this instance is already set up")
		return
	}
	if subtle.ConstantTimeCompare([]byte(strings.TrimSpace(in.Code)), []byte(a.setupCode)) != 1 {
		httpError(w, http.StatusForbidden, "setup_code", "wrong setup code, copy it from the server logs")
		return
	}
	u := &store.User{Email: strings.TrimSpace(in.Email), FirstName: in.FirstName, LastName: in.LastName, IsAdmin: true}
	if u.Email == "" || strings.TrimSpace(u.FirstName) == "" {
		httpError(w, http.StatusBadRequest, "email_name_required", "email and first name are required")
		return
	}
	if len(in.Password) < 8 {
		httpError(w, http.StatusBadRequest, "password_too_short", "password must be at least 8 characters")
		return
	}
	if err := a.Store.CreateUser(u, in.Password); err != nil {
		fail(w, err)
		return
	}
	a.setupCode = ""
	log.Printf("setup done: %s is the admin", u.Email)
	if err := a.startSession(w, u); err != nil {
		fail(w, err)
		return
	}
	writeJSON(w, u)
}
