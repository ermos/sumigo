package content

import (
	"strings"
	"testing"
	"time"
)

func TestRoundTrip(t *testing.T) {
	fields := []Field{{Name: "title"}, {Name: "date", Widget: "date"}, {Name: "tags"}, {Name: "body"}}
	data := map[string]any{"title": "Hello: world", "date": "2026-10-13", "tags": []any{"go", "cms"}, "extra": 1, "body": "# Hi\n\ntext"}

	out, err := Render(fields, data)
	if err != nil {
		t.Fatal(err)
	}
	want := "---\ntitle: 'Hello: world'\ndate: 2026-10-13\ntags:\n  - go\n  - cms\nextra: 1\n---\n\n# Hi\n\ntext\n"
	if string(out) != want {
		t.Fatalf("render:\n%s\nwant:\n%s", out, want)
	}

	got, body, err := Parse(out)
	if err != nil {
		t.Fatal(err)
	}
	if body != "# Hi\n\ntext\n" || got["title"] != "Hello: world" || got["date"] != "2026-10-13" || got["extra"] != 1 {
		t.Fatalf("parse: %#v %q", got, body)
	}
}

// A file saved without changes must keep its dates and quoted strings as written.
func TestDatesKeepTheirFormat(t *testing.T) {
	in := "---\ntitle: \"2026-01-01\"\npubDate: 2026-10-13\nupdated: 2026-10-13T10:00:00Z\nb: x\na: z\n---\n"
	data, _, err := Parse([]byte(in))
	if err != nil {
		t.Fatal(err)
	}
	out, err := Render([]Field{{Name: "title", Widget: "string"}, {Name: "updated", Widget: "datetime"}}, data)
	if err != nil {
		t.Fatal(err)
	}
	want := "---\ntitle: \"2026-01-01\"\nupdated: 2026-10-13T10:00:00Z\na: z\nb: x\npubDate: 2026-10-13\n---\n"
	if string(out) != want {
		t.Fatalf("render:\n%s\nwant:\n%s", out, want)
	}
}

func TestParseWithoutFrontMatter(t *testing.T) {
	data, body, err := Parse([]byte("just text"))
	if err != nil || len(data) != 0 || body != "just text" {
		t.Fatalf("%v %q %v", data, body, err)
	}
}

func TestSlug(t *testing.T) {
	now := time.Date(2026, 3, 7, 0, 0, 0, 0, time.UTC)
	got := Slug("{{year}}-{{month}}-{{day}}-{{slug}}", "Été à Paris, 2026 !", nil, now)
	if got != "2026-03-07-ete-a-paris-2026" {
		t.Fatal(got)
	}
}

func TestSEOMustUseFieldsOfTheCollection(t *testing.T) {
	ok := "collections:\n  - name: blog\n    folder: blog\n    seo: { title: title, keywords: tags, slug: true }\n    fields: [{ name: title }, { name: tags, widget: list }]\n"
	cfg, err := ParseConfig([]byte(ok))
	if err != nil || cfg.Collections[0].SEO.Keywords != "tags" || !cfg.Collections[0].SEO.Slug {
		t.Fatalf("cfg = %+v, %v", cfg, err)
	}
	if _, err := ParseConfig([]byte(strings.Replace(ok, "keywords: tags", "keywords: kw", 1))); err == nil || !strings.Contains(err.Error(), `"kw"`) {
		t.Fatalf("unknown seo field accepted: %v", err)
	}
}

func TestRelationsMustPointToACollection(t *testing.T) {
	ok := "collections:\n  - name: authors\n    folder: authors\n    fields: [{ name: name }]\n  - name: blog\n    folder: blog\n    fields:\n      - { name: author, widget: relation, collection: authors, display_fields: [name], multiple: true }\n"
	cfg, err := ParseConfig([]byte(ok))
	if err != nil || cfg.Collections[1].Fields[0].Collection != "authors" || !cfg.Collections[1].Fields[0].Multiple {
		t.Fatalf("cfg = %+v, %v", cfg, err)
	}
	if _, err := ParseConfig([]byte(strings.Replace(ok, "collection: authors", "collection: people", 1))); err == nil || !strings.Contains(err.Error(), `"people"`) {
		t.Fatalf("unknown relation collection accepted: %v", err)
	}
}

func TestI18nPaths(t *testing.T) {
	raw := "i18n: { structure: multiple_folders, locales: [en, fr, de], default_locale: fr }\ncollections:\n  - { name: blog, folder: blog, i18n: true }\n  - { name: pages, folder: pages }\n"
	cfg, err := ParseConfig([]byte(raw))
	if err != nil {
		t.Fatal(err)
	}
	blog, pages := cfg.Collections[0], cfg.Collections[1]
	if strings.Join(blog.Locales, ",") != "fr,en,de" {
		t.Fatalf("default locale first: %v", blog.Locales)
	}
	if blog.Path("hi", "") != "blog/fr/hi.md" || blog.Path("hi", "de") != "blog/de/hi.md" || pages.Path("hi", "") != "pages/hi.md" {
		t.Fatal(blog.Path("hi", ""), blog.Path("hi", "de"), pages.Path("hi", ""))
	}
	cfg, err = ParseConfig([]byte(strings.Replace(raw, "multiple_folders", "multiple_files", 1)))
	if err != nil || cfg.Collections[0].Path("hi", "en") != "blog/hi.en.md" {
		t.Fatalf("multiple_files: %v", err)
	}
	for _, bad := range []string{
		strings.Replace(raw, "multiple_folders", "single_file", 1),
		strings.Replace(raw, "default_locale: fr", "default_locale: it", 1),
		strings.Replace(raw, "[en, fr, de]", "[en, ../x]", 1),
		"collections:\n  - { name: blog, folder: blog, i18n: true }\n",
	} {
		if _, err := ParseConfig([]byte(bad)); err == nil {
			t.Fatalf("accepted:\n%s", bad)
		}
	}
}
