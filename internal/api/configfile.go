package api

import (
	"fmt"
	"net/http"
	"regexp"

	"github.com/ermos/sumigo/internal/content"
	"github.com/ermos/sumigo/internal/forge"
	"github.com/ermos/sumigo/internal/store"
)

// Editing sumigo.yml from the admin: read it, check it while typing, commit it.

// getConfigFile returns sumigo.yml as written, and its version to save on top of.
func (a *API) getConfigFile(w http.ResponseWriter, r *http.Request) {
	sc, ok := a.site(w, r, store.RolePublisher)
	if !ok {
		return
	}
	raw, sha, err := sc.gh.GetFile(r.Context(), content.ConfigFile, sc.site.Branch)
	if err != nil {
		fail(w, err)
		return
	}
	writeJSON(w, map[string]string{"yaml": string(raw), "sha": sha})
}

var yamlLine = regexp.MustCompile(`line (\d+)`)

// checkConfig answers 400 with the error, and its line when known, if yaml is not a valid config.
func checkConfig(w http.ResponseWriter, yaml string) bool {
	if _, err := content.ParseConfig([]byte(yaml)); err != nil {
		p := params{"detail": err.Error()}
		if m := yamlLine.FindStringSubmatch(err.Error()); m != nil {
			p["line"] = m[1]
		}
		httpError(w, http.StatusBadRequest, "invalid_config", err.Error(), p)
		return false
	}
	return true
}

func (a *API) checkConfigFile(w http.ResponseWriter, r *http.Request) {
	var in struct{ YAML string }
	if !readJSON(w, r, &in) || !checkConfig(w, in.YAML) {
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// saveConfigFile commits sumigo.yml on the site branch, on top of the version the admin edited.
func (a *API) saveConfigFile(w http.ResponseWriter, r *http.Request) {
	sc, ok := a.site(w, r, store.RolePublisher)
	if !ok {
		return
	}
	var in struct{ YAML, SHA string }
	if !readJSON(w, r, &in) || !checkConfig(w, in.YAML) {
		return
	}
	msg := fmt.Sprintf("chore(cms): update %s\n\nEdited by %s <%s> via Sumigo", content.ConfigFile, sc.user.Name, sc.user.Email)
	err := sc.gh.PutFile(r.Context(), content.ConfigFile, sc.site.Branch, msg, []byte(in.YAML), in.SHA, sc.author())
	// GitHub answers 409 when the file changed since it was read.
	// ponytail: GitLab and Gitea may overwrite instead; pass their commit id if concurrent edits of sumigo.yml happen.
	if forge.IsStatus(err, http.StatusConflict) {
		httpError(w, http.StatusConflict, "config_changed", content.ConfigFile+" changed in the repository since it was opened, reload it")
		return
	}
	if err != nil {
		fail(w, err)
		return
	}
	a.configs.Delete(sc.site.ID)
	a.getConfigFile(w, r)
}
