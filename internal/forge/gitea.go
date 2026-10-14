package forge

import (
	"context"
	"encoding/base64"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// Gitea covers Gitea, Forgejo and Codeberg: their API follows GitHub's REST shapes for most calls.
type Gitea struct{ client }

var _ Forge = (*Gitea)(nil)

// NewGitea builds a client on api, https://<host>/api/v1.
func NewGitea(token, repo, api string) *Gitea {
	return &Gitea{newClient(api+"/repos/"+repo, http.Header{"Authorization": {"token " + token}})}
}

func (c *Gitea) ListDir(ctx context.Context, dir, ref string) ([]File, error) {
	var files []File
	err := c.do(ctx, http.MethodGet, "/contents/"+escapePath(dir)+"?ref="+url.QueryEscape(ref), nil, &files)
	if IsNotFound(err) {
		return nil, nil
	}
	return files, err
}

func (c *Gitea) GetFile(ctx context.Context, path, ref string) ([]byte, string, error) {
	var f File
	if err := c.do(ctx, http.MethodGet, "/contents/"+escapePath(path)+"?ref="+url.QueryEscape(ref), nil, &f); err != nil {
		return nil, "", err
	}
	content, err := base64.StdEncoding.DecodeString(strings.ReplaceAll(f.Content, "\n", ""))
	return content, f.SHA, err
}

func (c *Gitea) GetRaw(ctx context.Context, path, ref string) (io.ReadCloser, error) {
	res, err := c.send(ctx, http.MethodGet, "/raw/"+escapePath(path)+"?ref="+url.QueryEscape(ref), nil, "*/*")
	if err != nil {
		return nil, err
	}
	return res.Body, nil
}

func (c *Gitea) PutFile(ctx context.Context, path, branch, message string, content []byte, sha string, author Author) error {
	in := map[string]any{"message": message, "content": base64.StdEncoding.EncodeToString(content), "branch": branch, "author": author}
	method := http.MethodPost
	if sha != "" {
		in["sha"] = sha
		method = http.MethodPut
	}
	return c.do(ctx, method, "/contents/"+escapePath(path), in, nil)
}

func (c *Gitea) DeleteFile(ctx context.Context, path, branch, message, sha string, author Author) error {
	in := map[string]any{"message": message, "sha": sha, "branch": branch, "author": author}
	return c.do(ctx, http.MethodDelete, "/contents/"+escapePath(path), in, nil)
}

func (c *Gitea) BranchSHA(ctx context.Context, branch string) (string, error) {
	var b struct {
		Commit struct{ ID string } `json:"commit"`
	}
	err := c.do(ctx, http.MethodGet, "/branches/"+escapePath(branch), nil, &b)
	return b.Commit.ID, err
}

func (c *Gitea) CreateBranch(ctx context.Context, name, fromSHA string) error {
	err := c.do(ctx, http.MethodPost, "/branches", map[string]string{"new_branch_name": name, "old_ref_name": fromSHA}, nil)
	if IsStatus(err, http.StatusConflict) { // already exists
		return nil
	}
	return err
}

func (c *Gitea) DeleteBranch(ctx context.Context, name string) error {
	return c.do(ctx, http.MethodDelete, "/branches/"+escapePath(name), nil, nil)
}

func (c *Gitea) ListPulls(ctx context.Context, prefix string) ([]Pull, error) {
	var all []Pull
	if err := c.do(ctx, http.MethodGet, "/pulls?state=open&limit=50", nil, &all); err != nil {
		return nil, err
	}
	return withPrefix(all, prefix), nil
}

func (c *Gitea) CreatePull(ctx context.Context, title, head, base, body string) (*Pull, error) {
	var p Pull
	err := c.do(ctx, http.MethodPost, "/pulls", map[string]string{"title": title, "head": head, "base": base, "body": body}, &p)
	return &p, err
}

func (c *Gitea) MergePull(ctx context.Context, number int, title string) error {
	return c.do(ctx, http.MethodPost, fmt.Sprintf("/pulls/%d/merge", number), map[string]string{"Do": "squash", "MergeTitleField": title}, nil)
}

func (c *Gitea) ClosePull(ctx context.Context, p Pull) error {
	if err := c.do(ctx, http.MethodPatch, fmt.Sprintf("/pulls/%d", p.Number), map[string]string{"state": "closed"}, nil); err != nil {
		return err
	}
	return c.DeleteBranch(ctx, p.Head.Ref)
}

func (c *Gitea) ReadDir(ctx context.Context, ref, dir, ext string, extra []string) ([]Blob, []string, error) {
	return readDir(ctx, c, ref, dir, ext, extra)
}

func (c *Gitea) ListCommits(ctx context.Context, path, ref string) ([]Commit, error) {
	var raw []struct {
		SHA    string `json:"sha"`
		Commit struct {
			Message string `json:"message"`
			Author  struct {
				Name string    `json:"name"`
				Date time.Time `json:"date"`
			} `json:"author"`
		} `json:"commit"`
	}
	q := url.Values{"path": {path}, "sha": {ref}, "limit": {"30"}, "stat": {"false"}, "files": {"false"}}
	if err := c.do(ctx, http.MethodGet, "/commits?"+q.Encode(), nil, &raw); err != nil {
		return nil, err
	}
	commits := make([]Commit, len(raw))
	for i, r := range raw {
		commits[i] = commit(r.SHA, r.Commit.Message, r.Commit.Author.Name, r.Commit.Author.Date)
	}
	return commits, nil
}

func (c *Gitea) CommitPatch(ctx context.Context, sha, path string) (string, error) {
	res, err := c.send(ctx, http.MethodGet, "/git/commits/"+url.PathEscape(sha)+".diff", nil, "text/plain")
	if err != nil {
		return "", err
	}
	defer func() { _ = res.Body.Close() }()
	diff, err := io.ReadAll(res.Body)
	return filePatch(string(diff), path), err
}

// filePatch extracts the hunks of one file from a unified diff, the format GitHub returns per file.
func filePatch(diff, path string) string {
	for _, part := range strings.Split("\n"+diff, "\ndiff --git ")[1:] {
		header, _, _ := strings.Cut(part, "\n")
		if !strings.HasSuffix(header, " b/"+path) {
			continue
		}
		if i := strings.Index(part, "\n@@"); i >= 0 {
			return strings.TrimSuffix(part[i+1:], "\n")
		}
		return ""
	}
	return ""
}
