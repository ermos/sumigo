package api

import (
	"errors"
	"net"
	"net/http"
	"net/url"
	"regexp"
	"slices"
	"strings"

	"github.com/ermos/sumigo/internal/store"
)

// Custom domains point to the instance with a CNAME and open one site. TLS is left to a reverse proxy,
// which asks /api/domains/check before issuing a certificate (Caddy on-demand TLS).

var hostname = regexp.MustCompile(`^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9-]{2,63}$`)

// normalizeHost lowercases a host and drops its port and trailing dot.
func normalizeHost(h string) string {
	if host, _, err := net.SplitHostPort(h); err == nil {
		h = host
	}
	return strings.TrimSuffix(strings.ToLower(strings.TrimSpace(h)), ".")
}

func (a *API) getDomains(w http.ResponseWriter, r *http.Request) {
	hosts, err := a.Store.Domains(pathID(r, "site"))
	if err != nil {
		fail(w, err)
		return
	}
	writeJSON(w, hosts)
}

// parseDomains normalizes the domains of site siteID (0 for a new site), and rejects invalid ones or the ones of another site.
func (a *API) parseDomains(w http.ResponseWriter, in []string, siteID int64) ([]string, bool) {
	hosts := []string{}
	for _, h := range in {
		// Accept a pasted URL too: https://cms.acme.io/ -> cms.acme.io.
		if u, err := url.Parse(strings.TrimSpace(h)); err == nil && u.Host != "" {
			h = u.Host
		}
		h = normalizeHost(h)
		if h == "" || slices.Contains(hosts, h) {
			continue
		}
		if !hostname.MatchString(h) {
			httpError(w, http.StatusBadRequest, "invalid_domain", "invalid domain "+h, params{"domain": h})
			return nil, false
		}
		if id, err := a.Store.DomainSite(h); err == nil && id != siteID {
			httpError(w, http.StatusConflict, "domain_taken", "domain "+h+" already opens another site", params{"domain": h})
			return nil, false
		} else if err != nil && !errors.Is(err, store.ErrNotFound) {
			fail(w, err)
			return nil, false
		}
		hosts = append(hosts, h)
	}
	return hosts, true
}

// checkDomain answers 200 for a declared domain, 404 otherwise: the "ask" endpoint of a reverse proxy issuing certificates.
func (a *API) checkDomain(w http.ResponseWriter, r *http.Request) {
	if _, err := a.Store.DomainSite(normalizeHost(r.URL.Query().Get("domain"))); err != nil {
		fail(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// currentDomain tells the web app which site the domain it is served on opens.
func (a *API) currentDomain(w http.ResponseWriter, r *http.Request) {
	id, err := a.Store.DomainSite(normalizeHost(r.Host))
	if err != nil {
		fail(w, err)
		return
	}
	writeJSON(w, map[string]int64{"site_id": id})
}

// cors lets the declared domains call the API from another origin. Read from the database on each
// request, so a domain added or removed in the admin applies right away.
func (a *API) cors(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		origin := r.Header.Get("Origin")
		u, err := url.Parse(origin)
		if origin == "" || err != nil || normalizeHost(u.Host) == normalizeHost(r.Host) {
			next.ServeHTTP(w, r)
			return
		}
		w.Header().Add("Vary", "Origin")
		if _, err := a.Store.DomainSite(normalizeHost(u.Host)); err != nil {
			next.ServeHTTP(w, r) // the browser blocks the response without the headers below
			return
		}
		w.Header().Set("Access-Control-Allow-Origin", origin)
		w.Header().Set("Access-Control-Allow-Credentials", "true")
		if r.Method == http.MethodOptions && r.Header.Get("Access-Control-Request-Method") != "" {
			w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE")
			w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
			w.Header().Set("Access-Control-Max-Age", "600")
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}
