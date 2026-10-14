package content

import (
	"strings"
	"testing"
)

func TestDetectConfigFromAnAstroRepo(t *testing.T) {
	paths := []string{
		"README.md", "astro.config.mjs", "public/admin/config.yml", "public/images/logo.png",
		"src/content/blog/a.md", "src/content/blog/b.md", "src/content/albums/x.mdx",
		"node_modules/pkg/README.md", ".github/ISSUE.md", "src/content/attestations/main.json",
	}
	folders := ContentFolders(paths)
	if len(folders) != 2 || folders[0].Path != "src/content/albums" || folders[0].Ext != ".mdx" || folders[1].Path != "src/content/blog" {
		t.Fatalf("folders = %+v", folders)
	}
	samples := map[string][]string{
		"src/content/blog": {
			"---\ntitle: A\npubDate: 2026-03-07\ncover: /images/a.webp\ndraft: false\ntags: [go]\n---\nHello\n",
			"---\ntitle: B\npubDate: 2026-03-08\ndraft: true\ntags: []\n---\nWorld\n",
		},
		"src/content/albums": {"---\nname: Rouez\nphotos:\n  - {src: a.jpg, alt: A}\n---\n"},
	}
	out, err := MarshalConfig(DetectConfig(paths, folders, samples))
	if err != nil {
		t.Fatal(err)
	}
	cfg, err := ParseConfig(out)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.MediaFolder != "public/images" || cfg.PublicFolder != "/images" {
		t.Fatalf("media = %q %q", cfg.MediaFolder, cfg.PublicFolder)
	}
	albums, blog := cfg.Collections[0], cfg.Collections[1]
	if albums.Name != "albums" || albums.Extension != "mdx" || albums.IdentifierField != "name" {
		t.Fatalf("albums = %+v", albums)
	}
	var got []string
	for _, f := range blog.Fields {
		got = append(got, f.Name+":"+f.Widget+map[bool]string{true: "", false: "?"}[f.IsRequired()])
	}
	// cover is missing from one sample, so optional; the body is markdown.
	if want := "title:string pubDate:date cover:image? draft:boolean tags:list body:markdown"; strings.Join(got, " ") != want {
		t.Fatalf("blog fields = %s\nwant          %s", strings.Join(got, " "), want)
	}
	if albums.Fields[1].Widget != "object" || albums.Fields[2].IsRequired() {
		t.Fatalf("albums fields = %+v", albums.Fields)
	}
}

func TestImportDecapKeepsOnlyWhatSumigoReads(t *testing.T) {
	out, err := ImportDecap([]byte("backend:\n  name: github\n  base_url: https://oauth.example\nsite_url: https://x.io\n# Uploads\nmedia_folder: \"public/uploads\"\ncollections:\n  - { name: blog, folder: src/content/blog, fields: [{ name: title, widget: string }] }\n"))
	if err != nil {
		t.Fatal(err)
	}
	s := string(out)
	if strings.Contains(s, "backend") || strings.Contains(s, "site_url") || !strings.Contains(s, "# Uploads") || !strings.Contains(s, `media_folder: "public/uploads"`) || !strings.Contains(s, "{name: blog") {
		t.Fatalf("imported:\n%s", s)
	}
}
