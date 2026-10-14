---
sidebar_position: 4
title: Single sign-on
---

# Single sign-on

Administration > Single sign-on connects an OpenID Connect provider (Keycloak, Authentik, Zitadel, Okta, Entra ID, Google…). Create a confidential client with the authorization code flow, and register one redirect URI per domain the CMS is reached on, all listed on that page: `https://<domain>/api/auth/oidc/callback`.

- Users are matched by email. "Create the account on first login" adds unknown emails automatically; otherwise an admin creates the user first, and site roles stay managed in Sumigo.
- "Admin group" makes the members of that `groups` claim admins, and removes admin rights from the others, on each login.
- Password login keeps working, so the admin is never locked out by a provider misconfiguration.
