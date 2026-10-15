---
title: sumigo.yml reference
sidebar_label: sumigo.yml
---

# `sumigo.yml` reference

`sumigo.yml` describes the content model of a site: where uploads go, which folders hold entries, and which fields each entry has. It lives **at the root of the site repository**, on the branch configured for the site in the CMS. The CMS reads it from the forge (GitHub, GitLab, Forgejo or Gitea), so changing the content model is a regular commit in the site repo.

A repository without `sumigo.yml` can still be added: the site page offers **Set up the site**, which drafts the file from the repository (its Decap CMS `admin/config.yml` when there is one, otherwise one collection per folder of markdown files, with fields guessed from a few entries), lets the admin edit it, then commits it.

The format follows [Decap CMS](https://decapcms.org/docs/configuration-options/), so most Decap configs can be copied over with little or no change (see [Differences with Decap](#differences-with-decap-cms)).

## Full example

```yaml
media_folder: static/images
public_folder: /images

collections:
  - name: posts
    label: Blog posts
    folder: content/posts
    extension: md
    slug: "{{year}}-{{month}}-{{day}}-{{slug}}"
    fields:
      - { name: title, label: Title, widget: string }
      - { name: date, label: Publish date, widget: datetime }
      - { name: description, label: Description, widget: text, required: false }
      - { name: category, label: Category, widget: select, options: [news, tutorial, release] }
      - { name: tags, label: Tags, widget: list, required: false }
      - { name: author, label: Author, widget: relation, collection: authors, display_fields: [name] }
      - { name: cover, label: Cover image, widget: image, required: false }
      - { name: draft, label: Draft, widget: boolean, default: true }
      - { name: body, label: Content, widget: markdown }

  - name: authors
    label: Authors
    folder: data/authors
    extension: md
    identifier_field: name
    create: false
    fields:
      - { name: name, label: Name, widget: string }
      - { name: social, label: Social links, widget: object, required: false }
      - { name: body, label: Bio, widget: markdown, required: false }
```

## Top-level keys

| Key | Required | Default | Description |
|---|---|---|---|
| `media_folder` | yes, to upload media | none | Repository folder where uploaded files are committed, e.g. `static/images`. |
| `public_folder` | no | `/` + `media_folder` | URL prefix written into entries for uploaded files, e.g. `/images`. |
| `collections` | yes | none | List of collections, see below. |
| `i18n` | for translated collections | none | Languages of the collections with `i18n: true`, see [Multilingual content](#multilingual-content). |

Unknown keys (such as Decap's `backend`, `publish_mode` or `site_url`) are ignored.

### Media uploads

When a user uploads a file from an `image` field:

1. It is committed to `<media_folder>/<name>-<timestamp>.<ext>`. The name is slugified and the timestamp avoids collisions.
2. The field gets the value `<public_folder>/<name>-<timestamp>.<ext>`.

With `media_folder: static/images` and `public_folder: /images`, uploading `My Photo.JPG` commits `static/images/my-photo-1760342400.jpg` and writes `/images/my-photo-1760342400.jpg` in the entry.

Uploads are committed directly to the site branch, even when the site uses the pull request workflow. Max size is 10 MB.

## Collections

A collection is a folder of Markdown files that all share the same fields, or a list of [fixed files](#files-collections) with their own fields.

| Key | Required | Default | Description |
|---|---|---|---|
| `name` | yes | none | Unique identifier, used in URLs and branch names. No `/`. |
| `label` | no | `name` | Name shown in the UI. |
| `folder` | yes, or `files` | none | Repository folder holding the entries, e.g. `content/posts`. Collections with neither `folder` nor `files` are ignored. |
| `files` | yes, or `folder` | none | Fixed files edited one by one, see [Files collections](#files-collections). |
| `extension` | no | `md` | File extension of entries. |
| `slug` | no | `{{slug}}` | Template of the file name for new entries, see [Slugs](#slugs). |
| `identifier_field` | no | `title` | Field used as the entry title in lists and as `{{slug}}`. |
| `seo` | no | | Turns on the SEO panel of the editor, see [SEO](#seo). |
| `create` | no | `true` | `false` prevents creating new entries. Existing ones can still be edited. |
| `i18n` | no | `false` | `true` stores each entry once per locale, see [Multilingual content](#multilingual-content). |
| `i18n_key` | no | none | Front matter field pairing translations with their own file names, see [Translated file names](#translated-file-names). |
| `fields` | yes | none | List of fields, see [Fields](#fields). |

Only files directly in `folder` with the right extension are listed. Subfolders are not read.

Each entry is stored at `<folder>/<slug>.<extension>`.

### Files collections

A collection with `files` instead of `folder` lists fixed files, each with its own fields. It fits content that exists once: the texts of a home page, an about page, the site settings. The layout stays in the site code, which reads the texts from these files, so editors change the words without being able to break the page.

```yaml
collections:
  - name: pages
    label: Pages
    files:
      - name: home
        label: Home page
        file: src/content/pages/home.md
        fields:
          - { name: title, label: Title, widget: string }
          - { name: lede, label: Introduction, widget: text }
      - name: about
        label: About
        file: src/content/pages/about.md
        fields:
          - { name: intro, label: Introduction, widget: text }
          - { name: body, label: Content, widget: markdown }
```

| Key | Required | Description |
|---|---|---|
| `name` | yes | Unique identifier of the file, used in URLs and branch names. No `/`. |
| `label` | no | Name shown in the collection list. |
| `file` | yes | Path of the file in the repository. |
| `fields` | yes | Fields of this file, see [Fields](#fields). |

- Files are listed in the order of the config, under their label. A file missing from the repository opens empty, and saving it creates it.
- Files cannot be created nor deleted from the CMS. Drafts, scheduling, history and SEO work as in folder collections.
- `seo` may name fields of any of the files. `folder`, `extension`, `slug`, `create`, `i18n` and `i18n_key` do not apply: `i18n` is refused.

### Slugs

The slug is computed **once, when the entry is created**, and becomes its file name. Renaming the title later does not rename the file.

| Placeholder | Value |
|---|---|
| `{{slug}}` | The `identifier_field` value, slugified. |
| `{{year}}`, `{{month}}`, `{{day}}` | Creation date: `2026`, `03`, `07`. |
| `{{<field>}}` or `{{fields.<field>}}` | Any text field of the entry, slugified. |

Slugify means: lowercase, accents removed, everything else that is not a letter or a digit becomes a single `-`. For example, `Été à Paris, 2026 !` becomes `ete-a-paris-2026`.

`slug: "{{year}}-{{month}}-{{day}}-{{slug}}"` with the title `Hello World` gives `2026-03-07-hello-world.md`.

Creating an entry whose slug already exists (published or as an open draft) is refused.

### SEO

A collection with a `seo` block gets an **SEO** tab in the editor, next to Preview and History. It scores the entry as it is typed and shows how it looks in Google. The block names the fields playing each role; the `body` is always analyzed. An entry without a `body` field, like a page whose layout lives in the site code, is analyzed from the text of its fields and lists instead: headings and links are then left out, and 300 words are enough.

```yaml
collections:
  - name: blog
    folder: src/content/blog
    seo:
      title: title             # meta title, defaults to identifier_field
      description: description
      keywords: keywords       # list or comma separated string, the first one is the focus keyword
      image: cover             # share image
      slug: true               # check the focus keyword in the URL
    fields:
      - { name: title, widget: string }
      - { name: description, widget: text }
      - { name: keywords, widget: list }
      - { name: cover, widget: image, required: false }
      - { name: body, widget: markdown }
```

Every key is optional, and a named field must exist in `fields`. The checks: title length (30 to 60) and description length (120 to 160), focus keyword in the title, description, URL and first 100 words, its density in the content (0.5 to 2.5%), content length (600 words or more), H2/H3 subheadings, no H1 in the content, images with an alternative text, links, and a share image. Keywords match whole words, ignoring case and accents.

## Fields

| Key | Required | Default | Description |
|---|---|---|---|
| `name` | yes | none | Key in the front matter. `body` is special, see below. |
| `label` | no | `name` | Label shown in the editor. |
| `widget` | no | `string` | Editor input, see [Widgets](#widgets). |
| `required` | no | `true` | Like Decap, **fields are required unless `required: false`**. Checked in the editor and on the server. Booleans are never required. |
| `default` | no | none | Initial value when creating an entry. |
| `options` | for `select` | none | Allowed values, see `select`. |
| `fields` | no | none | Sub-fields of an `object`, or of a `list` of objects. These are edited as JSON for now. |
| `collection`, `value_field`, `display_fields`, `multiple` | for `relation` | | See [Relations](#relations). |
| `i18n` | no | `duplicate` | In a translated collection: `true` for a translated field, `false` for one living only in the default locale. Unset, it is copied from the default locale. |

### The `body` field

The field named `body` is not written in the front matter. It is the Markdown content after it:

```markdown
---
title: Hello World
date: 2026-03-07T09:00:00.000Z
tags:
  - go
  - cms
---

The **body** goes here.
```

### Widgets

| Widget | Editor | Stored value |
|---|---|---|
| `string` | Single line input | String |
| `text` | Multi-line textarea | String |
| `markdown` | Markdown editor with live preview | String (Markdown) |
| `date` | Date picker | `2026-03-07` |
| `datetime` | Date and time picker (local time) | `2026-03-07T09:00:00.000Z` (UTC) |
| `boolean` | Checkbox | `true` / `false` |
| `number` | Number input | Number |
| `select` | Dropdown | String |
| `list` | Comma separated input | List of strings: `[go, cms]` |
| `image` | Path input + upload button | String (public URL) |
| `relation` | Dropdown of the entries of another collection | String, or list of strings with `multiple: true` |
| `hidden` | Not shown | Kept as is, or `default` on creation |
| `object` | JSON textarea | Nested map |

Any other widget name (for example Decap's `file`) is shown as a single line text input. If the existing value is not plain text, a JSON editor is shown instead, so it is never lost.

`select` options can be plain strings or label/value pairs:

```yaml
- name: category
  widget: select
  options:
    - news
    - { label: "Tutorials", value: tutorial }
```

### Relations

A `relation` field links an entry to entries of another collection: the author of a post, its categories.

```yaml
- name: authors
  widget: relation
  collection: authors        # a folder collection of this file
  value_field: "{{slug}}"    # stored value: the file name (default), or a field name
  display_fields: [name]     # the first one labels the choices, identifier_field by default
  multiple: true             # a list of entries instead of one
```

The choices are the entries of `collection`, drafts included. A stored value that matches no entry is kept as is. Decap's `search_fields` is accepted and ignored.

## Multilingual content

A collection with `i18n: true` stores each entry once per locale. The locales are declared once, at the top of the file:

```yaml
i18n:
  structure: multiple_folders  # or multiple_files
  locales: [en, fr, es]
  default_locale: en           # the first locale by default

collections:
  - name: blog
    folder: src/content/blog
    i18n: true
    fields:
      - { name: title, widget: string, i18n: true }
      - { name: date, widget: datetime }            # copied from the default locale
      - { name: cover, widget: image, i18n: false } # default locale only
      - { name: body, widget: markdown, i18n: true }
```

| `structure` | Files of the entry `hello` |
|---|---|
| `multiple_folders` | `src/content/blog/en/hello.md`, `src/content/blog/fr/hello.md` |
| `multiple_files` | `src/content/blog/hello.en.md`, `src/content/blog/hello.fr.md` |

- An entry is created in the default locale. The editor then shows a tab per locale, and the collection list shows which locales each entry is published in.
- A translation shows every field but the ones marked `i18n: false`, which only live in the default locale file. Fields without `i18n` (or with `i18n: duplicate`) start with the value of the default locale, `i18n: true` ones start empty.
- Every locale of an entry shares its slug and its draft: in the pull request workflow, the translations of an entry are reviewed and published together.
- Deleting an entry deletes it in every locale.

### Translated file names

By default a translation has the file name of its entry, like Decap. When each locale names its files after its own title, like `en/hello.md` and `fr/bonjour.md`, `i18n_key` names the front matter field that pairs them:

```yaml
collections:
  - name: blog
    folder: src/content/blog
    i18n: true
    i18n_key: translationKey
```

- A translation is the file of the locale folder whose `translationKey` equals the one of the entry. An entry without the field is paired by its slug.
- A new translation is named after its own title, with the `slug` template, and gets the `translationKey` of its entry.

## How entries are written

- Front matter keys follow the order of `fields`. Empty values are left out.
- Dates are written unquoted (`date: 2026-03-07`), so YAML and schemas like Astro's `z.date()` read them as dates. Dates already in a file keep their exact format.
- Keys present in a file but not declared in `fields` are **kept unchanged**, after the declared ones, in alphabetical order. Adding a field to `sumigo.yml` never breaks existing entries, and removing one never deletes data.
- Files without front matter can be opened: their whole content becomes `body`.

## Caching

The CMS caches `sumigo.yml` for one minute per site. To apply a change right away, click **Test access** in the site settings: it reloads the file and shows how many collections were found. Errors (missing file, invalid YAML, collection without a name) are shown at the top of the site page.

## Differences with Decap CMS

| Decap | Sumigo |
|---|---|
| `config.yml` anywhere (often `static/admin/config.yml`) | `sumigo.yml` at the repository root |
| `backend` (repo, branch) | Set per site in the CMS, ignored in the file |
| `publish_mode: editorial_workflow` | Set per site in the CMS (`direct` or `pr`), ignored in the file. Keeping it in the CMS means editing the file cannot bypass review. |
| `files` collections | Supported, without `i18n` |
| Nested folders, `path`, `filter`, `summary`, `sortable_fields`, `view_filters` | Not supported, ignored |
| `i18n` with `structure: single_file`, or an `i18n` object on a collection | Not supported, refused |
| A field without `i18n` lives only in the default locale | It is copied into translations, `i18n: false` keeps it in the default locale |
| Per-collection `media_folder` | Not supported, the top-level one is used |
| `file`, `code`, `color`, `map` widgets | Plain text input |
| `relation` with `{{fields.x}}` templates in `value_field` or `display_fields` | Field names only |
| `object` and `list` with `fields` | JSON editor |
