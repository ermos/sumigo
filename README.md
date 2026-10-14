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
- The content model lives **in the target repo**, in a Decap CMS style `sumigo.yml` at the repository root ([reference](docs/sumigo-yml.md)). Entries are Markdown with YAML front matter.
- Listing a collection reads every entry (and every PR draft) in **one GraphQL call**, so the list shows titles and dates.

## Run

```bash
cp .env.example .env   # set SECRET_KEY, ADMIN_EMAIL, ADMIN_PASSWORD
make build-web
set -a; . ./.env; set +a; ./bin/sumigo
```

Or with Docker: `make docker && docker run -p 8080:8080 --env-file .env -v sumigo:/data sumigo`.

Dev: `go run ./cmd/sumigo` and `cd web && npm run dev` (Vite proxies `/api` to `:8080`).

## Access token

Each site picks its forge and, when self-hosted, the instance URL (`https://git.example.com`).

- **GitHub** (and GitHub Enterprise Server): a fine-grained token scoped to the site repository, with **Contents: read/write** and **Pull requests: read/write**. The site settings page has a "Create it on GitHub" link that opens the token form with the owner and permissions prefilled, so you only pick the repository.
- **GitLab** (gitlab.com or self-managed): a project or personal access token with the `api` scope. Drafts are merge requests, published with a squash merge. The repository can include subgroups: `group/subgroup/project`.
- **Forgejo / Gitea** (Codeberg included): an access token with **repository: read and write**. The instance URL is required.

Listing a collection takes one GraphQL call on GitHub, and one call per entry on GitLab and Forgejo / Gitea (8 in parallel).

## Custom domains

In the site settings, admins list domains (one per line) that open the site directly, for a white-label CMS: `cms.client.com` with a CNAME to the instance. Declared domains may also call the API from the browser (CORS); adding or removing one applies right away.

TLS is left to a reverse proxy. With Caddy, on-demand TLS issues a certificate only for the declared domains:

```caddy
{
	on_demand_tls {
		ask http://localhost:8080/api/domains/check
	}
}

cms.example.com {
	reverse_proxy localhost:8080
}

https:// {
	tls {
		on_demand
	}
	reverse_proxy localhost:8080
}
```

## `sumigo.yml`

Each site repository declares its content model in a `sumigo.yml` at its root (Decap CMS format). Full reference: [docs/sumigo-yml.md](docs/sumigo-yml.md).
