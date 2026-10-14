package api

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/ermos/sumigo/internal/ai"
	"github.com/ermos/sumigo/internal/forge"
	"github.com/ermos/sumigo/internal/store"
)

const testConfig = `
media_folder: static/img
collections:
  - name: posts
    folder: content/posts
    fields:
      - {name: title, widget: string}
      - {name: body, widget: markdown, required: false}
  - name: pages
    files: [{name: about, file: about.md}]
`

// fakeGitHub records write calls and answers the few reads the CMS needs.
type fakeGitHub struct {
	mu      sync.Mutex
	writes  []string
	bodies  []map[string]any
	auth    string
	graphql map[string]any
	// pulls, when set, answers GET /pulls.
	pulls string
}

func (f *fakeGitHub) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.auth = r.Header.Get("Authorization")
	p := strings.TrimPrefix(r.URL.Path, "/repos/acme/blog")
	switch {
	case r.URL.Path == "/graphql":
		var body struct{ Variables map[string]any }
		_ = json.NewDecoder(r.Body).Decode(&body)
		f.graphql = body.Variables
		_, _ = w.Write([]byte(`{"data":{"repository":{
			"dir":{"entries":[{"name":"old.md","type":"blob","object":{"text":"---\ntitle: Old post\ncover: /static/img/cat.svg\n---\n"}},{"name":"img","type":"tree","object":{}}]},
			"e0":{"text":"---\ntitle: Draft post\n---\n"}}}}`))
	case r.Method == http.MethodGet && p == "/contents/sumigo.yml":
		_ = json.NewEncoder(w).Encode(map[string]string{"content": base64.StdEncoding.EncodeToString([]byte(testConfig)), "sha": "c1"})
	case r.Method == http.MethodGet && p == "/pulls" && f.pulls != "":
		_, _ = w.Write([]byte(f.pulls))
	case r.Method == http.MethodGet && p == "/pulls" && len(f.writes) > 0:
		_, _ = w.Write([]byte(`[{"number":7,"head":{"ref":"cms/posts/hello-world"}}]`))
	case r.Method == http.MethodGet && p == "/pulls":
		_, _ = w.Write([]byte("[]"))
	case r.Method == http.MethodGet && p == "/commits" && r.URL.Query().Get("path") == "content/posts/old.md":
		_, _ = w.Write([]byte(`[{"sha":"` + strings.Repeat("a", 40) + `","commit":{"message":"content(posts): update old\n\nEdited by Jane via Sumigo","author":{"name":"Jane","date":"2026-10-01T09:00:00Z"}}}]`))
	case r.Method == http.MethodGet && p == "/contents/content/posts/old.md" && r.URL.Query().Get("ref") == strings.Repeat("a", 40):
		_ = json.NewEncoder(w).Encode(map[string]string{"content": base64.StdEncoding.EncodeToString([]byte("---\ntitle: Old title\n---\nOld body\n"))})
	case r.Method == http.MethodGet && p == "/commits/"+strings.Repeat("a", 40):
		_, _ = w.Write([]byte(`{"files":[{"filename":"static/x.png"},{"filename":"content/posts/old.md","patch":"@@ -1 +1 @@\n-title: Older\n+title: Old title"}]}`))
	case r.Method == http.MethodGet && strings.HasPrefix(p, "/git/ref/heads/"):
		_, _ = w.Write([]byte(`{"object":{"sha":"base123"}}`))
	case r.Method == http.MethodGet && p == "/contents/static/img":
		_, _ = w.Write([]byte(`[{"name":"cat.svg","type":"file","size":3},{"name":"dog.png","type":"file","size":5},{"name":"old","type":"dir"}]`))
	case r.Method == http.MethodGet && p == "/contents/static/img/cat.svg" && strings.Contains(r.Header.Get("Accept"), "raw"):
		_, _ = w.Write([]byte("<svg/>"))
	case r.Method == http.MethodGet:
		w.WriteHeader(http.StatusNotFound)
	default:
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		f.writes = append(f.writes, r.Method+" "+p)
		f.bodies = append(f.bodies, body)
		_, _ = w.Write([]byte(`{"number":7,"head":{"ref":"cms/posts/hello-world"}}`))
	}
}

func TestPRWorkflowCommitsAsCMSUser(t *testing.T) {
	st, err := store.Open(filepath.Join(t.TempDir(), "t.db"), "test-secret-key-123")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = st.Close() }()

	gh := &fakeGitHub{}
	ghSrv := httptest.NewServer(gh)
	defer ghSrv.Close()

	a := &API{Store: st, NewForge: func(_, _, token, repo string) forge.Forge {
		return forge.NewGitHub(token, repo, ghSrv.URL)
	}}
	srv := httptest.NewServer(a.Handler())
	defer srv.Close()

	editor := &store.User{Email: "jane@acme.io", Name: "Jane Doe"}
	viewer := &store.User{Email: "bob@acme.io", Name: "Bob"}
	for _, u := range []*store.User{editor, viewer} {
		if err := st.CreateUser(u, "password123"); err != nil {
			t.Fatal(err)
		}
	}
	site := &store.Site{Name: "Blog", Repo: "acme/blog", Branch: "main", Workflow: "pr", Token: "ghp_secret"}
	if err := st.SaveSite(site); err != nil {
		t.Fatal(err)
	}
	if err := st.SetAccess(site.ID, []store.Access{{UserID: editor.ID, Role: store.RoleEditor}, {UserID: viewer.ID, Role: store.RoleViewer}}); err != nil {
		t.Fatal(err)
	}

	do := func(u *store.User, method, url, body string) *http.Response {
		token, _ := st.CreateSession(u.ID, time.Hour)
		req, _ := http.NewRequest(method, srv.URL+url, strings.NewReader(body))
		req.AddCookie(&http.Cookie{Name: sessionCookie, Value: token})
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		return res
	}
	call := func(u *store.User, method, body string) *http.Response {
		return do(u, method, "/api/sites/1/collections/posts/entries", body)
	}
	post := func(u *store.User, body string) *http.Response { return call(u, http.MethodPost, body) }
	autosaved := func() string {
		b, _ := io.ReadAll(do(editor, http.MethodGet, "/api/sites/1/collections/posts/autosave", "").Body)
		return string(b)
	}

	if res := post(viewer, `{"data":{"title":"Hello World"}}`); res.StatusCode != http.StatusForbidden {
		t.Fatalf("viewer must not write, got %d", res.StatusCode)
	}
	if res := post(editor, `{"data":{"body":"no title"}}`); res.StatusCode != http.StatusBadRequest {
		t.Fatalf("required field not enforced, got %d", res.StatusCode)
	}
	// The form of a new entry is autosaved without a commit, and dropped once the entry is saved.
	if res := do(editor, http.MethodPut, "/api/sites/1/collections/posts/autosave", `{"data":{"title":"Hel"}}`); res.StatusCode != http.StatusNoContent {
		t.Fatalf("autosave failed: %d", res.StatusCode)
	}
	if got := autosaved(); !strings.Contains(got, `"data":{"title":"Hel"}`) || len(gh.writes) != 0 {
		t.Fatalf("autosave = %s, writes = %v", got, gh.writes)
	}
	res := post(editor, `{"data":{"title":"Hello World","body":"Hi"}}`)
	if res.StatusCode != http.StatusOK {
		b, _ := io.ReadAll(res.Body)
		t.Fatalf("save failed: %d %s", res.StatusCode, b)
	}
	if got := autosaved(); strings.TrimSpace(got) != "null" {
		t.Fatalf("autosave left after save: %s", got)
	}

	want := []string{"POST /git/refs", "PUT /contents/content/posts/hello-world.md", "POST /pulls"}
	if strings.Join(gh.writes, ",") != strings.Join(want, ",") {
		t.Fatalf("writes = %v, want %v", gh.writes, want)
	}
	if gh.auth != "Bearer ghp_secret" {
		t.Fatalf("token not decrypted/used: %q", gh.auth)
	}
	put := gh.bodies[1]
	author := put["author"].(map[string]any)
	if put["branch"] != "cms/posts/hello-world" || author["name"] != "Jane Doe" || author["email"] != "jane@acme.io" {
		t.Fatalf("bad commit: %v", put)
	}
	if title := gh.bodies[2]["title"].(string); !strings.Contains(title, "Jane Doe") {
		t.Fatalf("PR title lacks author: %q", title)
	}

	// Listing: one GraphQL call returns published entries and PR drafts with their titles.
	res = call(viewer, http.MethodGet, "")
	var entries []entrySummary
	_ = json.NewDecoder(res.Body).Decode(&entries)
	if len(entries) != 2 || entries[0].Title != "Old post" || entries[1].Title != "Draft post" || entries[1].Draft == nil || entries[1].Data["title"] != "Draft post" {
		t.Fatalf("entries = %+v", entries)
	}
	if gh.graphql["dir"] != "main:content/posts" || gh.graphql["e0"] != "cms/posts/hello-world:content/posts/hello-world.md" {
		t.Fatalf("graphql vars = %v", gh.graphql)
	}

	// Publishing: editors cannot on a review site; on a direct site it merges the existing draft.
	publish := func() *http.Response {
		token, _ := st.CreateSession(editor.ID, time.Hour)
		req, _ := http.NewRequest(http.MethodPut, srv.URL+"/api/sites/1/collections/posts/entries/hello-world", strings.NewReader(`{"data":{"title":"Hello World"},"publish":true}`))
		req.AddCookie(&http.Cookie{Name: sessionCookie, Value: token})
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		return res
	}
	res = publish()
	var body struct{ Code string }
	_ = json.NewDecoder(res.Body).Decode(&body)
	// The web app translates errors by code.
	if res.StatusCode != http.StatusForbidden || body.Code != "publisher_only_draft" {
		t.Fatalf("editor published on a review site: %d %q", res.StatusCode, body.Code)
	}
	// Deleting: editors cannot delete on a review site, but can drop their draft and keep the published version.
	del := func(query string) *http.Response {
		token, _ := st.CreateSession(editor.ID, time.Hour)
		req, _ := http.NewRequest(http.MethodDelete, srv.URL+"/api/sites/1/collections/posts/entries/hello-world"+query, nil)
		req.AddCookie(&http.Cookie{Name: sessionCookie, Value: token})
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		return res
	}
	if res := del(""); res.StatusCode != http.StatusForbidden {
		t.Fatalf("editor deleted on a review site: %d", res.StatusCode)
	}
	before := len(gh.writes)
	if res := del("?only=draft"); res.StatusCode != http.StatusNoContent {
		t.Fatalf("discard draft failed: %d", res.StatusCode)
	}
	if got := gh.writes[before:]; strings.Join(got, ",") != "DELETE /git/refs/heads/cms/posts/hello-world" {
		t.Fatalf("discard writes = %v", got)
	}
	site.Workflow = "direct"
	if err := st.SaveSite(site); err != nil {
		t.Fatal(err)
	}
	before = len(gh.writes)
	if res := publish(); res.StatusCode != http.StatusOK {
		b, _ := io.ReadAll(res.Body)
		t.Fatalf("publish failed: %d %s", res.StatusCode, b)
	}
	want = []string{"PUT /contents/content/posts/hello-world.md", "PUT /pulls/7/merge", "DELETE /git/refs/heads/cms/posts/hello-world"}
	if got := gh.writes[before:]; strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("publish writes = %v, want %v", got, want)
	}
}

func TestMediaAndHistoryAreServed(t *testing.T) {
	st, err := store.Open(filepath.Join(t.TempDir(), "t.db"), "test-secret-key-123")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = st.Close() }()
	ghSrv := httptest.NewServer(&fakeGitHub{})
	defer ghSrv.Close()
	a := &API{Store: st, NewForge: func(_, _, token, repo string) forge.Forge {
		return forge.NewGitHub(token, repo, ghSrv.URL)
	}}
	srv := httptest.NewServer(a.Handler())
	defer srv.Close()

	viewer := &store.User{Email: "bob@acme.io", Name: "Bob"}
	if err := st.CreateUser(viewer, "password123"); err != nil {
		t.Fatal(err)
	}
	site := &store.Site{Name: "Blog", Repo: "acme/blog", Branch: "main", Workflow: "direct", Token: "ghp_secret"}
	if err := st.SaveSite(site); err != nil {
		t.Fatal(err)
	}
	if err := st.SetAccess(site.ID, []store.Access{{UserID: viewer.ID, Role: store.RoleViewer}}); err != nil {
		t.Fatal(err)
	}
	token, _ := st.CreateSession(viewer.ID, time.Hour)
	get := func(path string) (*http.Response, string) {
		req, _ := http.NewRequest(http.MethodGet, srv.URL+path, nil)
		req.AddCookie(&http.Cookie{Name: sessionCookie, Value: token})
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		b, _ := io.ReadAll(res.Body)
		return res, string(b)
	}

	want := `[{"name":"cat.svg","size":3,"url":"/static/img/cat.svg","used":true},{"name":"dog.png","size":5,"url":"/static/img/dog.png","used":false}]` + "\n"
	if _, body := get("/api/sites/1/media"); body != want {
		t.Fatalf("list: %s", body)
	}
	res, body := get("/api/sites/1/media/cat.svg")
	if body != "<svg/>" || res.Header.Get("Content-Type") != "image/svg+xml" {
		t.Fatalf("file: %q %s", body, res.Header.Get("Content-Type"))
	}
	if !strings.Contains(res.Header.Get("Content-Security-Policy"), "sandbox") {
		t.Fatal("uploaded files must be served sandboxed")
	}

	// History: versions of an entry, then one version's content to restore.
	if _, body := get("/api/sites/1/collections/posts/entries/old/history"); !strings.Contains(body, `"message":"content(posts): update old","author":"Jane"`) {
		t.Fatalf("history: %s", body)
	}
	if _, body := get("/api/sites/1/collections/posts/entries/old/history/" + strings.Repeat("a", 40)); !strings.Contains(body, `"title":"Old title"`) || !strings.Contains(body, "Old body") || !strings.Contains(body, `+title: Old title`) {
		t.Fatalf("version: %s", body)
	}

	req, _ := http.NewRequest(http.MethodDelete, srv.URL+"/api/sites/1/media/dog.png", nil)
	req.AddCookie(&http.Cookie{Name: sessionCookie, Value: token})
	if res, err := http.DefaultClient.Do(req); err != nil || res.StatusCode != http.StatusForbidden {
		t.Fatalf("viewer must not delete media: %v %v", err, res.StatusCode)
	}
}

// newTestAPI wires the API to a fake GitHub and a fresh database.
func newTestAPI(t *testing.T, gh http.Handler) (*API, *store.Store) {
	t.Helper()
	st, err := store.Open(filepath.Join(t.TempDir(), "t.db"), "test-secret-key-123")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	ghSrv := httptest.NewServer(gh)
	t.Cleanup(ghSrv.Close)
	return &API{Store: st, NewForge: func(_, _, token, repo string) forge.Forge {
		return forge.NewGitHub(token, repo, ghSrv.URL)
	}}, st
}

func TestSchedulerPublishesDueDrafts(t *testing.T) {
	gh := &fakeGitHub{pulls: `[{"number":7,"title":"content(posts): create hello","head":{"ref":"cms/posts/hello"}}]`}
	a, st := newTestAPI(t, gh)
	jane := &store.User{Email: "jane@acme.io", Name: "Jane"}
	if err := st.CreateUser(jane, "password123"); err != nil {
		t.Fatal(err)
	}
	site := &store.Site{Name: "Blog", Repo: "acme/blog", Branch: "main", Workflow: "pr", Token: "ghp_secret"}
	if err := st.SaveSite(site); err != nil {
		t.Fatal(err)
	}
	if err := st.SetAccess(site.ID, []store.Access{{UserID: jane.ID, Role: store.RolePublisher}}); err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	for n, at := range map[int]time.Time{7: now.Add(-time.Minute), 8: now.Add(time.Hour)} {
		if err := st.SetSchedule(store.Schedule{SiteID: site.ID, PullNumber: n, PublishAt: at, UserID: jane.ID}); err != nil {
			t.Fatal(err)
		}
	}

	a.publishDue(context.Background(), now)

	want := []string{"PUT /pulls/7/merge", "DELETE /git/refs/heads/cms/posts/hello"}
	if strings.Join(gh.writes, ",") != strings.Join(want, ",") {
		t.Fatalf("writes = %v, want %v", gh.writes, want)
	}
	if title := gh.bodies[0]["commit_title"]; title != "content(posts): create hello (#7, scheduled by Jane)" {
		t.Fatalf("merge title = %q", title)
	}
	left, _ := st.Schedules(site.ID)
	if _, ok := left[7]; ok || len(left) != 1 {
		t.Fatalf("schedules left = %v, want only #8", left)
	}
}

func TestAIAssistantIsGatedAndKeepsTheKeySecret(t *testing.T) {
	a, st := newTestAPI(t, &fakeGitHub{})
	var gotKey, gotPrompt string
	claude := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotKey = r.Header.Get("x-api-key")
		var body struct{ Messages []struct{ Content string } }
		_ = json.NewDecoder(r.Body).Decode(&body)
		gotPrompt = body.Messages[0].Content
		_, _ = w.Write([]byte(`{"content":[{"type":"text","text":"A short description."}]}`))
	}))
	defer claude.Close()
	a.NewAI = func(cfg ai.Config) *ai.Client {
		cfg.BaseURL = claude.URL
		return ai.New(cfg)
	}
	srv := httptest.NewServer(a.Handler())
	defer srv.Close()

	admin := &store.User{Email: "root@acme.io", Name: "Root", IsAdmin: true}
	if err := st.CreateUser(admin, "password123"); err != nil {
		t.Fatal(err)
	}
	site := &store.Site{Name: "Blog", Repo: "acme/blog", Branch: "main", Workflow: "direct", Token: "ghp_secret"}
	if err := st.SaveSite(site); err != nil {
		t.Fatal(err)
	}
	token, _ := st.CreateSession(admin.ID, time.Hour)
	call := func(method, path, body string) (int, string) {
		req, _ := http.NewRequest(method, srv.URL+path, strings.NewReader(body))
		req.AddCookie(&http.Cookie{Name: sessionCookie, Value: token})
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		b, _ := io.ReadAll(res.Body)
		return res.StatusCode, string(b)
	}
	assist := func() (int, string) {
		return call(http.MethodPost, "/api/sites/1/collections/posts/ai", `{"action":"write","field":"title","data":{"body":"Hi"}}`)
	}

	if code, body := assist(); code != http.StatusForbidden || !strings.Contains(body, "ai_disabled") {
		t.Fatalf("assistant must be off by default: %d %s", code, body)
	}
	if code, body := call(http.MethodPut, "/api/settings/ai", `{"enabled":true,"provider":"anthropic","api_key":"sk-ant-secret"}`); code != http.StatusOK || strings.Contains(body, "sk-ant") {
		t.Fatalf("save settings: %d %s", code, body)
	}
	// Enabled for the instance but not for the site yet.
	if code, _ := assist(); code != http.StatusForbidden {
		t.Fatalf("site opt-in not enforced: %d", code)
	}
	site.AIEnabled = true
	if err := st.SaveSite(site); err != nil {
		t.Fatal(err)
	}
	if code, body := assist(); code != http.StatusOK || !strings.Contains(body, "A short description.") || gotKey != "sk-ant-secret" {
		t.Fatalf("assist: %d %s (key %q)", code, body, gotKey)
	}
	// Writing the body sends the editor's brief, with the article rules.
	if code, _ := call(http.MethodPost, "/api/sites/1/collections/posts/ai", `{"action":"write","field":"body","brief":"Why cats nap","data":{"title":"Cats"}}`); code != http.StatusOK ||
		!strings.Contains(gotPrompt, "Why cats nap") || !strings.Contains(gotPrompt, "Article rules") {
		t.Fatalf("body prompt: %d %q", code, gotPrompt)
	}
}

func TestSiteRepoFollowsTheForge(t *testing.T) {
	a, st := newTestAPI(t, &fakeGitHub{})
	srv := httptest.NewServer(a.Handler())
	defer srv.Close()
	admin := &store.User{Email: "root@acme.io", Name: "Root", IsAdmin: true}
	if err := st.CreateUser(admin, "password123"); err != nil {
		t.Fatal(err)
	}
	token, _ := st.CreateSession(admin.ID, time.Hour)
	for body, want := range map[string]int{
		`{"name":"P","forge":"gitlab","forge_url":"https://gitlab.com","repo":"smiti-agency/portfolio/marianne-derouet"}`: http.StatusOK,
		`{"name":"P","forge":"github","repo":"acme/web/blog"}`:                                                            http.StatusBadRequest,
		`{"name":"P","forge":"gitea","repo":"acme/blog"}`:                                                                 http.StatusBadRequest,
	} {
		req, _ := http.NewRequest(http.MethodPost, srv.URL+"/api/sites", strings.NewReader(body))
		req.AddCookie(&http.Cookie{Name: sessionCookie, Value: token})
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		if res.StatusCode != want {
			t.Errorf("%s: got %d, want %d", body, res.StatusCode, want)
		}
	}
}

func TestCustomDomainsOpenASiteAndAllowCORSLive(t *testing.T) {
	a, st := newTestAPI(t, &fakeGitHub{})
	srv := httptest.NewServer(a.Handler())
	defer srv.Close()
	admin := &store.User{Email: "root@acme.io", Name: "Root", IsAdmin: true}
	if err := st.CreateUser(admin, "password123"); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"Blog", "Shop"} {
		if err := st.SaveSite(&store.Site{Name: name, Repo: "acme/" + name, Branch: "main", Workflow: "direct"}); err != nil {
			t.Fatal(err)
		}
	}
	token, _ := st.CreateSession(admin.ID, time.Hour)
	call := func(method, path, body string, header map[string]string) *http.Response {
		req, _ := http.NewRequest(method, srv.URL+path, strings.NewReader(body))
		req.AddCookie(&http.Cookie{Name: sessionCookie, Value: token})
		for k, v := range header {
			req.Header.Set(k, v)
		}
		if k, ok := header["Host"]; ok {
			req.Host = k
		}
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		return res
	}
	allowed := func() string {
		return call(http.MethodGet, "/api/me", "", map[string]string{"Origin": "https://cms.acme.io"}).Header.Get("Access-Control-Allow-Origin")
	}

	if got := allowed(); got != "" {
		t.Fatalf("unknown origin allowed: %q", got)
	}
	if res := call(http.MethodPut, "/api/sites/1", `{"name":"S","repo":"acme/s","domains":["https://CMS.acme.io/","bad domain"]}`, nil); res.StatusCode != http.StatusBadRequest {
		t.Fatalf("invalid domain accepted: %d", res.StatusCode)
	}
	if res := call(http.MethodPut, "/api/sites/1", `{"name":"S","repo":"acme/s","domains":["https://CMS.acme.io/"]}`, nil); res.StatusCode != http.StatusOK {
		t.Fatalf("set domains: %d", res.StatusCode)
	}
	if res := call(http.MethodPost, "/api/sites", `{"name":"New","repo":"acme/new","domains":["cms.acme.io"]}`, nil); res.StatusCode != http.StatusConflict {
		t.Fatalf("new site with a taken domain: %d", res.StatusCode)
	}
	if sites, _ := st.ListSites(admin); len(sites) != 2 {
		t.Fatalf("rejected domain left a site behind: %d sites", len(sites))
	}
	if got := allowed(); got != "https://cms.acme.io" {
		t.Fatalf("declared origin not allowed right away: %q", got)
	}
	if res := call(http.MethodPut, "/api/sites/2", `{"name":"S","repo":"acme/s","domains":["cms.acme.io"]}`, nil); res.StatusCode != http.StatusConflict {
		t.Fatalf("domain of another site: %d", res.StatusCode)
	}
	if res := call(http.MethodGet, "/api/domains/check?domain=cms.acme.io", "", nil); res.StatusCode != http.StatusNoContent {
		t.Fatalf("check declared domain: %d", res.StatusCode)
	}
	var cur struct {
		SiteID int64 `json:"site_id"`
	}
	_ = json.NewDecoder(call(http.MethodGet, "/api/domain", "", map[string]string{"Host": "cms.acme.io:443"}).Body).Decode(&cur)
	if cur.SiteID != 1 {
		t.Fatalf("domain opens site %d, want 1", cur.SiteID)
	}

	if res := call(http.MethodPut, "/api/sites/1", `{"name":"S","repo":"acme/s","domains":[]}`, nil); res.StatusCode != http.StatusOK {
		t.Fatalf("clear domains: %d", res.StatusCode)
	}
	if got := allowed(); got != "" {
		t.Fatalf("removed origin still allowed: %q", got)
	}
	if res := call(http.MethodGet, "/api/domains/check?domain=cms.acme.io", "", nil); res.StatusCode != http.StatusNotFound {
		t.Fatalf("check removed domain: %d", res.StatusCode)
	}
}

func TestTemporaryPasswordMustBeReplacedAtFirstLogin(t *testing.T) {
	a, st := newTestAPI(t, &fakeGitHub{})
	srv := httptest.NewServer(a.Handler())
	defer srv.Close()
	admin := &store.User{Email: "root@acme.io", Name: "Root", IsAdmin: true}
	if err := st.CreateUser(admin, "password123"); err != nil {
		t.Fatal(err)
	}
	adminToken, _ := st.CreateSession(admin.ID, time.Hour)
	call := func(token, method, path, body string) (int, string) {
		req, _ := http.NewRequest(method, srv.URL+path, strings.NewReader(body))
		req.AddCookie(&http.Cookie{Name: sessionCookie, Value: token})
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		b, _ := io.ReadAll(res.Body)
		return res.StatusCode, string(b)
	}
	login := func(password string) string {
		res, err := http.Post(srv.URL+"/api/login", "application/json", strings.NewReader(`{"email":"jane@acme.io","password":"`+password+`"}`))
		if err != nil {
			t.Fatal(err)
		}
		for _, c := range res.Cookies() {
			if c.Name == sessionCookie {
				return c.Value
			}
		}
		return ""
	}

	_, body := call(adminToken, http.MethodPost, "/api/users", `{"email":"jane@acme.io","first_name":"Jane","temporary":true}`)
	var created struct {
		TemporaryPassword string `json:"temporary_password"`
	}
	_ = json.Unmarshal([]byte(body), &created)
	if len(created.TemporaryPassword) != 12 {
		t.Fatalf("created: %s", body)
	}
	jane := login(created.TemporaryPassword)
	if code, body := call(jane, http.MethodGet, "/api/sites", ""); code != http.StatusForbidden || !strings.Contains(body, "password_change_required") {
		t.Fatalf("temporary password opened the app: %d %s", code, body)
	}
	if _, body := call(jane, http.MethodGet, "/api/me", ""); !strings.Contains(body, `"must_change_password":true`) {
		t.Fatalf("me: %s", body)
	}
	if code, _ := call(jane, http.MethodPost, "/api/me/password", `{"password":"short"}`); code != http.StatusBadRequest {
		t.Fatalf("short password accepted: %d", code)
	}
	// No current password needed to replace the temporary one.
	if code, body := call(jane, http.MethodPost, "/api/me/password", `{"password":"my-own-secret"}`); code != http.StatusOK {
		t.Fatalf("change: %d %s", code, body)
	}
	if code, _ := call(jane, http.MethodGet, "/api/sites", ""); code != http.StatusOK {
		t.Fatalf("app still locked: %d", code)
	}
	if login(created.TemporaryPassword) != "" || login("my-own-secret") == "" {
		t.Fatal("the temporary password must be replaced by the new one")
	}
	// From now on, changing it asks for the current one.
	if code, _ := call(jane, http.MethodPost, "/api/me/password", `{"current":"wrong","password":"another-secret"}`); code != http.StatusBadRequest {
		t.Fatalf("changed without the current password: %d", code)
	}
}

func TestUsersRenameThemselvesButKeepTheirRole(t *testing.T) {
	a, st := newTestAPI(t, &fakeGitHub{})
	srv := httptest.NewServer(a.Handler())
	defer srv.Close()
	jane := &store.User{Email: "jane@acme.io", Name: "Jane"}
	if err := st.CreateUser(jane, "password123"); err != nil {
		t.Fatal(err)
	}
	token, _ := st.CreateSession(jane.ID, time.Hour)
	put := func(body string) int {
		req, _ := http.NewRequest(http.MethodPut, srv.URL+"/api/me", strings.NewReader(body))
		req.AddCookie(&http.Cookie{Name: sessionCookie, Value: token})
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		return res.StatusCode
	}
	if code := put(`{"first_name":"  ","last_name":"Doe"}`); code != http.StatusBadRequest {
		t.Fatalf("empty name accepted: %d", code)
	}
	if code := put(`{"first_name":" Jane ","last_name":"de La Tour","is_admin":true,"email":"x@evil.io"}`); code != http.StatusOK {
		t.Fatalf("rename: %d", code)
	}
	u, _ := st.UserByID(jane.ID)
	if u.FirstName != "Jane" || u.LastName != "de La Tour" || u.Name != "Jane de La Tour" || u.IsAdmin || u.Email != "jane@acme.io" {
		t.Fatalf("user = %+v", u)
	}
}

func TestSetupCodeCreatesTheAdminOnce(t *testing.T) {
	a, st := newTestAPI(t, &fakeGitHub{})
	if err := a.PrepareSetup(); err != nil || a.setupCode == "" {
		t.Fatalf("no setup code: %v", err)
	}
	srv := httptest.NewServer(a.Handler())
	defer srv.Close()
	setup := func(code string) *http.Response {
		body := `{"code":"` + code + `","first_name":"Kilian","last_name":"Smiti","email":"k@acme.io","password":"password123"}`
		res, err := http.Post(srv.URL+"/api/setup", "application/json", strings.NewReader(body))
		if err != nil {
			t.Fatal(err)
		}
		return res
	}
	code := a.setupCode

	if res := setup("wrong"); res.StatusCode != http.StatusForbidden {
		t.Fatalf("wrong code: %d", res.StatusCode)
	}
	res := setup(" " + code + " ")
	if res.StatusCode != http.StatusOK || len(res.Cookies()) == 0 {
		t.Fatalf("setup: %d", res.StatusCode)
	}
	u, err := st.UserByEmail("k@acme.io")
	if err != nil || !u.IsAdmin || u.Name != "Kilian Smiti" {
		t.Fatalf("admin = %+v, %v", u, err)
	}
	if res := setup(code); res.StatusCode != http.StatusConflict {
		t.Fatalf("second setup: %d", res.StatusCode)
	}
	status, _ := http.Get(srv.URL + "/api/setup")
	if b, _ := io.ReadAll(status.Body); !strings.Contains(string(b), `"needed":false`) {
		t.Fatalf("status: %s", b)
	}
	// With users, a restart prints no code.
	b := &API{Store: st}
	if err := b.PrepareSetup(); err != nil || b.setupCode != "" {
		t.Fatalf("setup code with users: %q %v", b.setupCode, err)
	}
}

func TestUsersListTheSitesTheyOpen(t *testing.T) {
	a, st := newTestAPI(t, &fakeGitHub{})
	srv := httptest.NewServer(a.Handler())
	defer srv.Close()
	admin := &store.User{Email: "root@acme.io", Name: "Root", IsAdmin: true}
	jane := &store.User{Email: "jane@acme.io", Name: "Jane"}
	for _, u := range []*store.User{admin, jane} {
		if err := st.CreateUser(u, "password123"); err != nil {
			t.Fatal(err)
		}
	}
	for _, name := range []string{"Shop", "Blog"} {
		site := &store.Site{Name: name, Repo: "acme/" + name, Branch: "main", Workflow: "direct"}
		if err := st.SaveSite(site); err != nil {
			t.Fatal(err)
		}
		if err := st.SetAccess(site.ID, []store.Access{{UserID: jane.ID, Role: store.RoleEditor}, {UserID: admin.ID, Role: store.RoleViewer}}); err != nil {
			t.Fatal(err)
		}
	}
	token, _ := st.CreateSession(admin.ID, time.Hour)
	req, _ := http.NewRequest(http.MethodGet, srv.URL+"/api/users", nil)
	req.AddCookie(&http.Cookie{Name: sessionCookie, Value: token})
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	var users []struct {
		Email string
		Sites []store.SiteRole
	}
	_ = json.NewDecoder(res.Body).Decode(&users)
	got := map[string]string{}
	for _, u := range users {
		for _, s := range u.Sites {
			got[u.Email] += s.Name + ":" + s.Role + " "
		}
	}
	// Sites by name; an admin opens every site, so no list.
	if got["jane@acme.io"] != "Blog:editor Shop:editor " || got["root@acme.io"] != "" {
		t.Fatalf("sites = %v", got)
	}
}
