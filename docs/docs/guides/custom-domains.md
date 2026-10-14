---
sidebar_position: 3
title: Custom domains
---

# Custom domains

In Site settings > Domains, admins list domains (one per line) that open the site directly, for a white-label CMS: `cms.client.com` with a CNAME to the instance. Declared domains may also call the API from the browser (CORS); adding or removing one applies right away.

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

With [single sign-on](single-sign-on.md), register each domain as a redirect URI at the provider.
