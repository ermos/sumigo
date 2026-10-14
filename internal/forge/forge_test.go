package forge

import (
	"context"
	"encoding/base64"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
)

// fake answers GETs from a path -> JSON map and records the other calls.
type fake struct {
	mu    sync.Mutex
	gets  map[string]string
	calls []string
}

func (f *fake) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if r.Method == http.MethodGet {
		body, ok := f.gets[r.URL.RequestURI()]
		if !ok {
			w.WriteHeader(http.StatusNotFound)
		}
		_, _ = w.Write([]byte(body))
		return
	}
	f.calls = append(f.calls, r.Method+" "+r.URL.RequestURI())
	if strings.HasSuffix(r.URL.Path, "/branches") {
		w.WriteHeader(http.StatusConflict) // already exists on Gitea
	}
	_, _ = w.Write([]byte(`{"iid":3,"number":3,"source_branch":"cms/posts/a","head":{"ref":"cms/posts/a"}}`))
}

func b64(s string) string { return base64.StdEncoding.EncodeToString([]byte(s)) }

func TestGiteaReadsEntriesAndCommits(t *testing.T) {
	f := &fake{gets: map[string]string{
		"/repos/acme/blog/contents/content/posts?ref=main":         `[{"name":"a.md","type":"file"},{"name":"cat.png","type":"file"},{"name":"img","type":"dir"}]`,
		"/repos/acme/blog/contents/content/posts/a.md?ref=main":    `{"content":"` + b64("title: A") + `","sha":"s1"}`,
		"/repos/acme/blog/contents/content/posts/b.md?ref=cms%2Fb": `{"content":"` + b64("title: B") + `","sha":"s2"}`,
		"/repos/acme/blog/git/commits/c1.diff":                     "diff --git a/x.md b/x.md\n@@ -1 +1 @@\n-x\n+y\ndiff --git a/content/posts/a.md b/content/posts/a.md\nindex 1..2 100644\n--- a/content/posts/a.md\n+++ b/content/posts/a.md\n@@ -1 +1 @@\n-title: Old\n+title: A\n",
	}}
	srv := httptest.NewServer(f)
	defer srv.Close()
	g := NewGitea("tok", "acme/blog", srv.URL)
	ctx := context.Background()

	blobs, extra, err := g.ReadDir(ctx, "main", "content/posts", ".md", []string{"cms/b:content/posts/b.md", "cms/c:content/posts/c.md"})
	if err != nil || len(blobs) != 1 || blobs[0].Text != "title: A" || extra[0] != "title: B" || extra[1] != "" {
		t.Fatalf("ReadDir = %v %q %v", blobs, extra, err)
	}
	if p, _ := g.CommitPatch(ctx, "c1", "content/posts/a.md"); p != "@@ -1 +1 @@\n-title: Old\n+title: A" {
		t.Fatalf("patch = %q", p)
	}

	// Create is a POST and update a PUT; an existing branch is reused.
	_ = g.PutFile(ctx, "content/posts/a.md", "main", "m", []byte("x"), "", Author{})
	_ = g.PutFile(ctx, "content/posts/a.md", "main", "m", []byte("x"), "s1", Author{})
	if err := g.CreateBranch(ctx, "cms/posts/a", "sha"); err != nil {
		t.Fatalf("existing branch: %v", err)
	}
	want := "POST /repos/acme/blog/contents/content/posts/a.md,PUT /repos/acme/blog/contents/content/posts/a.md,POST /repos/acme/blog/branches"
	if got := strings.Join(f.calls, ","); got != want {
		t.Fatalf("calls = %s", got)
	}
}

func TestGitLabMapsMergeRequests(t *testing.T) {
	f := &fake{gets: map[string]string{
		"/projects/acme%2Fweb%2Fblog/merge_requests?state=opened&per_page=100": `[
			{"iid":3,"title":"content(posts): create a","web_url":"https://gl/mr/3","source_branch":"cms/posts/a","author":{"username":"jane"}},
			{"iid":4,"source_branch":"feature/x"}]`,
	}}
	srv := httptest.NewServer(f)
	defer srv.Close()
	g := NewGitLab("tok", "acme/web/blog", srv.URL)
	ctx := context.Background()

	pulls, err := g.ListPulls(ctx, "cms/")
	if err != nil || len(pulls) != 1 || pulls[0].Number != 3 || pulls[0].Head.Ref != "cms/posts/a" || pulls[0].HTMLURL != "https://gl/mr/3" || pulls[0].User.Login != "jane" {
		t.Fatalf("pulls = %+v %v", pulls, err)
	}
	_ = g.MergePull(ctx, 3, "title")
	_ = g.ClosePull(ctx, pulls[0])
	want := "PUT /projects/acme%2Fweb%2Fblog/merge_requests/3/merge,PUT /projects/acme%2Fweb%2Fblog/merge_requests/3,DELETE /projects/acme%2Fweb%2Fblog/repository/branches/cms%2Fposts%2Fa"
	if got := strings.Join(f.calls, ","); got != want {
		t.Fatalf("calls = %s", got)
	}
}
