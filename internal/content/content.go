// Package content converts entries to and from markdown files with YAML front matter.
package content

import (
	"bytes"
	"sort"
	"strings"
	"time"
	"unicode"

	"golang.org/x/text/unicode/norm"
	"gopkg.in/yaml.v3"
)

// BodyField is the field stored as the markdown body instead of front matter.
const BodyField = "body"

// Parse splits a file into front matter data and body.
func Parse(raw []byte) (map[string]any, string, error) {
	data := map[string]any{}
	s := strings.ReplaceAll(string(raw), "\r\n", "\n")
	if !strings.HasPrefix(s, "---\n") {
		return data, s, nil
	}
	end := strings.Index(s[4:], "\n---")
	if end < 0 {
		return data, s, nil
	}
	var node yaml.Node
	if err := yaml.Unmarshal([]byte(s[4:4+end]), &node); err != nil {
		return nil, "", err
	}
	timestampsAsStrings(&node)
	if err := node.Decode(&data); err != nil {
		return nil, "", err
	}
	body := strings.TrimPrefix(s[4+end+4:], "\n")
	return data, strings.TrimPrefix(body, "\n"), nil
}

// timestampsAsStrings keeps dates exactly as written (2026-10-13 stays 2026-10-13) instead of
// turning them into time.Time, which would be rewritten as 2026-10-13T00:00:00Z.
func timestampsAsStrings(n *yaml.Node) {
	if n.Kind == yaml.ScalarNode && n.ShortTag() == "!!timestamp" {
		n.Tag = "!!str"
	}
	for _, c := range n.Content {
		timestampsAsStrings(c)
	}
}

// isTimestamp reports whether YAML reads s, written unquoted, as a date.
func isTimestamp(s string) bool {
	var t time.Time
	return yaml.Unmarshal([]byte(s), &t) == nil && !t.IsZero()
}

// Render writes front matter in the collection field order, then unknown keys sorted, then the body.
// Dates of date/datetime fields and of unknown keys are written unquoted, so YAML (and schemas
// like Astro's z.date()) still read them as dates.
func Render(fields []Field, data map[string]any) ([]byte, error) {
	doc := &yaml.Node{Kind: yaml.MappingNode}
	add := func(k string, v any, dates bool) error {
		var val yaml.Node
		if err := val.Encode(v); err != nil {
			return err
		}
		if s, ok := v.(string); ok && dates && isTimestamp(s) {
			val.Tag, val.Style = "!!timestamp", 0
		}
		doc.Content = append(doc.Content, &yaml.Node{Kind: yaml.ScalarNode, Value: k}, &val)
		return nil
	}
	seen := map[string]bool{BodyField: true}
	for _, f := range fields {
		seen[f.Name] = true
		if v, ok := data[f.Name]; ok && f.Name != BodyField && v != nil && v != "" {
			if err := add(f.Name, v, f.Widget == "date" || f.Widget == "datetime"); err != nil {
				return nil, err
			}
		}
	}
	// Keep keys the CMS does not know about so it never drops data.
	unknown := []string{}
	for k := range data {
		if !seen[k] {
			unknown = append(unknown, k)
		}
	}
	sort.Strings(unknown)
	for _, k := range unknown {
		if err := add(k, data[k], true); err != nil {
			return nil, err
		}
	}
	var buf bytes.Buffer
	buf.WriteString("---\n")
	enc := yaml.NewEncoder(&buf)
	enc.SetIndent(2)
	if err := enc.Encode(doc); err != nil {
		return nil, err
	}
	buf.WriteString("---\n")
	if body, _ := data[BodyField].(string); body != "" {
		buf.WriteString("\n" + strings.TrimRight(body, "\n") + "\n")
	}
	return buf.Bytes(), nil
}

// Slugify lowercases, strips accents and joins words with dashes.
func Slugify(s string) string {
	var b strings.Builder
	dash := false
	for _, r := range norm.NFD.String(strings.ToLower(s)) {
		switch {
		case unicode.Is(unicode.Mn, r):
		case r < unicode.MaxASCII && (unicode.IsLetter(r) || unicode.IsDigit(r)):
			b.WriteRune(r)
			dash = false
		case !dash && b.Len() > 0:
			b.WriteByte('-')
			dash = true
		}
	}
	return strings.TrimRight(b.String(), "-")
}

// Slug builds an entry slug from a template like "{{year}}-{{month}}-{{day}}-{{slug}}".
// {{slug}} is the slugified title, {{field}} and {{fields.field}} take entry values.
func Slug(template, title string, data map[string]any, now time.Time) string {
	if template == "" {
		template = "{{slug}}"
	}
	r := []string{
		"{{year}}", now.Format("2006"), "{{month}}", now.Format("01"), "{{day}}", now.Format("02"),
		"{{slug}}", Slugify(title),
	}
	for k, v := range data {
		if s, ok := v.(string); ok {
			r = append(r, "{{"+k+"}}", Slugify(s), "{{fields."+k+"}}", Slugify(s))
		}
	}
	return strings.NewReplacer(r...).Replace(template)
}
