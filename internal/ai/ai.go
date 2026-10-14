// Package ai calls a text generation API: Anthropic's Messages API, or any OpenAI-compatible
// Chat Completions API (OpenAI, Mistral, Gemini, OpenRouter, Ollama…).
package ai

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"
)

type Provider struct {
	// BaseURL is the API root. Empty means the admin types it (custom provider).
	BaseURL string
	// Anthropic speaks the Messages API, the others Chat Completions.
	Anthropic bool
	// DefaultModel is used when the admin leaves the model empty.
	DefaultModel string
	// KeyOptional: local servers like Ollama need no key.
	KeyOptional bool
}

// Providers are the supported APIs, by id.
var Providers = map[string]Provider{
	"anthropic":  {BaseURL: "https://api.anthropic.com", Anthropic: true, DefaultModel: "claude-sonnet-5-5"},
	"openai":     {BaseURL: "https://api.openai.com/v1"},
	"mistral":    {BaseURL: "https://api.mistral.ai/v1"},
	"gemini":     {BaseURL: "https://generativelanguage.googleapis.com/v1beta/openai"},
	"openrouter": {BaseURL: "https://openrouter.ai/api/v1"},
	"custom":     {KeyOptional: true},
}

type Config struct {
	Provider string
	Key      string
	Model    string
	// BaseURL overrides the provider URL. Required for "custom".
	BaseURL string
}

// Validate returns the code of the first missing setting, "" when the config is usable.
func (c Config) Validate() string {
	p, ok := Providers[c.Provider]
	switch {
	case !ok:
		return "ai_provider"
	case c.Key == "" && !p.KeyOptional:
		return "ai_key_required"
	case c.Model == "" && p.DefaultModel == "":
		return "ai_model_required"
	case c.BaseURL == "" && p.BaseURL == "":
		return "ai_base_url_required"
	}
	return ""
}

type Client struct {
	cfg  Config
	p    Provider
	HTTP *http.Client
}

func New(cfg Config) *Client {
	p := Providers[cfg.Provider]
	if cfg.BaseURL == "" {
		cfg.BaseURL = p.BaseURL
	}
	if cfg.Model == "" {
		cfg.Model = p.DefaultModel
	}
	cfg.BaseURL = strings.TrimRight(cfg.BaseURL, "/")
	// Proofreading a long article takes a while.
	return &Client{cfg: cfg, p: p, HTTP: &http.Client{Timeout: 3 * time.Minute}}
}

// Complete sends a system prompt and one user message, and returns the text of the answer.
func (c *Client) Complete(ctx context.Context, system, prompt string, maxTokens int) (string, error) {
	if c.p.Anthropic {
		var out struct {
			Content []struct {
				Type string `json:"type"`
				Text string `json:"text"`
			} `json:"content"`
		}
		err := c.post(ctx, "/v1/messages", map[string]any{
			"model":      c.cfg.Model,
			"max_tokens": maxTokens,
			"system":     system,
			"messages":   []map[string]string{{"role": "user", "content": prompt}},
		}, &out)
		var text strings.Builder
		for _, b := range out.Content {
			if b.Type == "text" {
				text.WriteString(b.Text)
			}
		}
		return strings.TrimSpace(text.String()), err
	}
	// ponytail: no token limit sent, OpenAI-compatible APIs disagree on its name (max_tokens vs max_completion_tokens).
	var out struct {
		Choices []struct {
			Message struct {
				Content string `json:"content"`
			} `json:"message"`
		} `json:"choices"`
	}
	err := c.post(ctx, "/chat/completions", map[string]any{
		"model": c.cfg.Model,
		"messages": []map[string]string{
			{"role": "system", "content": system},
			{"role": "user", "content": prompt},
		},
	}, &out)
	if err == nil && len(out.Choices) == 0 {
		err = errors.New("empty answer")
	}
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(out.Choices[0].Message.Content), nil
}

func (c *Client) post(ctx context.Context, path string, in, out any) error {
	b, err := json.Marshal(in)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.cfg.BaseURL+path, bytes.NewReader(b))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	if c.p.Anthropic {
		req.Header.Set("x-api-key", c.cfg.Key)
		req.Header.Set("anthropic-version", "2023-06-01")
	} else if c.cfg.Key != "" {
		req.Header.Set("Authorization", "Bearer "+c.cfg.Key)
	}
	res, err := c.HTTP.Do(req)
	if err != nil {
		return err
	}
	defer func() { _ = res.Body.Close() }()
	if res.StatusCode >= 300 {
		// Both APIs answer {"error": {"message": "..."}}.
		var e struct {
			Error struct {
				Message string `json:"message"`
			} `json:"error"`
		}
		_ = json.NewDecoder(res.Body).Decode(&e)
		return fmt.Errorf("%s: %s %s", c.cfg.Provider, res.Status, e.Error.Message)
	}
	return json.NewDecoder(res.Body).Decode(out)
}
