---
slug: /
sidebar_position: 1
title: Introduction
---

# Sumigo

Sumigo is a self-hosted, multi-site Git CMS in the spirit of [Decap CMS](https://decapcms.org). One instance manages the content of many repositories on GitHub, GitLab, Forgejo or Gitea: entries are Markdown files with YAML front matter, and every change is a commit or a pull request in the site repository.

- **No "Login with GitHub"**: each site has an access token, encrypted at rest. Users log in to Sumigo with their own account, or with [single sign-on](guides/single-sign-on.md).
- **Attribution**: commits are authored with the user's name and email (the token owner stays the committer), and pull request titles name the author.
- **Access control**: per-site roles `viewer` < `editor` < `publisher`, plus admins who open every site. See [Users and roles](guides/users-and-roles.md).
- **Drafts**: "Save draft" keeps changes on a `cms/<collection>/<slug>` branch with an open pull request, "Publish" puts them live (squash-merging the draft). Drafts can also be **scheduled**: the server merges them at the set date.
- **Autosave**: the editor form is saved in the Sumigo database every few seconds, without any commit, and offered back on the next visit.
- **History**: every version of an entry can be compared and restored into the editor.
- **SEO**: collections can declare their SEO fields; the editor scores each entry as it is typed and previews its Google result.
- **AI assistant**: suggests field values, writes an article from a brief and proofreads, with Anthropic, OpenAI, Mistral, Gemini, OpenRouter or any OpenAI-compatible API.
- **Content model in the repository**: a [`sumigo.yml`](configuration/sumigo-yml.md) at the root, in the Decap format. A repository without one gets it drafted from its files, or from its Decap config.
- **Images** are resized, converted to WebP and stripped of their metadata (GPS position included) in the browser before upload.
- **Custom domains**: a site can open on its own domain, for a white-label CMS. See [Custom domains](guides/custom-domains.md).
