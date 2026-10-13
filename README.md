# Sumigo

Self-hosted, multi-site Git CMS in the spirit of Decap CMS. One instance manages the blog content of many GitHub repositories.

- **No "Login with GitHub"**: each site has a GitHub token (encrypted at rest). Users log in to Sumigo with their own account.
- **Attribution**: commits are authored with the CMS user's name and email (the token owner stays the committer), and PR titles and bodies name the author.
- **Access control**: per-site roles `viewer` < `editor` < `publisher`, plus global admins.
- **Workflows** per site:
  - `direct`: every save commits to the branch.
  - `pr`: saves go to `cms/<collection>/<slug>` and open a pull request. Publishers merge it (squash) from the UI.
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

## GitHub token

Use a fine-grained token scoped to the site repository, with **Contents: read/write** and **Pull requests: read/write**.

## `sumigo.yml`

Each site repository declares its content model in a `sumigo.yml` at its root (Decap CMS format). Full reference: [docs/sumigo-yml.md](docs/sumigo-yml.md).
