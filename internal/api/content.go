package api

import (
	"context"
	"fmt"
	"io"
	"mime"
	"net/http"
	"path"
	"strconv"
	"strings"
	"time"

	"github.com/ermos/sumigo/internal/content"
	"github.com/ermos/sumigo/internal/github"
	"github.com/ermos/sumigo/internal/store"
)

// Branches opened by the CMS in "pr" workflow: cms/<collection>/<slug>.
const branchPrefix = "cms/"

// ponytail: config cached per site for configTTL, edits to sumigo.yml show up after that (or on "Test GitHub access").
const configTTL = time.Minute

type cachedConfig struct {
	cfg *content.Config
	at  time.Time
}

type siteCtx struct {
	site *store.Site
	user *store.User
	gh   *github.Client
}

func (sc *siteCtx) author() github.Author {
	return github.Author{Name: sc.user.Name, Email: sc.user.Email}
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
		sc.gh = a.NewGitHub(token, st.Repo)
	} else if r.Pattern != "GET /api/sites/{site}" {
		httpError(w, http.StatusConflict, "no_token", "this site has no GitHub token configured")
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
	if github.IsNotFound(err) {
		return nil, fmt.Errorf("%s not found at the root of branch %s", content.ConfigFile, sc.site.Branch)
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

func entryPath(c *content.Collection, slug string) string { return path.Join(c.Folder, slug+c.Ext()) }

func validSlug(s string) bool {
	return s != "" && !strings.HasPrefix(s, ".") && !strings.ContainsAny(s, `/\`)
}

// draft returns the open CMS pull request for an entry, or nil.
func (sc *siteCtx) draft(ctx context.Context, branch string) (*github.Pull, error) {
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
	Slug  string       `json:"slug"`
	Path  string       `json:"path"`
	Title string       `json:"title"`
	Date  any          `json:"date,omitempty"`
	Draft *github.Pull `json:"draft,omitempty"`
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
	blobs, drafts, err := sc.gh.ReadDir(r.Context(), sc.site.Branch, col.Folder, extra)
	if err != nil {
		fail(w, err)
		return
	}
	entries := []entrySummary{}
	index := map[string]int{}
	for _, b := range blobs {
		if strings.HasSuffix(b.Name, col.Ext()) {
			slug := strings.TrimSuffix(b.Name, col.Ext())
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
	writeJSON(w, entries)
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
	ref := sc.site.Branch
	pr, err := sc.draft(r.Context(), branchPrefix+col.Name+"/"+slug)
	if err != nil {
		fail(w, err)
		return
	}
	if pr != nil {
		ref = pr.Head.Ref
	}
	raw, _, err := sc.gh.GetFile(r.Context(), entryPath(col, slug), ref)
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
	for _, f := range col.Fields {
		if v := in.Data[f.Name]; f.IsRequired() && f.Widget != "boolean" && (v == nil || v == "") {
			httpError(w, http.StatusBadRequest, "field_required", "field "+f.Name+" is required", params{"field": f.Name})
			return
		}
	}
	if in.Publish && sc.site.Workflow == "pr" && !store.RoleAtLeast(sc.site.Role, store.RolePublisher) {
		httpError(w, http.StatusForbidden, "publisher_only_draft", "only publishers can publish on this site, save a draft instead")
		return
	}
	creating := r.Method == http.MethodPost
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
	raw, err := content.Render(col.Fields, in.Data)
	if err != nil {
		httpError(w, http.StatusBadRequest, "invalid_data", err.Error(), params{"detail": err.Error()})
		return
	}

	ctx := r.Context()
	file := entryPath(col, slug)
	branch := sc.site.Branch
	pr, err := sc.draft(ctx, branchPrefix+col.Name+"/"+slug)
	if err != nil {
		fail(w, err)
		return
	}
	if creating {
		if _, _, err := sc.gh.GetFile(ctx, file, sc.site.Branch); err == nil || pr != nil {
			httpError(w, http.StatusConflict, "slug_exists", "an entry with slug "+slug+" already exists", params{"slug": slug})
			return
		} else if !github.IsNotFound(err) {
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
			// 422: branch left over from a closed PR, reuse it.
			if err := sc.gh.CreateBranch(ctx, branch, base); err != nil && !github.IsStatus(err, http.StatusUnprocessableEntity) {
				fail(w, err)
				return
			}
		}
	}
	_, sha, err := sc.gh.GetFile(ctx, file, branch)
	if err != nil && !github.IsNotFound(err) {
		fail(w, err)
		return
	}
	action := "update"
	if sha == "" {
		action = "create"
	}
	msg := fmt.Sprintf("content(%s): %s %s\n\nEdited by %s <%s> via Sumigo", col.Name, action, slug, sc.user.Name, sc.user.Email)
	if err := sc.gh.PutFile(ctx, file, branch, msg, raw, sha, sc.author()); err != nil {
		fail(w, err)
		return
	}
	if viaDraft && pr == nil {
		title := fmt.Sprintf("content(%s): %s %s (by %s)", col.Name, action, slug, sc.user.Name)
		body := fmt.Sprintf("Opened from Sumigo by **%s** (%s).", sc.user.Name, sc.user.Email)
		if pr, err = sc.gh.CreatePull(ctx, title, branch, sc.site.Branch, body); err != nil {
			fail(w, err)
			return
		}
	}
	if in.Publish && viaDraft {
		title := fmt.Sprintf("%s (#%d, published by %s)", pr.Title, pr.Number, sc.user.Name)
		if err := sc.gh.MergePull(ctx, pr.Number, title); err != nil {
			fail(w, err)
			return
		}
		_ = sc.gh.DeleteBranch(ctx, branch)
		pr = nil
	}
	writeJSON(w, map[string]any{"slug": slug, "draft": pr})
}

func (a *API) deleteEntry(w http.ResponseWriter, r *http.Request) {
	sc, col, ok := a.collection(w, r, store.RolePublisher)
	if !ok {
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
		// Deleting the branch closes the draft PR.
		if err := sc.gh.DeleteBranch(ctx, branch); err != nil {
			fail(w, err)
			return
		}
	}
	file := entryPath(col, slug)
	_, sha, err := sc.gh.GetFile(ctx, file, sc.site.Branch)
	if github.IsNotFound(err) && pr != nil {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if err != nil {
		fail(w, err)
		return
	}
	msg := fmt.Sprintf("content(%s): delete %s\n\nDeleted by %s <%s> via Sumigo", col.Name, slug, sc.user.Name, sc.user.Email)
	if err := sc.gh.DeleteFile(ctx, file, sc.site.Branch, msg, sha, sc.author()); err != nil {
		fail(w, err)
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
				extra = append(extra, p.Head.Ref+":"+entryPath(col, strings.TrimPrefix(p.Head.Ref, prefix)))
			}
		}
		blobs, drafts, err := sc.gh.ReadDir(ctx, sc.site.Branch, col.Folder, extra)
		if err != nil {
			return nil, err
		}
		for _, b := range blobs {
			texts = append(texts, b.Text)
		}
		texts = append(texts, drafts...)
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
	name := r.PathValue("name")
	if cfg.MediaFolder == "" || name == "" || strings.HasPrefix(name, ".") {
		httpError(w, http.StatusNotFound, "not_found", "not found")
		return nil, "", false
	}
	return sc, path.Join(cfg.MediaFolder, name), true
}

// getMedia streams one media file from GitHub, so images of private repos show in the CMS.
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
	writeJSON(w, pulls)
}

func (a *API) mergePull(w http.ResponseWriter, r *http.Request) {
	sc, ok := a.site(w, r, store.RoleEditor)
	if !ok {
		return
	}
	if sc.site.Workflow == "pr" && !store.RoleAtLeast(sc.site.Role, store.RolePublisher) {
		httpError(w, http.StatusForbidden, "publisher_only", "only publishers can publish on this site")
		return
	}
	n, _ := strconv.Atoi(r.PathValue("number"))
	ctx := r.Context()
	pulls, err := sc.gh.ListPulls(ctx, branchPrefix)
	if err != nil {
		fail(w, err)
		return
	}
	for _, p := range pulls {
		if p.Number != n {
			continue
		}
		title := fmt.Sprintf("%s (#%d, published by %s)", p.Title, p.Number, sc.user.Name)
		if err := sc.gh.MergePull(ctx, n, title); err != nil {
			fail(w, err)
			return
		}
		_ = sc.gh.DeleteBranch(ctx, p.Head.Ref)
		w.WriteHeader(http.StatusNoContent)
		return
	}
	httpError(w, http.StatusNotFound, "no_cms_pull", "no open CMS pull request with this number")
}
