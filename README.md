<div align="center">

# 🌿 Sumigo

### *The Git CMS for every site you run, self-hosted.*

[![CI](https://github.com/ermos/sumigo/actions/workflows/ci.yml/badge.svg)](https://github.com/ermos/sumigo/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/ermos/sumigo?sort=semver)](https://github.com/ermos/sumigo/releases)
[![Docs](https://img.shields.io/badge/docs-ermos.github.io%2Fsumigo-7c3aed)](https://ermos.github.io/sumigo/)
[![License: AGPL v3](https://img.shields.io/badge/license-AGPL--3.0-blue)](LICENSE)

</div>

**Sumigo** is a self-hosted, multi-site Git CMS in the spirit of [Decap CMS](https://decapcms.org). One instance edits the content of many static sites (Astro, Hugo, Jekyll, Eleventy, Next…) living on **GitHub, GitLab, Forgejo or Gitea**. Entries stay Markdown files with YAML front matter in each repository, and every change is a commit or a pull request, signed with the name of whoever made it.

One small **Go binary** with the web app embedded, and **SQLite**. No database server, no "Login with GitHub" for your editors: they get a Sumigo account, or log in with your identity provider. 🚀

---

## ✨ What you get

- 🗂️ **Many sites, one CMS**: each site has its repository, branch and access token (encrypted at rest). Point a client's domain at it for a white-label CMS.
- 🌍 **Any Git forge**: GitHub (and Enterprise Server), GitLab (subgroups included), Forgejo, Gitea and Codeberg.
- 📝 **Drafts as pull requests**: "Save draft" opens a pull request, "Publish" squash-merges it, or **schedule** it and the server publishes it on time.
- 💾 **Autosave**: the form is saved every few seconds, without any commit, and offered back on the next visit.
- 🕰️ **History**: compare every version of an entry with a diff, and restore one in a click.
- 🔎 **SEO**: declare the SEO fields of a collection and get a live score, the checks to fix and a Google result preview while writing.
- 🤖 **AI assistant** (optional): field suggestions, a whole article from a brief, reviewable proofreading. Anthropic, OpenAI, Mistral, Gemini, OpenRouter or any OpenAI-compatible API, Ollama included.
- 🖼️ **Lighter images**: resized, converted to WebP and stripped of their metadata (GPS position included) before upload.
- 👥 **Roles per site**: viewer, editor, publisher, and a review workflow where only publishers put content live.
- 🔐 **Single sign-on**: OpenID Connect (Keycloak, Authentik, Zitadel, Okta, Entra ID, Google…), with admin rights from a group.
- 🧩 **Content model in the repository**: a Decap-style `sumigo.yml`, edited with completion and live checks. A repository without one gets it drafted from its files, or imported from its Decap config.
- 🌐 **English, French, Spanish** interface.

## 🚀 Quick start

```bash
docker run -d --name sumigo -p 8080:8080 \
  -e SECRET_KEY="$(openssl rand -hex 32)" \
  -v sumigo:/data \
  ghcr.io/ermos/sumigo:latest
```

Then:

1. 🔑 Read the **setup code** in the logs: `docker logs sumigo`.
2. 🌐 Open http://localhost:8080, enter the code and create your account: you are the admin.
3. ➕ Add a site with its repository and an access token. No `sumigo.yml` yet? Sumigo drafts one for you.

Keep `SECRET_KEY` safe: it encrypts the tokens and keys stored in the database. Images are published for `linux/amd64` and `linux/arm64`.

## 📚 Documentation

Everything lives at **[ermos.github.io/sumigo](https://ermos.github.io/sumigo/)**:

- [Installation](https://ermos.github.io/sumigo/installation): Docker, binary, environment variables, reverse proxy.
- [`sumigo.yml` reference](https://ermos.github.io/sumigo/configuration/sumigo-yml): collections, fields, widgets, SEO.
- Guides: [forges and tokens](https://ermos.github.io/sumigo/guides/forges), [users and roles](https://ermos.github.io/sumigo/guides/users-and-roles), [custom domains](https://ermos.github.io/sumigo/guides/custom-domains), [single sign-on](https://ermos.github.io/sumigo/guides/single-sign-on).

## 🛠️ Development

```bash
go run ./cmd/sumigo          # API on :8080 (needs SECRET_KEY)
cd web && npm run dev        # web app, Vite proxies /api to :8080
cd docs && npm start         # documentation
```

Stack: Go standard library HTTP server, SQLite (pure Go, no cgo), React, Vite and Tailwind for the web app, Docusaurus for the docs.

## 🤝 Contributing

Issues and pull requests are very welcome! 🙌

- Run `make test lint` and, in `web/`, `npm run typecheck && npm test` before opening a PR: CI runs the same checks, plus golangci-lint and govulncheck.
- Use [conventional commits](https://www.conventionalcommits.org) (`feat(editor): …`, `fix(api): …`). They drive the version: `feat` releases a minor, `fix` a patch, `!` a major. See [Releases](https://ermos.github.io/sumigo/releases).
- Security issue? Please report it privately through [GitHub security advisories](https://github.com/ermos/sumigo/security/advisories/new), not in a public issue.

## 📜 License

Sumigo is free software, licensed under the **[GNU AGPLv3](LICENSE)**. You're free to use, study, share and improve it: keep it free, and if you run a modified version as a network service, share your changes too. 💚
