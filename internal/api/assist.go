package api

import (
	"encoding/json"
	"fmt"
	"net/http"

	"github.com/ermos/sumigo/internal/ai"
	"github.com/ermos/sumigo/internal/store"
)

func (a *API) getAI(w http.ResponseWriter, _ *http.Request) {
	s, err := a.Store.AI()
	if err != nil {
		fail(w, err)
		return
	}
	s.APIKey = ""
	writeJSON(w, s)
}

func (a *API) saveAI(w http.ResponseWriter, r *http.Request) {
	var in store.AISettings
	if !readJSON(w, r, &in) {
		return
	}
	cur, err := a.Store.AI()
	if err != nil {
		fail(w, err)
		return
	}
	// An empty key keeps the saved one, unless the provider changed: that key would not work.
	if in.APIKey == "" && in.Provider == cur.Provider {
		in.APIKey = cur.APIKey
	}
	if _, ok := ai.Providers[in.Provider]; !ok {
		httpError(w, http.StatusBadRequest, "ai_provider", "unknown AI provider")
		return
	}
	if code := aiConfig(in).Validate(); in.Enabled && code != "" {
		httpError(w, http.StatusBadRequest, code, "incomplete AI settings: "+code)
		return
	}
	if err := a.Store.SaveAI(in); err != nil {
		fail(w, err)
		return
	}
	a.getAI(w, r)
}

func aiConfig(s store.AISettings) ai.Config {
	return ai.Config{Provider: s.Provider, Key: s.APIKey, Model: s.Model, BaseURL: s.BaseURL}
}

// aiReady reports whether the assistant is on for the instance and for this site.
func (a *API) aiReady(site *store.Site) (store.AISettings, bool) {
	s, err := a.Store.AI()
	return s, err == nil && s.Enabled && site.AIEnabled && aiConfig(s).Validate() == ""
}

const assistSystem = `You assist the editors of a website in a content management system.
Reply with the requested text only: no preamble, no explanation, no surrounding quotes, no code fence.
Write in the language of the entry, or of the editor's brief when the entry is still empty.`

// seoRules apply to every generated value, so suggestions are ready to rank without rework.
const seoRules = `SEO rules:
- Find the main keyword of the entry (the topic people would search for) and use it naturally, never stuffed.
- Title: 50 to 60 characters, main keyword near the start, specific and honest, no clickbait, no all caps.
- Description, excerpt or summary: 140 to 160 characters, includes the main keyword, says what the reader gets and invites to read.
- Never invent facts, figures, quotes, sources or links. Where one is needed, leave a placeholder in square brackets, like [source to add].`

// seoArticleRules apply when writing a whole Markdown body.
const seoArticleRules = `Article rules:
- Do not repeat the title as a heading: the body starts with an introduction, then uses ## and ### headings.
- The introduction states the topic and includes the main keyword within the first 100 words.
- Headings are descriptive and use the main keyword or close variants where it reads naturally.
- Short paragraphs (2 to 4 sentences), bulleted or numbered lists where they help scanning, one idea per section.
- Link text describes its target, never "click here". Images, if any, get a descriptive alt text.
- End with a short conclusion or next step for the reader.
- 800 to 1500 words unless the brief asks otherwise.`

// assist writes a field value ("write") or proofreads a text field ("proofread") with the configured provider.
func (a *API) assist(w http.ResponseWriter, r *http.Request) {
	sc, col, ok := a.collection(w, r, store.RoleEditor)
	if !ok {
		return
	}
	settings, ready := a.aiReady(sc.site)
	if !ready {
		httpError(w, http.StatusForbidden, "ai_disabled", "the AI assistant is not enabled on this site")
		return
	}
	var in struct {
		Action string         `json:"action"`
		Field  string         `json:"field"`
		Data   map[string]any `json:"data"`
		// Brief is the editor's description of the article, when writing a whole Markdown body.
		Brief string `json:"brief"`
	}
	if !readJSON(w, r, &in) {
		return
	}
	var prompt string
	maxTokens := 400
	for _, f := range col.Fields {
		if f.Name != in.Field {
			continue
		}
		label := f.Label
		if label == "" {
			label = f.Name
		}
		switch in.Action {
		case "write":
			data := map[string]any{}
			for k, v := range in.Data {
				data[k] = v
			}
			delete(data, f.Name)
			entry, _ := json.MarshalIndent(data, "", "  ")
			if f.Widget == "markdown" {
				prompt = fmt.Sprintf("The other fields of the entry, as JSON:\n%s\n\nThe editor's brief:\n%s\n\n"+
					"Write the field %q: the full article body in Markdown, following the brief and consistent with the other fields.\n\n%s\n\n%s",
					entry, in.Brief, label, seoRules, seoArticleRules)
				maxTokens = 8000
				break
			}
			prompt = fmt.Sprintf("The other fields of the entry, as JSON:\n%s\n\n"+
				"Write a value for the field %q (name: %s, type: %s), based on the rest of the entry.\n\n%s",
				entry, label, f.Name, f.Widget, seoRules)
		case "proofread":
			text, _ := in.Data[f.Name].(string)
			if text == "" {
				writeJSON(w, map[string]string{"text": ""})
				return
			}
			prompt = "Proofread this text. Fix spelling, grammar, punctuation and typos only. " +
				"Keep the meaning, tone, wording, structure and Markdown syntax (links, images, headings, code) unchanged. " +
				"Return the full corrected text.\n\n" + text
			maxTokens = 16000
		}
	}
	if prompt == "" {
		httpError(w, http.StatusBadRequest, "ai_request", "unknown action or field")
		return
	}
	text, err := a.NewAI(aiConfig(settings)).Complete(r.Context(), assistSystem, prompt, maxTokens)
	if err != nil {
		httpError(w, http.StatusBadGateway, "ai", err.Error(), params{"detail": err.Error()})
		return
	}
	writeJSON(w, map[string]string{"text": text})
}
