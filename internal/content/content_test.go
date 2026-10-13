package content

import (
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
