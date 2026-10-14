package content

import (
	"errors"
	"fmt"
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
}

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
}

// IsRequired follows Decap: fields are required unless `required: false`.
func (f Field) IsRequired() bool { return f.Required == nil || *f.Required }

func (c Collection) Ext() string {
	if c.Extension != "" {
		return "." + strings.TrimPrefix(c.Extension, ".")
	}
	return ".md"
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
	cols := cfg.Collections[:0]
	for _, c := range cfg.Collections {
		if c.Folder == "" {
			continue
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
	cfg.MediaFolder = strings.Trim(cfg.MediaFolder, "/")
	return &cfg, nil
}
