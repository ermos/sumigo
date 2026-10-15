package content

import (
	"errors"
	"fmt"
	"path"
	"regexp"
	"slices"
	"strings"

	"gopkg.in/yaml.v3"
)

// ConfigFile is the CMS config at the root of every site repository.
const ConfigFile = "sumigo.yml"

// Config is the content of ConfigFile. It follows the Decap CMS format.
type Config struct {
	MediaFolder  string       `yaml:"media_folder,omitempty" json:"media_folder"`
	PublicFolder string       `yaml:"public_folder,omitempty" json:"public_folder"`
	Collections  []Collection `yaml:"collections,omitempty" json:"collections"`
	// I18n lists the languages of the collections that turn on i18n, like Decap.
	I18n *I18n `yaml:"i18n,omitempty" json:"i18n,omitempty"`
}

// I18n structures supported: content/posts/fr/hello.md, or content/posts/hello.fr.md.
const (
	MultipleFolders = "multiple_folders"
	MultipleFiles   = "multiple_files"
)

type I18n struct {
	Structure     string   `yaml:"structure,omitempty" json:"structure"`
	Locales       []string `yaml:"locales,omitempty" json:"locales"`
	DefaultLocale string   `yaml:"default_locale,omitempty" json:"default_locale"`
}

var validLocale = regexp.MustCompile(`^[A-Za-z0-9_-]+$`)

type Collection struct {
	Name            string  `yaml:"name,omitempty" json:"name"`
	Label           string  `yaml:"label,omitempty" json:"label,omitempty"`
	Folder          string  `yaml:"folder,omitempty" json:"folder"`
	Extension       string  `yaml:"extension,omitempty" json:"extension,omitempty"`
	Slug            string  `yaml:"slug,omitempty" json:"slug,omitempty"`
	IdentifierField string  `yaml:"identifier_field,omitempty" json:"identifier_field,omitempty"`
	Create          *bool   `yaml:"create,omitempty" json:"create,omitempty"`
	Fields          []Field `yaml:"fields,omitempty" json:"fields"`
	// SEO turns on the SEO analysis of the entries and names the fields playing each role. The body is always analyzed.
	SEO *SEO `yaml:"seo,omitempty" json:"seo,omitempty"`
	// I18n stores each entry once per locale. Locales is filled from the top-level i18n, default locale first.
	I18n bool `yaml:"i18n,omitempty" json:"i18n,omitempty"`
	// I18nKey names the front matter field pairing the translations of an entry, so each locale keeps its own file name.
	// Without it, translations share the file name of the default entry, like Decap.
	I18nKey string   `yaml:"i18n_key,omitempty" json:"i18n_key,omitempty"`
	Locales []string `yaml:"-" json:"locales,omitempty"`
	// Files makes a collection of fixed files, each with its own fields, instead of a folder (Decap "files" collection).
	// Entries can be edited, never created nor deleted.
	Files     []File `yaml:"files,omitempty" json:"files,omitempty"`
	structure string
}

// File is one entry of a files collection: its slug is Name.
type File struct {
	Name   string  `yaml:"name,omitempty" json:"name"`
	Label  string  `yaml:"label,omitempty" json:"label,omitempty"`
	File   string  `yaml:"file,omitempty" json:"file"`
	Fields []Field `yaml:"fields,omitempty" json:"fields"`
}

// IsFiles reports whether the collection lists fixed files instead of a folder.
func (c Collection) IsFiles() bool { return len(c.Files) > 0 }

// Entry returns the collection as seen by one of its entries: a file of a files collection brings its own fields.
// ok is false for a name that is not one of the files.
func (c Collection) Entry(slug string) (*Collection, bool) {
	if !c.IsFiles() {
		return &c, true
	}
	for _, f := range c.Files {
		if f.Name == slug {
			c.Fields = f.Fields
			return &c, true
		}
	}
	return nil, false
}

// SEO names the fields of a collection that hold its search metadata.
type SEO struct {
	Title       string `yaml:"title,omitempty" json:"title,omitempty"`
	Description string `yaml:"description,omitempty" json:"description,omitempty"`
	// Keywords holds the targeted keywords, the first one being the focus keyword.
	Keywords string `yaml:"keywords,omitempty" json:"keywords,omitempty"`
	Image    string `yaml:"image,omitempty" json:"image,omitempty"`
	// Slug checks the focus keyword in the entry URL.
	Slug bool `yaml:"slug,omitempty" json:"slug,omitempty"`
}

type Field struct {
	Name     string  `yaml:"name,omitempty" json:"name"`
	Label    string  `yaml:"label,omitempty" json:"label,omitempty"`
	Widget   string  `yaml:"widget,omitempty" json:"widget"`
	Required *bool   `yaml:"required,omitempty" json:"required,omitempty"`
	Options  []any   `yaml:"options,omitempty" json:"options,omitempty"`
	Default  any     `yaml:"default,omitempty" json:"default,omitempty"`
	Fields   []Field `yaml:"fields,omitempty" json:"fields,omitempty"`
	// Collection, ValueField, DisplayFields and Multiple set up a relation widget, like Decap.
	Collection    string   `yaml:"collection,omitempty" json:"collection,omitempty"`
	ValueField    string   `yaml:"value_field,omitempty" json:"value_field,omitempty"`
	DisplayFields []string `yaml:"display_fields,omitempty" json:"display_fields,omitempty"`
	Multiple      bool     `yaml:"multiple,omitempty" json:"multiple,omitempty"`
	// I18n is true (or Decap's "translate") for a translated field, false (or "none") for one living only in the
	// default locale. Unset, or "duplicate", the field is copied from the default locale into new translations.
	I18n any `yaml:"i18n,omitempty" json:"i18n,omitempty"`
}

// Translatable reports whether the field shows in the translations of an entry.
func (f Field) Translatable() bool {
	return f.I18n != false && f.I18n != "none"
}

// IsRequired follows Decap: fields are required unless `required: false`.
func (f Field) IsRequired() bool { return f.Required == nil || *f.Required }

func (c Collection) Ext() string {
	if c.IsFiles() {
		return path.Ext(c.Files[0].File)
	}
	if c.Extension != "" {
		return "." + strings.TrimPrefix(c.Extension, ".")
	}
	return ".md"
}

// AllLocales lists the locales an entry is stored in: "" alone when the collection is not translated.
func (c Collection) AllLocales() []string {
	if !c.I18n {
		return []string{""}
	}
	return c.Locales
}

// IsLocale reports whether locale is one of the collection. "" is the default locale.
func (c Collection) IsLocale(locale string) bool {
	return locale == "" || slices.Contains(c.Locales, locale)
}

// Dir returns the folder holding the entries of a locale and the end of their file names after the slug.
// "" is the default locale.
func (c Collection) Dir(locale string) (string, string) {
	if c.IsFiles() {
		return "", ""
	}
	if !c.I18n {
		return c.Folder, c.Ext()
	}
	if locale == "" {
		locale = c.Locales[0]
	}
	if c.structure == MultipleFiles {
		return c.Folder, "." + locale + c.Ext()
	}
	return path.Join(c.Folder, locale), c.Ext()
}

// Path is the file of an entry in a locale, "" being the default one.
func (c Collection) Path(slug, locale string) string {
	if c.IsFiles() {
		for _, f := range c.Files {
			if f.Name == slug {
				return f.File
			}
		}
		return ""
	}
	dir, suffix := c.Dir(locale)
	return path.Join(dir, slug+suffix)
}

// TranslationKey is what pairs an entry with its translations: its I18nKey field, or its slug.
func (c Collection) TranslationKey(slug string, data map[string]any) string {
	if k, ok := data[c.I18nKey].(string); ok && c.I18nKey != "" && k != "" {
		return k
	}
	return slug
}

func (c Collection) TitleField() string {
	if c.IdentifierField != "" {
		return c.IdentifierField
	}
	return "title"
}

// ParseConfig reads a Decap-style config.
func ParseConfig(raw []byte) (*Config, error) {
	var cfg Config
	if err := yaml.Unmarshal(raw, &cfg); err != nil {
		return nil, err
	}
	if err := cfg.checkI18n(); err != nil {
		return nil, err
	}
	cols := cfg.Collections[:0]
	for _, c := range cfg.Collections {
		if c.Folder == "" && !c.IsFiles() {
			continue
		}
		if c.IsFiles() {
			if err := c.checkFiles(); err != nil {
				return nil, fmt.Errorf("collection %s: %w", c.Name, err)
			}
		}
		if c.I18n {
			if cfg.I18n == nil {
				return nil, fmt.Errorf("collection %s: i18n needs the top-level i18n block with its locales", c.Name)
			}
			c.structure = cfg.I18n.Structure
			c.Locales = append([]string{cfg.I18n.DefaultLocale}, slices.DeleteFunc(slices.Clone(cfg.I18n.Locales), func(l string) bool { return l == cfg.I18n.DefaultLocale })...)
		}
		if c.I18nKey != "" && !c.I18n {
			return nil, fmt.Errorf("collection %s: i18n_key needs i18n: true", c.Name)
		}
		if c.Name == "" || strings.ContainsAny(c.Name, `/\`) {
			return nil, errors.New("collection names must be set and contain no slash")
		}
		c.Folder = strings.Trim(c.Folder, "/")
		if c.SEO != nil {
			for _, name := range []string{c.SEO.Title, c.SEO.Description, c.SEO.Keywords, c.SEO.Image} {
				if name != "" && !slices.ContainsFunc(c.allFields(), func(f Field) bool { return f.Name == name }) {
					return nil, fmt.Errorf("collection %s: seo uses field %q, which is not in its fields", c.Name, name)
				}
			}
		}
		cols = append(cols, c)
	}
	cfg.Collections = cols
	for _, c := range cols {
		if err := checkRelations(cols, c.allFields()); err != nil {
			return nil, fmt.Errorf("collection %s: %w", c.Name, err)
		}
	}
	cfg.MediaFolder = strings.Trim(cfg.MediaFolder, "/")
	return &cfg, nil
}

// checkFiles validates the files of a files collection, which can be edited but never created.
func (c *Collection) checkFiles() error {
	if c.I18n {
		return errors.New("i18n is not supported with files")
	}
	seen := map[string]bool{}
	for i, f := range c.Files {
		if f.Name == "" || strings.HasPrefix(f.Name, ".") || strings.ContainsAny(f.Name, `/\`) || seen[f.Name] {
			return fmt.Errorf("file names must be set, unique and contain no slash: %q", f.Name)
		}
		seen[f.Name] = true
		c.Files[i].File = strings.Trim(f.File, "/")
		if c.Files[i].File == "" || strings.Contains("/"+c.Files[i].File+"/", "/../") {
			return fmt.Errorf("file %s needs a file path in the repository", f.Name)
		}
		// Sent as [] rather than null: the UI lists the fields of every collection and file.
		if f.Fields == nil {
			c.Files[i].Fields = []Field{}
		}
	}
	if c.Fields == nil {
		c.Fields = []Field{}
	}
	no := false
	c.Create = &no
	return nil
}

// allFields lists the fields of the collection and of each of its files.
func (c Collection) allFields() []Field {
	fields := slices.Clone(c.Fields)
	for _, f := range c.Files {
		fields = append(fields, f.Fields...)
	}
	return fields
}

// checkRelations makes sure every relation field, nested ones included, points to a folder collection.
func checkRelations(cols []Collection, fields []Field) error {
	for _, f := range fields {
		if f.Widget == "relation" && !slices.ContainsFunc(cols, func(c Collection) bool { return c.Name == f.Collection }) {
			return fmt.Errorf("relation field %q uses collection %q, which is not a folder collection", f.Name, f.Collection)
		}
		if err := checkRelations(cols, f.Fields); err != nil {
			return err
		}
	}
	return nil
}

// checkI18n validates the top-level i18n block and fills its defaults.
func (cfg *Config) checkI18n() error {
	i := cfg.I18n
	if i == nil {
		return nil
	}
	if i.Structure == "" {
		i.Structure = MultipleFolders
	}
	if i.Structure != MultipleFolders && i.Structure != MultipleFiles {
		return fmt.Errorf("i18n structure %q is not supported, use %s or %s", i.Structure, MultipleFolders, MultipleFiles)
	}
	if len(i.Locales) == 0 {
		return errors.New("i18n needs at least one locale")
	}
	for _, l := range i.Locales {
		if !validLocale.MatchString(l) {
			return fmt.Errorf("i18n locale %q must be letters, digits, - or _", l)
		}
	}
	if i.DefaultLocale == "" {
		i.DefaultLocale = i.Locales[0]
	}
	if !slices.Contains(i.Locales, i.DefaultLocale) {
		return fmt.Errorf("i18n default_locale %q is not in its locales", i.DefaultLocale)
	}
	return nil
}
