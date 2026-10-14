package api

import (
	"fmt"
	"net/http"
	"regexp"

	"golang.org/x/sync/errgroup"

	"github.com/ermos/sumigo/internal/content"
	"github.com/ermos/sumigo/internal/forge"
	"github.com/ermos/sumigo/internal/store"
)

// Onboarding of a repository without sumigo.yml: propose one, then commit it.

// A Decap CMS config already holds the content model in the same format.
var decapConfig = regexp.MustCompile(`(^|/)admin/config\.ya?ml$`)

const samplesPerFolder = 3

// proposeSetup drafts the sumigo.yml of a site: its Decap config when it has one, otherwise one detected from its files.
func (a *API) proposeSetup(w http.ResponseWriter, r *http.Request) {
	sc, ok := a.site(w, r, store.RolePublisher)
	if !ok {
		return
	}
	ctx, branch := r.Context(), sc.site.Branch
	if _, _, err := sc.gh.GetFile(ctx, content.ConfigFile, branch); err == nil {
		httpError(w, http.StatusConflict, "config_exists", content.ConfigFile+" already exists")
		return
	} else if !forge.IsNotFound(err) {
		fail(w, err)
		return
	}
	paths, err := sc.gh.Tree(ctx, branch)
	if err != nil {
		fail(w, err)
		return
	}
	for _, p := range paths {
		if !decapConfig.MatchString(p) {
			continue
		}
		raw, _, err := sc.gh.GetFile(ctx, p, branch)
		if err != nil {
			continue
		}
		if cfg, err := content.ParseConfig(raw); err != nil || len(cfg.Collections) == 0 {
			continue
		}
		if raw, err = content.ImportDecap(raw); err == nil {
			writeJSON(w, map[string]string{"yaml": fmt.Sprintf("# Imported from %s (Decap CMS).\n%s", p, raw), "source": "decap", "from": p})
			return
		}
	}

	folders := content.ContentFolders(paths)
	samples := make(map[string][]string, len(folders))
	texts := make([][]string, len(folders))
	g, gctx := errgroup.WithContext(ctx)
	g.SetLimit(8)
	for i, f := range folders {
		files := f.Files[:min(len(f.Files), samplesPerFolder)]
		texts[i] = make([]string, len(files))
		for j, file := range files {
			g.Go(func() error {
				raw, _, err := sc.gh.GetFile(gctx, file, branch)
				texts[i][j] = string(raw)
				return err
			})
		}
	}
	if err := g.Wait(); err != nil {
		fail(w, err)
		return
	}
	for i, f := range folders {
		samples[f.Path] = texts[i]
	}
	raw, err := content.MarshalConfig(content.DetectConfig(paths, folders, samples))
	if err != nil {
		fail(w, err)
		return
	}
	writeJSON(w, map[string]string{"yaml": "# Detected by Sumigo, review the collections and fields.\n" + string(raw), "source": "detected"})
}

// applySetup commits the sumigo.yml the admin reviewed on the site branch.
func (a *API) applySetup(w http.ResponseWriter, r *http.Request) {
	sc, ok := a.site(w, r, store.RolePublisher)
	if !ok {
		return
	}
	var in struct {
		YAML string `json:"yaml"`
	}
	if !readJSON(w, r, &in) {
		return
	}
	cfg, err := content.ParseConfig([]byte(in.YAML))
	if err != nil {
		httpError(w, http.StatusBadRequest, "invalid_config", err.Error(), params{"detail": err.Error()})
		return
	}
	if len(cfg.Collections) == 0 {
		httpError(w, http.StatusBadRequest, "setup_no_collection", "add at least one folder collection")
		return
	}
	ctx, branch := r.Context(), sc.site.Branch
	if _, _, err := sc.gh.GetFile(ctx, content.ConfigFile, branch); err == nil {
		httpError(w, http.StatusConflict, "config_exists", content.ConfigFile+" already exists")
		return
	} else if !forge.IsNotFound(err) {
		fail(w, err)
		return
	}
	msg := fmt.Sprintf("chore(cms): add %s\n\nSet up by %s <%s> via Sumigo", content.ConfigFile, sc.user.Name, sc.user.Email)
	if err := sc.gh.PutFile(ctx, content.ConfigFile, branch, msg, []byte(in.YAML), "", sc.author()); err != nil {
		fail(w, err)
		return
	}
	a.configs.Delete(sc.site.ID)
	writeJSON(w, map[string]int{"collections": len(cfg.Collections)})
}
