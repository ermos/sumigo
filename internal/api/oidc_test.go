package api

import (
	"crypto/rand"
	"crypto/rsa"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/go-jose/go-jose/v4"

	"github.com/ermos/sumigo/internal/store"
)

// fakeIdP is an OpenID Connect provider that signs an id token for the email it is given.
func fakeIdP(t *testing.T, email string, groups []string) (*httptest.Server, *string) {
	t.Helper()
	key, _ := rsa.GenerateKey(rand.Reader, 2048)
	signer, err := jose.NewSigner(jose.SigningKey{Algorithm: jose.RS256, Key: key}, (&jose.SignerOptions{}).WithHeader("kid", "k1"))
	if err != nil {
		t.Fatal(err)
	}
	var nonce string
	var srv *httptest.Server
	srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/.well-known/openid-configuration":
			_ = json.NewEncoder(w).Encode(map[string]any{
				"issuer": srv.URL, "authorization_endpoint": srv.URL + "/auth", "token_endpoint": srv.URL + "/token",
				"jwks_uri": srv.URL + "/keys", "id_token_signing_alg_values_supported": []string{"RS256"},
			})
		case "/keys":
			_ = json.NewEncoder(w).Encode(jose.JSONWebKeySet{Keys: []jose.JSONWebKey{{Key: &key.PublicKey, KeyID: "k1", Algorithm: "RS256", Use: "sig"}}})
		case "/token":
			if r.FormValue("code") != "good" || r.FormValue("code_verifier") == "" {
				w.WriteHeader(http.StatusBadRequest)
				return
			}
			claims, _ := json.Marshal(map[string]any{
				"iss": srv.URL, "aud": "sumigo", "sub": "u1", "nonce": nonce, "email": email, "email_verified": true,
				"name": "Jane SSO", "groups": groups, "iat": time.Now().Unix(), "exp": time.Now().Add(time.Hour).Unix(),
			})
			jws, _ := signer.Sign(claims)
			idToken, _ := jws.CompactSerialize()
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{"access_token": "at", "token_type": "Bearer", "id_token": idToken})
		}
	}))
	t.Cleanup(srv.Close)
	return srv, &nonce
}

func TestOIDCLoginCreatesTheUserAndSyncsAdmin(t *testing.T) {
	a, st := newTestAPI(t, &fakeGitHub{})
	srv := httptest.NewServer(a.Handler())
	defer srv.Close()
	idp, nonce := fakeIdP(t, "Jane@Acme.io", []string{"cms-admins"})
	if err := st.SaveOIDC(store.OIDCSettings{Enabled: true, Issuer: idp.URL, ClientID: "sumigo", ClientSecret: "s", AutoCreate: true, AdminGroup: "cms-admins"}); err != nil {
		t.Fatal(err)
	}
	client := &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}

	// login: redirect to the provider, with state, nonce and PKCE kept in a cookie.
	res, err := client.Get(srv.URL + "/api/auth/oidc")
	if err != nil {
		t.Fatal(err)
	}
	auth, _ := url.Parse(res.Header.Get("Location"))
	q := auth.Query()
	if !strings.HasPrefix(auth.String(), idp.URL+"/auth") || q.Get("redirect_uri") != srv.URL+"/api/auth/oidc/callback" || q.Get("code_challenge") == "" {
		t.Fatalf("authorize URL = %s", auth)
	}
	*nonce = q.Get("nonce")
	flow := res.Cookies()[0]

	callback := func(state, code string) *http.Response {
		req, _ := http.NewRequest(http.MethodGet, srv.URL+"/api/auth/oidc/callback?state="+state+"&code="+code, nil)
		req.AddCookie(flow)
		res, err := client.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		return res
	}
	if res := callback("forged", "good"); res.Header.Get("Location") != "/?login_error=oidc_failed" {
		t.Fatalf("forged state: %s", res.Header.Get("Location"))
	}
	res = callback(q.Get("state"), "good")
	if res.Header.Get("Location") != "/" {
		t.Fatalf("callback redirects to %s", res.Header.Get("Location"))
	}
	var session *http.Cookie
	for _, c := range res.Cookies() {
		if c.Name == sessionCookie {
			session = c
		}
	}
	u, err := st.UserBySession(session.Value)
	if err != nil || u.Email != "Jane@Acme.io" || u.Name != "Jane SSO" || !u.IsAdmin {
		t.Fatalf("logged in as %+v, %v", u, err)
	}

	// Without auto-create, an email unknown to Sumigo is refused.
	if err := st.SaveOIDC(store.OIDCSettings{Enabled: true, Issuer: idp.URL, ClientID: "sumigo"}); err != nil {
		t.Fatal(err)
	}
	if err := st.DeleteUser(u.ID); err != nil {
		t.Fatal(err)
	}
	if res := callback(q.Get("state"), "good"); res.Header.Get("Location") != "/?login_error=oidc_unknown_user" {
		t.Fatalf("unknown user: %s", res.Header.Get("Location"))
	}
}

func TestOriginFollowsTheRequestNotTheCookieSetting(t *testing.T) {
	a := &API{SecureCookie: true}
	r := httptest.NewRequest(http.MethodGet, "http://localhost:8080/api/auth/oidc", nil)
	if got := a.origin(r); got != "http://localhost:8080" {
		t.Fatalf("plain http = %s", got)
	}
	r.Host = "cms.acme.io"
	r.Header.Set("X-Forwarded-Proto", "https")
	if got := a.origin(r); got != "https://cms.acme.io" {
		t.Fatalf("behind a TLS proxy = %s", got)
	}
}
