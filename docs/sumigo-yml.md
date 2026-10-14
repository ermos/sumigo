# `sumigo.yml` reference

`sumigo.yml` describes the content model of a site: where uploads go, which folders hold entries, and which fields each entry has. It lives **at the root of the site repository**, on the branch configured for the site in the CMS. The CMS reads it from the forge (GitHub, GitLab, Forgejo or Gitea), so changing the content model is a regular commit in the site repo.

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

Unknown keys (such as Decap's `backend`, `publish_mode` or `site_url`) are ignored.

### Media uploads

When a user uploads a file from an `image` field:

1. It is committed to `<media_folder>/<name>-<timestamp>.<ext>`. The name is slugified and the timestamp avoids collisions.
2. The field gets the value `<public_folder>/<name>-<timestamp>.<ext>`.

With `media_folder: static/images` and `public_folder: /images`, uploading `My Photo.JPG` commits `static/images/my-photo-1760342400.jpg` and writes `/images/my-photo-1760342400.jpg` in the entry.

Uploads are committed directly to the site branch, even when the site uses the pull request workflow. Max size is 10 MB.

## Collections

A collection is a folder of Markdown files that all share the same fields.

| Key | Required | Default | Description |
|---|---|---|---|
| `name` | yes | none | Unique identifier, used in URLs and branch names. No `/`. |
| `label` | no | `name` | Name shown in the UI. |
| `folder` | yes | none | Repository folder holding the entries, e.g. `content/posts`. Collections without `folder` are ignored. |
| `extension` | no | `md` | File extension of entries. |
| `slug` | no | `{{slug}}` | Template of the file name for new entries, see [Slugs](#slugs). |
| `identifier_field` | no | `title` | Field used as the entry title in lists and as `{{slug}}`. |
| `create` | no | `true` | `false` prevents creating new entries. Existing ones can still be edited. |
| `fields` | yes | none | List of fields, see [Fields](#fields). |

Only files directly in `folder` with the right extension are listed. Subfolders are not read.

Each entry is stored at `<folder>/<slug>.<extension>`.

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
| `hidden` | Not shown | Kept as is, or `default` on creation |
| `object` | JSON textarea | Nested map |

Any other widget name (for example Decap's `relation` or `file`) is shown as a single line text input. If the existing value is not plain text, a JSON editor is shown instead, so it is never lost.

`select` options can be plain strings or label/value pairs:

```yaml
- name: category
  widget: select
  options:
    - news
    - { label: "Tutorials", value: tutorial }
```

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
| `files` collections | Not supported yet, ignored |
| Nested folders, `path`, `i18n`, `filter`, `summary`, `sortable_fields`, `view_filters` | Not supported, ignored |
| Per-collection `media_folder` | Not supported, the top-level one is used |
| `relation`, `file`, `code`, `color`, `map` widgets | Plain text input |
| `object` and `list` with `fields` | JSON editor |
