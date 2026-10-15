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
	I18nKey   string   `yaml:"i18n_key,omitempty" json:"i18n_key,omitempty"`
	Locales   []string `yaml:"-" json:"locales,omitempty"`
	structure string
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
	// I18n is true (or Decap's "translate") for a translated field, "duplicate" for one copied from the default locale.
	// Other fields only live in the default locale.
	I18n any `yaml:"i18n,omitempty" json:"i18n,omitempty"`
}

// Translatable reports whether the field shows in the translations of an entry.
func (f Field) Translatable() bool {
	return f.I18n == true || f.I18n == "translate" || f.I18n == "duplicate"
}

// IsRequired follows Decap: fields are required unless `required: false`.
func (f Field) IsRequired() bool { return f.Required == nil || *f.Required }

func (c Collection) Ext() string {
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

// ParseConfig reads a Decap-style config. Collections without a folder (Decap "files"
// collections) are skipped.
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
		if c.Folder == "" {
			continue
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
				if name != "" && !slices.ContainsFunc(c.Fields, func(f Field) bool { return f.Name == name }) {
					return nil, fmt.Errorf("collection %s: seo uses field %q, which is not in its fields", c.Name, name)
				}
			}
		}
		cols = append(cols, c)
	}
	cfg.Collections = cols
	for _, c := range cols {
		if err := checkRelations(cols, c.Fields); err != nil {
			return nil, fmt.Errorf("collection %s: %w", c.Name, err)
		}
	}
	cfg.MediaFolder = strings.Trim(cfg.MediaFolder, "/")
	return &cfg, nil
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
