---
sidebar_position: 1
title: Forges and access tokens
---

# Forges and access tokens

Each site picks its forge and, when self-hosted, the instance URL (`https://git.example.com`). The access token is stored encrypted and never sent back to the browser.

- **GitHub** (and GitHub Enterprise Server): a fine-grained token scoped to the site repository, with **Contents: read/write** and **Pull requests: read/write**. The site settings link "Create it on GitHub" opens the token form with the owner and permissions prefilled, so you only pick the repository.
- **GitLab** (gitlab.com or self-managed): a project or personal access token with the `api` scope. Drafts are merge requests, published with a squash merge. The repository can include subgroups: `group/subgroup/project`.
- **Forgejo / Gitea** (Codeberg included): an access token with **repository: read and write**. The instance URL is required.

Listing a collection takes one GraphQL call on GitHub, and one call per entry on GitLab and Forgejo / Gitea (8 in parallel).
