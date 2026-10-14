package api

import (
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/ermos/sumigo/internal/store"
)

// bareRepo is a GitHub repository without sumigo.yml, recording the files committed to it.
type bareRepo struct{ committed map[string]string }

func (b *bareRepo) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	p := strings.TrimPrefix(r.URL.Path, "/repos/acme/blog")
	file := func(text string) {
		_ = json.NewEncoder(w).Encode(map[string]string{"content": base64.StdEncoding.EncodeToString([]byte(text)), "sha": "s"})
	}
	switch {
	case r.Method == http.MethodPut:
		var in struct{ Content string }
		_ = json.NewDecoder(r.Body).Decode(&in)
		raw, _ := base64.StdEncoding.DecodeString(in.Content)
		b.committed[strings.TrimPrefix(p, "/contents/")] = string(raw)
	case p == "/git/trees/main":
		_, _ = w.Write([]byte(`{"tree":[{"path":"content/posts/a.md","type":"blob"},{"path":"static/img/x.png","type":"blob"}]}`))
	case p == "/contents/content/posts/a.md":
		file("---\ntitle: A\ndate: 2026-01-02\n---\nHi\n")
	case p == "/contents/sumigo.yml" && b.committed["sumigo.yml"] != "":
		file(b.committed["sumigo.yml"])
	default:
		w.WriteHeader(http.StatusNotFound)
	}
}

func TestSetupProposesThenCommitsTheConfig(t *testing.T) {
	repo := &bareRepo{committed: map[string]string{}}
	a, st := newTestAPI(t, repo)
	srv := httptest.NewServer(a.Handler())
	defer srv.Close()
	admin := &store.User{Email: "root@acme.io", Name: "Root", IsAdmin: true}
	if err := st.CreateUser(admin, "password123"); err != nil {
		t.Fatal(err)
	}
	if err := st.SaveSite(&store.Site{Name: "Blog", Repo: "acme/blog", Branch: "main", Workflow: "direct", Token: "t"}); err != nil {
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

	if _, body := call(http.MethodGet, "/api/sites/1", ""); !strings.Contains(body, `"config_missing":true`) {
		t.Fatalf("site without config: %s", body)
	}
	code, body := call(http.MethodGet, "/api/sites/1/setup", "")
	var proposal struct{ YAML, Source string }
	_ = json.Unmarshal([]byte(body), &proposal)
	if code != http.StatusOK || proposal.Source != "detected" || !strings.Contains(proposal.YAML, "folder: content/posts") || !strings.Contains(proposal.YAML, "media_folder: static/img") {
		t.Fatalf("proposal %d: %s", code, body)
	}
	if code, _ := call(http.MethodPost, "/api/sites/1/setup", `{"yaml":"collections: []"}`); code != http.StatusBadRequest {
		t.Fatalf("empty config accepted: %d", code)
	}
	in, _ := json.Marshal(map[string]string{"yaml": proposal.YAML})
	if code, body := call(http.MethodPost, "/api/sites/1/setup", string(in)); code != http.StatusOK {
		t.Fatalf("apply %d: %s", code, body)
	}
	if repo.committed["sumigo.yml"] != proposal.YAML {
		t.Fatalf("committed %q", repo.committed["sumigo.yml"])
	}
	if code, _ := call(http.MethodGet, "/api/sites/1/setup", ""); code != http.StatusConflict {
		t.Fatalf("setup offered again: %d", code)
	}
}
