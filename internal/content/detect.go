package content

import (
	"bytes"
	"errors"
	"path"
	"regexp"
	"slices"
	"strings"

	"gopkg.in/yaml.v3"
)

// Folder is a directory of the repository holding content files, a collection candidate.
type Folder struct {
	Path  string
	Ext   string // ".md", ".mdx" or ".markdown"
	Files []string
}

var contentExts = []string{".md", ".mdx", ".markdown"}

// Files that are documentation of the repository, not content.
var repoDocs = regexp.MustCompile(`(?i)^(readme|changelog|license|contributing|code_of_conduct|security)\.`)

// skipDir tells the directories never holding site content: tooling, dependencies, build output.
func skipDir(dir string) bool {
	for _, seg := range strings.Split(dir, "/") {
		if (strings.HasPrefix(seg, ".") || strings.HasPrefix(seg, "_")) && seg != "_posts" {
			return true
		}
		switch seg {
		case "node_modules", "vendor", "dist", "build", "public", "static", "admin":
			return true
		}
	}
	return false
}

// ContentFolders finds the directories holding markdown files, in path order.
func ContentFolders(paths []string) []Folder {
	byDir := map[string]map[string][]string{} // dir -> ext -> files
	for _, p := range paths {
		dir, file, ext := path.Dir(p), path.Base(p), path.Ext(p)
		if dir == "." || !slices.Contains(contentExts, ext) || repoDocs.MatchString(file) || skipDir(dir) {
			continue
		}
		if byDir[dir] == nil {
			byDir[dir] = map[string][]string{}
		}
		byDir[dir][ext] = append(byDir[dir][ext], p)
	}
	folders := []Folder{}
	for dir, exts := range byDir {
		f := Folder{Path: dir}
		for _, ext := range contentExts { // the most used extension wins
			if len(exts[ext]) > len(f.Files) {
				f.Ext, f.Files = ext, exts[ext]
			}
		}
		folders = append(folders, f)
	}
	slices.SortFunc(folders, func(a, b Folder) int { return strings.Compare(a.Path, b.Path) })
	return folders
}

// DetectConfig proposes a config: one collection per folder, its fields guessed from samples
// (the text of a few of its files), and a media folder guessed from the repository layout.
// ponytail: flat folders only, a folder of yearly subfolders becomes one collection per year; the admin edits the YAML before saving.
func DetectConfig(paths []string, folders []Folder, samples map[string][]string) *Config {
	cfg := &Config{}
	cfg.MediaFolder, cfg.PublicFolder = mediaFolder(paths)
	names := map[string]bool{}
	for _, f := range folders {
		name := Slugify(path.Base(f.Path))
		if names[name] || name == "" {
			name = Slugify(strings.ReplaceAll(f.Path, "/", "-"))
		}
		names[name] = true
		col := Collection{Name: name, Label: label(path.Base(f.Path)), Folder: f.Path, Fields: guessFields(samples[f.Path])}
		if f.Ext != ".md" {
			col.Extension = strings.TrimPrefix(f.Ext, ".")
		}
		if !slices.ContainsFunc(col.Fields, func(fl Field) bool { return fl.Name == "title" }) {
			for _, fl := range col.Fields {
				if fl.Widget == "string" {
					col.IdentifierField = fl.Name
					break
				}
			}
		}
		cfg.Collections = append(cfg.Collections, col)
	}
	return cfg
}

func label(s string) string {
	s = strings.NewReplacer("-", " ", "_", " ").Replace(s)
	if s == "" {
		return s
	}
	return strings.ToUpper(s[:1]) + s[1:]
}

// mediaFolder picks where uploads go: an existing image folder, else images under the public root.
func mediaFolder(paths []string) (string, string) {
	has := func(dir string) bool {
		return slices.ContainsFunc(paths, func(p string) bool { return strings.HasPrefix(p, dir+"/") })
	}
	for _, dir := range []string{"public/images", "public/img", "public/uploads", "static/images", "static/img", "static/uploads", "assets/images", "images"} {
		if has(dir) {
			return dir, "/" + strings.TrimPrefix(strings.TrimPrefix(dir, "public/"), "static/")
		}
	}
	for _, root := range []string{"public", "static"} {
		if has(root) {
			return root + "/images", "/images"
		}
	}
	return "images", "/images"
}

var imageKey = regexp.MustCompile(`(?i)(image|img|cover|thumbnail|thumb|hero|banner|photo|picture|avatar|logo)`)
var imageValue = regexp.MustCompile(`(?i)\.(png|jpe?g|gif|webp|avif|svg)$`)

// guessFields lists the front matter keys of the samples in order of appearance, then the body.
// A key missing or empty in one sample is optional.
func guessFields(samples []string) []Field {
	var keys []string
	values := map[string][]any{}
	emptyBody := false
	for _, text := range samples {
		data, body, err := Parse([]byte(text))
		if err != nil {
			continue
		}
		emptyBody = emptyBody || strings.TrimSpace(body) == ""
		var node yaml.Node // map order is lost in data, read the keys from the YAML itself
		if front, ok := frontMatter(text); ok && yaml.Unmarshal([]byte(front), &node) == nil && len(node.Content) > 0 {
			for i := 0; i < len(node.Content[0].Content); i += 2 {
				if k := node.Content[0].Content[i].Value; !slices.Contains(keys, k) && k != BodyField {
					keys = append(keys, k)
				}
			}
		}
		for k, v := range data {
			values[k] = append(values[k], v)
		}
	}
	fields := []Field{}
	no := false
	for _, k := range keys {
		f := Field{Name: k, Label: label(k), Widget: guessWidget(k, values[k])}
		if len(values[k]) < len(samples) || slices.ContainsFunc(values[k], func(v any) bool { return v == nil || v == "" }) {
			f.Required = &no
		}
		fields = append(fields, f)
	}
	body := Field{Name: BodyField, Label: "Body", Widget: "markdown"}
	if emptyBody {
		body.Required = &no
	}
	return append(fields, body)
}

func frontMatter(text string) (string, bool) {
	s := strings.ReplaceAll(text, "\r\n", "\n")
	if !strings.HasPrefix(s, "---\n") {
		return "", false
	}
	end := strings.Index(s[4:], "\n---")
	return s[4 : 4+max(end, 0)], end >= 0
}

// guessWidget infers the editor input of a key from its name and sample values.
func guessWidget(key string, values []any) string {
	widget := ""
	for _, v := range values {
		w := ""
		switch v := v.(type) {
		case bool:
			w = "boolean"
		case int, float64:
			w = "number"
		case []any:
			w = "list"
			if slices.ContainsFunc(v, func(e any) bool { _, ok := e.(string); return !ok }) {
				w = "object"
			}
		case map[string]any:
			w = "object"
		case string:
			switch {
			case isTimestamp(v) && len(v) == len("2006-01-02"):
				w = "date"
			case isTimestamp(v):
				w = "datetime"
			case imageKey.MatchString(key) || imageValue.MatchString(v):
				w = "image"
			case strings.Contains(v, "\n") || len(v) > 120 || slices.Contains([]string{"description", "summary", "excerpt"}, strings.ToLower(key)):
				w = "text"
			default:
				w = "string"
			}
		}
		if w == "" {
			continue
		}
		if widget != "" && widget != w { // samples disagree: plain text keeps any value
			return "string"
		}
		widget = w
	}
	if widget == "" {
		return "string"
	}
	return widget
}

// MarshalConfig writes a config as sumigo.yml.
func MarshalConfig(cfg *Config) ([]byte, error) {
	var buf bytes.Buffer
	enc := yaml.NewEncoder(&buf)
	enc.SetIndent(2)
	if err := enc.Encode(cfg); err != nil {
		return nil, err
	}
	return buf.Bytes(), enc.Close()
}

// ImportDecap keeps the keys of a Decap CMS config that Sumigo reads (media folders and collections),
// with their comments and style, and drops the rest (backend, site_url…).
func ImportDecap(raw []byte) ([]byte, error) {
	var doc yaml.Node
	if err := yaml.Unmarshal(raw, &doc); err != nil {
		return nil, err
	}
	if len(doc.Content) == 0 || doc.Content[0].Kind != yaml.MappingNode {
		return nil, errors.New("not a YAML mapping")
	}
	root := doc.Content[0]
	kept := root.Content[:0]
	for i := 0; i+1 < len(root.Content); i += 2 {
		switch root.Content[i].Value {
		case "media_folder", "public_folder", "collections":
			kept = append(kept, root.Content[i], root.Content[i+1])
		}
	}
	root.Content = kept
	var buf bytes.Buffer
	enc := yaml.NewEncoder(&buf)
	enc.SetIndent(2)
	if err := enc.Encode(&doc); err != nil {
		return nil, err
	}
	return buf.Bytes(), enc.Close()
}
