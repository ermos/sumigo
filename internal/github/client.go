// Package github is a minimal GitHub REST client authenticated by a token.
package github

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

type Client struct {
	Token   string
	Repo    string // owner/name
	BaseURL string // defaults to https://api.github.com
	HTTP    *http.Client
}

func New(token, repo string) *Client {
	return &Client{Token: token, Repo: repo, BaseURL: "https://api.github.com", HTTP: &http.Client{Timeout: 30 * time.Second}}
}

// Author is the identity written on commits. The token owner stays the committer.
type Author struct {
	Name  string `json:"name"`
	Email string `json:"email"`
}

type Error struct {
	Status  int
	Message string
}

func (e *Error) Error() string { return fmt.Sprintf("github: %d %s", e.Status, e.Message) }

func IsStatus(err error, status int) bool {
	var e *Error
	return errors.As(err, &e) && e.Status == status
}

func IsNotFound(err error) bool { return IsStatus(err, http.StatusNotFound) }

func (c *Client) do(ctx context.Context, method, path string, in, out any) error {
	var body io.Reader
	if in != nil {
		b, err := json.Marshal(in)
		if err != nil {
			return err
		}
		body = bytes.NewReader(b)
	}
	req, err := http.NewRequestWithContext(ctx, method, c.BaseURL+"/repos/"+c.Repo+path, body)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+c.Token)
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("X-GitHub-Api-Version", "2022-11-28")
	res, err := c.HTTP.Do(req)
	if err != nil {
		return err
	}
	defer func() { _ = res.Body.Close() }()
	if res.StatusCode >= 300 {
		var e struct{ Message string }
		_ = json.NewDecoder(res.Body).Decode(&e)
		return &Error{Status: res.StatusCode, Message: e.Message}
	}
	if out == nil {
		return nil
	}
	return json.NewDecoder(res.Body).Decode(out)
}

func escapePath(p string) string {
	parts := strings.Split(strings.Trim(p, "/"), "/")
	for i, s := range parts {
		parts[i] = url.PathEscape(s)
	}
	return strings.Join(parts, "/")
}

type File struct {
	Name    string `json:"name"`
	Path    string `json:"path"`
	SHA     string `json:"sha"`
	Type    string `json:"type"`
	Content string `json:"content"`
}

// CheckAccess verifies the token can read the repository.
func (c *Client) CheckAccess(ctx context.Context) error {
	return c.do(ctx, http.MethodGet, "", nil, nil)
}

// ListDir lists a directory at ref. A missing directory is empty.
func (c *Client) ListDir(ctx context.Context, dir, ref string) ([]File, error) {
	var files []File
	err := c.do(ctx, http.MethodGet, "/contents/"+escapePath(dir)+"?ref="+url.QueryEscape(ref), nil, &files)
	if IsNotFound(err) {
		return nil, nil
	}
	return files, err
}

// GetFile returns a file content and its blob sha.
func (c *Client) GetFile(ctx context.Context, path, ref string) ([]byte, string, error) {
	var f File
	if err := c.do(ctx, http.MethodGet, "/contents/"+escapePath(path)+"?ref="+url.QueryEscape(ref), nil, &f); err != nil {
		return nil, "", err
	}
	content, err := base64.StdEncoding.DecodeString(strings.ReplaceAll(f.Content, "\n", ""))
	return content, f.SHA, err
}

// PutFile creates (sha empty) or updates a file in a single commit on branch.
func (c *Client) PutFile(ctx context.Context, path, branch, message string, content []byte, sha string, author Author) error {
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

func (c *Client) DeleteFile(ctx context.Context, path, branch, message, sha string, author Author) error {
	in := map[string]any{"message": message, "sha": sha, "branch": branch, "author": author}
	return c.do(ctx, http.MethodDelete, "/contents/"+escapePath(path), in, nil)
}

// BranchSHA returns the head commit sha of a branch.
func (c *Client) BranchSHA(ctx context.Context, branch string) (string, error) {
	var ref struct {
		Object struct{ SHA string } `json:"object"`
	}
	err := c.do(ctx, http.MethodGet, "/git/ref/heads/"+escapePath(branch), nil, &ref)
	return ref.Object.SHA, err
}

func (c *Client) CreateBranch(ctx context.Context, name, fromSHA string) error {
	return c.do(ctx, http.MethodPost, "/git/refs", map[string]string{"ref": "refs/heads/" + name, "sha": fromSHA}, nil)
}

func (c *Client) DeleteBranch(ctx context.Context, name string) error {
	return c.do(ctx, http.MethodDelete, "/git/refs/heads/"+escapePath(name), nil, nil)
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
	UpdatedAt time.Time `json:"updated_at"`
}

// ListPulls returns open pull requests whose head branch starts with prefix.
func (c *Client) ListPulls(ctx context.Context, prefix string) ([]Pull, error) {
	var all []Pull
	// ponytail: first 100 open PRs only, paginate if a repo ever has more pending drafts.
	if err := c.do(ctx, http.MethodGet, "/pulls?state=open&per_page=100", nil, &all); err != nil {
		return nil, err
	}
	pulls := []Pull{}
	for _, p := range all {
		if strings.HasPrefix(p.Head.Ref, prefix) {
			pulls = append(pulls, p)
		}
	}
	return pulls, nil
}

func (c *Client) CreatePull(ctx context.Context, title, head, base, body string) (*Pull, error) {
	var p Pull
	err := c.do(ctx, http.MethodPost, "/pulls", map[string]string{"title": title, "head": head, "base": base, "body": body}, &p)
	return &p, err
}

// MergePull squash-merges a pull request.
func (c *Client) MergePull(ctx context.Context, number int, title string) error {
	return c.do(ctx, http.MethodPut, fmt.Sprintf("/pulls/%d/merge", number),
		map[string]string{"merge_method": "squash", "commit_title": title}, nil)
}

type Blob struct {
	Name string
	Text string
}

// ReadDir returns the text of every file in dir at ref, plus the text of each extra
// "ref:path" expression ("" when missing), in a single GraphQL call.
func (c *Client) ReadDir(ctx context.Context, ref, dir string, extra []string) ([]Blob, []string, error) {
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
		if e.Type == "blob" {
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

func (c *Client) graphql(ctx context.Context, query string, vars map[string]any, out any) error {
	b, err := json.Marshal(map[string]any{"query": query, "variables": vars})
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.BaseURL+"/graphql", bytes.NewReader(b))
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
