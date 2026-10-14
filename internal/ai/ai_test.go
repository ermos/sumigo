package ai

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestOpenAICompatibleProviders(t *testing.T) {
	var got struct {
		Model    string
		Messages []struct{ Role, Content string }
	}
	var auth, path string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		auth, path = r.Header.Get("Authorization"), r.URL.Path
		_ = json.NewDecoder(r.Body).Decode(&got)
		_, _ = w.Write([]byte(`{"choices":[{"message":{"content":" Bonjour "}}]}`))
	}))
	defer srv.Close()

	text, err := New(Config{Provider: "mistral", Key: "k1", Model: "some-model", BaseURL: srv.URL + "/v1/"}).Complete(context.Background(), "sys", "hi", 100)
	if err != nil || text != "Bonjour" {
		t.Fatalf("text = %q, err = %v", text, err)
	}
	if auth != "Bearer k1" || path != "/v1/chat/completions" || got.Model != "some-model" || got.Messages[0].Role != "system" || got.Messages[1].Content != "hi" {
		t.Fatalf("request: auth %q path %q body %+v", auth, path, got)
	}
}

func TestValidateNamesTheMissingSetting(t *testing.T) {
	for cfg, want := range map[Config]string{
		{Provider: "anthropic", Key: "k"}:                     "",
		{Provider: "openai", Key: "k"}:                        "ai_model_required",
		{Provider: "openai", Model: "m"}:                      "ai_key_required",
		{Provider: "custom", Model: "m"}:                      "ai_base_url_required",
		{Provider: "custom", Model: "m", BaseURL: "http://x"}: "",
		{Provider: "nope"}:                                    "ai_provider",
	} {
		if got := cfg.Validate(); got != want {
			t.Errorf("%+v: got %q, want %q", cfg, got, want)
		}
	}
}
