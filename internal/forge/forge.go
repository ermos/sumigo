// Package forge talks to the git hosting of a site: GitHub, GitLab, or Gitea and Forgejo (same API).
package forge

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"path"
	"strings"
	"time"

	"golang.org/x/sync/errgroup"
)

// Forge is what the CMS needs from a git hosting. "Pull" means a pull request, or a merge request on GitLab.
type Forge interface {
	ListDir(ctx context.Context, dir, ref string) ([]File, error)
	// Tree lists the paths of every file of the repository at ref.
	Tree(ctx context.Context, ref string) ([]string, error)
	// GetFile returns the content of a file and the version to pass back to PutFile or DeleteFile.
	GetFile(ctx context.Context, path, ref string) ([]byte, string, error)
	GetRaw(ctx context.Context, path, ref string) (io.ReadCloser, error)
	// PutFile creates the file when sha is empty, updates it otherwise.
	PutFile(ctx context.Context, path, branch, message string, content []byte, sha string, author Author) error
	DeleteFile(ctx context.Context, path, branch, message, sha string, author Author) error
	BranchSHA(ctx context.Context, branch string) (string, error)
	// CreateBranch reuses the branch when it already exists (left over from a closed pull request).
	CreateBranch(ctx context.Context, name, fromSHA string) error
	DeleteBranch(ctx context.Context, name string) error
	ListPulls(ctx context.Context, prefix string) ([]Pull, error)
	CreatePull(ctx context.Context, title, head, base, body string) (*Pull, error)
	MergePull(ctx context.Context, number int, title string) error
	// ClosePull drops a pull request without merging it, and its branch.
	ClosePull(ctx context.Context, p Pull) error
	// ReadDir returns the files of dir ending with ext, with their text, and the text of the extra "ref:path" files.
	ReadDir(ctx context.Context, ref, dir, ext string, extra []string) ([]Blob, []string, error)
	ListCommits(ctx context.Context, path, ref string) ([]Commit, error)
	// CommitPatch returns the diff hunks of path in a commit.
	CommitPatch(ctx context.Context, sha, path string) (string, error)
}

// Kinds of forge a site can live on.
const (
	KindGitHub = "github"
	KindGitLab = "gitlab"
	KindGitea  = "gitea"
)

// New builds the client of a site. baseURL is the instance (https://gitlab.example.com), empty for github.com and gitlab.com.
func New(kind, baseURL, token, repo string) Forge {
	baseURL = strings.TrimRight(baseURL, "/")
	switch kind {
	case KindGitLab:
		if baseURL == "" {
			baseURL = "https://gitlab.com"
		}
		return NewGitLab(token, repo, baseURL+"/api/v4")
	case KindGitea:
		return NewGitea(token, repo, baseURL+"/api/v1")
	}
	api := "https://api.github.com"
	if baseURL != "" && baseURL != "https://github.com" {
		api = baseURL + "/api/v3" // GitHub Enterprise Server
	}
	return NewGitHub(token, repo, api)
}

type Author struct {
	Name  string `json:"name"`
	Email string `json:"email"`
}

type Error struct {
	Status  int
	Message string
}

func (e *Error) Error() string { return fmt.Sprintf("forge: %d %s", e.Status, e.Message) }

func IsStatus(err error, status int) bool {
	var e *Error
	return errors.As(err, &e) && e.Status == status
}

func IsNotFound(err error) bool { return IsStatus(err, http.StatusNotFound) }

type File struct {
	Name string `json:"name"`
	Path string `json:"path"`
	SHA  string `json:"sha"`
	// Type is "file" or "dir".
	Type    string `json:"type"`
	Size    int64  `json:"size"`
	Content string `json:"content"`
}

type Pull struct {
	Number  int    `json:"number"`
	Title   string `json:"title"`
	HTMLURL string `json:"html_url"`
	Head    struct {
		Ref string `json:"ref"`
	} `json:"head"`
	User struct {
		Login string `json:"login"`
	} `json:"user"`
	UpdatedAt   time.Time  `json:"updated_at"`
	ScheduledAt *time.Time `json:"scheduled_at,omitempty"`
}

type Blob struct {
	Name string
	Text string
}

type Commit struct {
	SHA     string    `json:"sha"`
	Message string    `json:"message"`
	Author  string    `json:"author"`
	Date    time.Time `json:"date"`
}

// client is the REST plumbing shared by the forges.
type client struct {
	base   string // API URL of the repository
	header http.Header
	accept string
	HTTP   *http.Client
}

func newClient(base string, header http.Header) client {
	return client{base: base, header: header, accept: "application/json", HTTP: &http.Client{Timeout: 30 * time.Second}}
}

func (c *client) do(ctx context.Context, method, path string, in, out any) error {
	var body io.Reader
	if in != nil {
		b, err := json.Marshal(in)
		if err != nil {
			return err
		}
		body = bytes.NewReader(b)
	}
	res, err := c.send(ctx, method, path, body, c.accept)
	if err != nil {
		return err
	}
	defer func() { _ = res.Body.Close() }()
	if out == nil {
		return nil
	}
	return json.NewDecoder(res.Body).Decode(out)
}

func (c *client) send(ctx context.Context, method, path string, body io.Reader, accept string) (*http.Response, error) {
	req, err := http.NewRequestWithContext(ctx, method, c.base+path, body)
	if err != nil {
		return nil, err
	}
	for k, v := range c.header {
		req.Header[k] = v
	}
	req.Header.Set("Accept", accept)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	res, err := c.HTTP.Do(req)
	if err != nil {
		return nil, err
	}
	if res.StatusCode >= 300 {
		defer func() { _ = res.Body.Close() }()
		// GitHub and Gitea answer {"message": "..."}, GitLab {"message": ...} or {"error": "..."}.
		var e struct{ Message, Error any }
		_ = json.NewDecoder(res.Body).Decode(&e)
		msg := e.Message
		if msg == nil {
			msg = e.Error
		}
		if msg == nil {
			msg = res.Status
		}
		return nil, &Error{Status: res.StatusCode, Message: fmt.Sprint(msg)}
	}
	return res, nil
}

func escapePath(p string) string {
	parts := strings.Split(strings.Trim(p, "/"), "/")
	for i, s := range parts {
		parts[i] = url.PathEscape(s)
	}
	return strings.Join(parts, "/")
}

// readDir is ReadDir for forges without GraphQL: one call per file, a few at a time.
// ponytail: N calls for N entries, fine for a blog; a git clone (or tree + blobs batch) if collections reach thousands.
func readDir(ctx context.Context, f Forge, ref, dir, ext string, extra []string) ([]Blob, []string, error) {
	files, err := f.ListDir(ctx, dir, ref)
	if err != nil {
		return nil, nil, err
	}
	blobs := []Blob{}
	for _, file := range files {
		if file.Type == "file" && strings.HasSuffix(file.Name, ext) {
			blobs = append(blobs, Blob{Name: file.Name})
		}
	}
	texts := make([]string, len(extra))
	g, ctx := errgroup.WithContext(ctx)
	g.SetLimit(8)
	for i := range blobs {
		g.Go(func() error {
			b, _, err := f.GetFile(ctx, path.Join(dir, blobs[i].Name), ref)
			blobs[i].Text = string(b)
			return err
		})
	}
	for i, e := range extra {
		g.Go(func() error {
			r, p, _ := strings.Cut(e, ":")
			b, _, err := f.GetFile(ctx, p, r)
			if IsNotFound(err) {
				return nil
			}
			texts[i] = string(b)
			return err
		})
	}
	return blobs, texts, g.Wait()
}

type treeEntry struct{ Path, Type string }

// blobs keeps the file paths of a git tree listing (GitHub and Gitea shape).
func blobs(entries []treeEntry) []string {
	paths := []string{}
	for _, e := range entries {
		if e.Type == "blob" {
			paths = append(paths, e.Path)
		}
	}
	return paths
}

// withPrefix keeps the pull requests whose branch starts with prefix.
func withPrefix(all []Pull, prefix string) []Pull {
	pulls := []Pull{}
	for _, p := range all {
		if strings.HasPrefix(p.Head.Ref, prefix) {
			pulls = append(pulls, p)
		}
	}
	return pulls
}

// commit keeps the first line of the message, the title.
func commit(sha, message, author string, date time.Time) Commit {
	title, _, _ := strings.Cut(message, "\n")
	return Commit{SHA: sha, Message: title, Author: author, Date: date}
}
