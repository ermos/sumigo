# Sumigo

Self-hosted, multi-site Git CMS in the spirit of Decap CMS. One instance manages the blog content of many repositories on GitHub, GitLab, Forgejo or Gitea.

- **No "Login with GitHub"**: each site has an access token (encrypted at rest). Users log in to Sumigo with their own account.
- **Attribution**: commits are authored with the CMS user's name and email (the token owner stays the committer), and PR titles and bodies name the author.
- **Access control**: per-site roles `viewer` < `editor` < `publisher`, plus global admins.
- **Drafts**: "Save draft" keeps changes on `cms/<collection>/<slug>` in an open pull request, "Publish" puts them live (squash-merging the draft if there is one). Drafts are listed in the Workflow page.
- **Publishing** per site:
  - `direct` (open): editors and publishers can publish.
  - `pr` (review): editors only save drafts, publishers publish them.
- **Scheduled publishing**: a draft can be published at a set date. The server merges it then, as the user who scheduled it, even with nobody in the CMS.
- **History**: every version of an entry (its commits) can be previewed and restored into the editor.
- **AI assistant**: suggests field values (titles, descriptions) and proofreads Markdown. Works with Anthropic, OpenAI, Mistral, Google Gemini, OpenRouter, or any OpenAI-compatible API (Ollama…). An admin picks the provider and stores its API key (encrypted, never sent to the browser) in Administration > AI assistant, then turns it on per site.
- The content model lives **in the target repo**, in a Decap CMS style `sumigo.yml` at the repository root ([reference](https://ermos.github.io/sumigo/configuration/sumigo-yml)). Entries are Markdown with YAML front matter.
- Listing a collection reads every entry (and every PR draft) in **one GraphQL call**, so the list shows titles and dates.

**Documentation: https://ermos.github.io/sumigo/** (installation, `sumigo.yml`, forges, users and roles, custom domains, single sign-on, releases). Its sources are in [`docs/`](docs/), a Docusaurus site.

## Quick start

```bash
docker run -d -p 8080:8080 -e SECRET_KEY="$(openssl rand -hex 32)" -v sumigo:/data ghcr.io/ermos/sumigo:latest
```

On the first start, the server logs a setup code: open the web app, enter it, and create your account, the admin. See [Installation](https://ermos.github.io/sumigo/installation) for the binary, the environment variables and running behind a reverse proxy.

## Development

```bash
go run ./cmd/sumigo          # API on :8080
cd web && npm run dev        # web app, Vite proxies /api to :8080
cd docs && npm start         # documentation
```

Versions are released automatically from the conventional commits merged on `main`, see [Releases](https://ermos.github.io/sumigo/releases).
