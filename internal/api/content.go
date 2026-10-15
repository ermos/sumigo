package api

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"net/http"
	"path"
	"strconv"
	"strings"
	"time"

	"github.com/ermos/sumigo/internal/content"
	"github.com/ermos/sumigo/internal/forge"
	"github.com/ermos/sumigo/internal/store"
)

// Branches opened by the CMS in "pr" workflow: cms/<collection>/<slug>.
const branchPrefix = "cms/"

// ponytail: config cached per site for configTTL, edits to sumigo.yml show up after that (or on "Test access").
const configTTL = time.Minute

var errNoConfig = errors.New(content.ConfigFile + " not found")

type cachedConfig struct {
	cfg *content.Config
	at  time.Time
}

type siteCtx struct {
	site *store.Site
	user *store.User
	gh   forge.Forge
}

func (sc *siteCtx) author() forge.Author {
	return forge.Author{Name: sc.user.Name, Email: sc.user.Email}
}

// site loads the site from the path and checks the user has at least min role on it.
func (a *API) site(w http.ResponseWriter, r *http.Request, min string) (*siteCtx, bool) {
	u := userFrom(r)
	id := pathID(r, "site")
	role, err := a.Store.Role(u, id)
	if err != nil {
		fail(w, err)
		return nil, false
	}
	if !store.RoleAtLeast(role, min) {
		httpError(w, http.StatusForbidden, "forbidden_site", "insufficient rights on this site")
		return nil, false
	}
	st, err := a.Store.GetSite(id)
	if err != nil {
		fail(w, err)
		return nil, false
	}
	st.Role = role
	sc := &siteCtx{site: st, user: u}
	if st.HasToken {
		token, err := a.Store.SiteToken(id)
		if err != nil {
			fail(w, err)
			return nil, false
		}
		sc.gh = a.NewForge(st.Forge, st.ForgeURL, token, st.Repo)
	} else if r.Pattern != "GET /api/sites/{site}" {
		httpError(w, http.StatusConflict, "no_token", "this site has no access token configured")
		return nil, false
	}
	return sc, true
}

// config reads the site config file from its repository, cached for configTTL.
func (a *API) config(ctx context.Context, sc *siteCtx, fresh bool) (*content.Config, error) {
	if c, ok := a.configs.Load(sc.site.ID); ok && !fresh && time.Since(c.(cachedConfig).at) < configTTL {
		return c.(cachedConfig).cfg, nil
	}
	raw, _, err := sc.gh.GetFile(ctx, content.ConfigFile, sc.site.Branch)
	if forge.IsNotFound(err) {
		return nil, fmt.Errorf("%w at the root of branch %s", errNoConfig, sc.site.Branch)
	}
	if err != nil {
		return nil, err
	}
	cfg, err := content.ParseConfig(raw)
	if err != nil {
		return nil, fmt.Errorf("invalid %s: %w", content.ConfigFile, err)
	}
	a.configs.Store(sc.site.ID, cachedConfig{cfg: cfg, at: time.Now()})
	return cfg, nil
}

func (a *API) collection(w http.ResponseWriter, r *http.Request, min string) (*siteCtx, *content.Collection, bool) {
	sc, ok := a.site(w, r, min)
	if !ok {
		return nil, nil, false
	}
	cfg, err := a.config(r.Context(), sc, false)
	if err != nil {
		httpError(w, http.StatusBadGateway, "config", err.Error(), params{"detail": err.Error()})
		return nil, nil, false
	}
	for i, c := range cfg.Collections {
		if c.Name == r.PathValue("col") {
			return sc, &cfg.Collections[i], true
		}
	}
	httpError(w, http.StatusNotFound, "unknown_collection", "unknown collection")
	return nil, nil, false
}

func entryPath(c *content.Collection, slug string) string { return c.Path(slug, "") }

// locale reads ?locale=, a locale of the collection; "" is the default one.
func locale(w http.ResponseWriter, r *http.Request, col *content.Collection) (string, bool) {
	l := r.URL.Query().Get("locale")
	if !col.IsLocale(l) {
		httpError(w, http.StatusBadRequest, "unknown_locale", "unknown locale "+l, params{"locale": l})
		return "", false
	}
	if col.I18n && l == col.Locales[0] {
		l = ""
	}
	return l, true
}

// entryFile finds the file of an entry in a locale at ref. With i18n_key, a translation has its own file name: it is
// the file of the locale folder whose key matches the default entry. file is "" for a translation not written yet,
// key is what pairs it with the default entry.
// ponytail: reads the whole locale folder per call, an index cached per ref if folders get large.
func (sc *siteCtx) entryFile(ctx context.Context, col *content.Collection, slug, loc, ref string) (file, key string, err error) {
	if loc == "" || col.I18nKey == "" {
		return col.Path(slug, loc), slug, nil
	}
	raw, _, err := sc.gh.GetFile(ctx, col.Path(slug, ""), ref)
	if err != nil {
		return "", "", err
	}
	data, _, _ := content.Parse(raw)
	key = col.TranslationKey(slug, data)
	dir, suffix := col.Dir(loc)
	blobs, _, err := sc.gh.ReadDir(ctx, ref, dir, col.Ext(), nil)
	if err != nil && !forge.IsNotFound(err) {
		return "", "", err
	}
	for _, b := range blobs {
		if name, ok := strings.CutSuffix(b.Name, suffix); ok {
			if d, _, _ := content.Parse([]byte(b.Text)); col.TranslationKey(name, d) == key {
				return path.Join(dir, b.Name), key, nil
			}
		}
	}
	return "", key, nil
}

// autosaveKey keeps the autosave of each translation apart: "fr/hello" cannot clash with a slug, which has no slash.
func autosaveKey(slug, locale string) string {
	if locale == "" {
		return slug
	}
	return locale + "/" + slug
}

func validSlug(s string) bool {
	return s != "" && !strings.HasPrefix(s, ".") && !strings.ContainsAny(s, `/\`)
}

// draft returns the open CMS pull request for an entry, or nil.
func (sc *siteCtx) draft(ctx context.Context, branch string) (*forge.Pull, error) {
	pulls, err := sc.gh.ListPulls(ctx, branch)
	if err != nil {
		return nil, err
	}
	for _, p := range pulls {
		if p.Head.Ref == branch {
			return &p, nil
		}
	}
	return nil, nil
}

type entrySummary struct {
	Slug  string      `json:"slug"`
	Path  string      `json:"path"`
	Title string      `json:"title"`
	Date  any         `json:"date,omitempty"`
	Draft *forge.Pull `json:"draft,omitempty"`
	// Locales lists the locales the entry is published in, for translated collections.
	Locales []string `json:"locales,omitempty"`
	// Data is the full entry (front matter + body), so the UI opens it without another call.
	Data map[string]any `json:"data,omitempty"`
}

func summarize(col *content.Collection, slug, text string) entrySummary {
	e := entrySummary{Slug: slug, Path: entryPath(col, slug), Title: slug}
	if data, body, err := content.Parse([]byte(text)); err == nil {
		if t, ok := data[col.TitleField()].(string); ok && t != "" {
			e.Title = t
		}
		e.Date = data["date"]
		data[content.BodyField] = body
		e.Data = data
	}
	return e
}

// listEntries reads the whole collection folder, and the drafts of open CMS pull requests,
// in one GraphQL call.
func (a *API) listEntries(w http.ResponseWriter, r *http.Request) {
	sc, col, ok := a.collection(w, r, store.RoleViewer)
	if !ok {
		return
	}
	var extra []string
	prefix := branchPrefix + col.Name + "/"
	pulls, err := sc.gh.ListPulls(r.Context(), prefix)
	if err != nil {
		fail(w, err)
		return
	}
	for _, p := range pulls {
		extra = append(extra, p.Head.Ref+":"+entryPath(col, strings.TrimPrefix(p.Head.Ref, prefix)))
	}
	a.markScheduled(sc.site.ID, pulls)
	dir, suffix := col.Dir("")
	blobs, drafts, err := sc.gh.ReadDir(r.Context(), sc.site.Branch, dir, col.Ext(), extra)
	if err != nil {
		fail(w, err)
		return
	}
	entries := []entrySummary{}
	index := map[string]int{}
	for _, b := range blobs {
		if strings.HasSuffix(b.Name, suffix) {
			slug := strings.TrimSuffix(b.Name, suffix)
			index[slug] = len(entries)
			entries = append(entries, summarize(col, slug, b.Text))
		}
	}
	for i, p := range pulls {
		e := summarize(col, strings.TrimPrefix(p.Head.Ref, prefix), drafts[i])
		e.Draft = &pulls[i]
		if j, ok := index[e.Slug]; ok {
			entries[j] = e
		} else {
			entries = append(entries, e)
		}
	}
	if col.I18n {
		if err := sc.markLocales(r.Context(), col, blobs, entries, index); err != nil {
			fail(w, err)
			return
		}
	}
	writeJSON(w, entries)
}

// markLocales fills the published locales of the entries of a translated collection.
// ponytail: translations that only exist in a draft are not marked, the draft pill already flags the entry.
func (sc *siteCtx) markLocales(ctx context.Context, col *content.Collection, blobs []forge.Blob, entries []entrySummary, index map[string]int) error {
	byKey := map[string]int{}
	for slug, j := range index {
		entries[j].Locales = []string{col.Locales[0]}
		byKey[col.TranslationKey(slug, entries[j].Data)] = j
	}
	for _, l := range col.Locales[1:] {
		dir, suffix := col.Dir(l)
		if col.I18nKey != "" {
			files, _, err := sc.gh.ReadDir(ctx, sc.site.Branch, dir, col.Ext(), nil)
			if err != nil && !forge.IsNotFound(err) {
				return err
			}
			for _, f := range files {
				if name, ok := strings.CutSuffix(f.Name, suffix); ok {
					d, _, _ := content.Parse([]byte(f.Text))
					if j, ok := byKey[col.TranslationKey(name, d)]; ok {
						entries[j].Locales = append(entries[j].Locales, l)
					}
				}
			}
			continue
		}
		var names []string
		if dir == col.Folder {
			for _, b := range blobs {
				names = append(names, b.Name)
			}
		} else {
			files, err := sc.gh.ListDir(ctx, dir, sc.site.Branch)
			if err != nil && !forge.IsNotFound(err) {
				return err
			}
			for _, f := range files {
				names = append(names, f.Name)
			}
		}
		for _, n := range names {
			if j, ok := index[strings.TrimSuffix(n, suffix)]; ok && strings.HasSuffix(n, suffix) {
				entries[j].Locales = append(entries[j].Locales, l)
			}
		}
	}
	return nil
}

func (a *API) getEntry(w http.ResponseWriter, r *http.Request) {
	sc, col, ok := a.collection(w, r, store.RoleViewer)
	if !ok {
		return
	}
	slug := r.PathValue("slug")
	if !validSlug(slug) {
		httpError(w, http.StatusBadRequest, "invalid_slug", "invalid slug")
		return
	}
	loc, ok := locale(w, r, col)
	if !ok {
		return
	}
	ref := sc.site.Branch
	pr, err := sc.draft(r.Context(), branchPrefix+col.Name+"/"+slug)
	if err != nil {
		fail(w, err)
		return
	}
	if pr != nil {
		ref = pr.Head.Ref
		a.markScheduled(sc.site.ID, []forge.Pull{*pr})
	}
	file, _, err := sc.entryFile(r.Context(), col, slug, loc, ref)
	if err != nil {
		fail(w, err)
		return
	}
	if file == "" {
		httpError(w, http.StatusNotFound, "not_found", "not found")
		return
	}
	raw, _, err := sc.gh.GetFile(r.Context(), file, ref)
	if err != nil {
		fail(w, err)
		return
	}
	data, body, err := content.Parse(raw)
	if err != nil {
		httpError(w, http.StatusUnprocessableEntity, "front_matter", "cannot parse front matter: "+err.Error(), params{"detail": err.Error()})
		return
	}
	data[content.BodyField] = body
	writeJSON(w, map[string]any{"slug": slug, "data": data, "draft": pr})
}

// saveEntry creates (POST) or updates (PUT) an entry. In "direct" workflow it commits on the
// site branch; in "pr" workflow it commits on cms/<collection>/<slug> and opens a pull request.
func (a *API) saveEntry(w http.ResponseWriter, r *http.Request) {
	sc, col, ok := a.collection(w, r, store.RoleEditor)
	if !ok {
		return
	}
	var in struct {
		Data map[string]any `json:"data"`
		// Publish puts the entry live. Otherwise it is saved as a draft: a pull request left open.
		Publish bool `json:"publish"`
	}
	if !readJSON(w, r, &in) {
		return
	}
	loc, ok := locale(w, r, col)
	if !ok {
		return
	}
	creating := r.Method == http.MethodPost
	// An entry is created in the default locale, its translations are added to it.
	if creating && loc != "" {
		httpError(w, http.StatusBadRequest, "translation_of_new_entry", "create the entry in the default locale first")
		return
	}
	for _, f := range col.Fields {
		if loc != "" && !f.Translatable() {
			continue
		}
		if v := in.Data[f.Name]; f.IsRequired() && f.Widget != "boolean" && (v == nil || v == "" || isEmptyList(v)) {
			httpError(w, http.StatusBadRequest, "field_required", "field "+f.Name+" is required", params{"field": f.Name})
			return
		}
	}
	if in.Publish && !sc.canPublish() {
		httpError(w, http.StatusForbidden, "publisher_only_draft", "only publishers can publish on this site, save a draft instead")
		return
	}
	slug := r.PathValue("slug")
	if creating && col.Create != nil && !*col.Create {
		httpError(w, http.StatusForbidden, "create_disabled", "this collection does not allow new entries (create: false)")
		return
	}
	if creating {
		title, _ := in.Data[col.TitleField()].(string)
		slug = content.Slug(col.Slug, title, in.Data, time.Now())
	}
	if !validSlug(slug) {
		httpError(w, http.StatusBadRequest, "invalid_slug_title", "invalid slug, check the title")
		return
	}
	ctx := r.Context()
	branch := sc.site.Branch
	pr, err := sc.draft(ctx, branchPrefix+col.Name+"/"+slug)
	if err != nil {
		fail(w, err)
		return
	}
	ref := branch
	if pr != nil {
		ref = pr.Head.Ref
	}
	file, key, err := sc.entryFile(ctx, col, slug, loc, ref)
	if err != nil {
		fail(w, err)
		return
	}
	if loc != "" && col.I18nKey != "" {
		// The key pairs the translation with its entry. A new one is named after its own title.
		in.Data[col.I18nKey] = key
		if file == "" {
			title, _ := in.Data[col.TitleField()].(string)
			name := content.Slug(col.Slug, title, in.Data, time.Now())
			if !validSlug(name) {
				httpError(w, http.StatusBadRequest, "invalid_slug_title", "invalid slug, check the title")
				return
			}
			file = col.Path(name, loc)
			// Another entry may already hold this name in the locale: never write over it.
			if _, _, err := sc.gh.GetFile(ctx, file, ref); err == nil {
				httpError(w, http.StatusConflict, "slug_exists", "an entry with slug "+name+" already exists", params{"slug": name})
				return
			} else if !forge.IsNotFound(err) {
				fail(w, err)
				return
			}
		}
	}
	raw, err := content.Render(col.Fields, in.Data)
	if err != nil {
		httpError(w, http.StatusBadRequest, "invalid_data", err.Error(), params{"detail": err.Error()})
		return
	}
	if creating {
		if _, _, err := sc.gh.GetFile(ctx, file, sc.site.Branch); err == nil || pr != nil {
			httpError(w, http.StatusConflict, "slug_exists", "an entry with slug "+slug+" already exists", params{"slug": slug})
			return
		} else if !forge.IsNotFound(err) {
			fail(w, err)
			return
		}
	}
	// Drafts live on their own branch. Publishing an entry that has a draft goes through
	// that branch too, so its pull request gets merged instead of left behind.
	viaDraft := !in.Publish || pr != nil
	if viaDraft {
		branch = branchPrefix + col.Name + "/" + slug
		if pr == nil {
			base, err := sc.gh.BranchSHA(ctx, sc.site.Branch)
			if err != nil {
				fail(w, err)
				return
			}
			if err := sc.gh.CreateBranch(ctx, branch, base); err != nil {
				fail(w, err)
				return
			}
		}
	}
	_, sha, err := sc.gh.GetFile(ctx, file, branch)
	if err != nil && !forge.IsNotFound(err) {
		fail(w, err)
		return
	}
	action := "update"
	if sha == "" {
		action = "create"
	}
	name := slug
	if loc != "" {
		name += " (" + loc + ")"
	}
	msg := fmt.Sprintf("content(%s): %s %s\n\nEdited by %s <%s> via Sumigo", col.Name, action, name, sc.user.Name, sc.user.Email)
	if err := sc.gh.PutFile(ctx, file, branch, msg, raw, sha, sc.author()); err != nil {
		fail(w, err)
		return
	}
	if viaDraft && pr == nil {
		title := fmt.Sprintf("content(%s): %s %s (by %s)", col.Name, action, name, sc.user.Name)
		body := fmt.Sprintf("Opened from Sumigo by **%s** (%s).", sc.user.Name, sc.user.Email)
		if pr, err = sc.gh.CreatePull(ctx, title, branch, sc.site.Branch, body); err != nil {
			fail(w, err)
			return
		}
	}
	if in.Publish && viaDraft {
		if err := a.publish(ctx, sc, pr, "published"); err != nil {
			fail(w, err)
			return
		}
		pr = nil
	}
	if pr != nil {
		pulls := []forge.Pull{*pr}
		a.markScheduled(sc.site.ID, pulls)
		pr = &pulls[0]
	}
	// The entry is committed: what was autosaved for it is now stale.
	if err := a.Store.DeleteAutosave(sc.site.ID, sc.user.ID, col.Name, autosaveKey(r.PathValue("slug"), loc)); err != nil {
		fail(w, err)
		return
	}
	writeJSON(w, map[string]any{"slug": slug, "draft": pr})
}

// autosave keeps the editor form of the user in the database, without a commit. ?slug= is empty for a new entry.
func (a *API) autosave(w http.ResponseWriter, r *http.Request) {
	sc, ok := a.site(w, r, store.RoleEditor)
	if !ok {
		return
	}
	col, slug, loc := r.PathValue("col"), r.URL.Query().Get("slug"), r.URL.Query().Get("locale")
	if (slug != "" && !validSlug(slug)) || (loc != "" && !validSlug(loc)) {
		httpError(w, http.StatusBadRequest, "invalid_slug", "invalid slug")
		return
	}
	slug = autosaveKey(slug, loc)
	switch r.Method {
	case http.MethodGet:
		saved, err := a.Store.GetAutosave(sc.site.ID, sc.user.ID, col, slug)
		if err != nil {
			fail(w, err)
			return
		}
		writeJSON(w, saved)
	case http.MethodPut:
		var in struct {
			Data json.RawMessage `json:"data"`
		}
		if !readJSON(w, r, &in) {
			return
		}
		if len(in.Data) == 0 {
			httpError(w, http.StatusBadRequest, "invalid_data", "missing data")
			return
		}
		if err := a.Store.SetAutosave(sc.site.ID, sc.user.ID, col, slug, in.Data); err != nil {
			fail(w, err)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	default:
		if err := a.Store.DeleteAutosave(sc.site.ID, sc.user.ID, col, slug); err != nil {
			fail(w, err)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}
}

// deleteEntry deletes an entry and its draft. With ?only=draft, it drops the draft and keeps the published version.
func (a *API) deleteEntry(w http.ResponseWriter, r *http.Request) {
	sc, col, ok := a.collection(w, r, store.RoleEditor)
	if !ok {
		return
	}
	onlyDraft := r.URL.Query().Get("only") == "draft"
	if !onlyDraft && !sc.canPublish() {
		httpError(w, http.StatusForbidden, "publisher_only_delete", "only publishers can delete entries on this site")
		return
	}
	slug := r.PathValue("slug")
	if !validSlug(slug) {
		httpError(w, http.StatusBadRequest, "invalid_slug", "invalid slug")
		return
	}
	ctx := r.Context()
	branch := branchPrefix + col.Name + "/" + slug
	pr, err := sc.draft(ctx, branch)
	if err != nil {
		fail(w, err)
		return
	}
	if pr != nil {
		if err := sc.gh.ClosePull(ctx, *pr); err != nil {
			fail(w, err)
			return
		}
	}
	if onlyDraft {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	// Every locale goes: a translation left without its default entry would never be listed.
	deleted := pr != nil
	// The default locale goes last: entryFile reads it to find the translations.
	locs := col.AllLocales()
	for i := range locs {
		loc := locs[len(locs)-1-i]
		file, _, err := sc.entryFile(ctx, col, slug, loc, sc.site.Branch)
		if forge.IsNotFound(err) || file == "" {
			continue
		}
		if err != nil {
			fail(w, err)
			return
		}
		_, sha, err := sc.gh.GetFile(ctx, file, sc.site.Branch)
		if forge.IsNotFound(err) {
			continue
		}
		if err != nil {
			fail(w, err)
			return
		}
		msg := fmt.Sprintf("content(%s): delete %s\n\nDeleted by %s <%s> via Sumigo", col.Name, path.Base(file), sc.user.Name, sc.user.Email)
		if err := sc.gh.DeleteFile(ctx, file, sc.site.Branch, msg, sha, sc.author()); err != nil {
			fail(w, err)
			return
		}
		deleted = true
	}
	if !deleted {
		httpError(w, http.StatusNotFound, "not_found", "not found")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// uploadMedia commits a file into the site media folder.
func (a *API) uploadMedia(w http.ResponseWriter, r *http.Request) {
	sc, ok := a.site(w, r, store.RoleEditor)
	if !ok {
		return
	}
	cfg, err := a.config(r.Context(), sc, false)
	if err != nil {
		httpError(w, http.StatusBadGateway, "config", err.Error(), params{"detail": err.Error()})
		return
	}
	if cfg.MediaFolder == "" {
		httpError(w, http.StatusBadRequest, "media_folder_missing", "set media_folder in "+content.ConfigFile+" to upload files")
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, 10<<20)
	f, hdr, err := r.FormFile("file")
	if err != nil {
		httpError(w, http.StatusBadRequest, "missing_file", "missing file (max 10MB)")
		return
	}
	defer func() { _ = f.Close() }()
	data, err := io.ReadAll(f)
	if err != nil {
		httpError(w, http.StatusBadRequest, "read_file", err.Error(), params{"detail": err.Error()})
		return
	}
	name := content.Slugify(strings.TrimSuffix(hdr.Filename, path.Ext(hdr.Filename)))
	if name == "" {
		name = "file"
	}
	name = fmt.Sprintf("%s-%d%s", name, time.Now().Unix(), sanitizeExt(path.Ext(hdr.Filename)))
	file := path.Join(cfg.MediaFolder, name)
	// ponytail: media always lands on the site branch, even in "pr" workflow; unused files stay if a draft is dropped.
	msg := fmt.Sprintf("content(media): upload %s\n\nUploaded by %s <%s> via Sumigo", name, sc.user.Name, sc.user.Email)
	if err := sc.gh.PutFile(r.Context(), file, sc.site.Branch, msg, data, "", sc.author()); err != nil {
		fail(w, err)
		return
	}
	_, public := mediaFolders(cfg)
	writeJSON(w, map[string]string{"path": file, "url": path.Join(public, name)})
}

// mediaFolders returns where media lives in the repo and the URL prefix the site serves it from.
func mediaFolders(cfg *content.Config) (string, string) {
	public := cfg.PublicFolder
	if public == "" {
		public = cfg.MediaFolder
	}
	return cfg.MediaFolder, "/" + strings.Trim(public, "/")
}

type mediaFile struct {
	Name string `json:"name"`
	Size int64  `json:"size"`
	URL  string `json:"url"`
	// Used is true when an entry, published or draft, mentions the file name.
	Used bool `json:"used"`
}

// listMedia lists the files at the root of the site media folder and flags the ones entries use.
func (a *API) listMedia(w http.ResponseWriter, r *http.Request) {
	sc, ok := a.site(w, r, store.RoleViewer)
	if !ok {
		return
	}
	cfg, err := a.config(r.Context(), sc, false)
	if err != nil {
		httpError(w, http.StatusBadGateway, "config", err.Error(), params{"detail": err.Error()})
		return
	}
	folder, public := mediaFolders(cfg)
	out := []mediaFile{}
	if folder == "" {
		writeJSON(w, out)
		return
	}
	files, err := sc.gh.ListDir(r.Context(), folder, sc.site.Branch)
	if err != nil {
		fail(w, err)
		return
	}
	texts, err := sc.entryTexts(r.Context(), cfg)
	if err != nil {
		fail(w, err)
		return
	}
	all := strings.Join(texts, "\n")
	for _, f := range files {
		if f.Type == "file" {
			out = append(out, mediaFile{Name: f.Name, Size: f.Size, URL: path.Join(public, f.Name), Used: strings.Contains(all, f.Name)})
		}
	}
	writeJSON(w, out)
}

// entryTexts returns the raw text of every entry of every collection, drafts included,
// in one GraphQL call per collection.
// ponytail: only entries are scanned, media used by templates or other repo files shows as unused.
func (sc *siteCtx) entryTexts(ctx context.Context, cfg *content.Config) ([]string, error) {
	pulls, err := sc.gh.ListPulls(ctx, branchPrefix)
	if err != nil {
		return nil, err
	}
	var texts []string
	for i := range cfg.Collections {
		col := &cfg.Collections[i]
		prefix := branchPrefix + col.Name + "/"
		var extra []string
		for _, p := range pulls {
			if strings.HasPrefix(p.Head.Ref, prefix) {
				for _, loc := range col.AllLocales() {
					extra = append(extra, p.Head.Ref+":"+col.Path(strings.TrimPrefix(p.Head.Ref, prefix), loc))
				}
			}
		}
		// The drafts are read with the first folder, the other locales only add their folder (multiple_folders).
		dirs := map[string]bool{}
		for _, loc := range col.AllLocales() {
			dir, _ := col.Dir(loc)
			if dirs[dir] {
				continue
			}
			dirs[dir] = true
			blobs, drafts, err := sc.gh.ReadDir(ctx, sc.site.Branch, dir, col.Ext(), extra)
			if err != nil {
				return nil, err
			}
			for _, b := range blobs {
				texts = append(texts, b.Text)
			}
			texts = append(texts, drafts...)
			extra = nil
		}
	}
	return texts, nil
}

// mediaPath resolves the {name} of a media route to its path in the repo.
func (a *API) mediaPath(w http.ResponseWriter, r *http.Request, min string) (*siteCtx, string, bool) {
	sc, ok := a.site(w, r, min)
	if !ok {
		return nil, "", false
	}
	cfg, err := a.config(r.Context(), sc, false)
	if err != nil {
		httpError(w, http.StatusBadGateway, "config", err.Error(), params{"detail": err.Error()})
		return nil, "", false
	}
	// The mux decodes %2F in {name}: validSlug keeps "x%2F..%2F..%2Fsumigo.yml" out of the media folder.
	name := r.PathValue("name")
	if cfg.MediaFolder == "" || !validSlug(name) {
		httpError(w, http.StatusNotFound, "not_found", "not found")
		return nil, "", false
	}
	return sc, path.Join(cfg.MediaFolder, name), true
}

// getMedia streams one media file from the forge, so images of private repos show in the CMS.
func (a *API) getMedia(w http.ResponseWriter, r *http.Request) {
	sc, file, ok := a.mediaPath(w, r, store.RoleViewer)
	if !ok {
		return
	}
	body, err := sc.gh.GetRaw(r.Context(), file, sc.site.Branch)
	if err != nil {
		fail(w, err)
		return
	}
	defer func() { _ = body.Close() }()
	if ct := mime.TypeByExtension(path.Ext(file)); ct != "" {
		w.Header().Set("Content-Type", ct)
	}
	// Uploaded files are untrusted: never let them run script on the CMS origin (SVG, HTML).
	w.Header().Set("Content-Security-Policy", "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Cache-Control", "private, max-age=300")
	_, _ = io.Copy(w, body)
}

// deleteMedia removes a media file with a commit on the site branch.
func (a *API) deleteMedia(w http.ResponseWriter, r *http.Request) {
	sc, file, ok := a.mediaPath(w, r, store.RolePublisher)
	if !ok {
		return
	}
	ctx := r.Context()
	_, sha, err := sc.gh.GetFile(ctx, file, sc.site.Branch)
	if err != nil {
		fail(w, err)
		return
	}
	msg := fmt.Sprintf("content(media): delete %s\n\nDeleted by %s <%s> via Sumigo", path.Base(file), sc.user.Name, sc.user.Email)
	if err := sc.gh.DeleteFile(ctx, file, sc.site.Branch, msg, sha, sc.author()); err != nil {
		fail(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func sanitizeExt(e string) string {
	s := content.Slugify(strings.TrimPrefix(e, "."))
	if s == "" {
		return ""
	}
	return "." + s
}

func (a *API) listPulls(w http.ResponseWriter, r *http.Request) {
	sc, ok := a.site(w, r, store.RoleViewer)
	if !ok {
		return
	}
	pulls, err := sc.gh.ListPulls(r.Context(), branchPrefix)
	if err != nil {
		fail(w, err)
		return
	}
	a.markScheduled(sc.site.ID, pulls)
	writeJSON(w, pulls)
}

func (a *API) mergePull(w http.ResponseWriter, r *http.Request) {
	sc, ok := a.site(w, r, store.RoleEditor)
	if !ok {
		return
	}
	p, ok := a.publishablePull(w, r, sc)
	if !ok {
		return
	}
	if err := a.publish(r.Context(), sc, p, "published"); err != nil {
		fail(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// publishablePull checks the user can publish on the site and returns the CMS pull request {number}.
func (a *API) publishablePull(w http.ResponseWriter, r *http.Request, sc *siteCtx) (*forge.Pull, bool) {
	if !sc.canPublish() {
		httpError(w, http.StatusForbidden, "publisher_only", "only publishers can publish on this site")
		return nil, false
	}
	n, _ := strconv.Atoi(r.PathValue("number"))
	pulls, err := sc.gh.ListPulls(r.Context(), branchPrefix)
	if err != nil {
		fail(w, err)
		return nil, false
	}
	for i := range pulls {
		if pulls[i].Number == n {
			return &pulls[i], true
		}
	}
	httpError(w, http.StatusNotFound, "no_cms_pull", "no open CMS pull request with this number")
	return nil, false
}

// canPublish: on a review site only publishers put entries live, editors save drafts for them.
func (sc *siteCtx) canPublish() bool {
	min := store.RoleEditor
	if sc.site.Workflow == "pr" {
		min = store.RolePublisher
	}
	return store.RoleAtLeast(sc.site.Role, min)
}

// publish squash-merges a draft pull request, deletes its branch and drops its schedule.
// how ends up in the commit title: "published by Jane", "scheduled by Jane".
func (a *API) publish(ctx context.Context, sc *siteCtx, p *forge.Pull, how string) error {
	title := fmt.Sprintf("%s (#%d, %s by %s)", p.Title, p.Number, how, sc.user.Name)
	if err := sc.gh.MergePull(ctx, p.Number, title); err != nil {
		return err
	}
	_ = sc.gh.DeleteBranch(ctx, p.Head.Ref)
	return a.Store.DeleteSchedule(sc.site.ID, p.Number)
}

// markScheduled fills ScheduledAt on the pull requests that have a planned publication.
func (a *API) markScheduled(siteID int64, pulls []forge.Pull) {
	// Display only: a read error just hides the dates, the scheduler still runs.
	at, _ := a.Store.Schedules(siteID)
	for i := range pulls {
		if t, ok := at[pulls[i].Number]; ok {
			pulls[i].ScheduledAt = &t
		}
	}
}

// entryHistory lists the commits that changed an entry, on its draft branch when it has one.
func (a *API) entryHistory(w http.ResponseWriter, r *http.Request) {
	sc, col, ok := a.collection(w, r, store.RoleViewer)
	if !ok {
		return
	}
	slug := r.PathValue("slug")
	if !validSlug(slug) {
		httpError(w, http.StatusBadRequest, "invalid_slug", "invalid slug")
		return
	}
	loc, ok := locale(w, r, col)
	if !ok {
		return
	}
	ref := sc.site.Branch
	pr, err := sc.draft(r.Context(), branchPrefix+col.Name+"/"+slug)
	if err != nil {
		fail(w, err)
		return
	}
	if pr != nil {
		ref = pr.Head.Ref
	}
	file, _, err := sc.entryFile(r.Context(), col, slug, loc, ref)
	if err != nil {
		fail(w, err)
		return
	}
	if file == "" {
		writeJSON(w, []forge.Commit{})
		return
	}
	commits, err := sc.gh.ListCommits(r.Context(), file, ref)
	if err != nil {
		fail(w, err)
		return
	}
	writeJSON(w, commits)
}

// entryVersion returns an entry as it was at a commit, to preview or restore it, with the diff that commit made.
func (a *API) entryVersion(w http.ResponseWriter, r *http.Request) {
	sc, col, ok := a.collection(w, r, store.RoleViewer)
	if !ok {
		return
	}
	slug, sha := r.PathValue("slug"), r.PathValue("sha")
	if !validSlug(slug) || !isHex(sha) {
		httpError(w, http.StatusBadRequest, "invalid_slug", "invalid slug")
		return
	}
	loc, ok := locale(w, r, col)
	if !ok {
		return
	}
	file, _, err := sc.entryFile(r.Context(), col, slug, loc, sha)
	if err != nil {
		fail(w, err)
		return
	}
	if file == "" {
		httpError(w, http.StatusNotFound, "not_found", "not found")
		return
	}
	raw, _, err := sc.gh.GetFile(r.Context(), file, sha)
	if err != nil {
		fail(w, err)
		return
	}
	data, body, err := content.Parse(raw)
	if err != nil {
		httpError(w, http.StatusUnprocessableEntity, "front_matter", "cannot parse front matter: "+err.Error(), params{"detail": err.Error()})
		return
	}
	data[content.BodyField] = body
	patch, err := sc.gh.CommitPatch(r.Context(), sha, file)
	if err != nil {
		fail(w, err)
		return
	}
	writeJSON(w, map[string]any{"data": data, "patch": patch})
}

func isEmptyList(v any) bool {
	l, ok := v.([]any)
	return ok && len(l) == 0
}

func isHex(s string) bool {
	_, err := hex.DecodeString(s)
	return len(s) == 40 && err == nil
}
