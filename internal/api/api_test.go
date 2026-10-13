package api

import (
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

	"github.com/ermos/sumigo/internal/github"
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
	case r.Method == http.MethodGet && p == "/pulls" && len(f.writes) > 0:
		_, _ = w.Write([]byte(`[{"number":7,"head":{"ref":"cms/posts/hello-world"}}]`))
	case r.Method == http.MethodGet && p == "/pulls":
		_, _ = w.Write([]byte("[]"))
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

	a := &API{Store: st, NewGitHub: func(token, repo string) *github.Client {
		c := github.New(token, repo)
		c.BaseURL = ghSrv.URL
		return c
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

	call := func(u *store.User, method, body string) *http.Response {
		token, _ := st.CreateSession(u.ID, time.Hour)
		req, _ := http.NewRequest(method, srv.URL+"/api/sites/1/collections/posts/entries", strings.NewReader(body))
		req.AddCookie(&http.Cookie{Name: sessionCookie, Value: token})
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		return res
	}
	post := func(u *store.User, body string) *http.Response { return call(u, http.MethodPost, body) }

	if res := post(viewer, `{"data":{"title":"Hello World"}}`); res.StatusCode != http.StatusForbidden {
		t.Fatalf("viewer must not write, got %d", res.StatusCode)
	}
	if res := post(editor, `{"data":{"body":"no title"}}`); res.StatusCode != http.StatusBadRequest {
		t.Fatalf("required field not enforced, got %d", res.StatusCode)
	}
	res := post(editor, `{"data":{"title":"Hello World","body":"Hi"}}`)
	if res.StatusCode != http.StatusOK {
		b, _ := io.ReadAll(res.Body)
		t.Fatalf("save failed: %d %s", res.StatusCode, b)
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
	site.Workflow = "direct"
	if err := st.SaveSite(site); err != nil {
		t.Fatal(err)
	}
	before := len(gh.writes)
	if res := publish(); res.StatusCode != http.StatusOK {
		b, _ := io.ReadAll(res.Body)
		t.Fatalf("publish failed: %d %s", res.StatusCode, b)
	}
	want = []string{"PUT /contents/content/posts/hello-world.md", "PUT /pulls/7/merge", "DELETE /git/refs/heads/cms/posts/hello-world"}
	if got := gh.writes[before:]; strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("publish writes = %v, want %v", got, want)
	}
}

func TestMediaIsListedAndServedSafely(t *testing.T) {
	st, err := store.Open(filepath.Join(t.TempDir(), "t.db"), "test-secret-key-123")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = st.Close() }()
	ghSrv := httptest.NewServer(&fakeGitHub{})
	defer ghSrv.Close()
	a := &API{Store: st, NewGitHub: func(token, repo string) *github.Client {
		c := github.New(token, repo)
		c.BaseURL = ghSrv.URL
		return c
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

	req, _ := http.NewRequest(http.MethodDelete, srv.URL+"/api/sites/1/media/dog.png", nil)
	req.AddCookie(&http.Cookie{Name: sessionCookie, Value: token})
	if res, err := http.DefaultClient.Do(req); err != nil || res.StatusCode != http.StatusForbidden {
		t.Fatalf("viewer must not delete media: %v %v", err, res.StatusCode)
	}
}
