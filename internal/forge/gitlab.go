package forge

import (
	"context"
	"encoding/base64"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"time"
)

// GitLab maps the CMS calls onto the GitLab API: merge requests stand for pull requests.
type GitLab struct{ client }

var _ Forge = (*GitLab)(nil)

// NewGitLab builds a client on api, https://<host>/api/v4. repo is the project path, group/subgroup/name.
func NewGitLab(token, repo, api string) *GitLab {
	return &GitLab{newClient(api+"/projects/"+url.PathEscape(repo), http.Header{"Private-Token": {token}})}
}

func filePath(path string) string { return "/repository/files/" + url.PathEscape(path) }

func (c *GitLab) ListDir(ctx context.Context, dir, ref string) ([]File, error) {
	files := []File{}
	for page := 1; ; page++ {
		var tree []struct{ ID, Name, Path, Type string }
		q := url.Values{"path": {dir}, "ref": {ref}, "per_page": {"100"}, "page": {fmt.Sprint(page)}}
		err := c.do(ctx, http.MethodGet, "/repository/tree?"+q.Encode(), nil, &tree)
		if IsNotFound(err) {
			return nil, nil
		}
		if err != nil {
			return nil, err
		}
		for _, t := range tree {
			typ := "file"
			if t.Type == "tree" {
				typ = "dir"
			}
			// ponytail: the tree API gives no size, the media page shows 0 on GitLab.
			files = append(files, File{Name: t.Name, Path: t.Path, SHA: t.ID, Type: typ})
		}
		if len(tree) < 100 {
			return files, nil
		}
	}
}

func (c *GitLab) GetFile(ctx context.Context, path, ref string) ([]byte, string, error) {
	var f struct {
		Content string `json:"content"`
		BlobID  string `json:"blob_id"`
	}
	if err := c.do(ctx, http.MethodGet, filePath(path)+"?ref="+url.QueryEscape(ref), nil, &f); err != nil {
		return nil, "", err
	}
	content, err := base64.StdEncoding.DecodeString(f.Content)
	return content, f.BlobID, err
}

func (c *GitLab) GetRaw(ctx context.Context, path, ref string) (io.ReadCloser, error) {
	res, err := c.send(ctx, http.MethodGet, filePath(path)+"/raw?ref="+url.QueryEscape(ref), nil, "*/*")
	if err != nil {
		return nil, err
	}
	return res.Body, nil
}

func (c *GitLab) PutFile(ctx context.Context, path, branch, message string, content []byte, sha string, author Author) error {
	in := map[string]string{
		"branch": branch, "commit_message": message, "author_name": author.Name, "author_email": author.Email,
		"encoding": "base64", "content": base64.StdEncoding.EncodeToString(content),
	}
	method := http.MethodPost
	if sha != "" {
		method = http.MethodPut
	}
	return c.do(ctx, method, filePath(path), in, nil)
}

func (c *GitLab) DeleteFile(ctx context.Context, path, branch, message, _ string, author Author) error {
	in := map[string]string{"branch": branch, "commit_message": message, "author_name": author.Name, "author_email": author.Email}
	return c.do(ctx, http.MethodDelete, filePath(path), in, nil)
}

func (c *GitLab) BranchSHA(ctx context.Context, branch string) (string, error) {
	var b struct {
		Commit struct{ ID string } `json:"commit"`
	}
	err := c.do(ctx, http.MethodGet, "/repository/branches/"+url.PathEscape(branch), nil, &b)
	return b.Commit.ID, err
}

func (c *GitLab) CreateBranch(ctx context.Context, name, fromSHA string) error {
	q := url.Values{"branch": {name}, "ref": {fromSHA}}
	err := c.do(ctx, http.MethodPost, "/repository/branches?"+q.Encode(), nil, nil)
	if IsStatus(err, http.StatusBadRequest) { // "Branch already exists"
		return nil
	}
	return err
}

func (c *GitLab) DeleteBranch(ctx context.Context, name string) error {
	return c.do(ctx, http.MethodDelete, "/repository/branches/"+url.PathEscape(name), nil, nil)
}

type mergeRequest struct {
	IID          int       `json:"iid"`
	Title        string    `json:"title"`
	WebURL       string    `json:"web_url"`
	SourceBranch string    `json:"source_branch"`
	UpdatedAt    time.Time `json:"updated_at"`
	Author       struct {
		Username string `json:"username"`
	} `json:"author"`
}

func (m mergeRequest) pull() Pull {
	p := Pull{Number: m.IID, Title: m.Title, HTMLURL: m.WebURL, UpdatedAt: m.UpdatedAt}
	p.Head.Ref = m.SourceBranch
	p.User.Login = m.Author.Username
	return p
}

func (c *GitLab) ListPulls(ctx context.Context, prefix string) ([]Pull, error) {
	var mrs []mergeRequest
	if err := c.do(ctx, http.MethodGet, "/merge_requests?state=opened&per_page=100", nil, &mrs); err != nil {
		return nil, err
	}
	all := make([]Pull, len(mrs))
	for i, m := range mrs {
		all[i] = m.pull()
	}
	return withPrefix(all, prefix), nil
}

func (c *GitLab) CreatePull(ctx context.Context, title, head, base, body string) (*Pull, error) {
	var m mergeRequest
	in := map[string]string{"title": title, "source_branch": head, "target_branch": base, "description": body}
	if err := c.do(ctx, http.MethodPost, "/merge_requests", in, &m); err != nil {
		return nil, err
	}
	p := m.pull()
	return &p, nil
}

// MergePull retries for a few seconds: GitLab checks mergeability in the background after a push, and refuses to merge meanwhile.
func (c *GitLab) MergePull(ctx context.Context, number int, title string) error {
	in := map[string]any{"squash": true, "squash_commit_message": title}
	for try := 1; ; try++ {
		err := c.do(ctx, http.MethodPut, fmt.Sprintf("/merge_requests/%d/merge", number), in, nil)
		if try == 5 || (!IsStatus(err, http.StatusMethodNotAllowed) && !IsStatus(err, http.StatusUnprocessableEntity)) {
			return err
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(time.Second):
		}
	}
}

func (c *GitLab) ClosePull(ctx context.Context, p Pull) error {
	if err := c.do(ctx, http.MethodPut, fmt.Sprintf("/merge_requests/%d", p.Number), map[string]string{"state_event": "close"}, nil); err != nil {
		return err
	}
	return c.DeleteBranch(ctx, p.Head.Ref)
}

func (c *GitLab) ReadDir(ctx context.Context, ref, dir, ext string, extra []string) ([]Blob, []string, error) {
	return readDir(ctx, c, ref, dir, ext, extra)
}

func (c *GitLab) ListCommits(ctx context.Context, path, ref string) ([]Commit, error) {
	var raw []struct {
		ID           string    `json:"id"`
		Message      string    `json:"message"`
		AuthorName   string    `json:"author_name"`
		AuthoredDate time.Time `json:"authored_date"`
	}
	q := url.Values{"path": {path}, "ref_name": {ref}, "per_page": {"30"}}
	if err := c.do(ctx, http.MethodGet, "/repository/commits?"+q.Encode(), nil, &raw); err != nil {
		return nil, err
	}
	commits := make([]Commit, len(raw))
	for i, r := range raw {
		commits[i] = commit(r.ID, r.Message, r.AuthorName, r.AuthoredDate)
	}
	return commits, nil
}

func (c *GitLab) CommitPatch(ctx context.Context, sha, path string) (string, error) {
	var files []struct {
		NewPath string `json:"new_path"`
		Diff    string `json:"diff"`
	}
	if err := c.do(ctx, http.MethodGet, "/repository/commits/"+url.PathEscape(sha)+"/diff?per_page=100", nil, &files); err != nil {
		return "", err
	}
	for _, f := range files {
		if f.NewPath == path {
			return f.Diff, nil
		}
	}
	return "", nil
}
