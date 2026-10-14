package forge

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

type GitHub struct {
	client
	Token   string
	Repo    string // owner/name
	graphQL string
}

// NewGitHub builds a client on api, https://api.github.com or https://<host>/api/v3 on GitHub Enterprise Server.
func NewGitHub(token, repo, api string) *GitHub {
	h := http.Header{"Authorization": {"Bearer " + token}, "X-Github-Api-Version": {"2022-11-28"}}
	c := &GitHub{client: newClient(api+"/repos/"+repo, h), Token: token, Repo: repo, graphQL: strings.TrimSuffix(api, "/v3") + "/graphql"}
	c.accept = "application/vnd.github+json"
	return c
}

var _ Forge = (*GitHub)(nil)

// ListDir lists a directory at ref. A missing directory is empty.
func (c *GitHub) ListDir(ctx context.Context, dir, ref string) ([]File, error) {
	var files []File
	err := c.do(ctx, http.MethodGet, "/contents/"+escapePath(dir)+"?ref="+url.QueryEscape(ref), nil, &files)
	if IsNotFound(err) {
		return nil, nil
	}
	return files, err
}

// GetFile returns a file content and its blob sha.
func (c *GitHub) GetFile(ctx context.Context, path, ref string) ([]byte, string, error) {
	var f File
	if err := c.do(ctx, http.MethodGet, "/contents/"+escapePath(path)+"?ref="+url.QueryEscape(ref), nil, &f); err != nil {
		return nil, "", err
	}
	content, err := base64.StdEncoding.DecodeString(strings.ReplaceAll(f.Content, "\n", ""))
	return content, f.SHA, err
}

// GetRaw streams a file body. Unlike GetFile it works past GitHub's 1MB contents limit.
func (c *GitHub) GetRaw(ctx context.Context, path, ref string) (io.ReadCloser, error) {
	res, err := c.send(ctx, http.MethodGet, "/contents/"+escapePath(path)+"?ref="+url.QueryEscape(ref), nil, "application/vnd.github.raw+json")
	if err != nil {
		return nil, err
	}
	return res.Body, nil
}

// PutFile creates (sha empty) or updates a file in a single commit on branch.
func (c *GitHub) PutFile(ctx context.Context, path, branch, message string, content []byte, sha string, author Author) error {
	in := map[string]any{
		"message": message,
		"content": base64.StdEncoding.EncodeToString(content),
		"branch":  branch,
		"author":  author,
	}
	if sha != "" {
		in["sha"] = sha
	}
	return c.do(ctx, http.MethodPut, "/contents/"+escapePath(path), in, nil)
}

func (c *GitHub) DeleteFile(ctx context.Context, path, branch, message, sha string, author Author) error {
	in := map[string]any{"message": message, "sha": sha, "branch": branch, "author": author}
	return c.do(ctx, http.MethodDelete, "/contents/"+escapePath(path), in, nil)
}

// BranchSHA returns the head commit sha of a branch.
func (c *GitHub) BranchSHA(ctx context.Context, branch string) (string, error) {
	var ref struct {
		Object struct{ SHA string } `json:"object"`
	}
	err := c.do(ctx, http.MethodGet, "/git/ref/heads/"+escapePath(branch), nil, &ref)
	return ref.Object.SHA, err
}

func (c *GitHub) CreateBranch(ctx context.Context, name, fromSHA string) error {
	err := c.do(ctx, http.MethodPost, "/git/refs", map[string]string{"ref": "refs/heads/" + name, "sha": fromSHA}, nil)
	if IsStatus(err, http.StatusUnprocessableEntity) { // already exists
		return nil
	}
	return err
}

// ClosePull deletes the branch, which closes its pull request.
func (c *GitHub) ClosePull(ctx context.Context, p Pull) error {
	return c.DeleteBranch(ctx, p.Head.Ref)
}

func (c *GitHub) DeleteBranch(ctx context.Context, name string) error {
	return c.do(ctx, http.MethodDelete, "/git/refs/heads/"+escapePath(name), nil, nil)
}

// ListPulls returns open pull requests whose head branch starts with prefix.
func (c *GitHub) ListPulls(ctx context.Context, prefix string) ([]Pull, error) {
	var all []Pull
	// ponytail: first 100 open PRs only, paginate if a repo ever has more pending drafts.
	if err := c.do(ctx, http.MethodGet, "/pulls?state=open&per_page=100", nil, &all); err != nil {
		return nil, err
	}
	return withPrefix(all, prefix), nil
}

func (c *GitHub) CreatePull(ctx context.Context, title, head, base, body string) (*Pull, error) {
	var p Pull
	err := c.do(ctx, http.MethodPost, "/pulls", map[string]string{"title": title, "head": head, "base": base, "body": body}, &p)
	return &p, err
}

// MergePull squash-merges a pull request.
func (c *GitHub) MergePull(ctx context.Context, number int, title string) error {
	return c.do(ctx, http.MethodPut, fmt.Sprintf("/pulls/%d/merge", number),
		map[string]string{"merge_method": "squash", "commit_title": title}, nil)
}

// ReadDir returns the text of every file in dir at ref, plus the text of each extra
// "ref:path" expression ("" when missing), in a single GraphQL call.
func (c *GitHub) ReadDir(ctx context.Context, ref, dir, ext string, extra []string) ([]Blob, []string, error) {
	owner, name, _ := strings.Cut(c.Repo, "/")
	vars := map[string]any{"owner": owner, "name": name, "dir": ref + ":" + dir}
	decl := "$owner: String!, $name: String!, $dir: String!"
	fields := "dir: object(expression: $dir) { ... on Tree { entries { name type object { ... on Blob { text } } } } }"
	for i, e := range extra {
		vars[fmt.Sprintf("e%d", i)] = e
		decl += fmt.Sprintf(", $e%d: String!", i)
		fields += fmt.Sprintf(" e%d: object(expression: $e%d) { ... on Blob { text } }", i, i)
	}
	query := "query(" + decl + ") { repository(owner: $owner, name: $name) { " + fields + " } }"

	var out struct {
		Data struct {
			Repository map[string]json.RawMessage `json:"repository"`
		} `json:"data"`
		Errors []struct{ Message string } `json:"errors"`
	}
	if err := c.graphql(ctx, query, vars, &out); err != nil {
		return nil, nil, err
	}
	if len(out.Errors) > 0 {
		return nil, nil, &Error{Status: http.StatusBadGateway, Message: out.Errors[0].Message}
	}
	repo := out.Data.Repository
	var tree struct {
		Entries []struct {
			Name   string
			Type   string
			Object struct{ Text string }
		}
	}
	if raw := repo["dir"]; len(raw) > 0 && string(raw) != "null" {
		if err := json.Unmarshal(raw, &tree); err != nil {
			return nil, nil, err
		}
	}
	blobs := []Blob{}
	for _, e := range tree.Entries {
		if e.Type == "blob" && strings.HasSuffix(e.Name, ext) {
			blobs = append(blobs, Blob{Name: e.Name, Text: e.Object.Text})
		}
	}
	texts := make([]string, len(extra))
	for i := range extra {
		var b struct{ Text string }
		if raw := repo[fmt.Sprintf("e%d", i)]; len(raw) > 0 && string(raw) != "null" {
			if err := json.Unmarshal(raw, &b); err != nil {
				return nil, nil, err
			}
		}
		texts[i] = b.Text
	}
	return blobs, texts, nil
}

func (c *GitHub) graphql(ctx context.Context, query string, vars map[string]any, out any) error {
	b, err := json.Marshal(map[string]any{"query": query, "variables": vars})
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.graphQL, bytes.NewReader(b))
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+c.Token)
	res, err := c.HTTP.Do(req)
	if err != nil {
		return err
	}
	defer func() { _ = res.Body.Close() }()
	if res.StatusCode >= 300 {
		return &Error{Status: res.StatusCode, Message: res.Status}
	}
	return json.NewDecoder(res.Body).Decode(out)
}

// ListCommits returns the last 30 commits that touched path on ref, newest first.
func (c *GitHub) ListCommits(ctx context.Context, path, ref string) ([]Commit, error) {
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
	q := url.Values{"path": {path}, "sha": {ref}, "per_page": {"30"}}
	if err := c.do(ctx, http.MethodGet, "/commits?"+q.Encode(), nil, &raw); err != nil {
		return nil, err
	}
	commits := make([]Commit, len(raw))
	for i, r := range raw {
		commits[i] = commit(r.SHA, r.Commit.Message, r.Commit.Author.Name, r.Commit.Author.Date)
	}
	return commits, nil
}

// CommitPatch returns the unified diff a commit made to path, "" when GitHub has none (binary or too large).
func (c *GitHub) CommitPatch(ctx context.Context, sha, path string) (string, error) {
	var out struct {
		Files []struct {
			Filename string `json:"filename"`
			Patch    string `json:"patch"`
		} `json:"files"`
	}
	if err := c.do(ctx, http.MethodGet, "/commits/"+url.PathEscape(sha), nil, &out); err != nil {
		return "", err
	}
	for _, f := range out.Files {
		if f.Filename == path {
			return f.Patch, nil
		}
	}
	return "", nil
}
