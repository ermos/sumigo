---
sidebar_position: 2
title: Installation
---

# Installation

Sumigo is a single binary with an embedded web app and a SQLite database. It needs no other service.

## Docker

```bash
docker run -d --name sumigo -p 8080:8080 \
  -e SECRET_KEY="$(openssl rand -hex 32)" \
  -v sumigo:/data \
  ghcr.io/ermos/sumigo:latest
```

Images are published for `linux/amd64` and `linux/arm64`, tagged with the version (`0.1.0`), the minor (`0.1`) and `latest`. See [Releases](releases.md).

Keep `SECRET_KEY` somewhere safe: it encrypts the access tokens and API keys stored in the database, and changing it makes them unreadable.

## Binary

```bash
git clone https://github.com/ermos/sumigo && cd sumigo
cp .env.example .env   # set SECRET_KEY
make build-web         # builds the web app, then the binary in bin/sumigo
set -a; . ./.env; set +a; ./bin/sumigo
```

## Environment variables

| Variable | Default | |
|---|---|---|
| `SECRET_KEY` | required | 16 characters or more. Encrypts the secrets stored in the database. |
| `DATABASE_PATH` | `sumigo.db` (`/data/sumigo.db` in Docker) | SQLite database file. |
| `PORT` | `8080` | HTTP port. |
| `SECURE_COOKIE` | `true` | The session cookie is only sent over HTTPS (browsers also accept it on `http://localhost`). Set to `false` only to reach Sumigo over plain HTTP from another host, such as a LAN IP. |

## First start

With no user yet, the server logs a setup code:

```
no user yet: open the web app and enter this setup code to create the admin account: 3f2b9c1e-…
```

Open the web app, enter that code and create your account: it is the admin. The code only lives in memory (a restart prints a new one) and stops working once the admin exists.

Then add a site: Administration > Sites > Add a site, with the repository and an [access token](guides/forges.md).

## Behind a reverse proxy

Serve Sumigo over HTTPS behind a reverse proxy (Caddy, Traefik, nginx). The proxy must send the `X-Forwarded-Proto` header, used to build the single sign-on redirect URI: Caddy and Traefik do by default, with nginx add `proxy_set_header X-Forwarded-Proto $scheme;`. For sites opened on their own domain, see [Custom domains](guides/custom-domains.md).

## Development

```bash
go run ./cmd/sumigo          # API on :8080
cd web && npm run dev        # web app, Vite proxies /api to :8080
cd docs && npm start         # this documentation
```
