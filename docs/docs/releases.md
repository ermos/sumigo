---
sidebar_position: 5
title: Releases
---

# Releases

Versions follow [semver](https://semver.org) and are computed from the [conventional commits](https://www.conventionalcommits.org) merged on `main`:

| Commit | Release |
|---|---|
| `feat: …` | minor |
| `fix: …`, `perf: …` | patch |
| `feat!: …`, or a `BREAKING CHANGE:` footer | major |
| `chore`, `docs`, `ci`, `refactor`, `test`… | none |

Each release gets a git tag, a [GitHub release](https://github.com/ermos/sumigo/releases) with its changelog, and a multi-arch Docker image: `ghcr.io/ermos/sumigo:<version>`, `:<major>.<minor>` and `:latest`. The version shows in the startup log.
