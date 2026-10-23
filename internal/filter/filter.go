// Package filter asks Gemini which items are news, summarises the ones worth keeping, and clusters reports of
// the same story. The prompt is the editorial policy; it is rendered per club from prompt.tmpl.
package filter

import (
	"bytes"
	"context"
	_ "embed"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"regexp"
	"strings"
	"text/template"
	"time"

	"github.com/BeardedSteve/wire-futbol/internal/club"
	"github.com/BeardedSteve/wire-futbol/internal/wire"
)

//go:embed prompt.tmpl
var promptText string

var promptTmpl = template.Must(template.New("prompt").Parse(promptText))

// SystemPrompt renders the filter instructions for a club.
func SystemPrompt(c *club.Club) string {
	var b strings.Builder
	err := promptTmpl.Execute(&b, struct {
		Name, Short string
		club.Prompt
	}{c.Name, c.Short, c.Prompt})
	if err != nil {
		panic(err) // the template is fixed and tested
	}
	return b.String()
}

var (
	DropKinds  = []string{"opinion", "reaction", "preview", "rumour", "feature", "promo", "off-topic", "thin", "other", "none"}
	Categories = []string{"injury", "team-news", "result", "transfer", "contract", "staff", "business", "regulation", "other", "none"}
)

// schema is the structured output schema, built per batch so ids and cluster targets can only be valid values.
func schema(batchIDs, clusterIDs []string, short string) map[string]any {
	str := func(desc string, enum []string) map[string]any {
		m := map[string]any{"type": "string"}
		if enum != nil {
			m["enum"] = enum
		}
		if desc != "" {
			m["description"] = desc
		}
		return m
	}
	return map[string]any{
		"type": "object",
		"properties": map[string]any{
			"results": map[string]any{
				"type":     "array",
				"minItems": len(batchIDs),
				"maxItems": len(batchIDs),
				"items": map[string]any{
					"type": "object",
					"properties": map[string]any{
						"id":        str("The input item's id.", batchIDs),
						"status":    str("", []string{"kept", "dropped"}),
						"category":  str("For kept items the news category; for dropped items use none.", Categories),
						"summary":   str("Kept: one or two factual sentences, UK English, stating the news first and attributing it at the end. Dropped: empty string.", nil),
						"reason":    str("Dropped: 3 to 6 word reason. Kept: empty string.", nil),
						"material":  map[string]any{"type": "boolean", "description": "True only if worth a phone notification. Always false for dropped items."},
						"drop_kind": str("Dropped: opinion (analysis, columns, predictions), reaction (quotes or social chatter with no new fact), preview (match previews, listings, how to watch), rumour (relayed from other outlets or unnamed sources), feature (history, interviews, nostalgia), promo (tickets, retail, FPL, video, podcasts), off-topic (not about "+short+"), thin (vague, duplicate, live blog), other. Kept: none.", DropKinds),
						"cluster":   str("Id of the RECENT STORY or other NEW ITEM reporting the same story, else new.", append([]string{"new"}, clusterIDs...)),
					},
					"required":             []string{"id", "status", "category", "summary", "reason", "material", "drop_kind", "cluster"},
					"additionalProperties": false,
				},
			},
		},
		"required":             []string{"results"},
		"additionalProperties": false,
	}
}

// Filter calls Gemini.
type Filter struct {
	APIKey   string
	Model    string // e.g. gemini-3.8-flash
	Thinking string // thinking level; empty omits it
	BaseURL  string
	DailyCap int // tokens per London day across calls
	Client   *http.Client
	Sleep    func(time.Duration) // tests replace this
	Now      func() time.Time
}

func (f *Filter) now() time.Time {
	if f.Now != nil {
		return f.Now()
	}
	return time.Now()
}

func (f *Filter) sleep(d time.Duration) {
	if f.Sleep != nil {
		f.Sleep(d)
		return
	}
	time.Sleep(d)
}

type result struct {
	ID       string `json:"id"`
	Status   string `json:"status"`
	Category string `json:"category"`
	Summary  string `json:"summary"`
	Reason   string `json:"reason"`
	Material bool   `json:"material"`
	DropKind string `json:"drop_kind"`
	Cluster  string `json:"cluster"`
}

func (f *Filter) call(ctx context.Context, system, prompt string, sch map[string]any, thinking bool) (int, []byte, error) {
	gen := map[string]any{"temperature": 0.2, "maxOutputTokens": 8000, "responseMimeType": "application/json", "responseJsonSchema": sch}
	if thinking && f.Thinking != "" {
		gen["thinkingConfig"] = map[string]any{"thinkingLevel": f.Thinking}
	}
	body, _ := json.Marshal(map[string]any{
		"systemInstruction": map[string]any{"parts": []any{map[string]any{"text": system}}},
		"contents":          []any{map[string]any{"role": "user", "parts": []any{map[string]any{"text": prompt}}}},
		"generationConfig":  gen,
	})
	base := f.BaseURL
	if base == "" {
		base = "https://generativelanguage.googleapis.com"
	}
	ctx, cancel := context.WithTimeout(ctx, 90*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, base+"/v1beta/models/"+f.Model+":generateContent", bytes.NewReader(body))
	if err != nil {
		return 0, nil, err
	}
	req.Header.Set("x-goog-api-key", f.APIKey)
	req.Header.Set("content-type", "application/json")
	c := f.Client
	if c == nil {
		c = http.DefaultClient
	}
	r, err := c.Do(req)
	if err != nil {
		return 0, nil, err
	}
	defer r.Body.Close()
	b, err := io.ReadAll(io.LimitReader(r.Body, 4<<20))
	return r.StatusCode, b, err
}

func clip(s string, n int) string {
	if len(s) > n {
		return s[:n]
	}
	return s
}

var dashRe = regexp.MustCompile(`\s*[–—]\s*`)

func stamp(t time.Time) string { return t.In(wire.London).Format("Mon 2 Jan, 15:04") }

// Classify decides a batch of pending items. recent holds kept items from the last 48 hours, newest first; newly
// kept items are added to its front. It returns false when the model could not be used, leaving items pending.
func (f *Filter) Classify(ctx context.Context, c *club.Club, batch []*wire.Item, recent *[]*wire.Item, st *wire.State) bool {
	log := slog.With("club", c.Slug)
	if f.APIKey == "" {
		log.Info("no GEMINI_API_KEY, leaving items pending")
		return false
	}
	day := wire.Day(f.now())
	u := st.Usage[day]
	if u == nil {
		u = &wire.Usage{}
		st.Usage[day] = u
	}
	if u.In+u.Out > f.DailyCap {
		log.Info("daily token cap reached, leaving items pending")
		return false
	}

	top := *recent
	if len(top) > 30 {
		top = top[:30]
	}
	var lines []string
	var recentIDs []string
	seen := map[string]bool{}
	for _, r := range top {
		lines = append(lines, r.Cluster+": "+r.Title)
		if r.Cluster != "" && !seen[r.Cluster] {
			seen[r.Cluster] = true
			recentIDs = append(recentIDs, r.Cluster)
		}
	}
	recentList := strings.Join(lines, "\n")
	if recentList == "" {
		recentList = "(none)"
	}
	var items []string
	var batchIDs []string
	for _, b := range batch {
		items = append(items, fmt.Sprintf("id: %s\nsource: %s\npublished: %s\nheadline: %s\nstandfirst: %s", b.ID, b.Source, b.Published.UTC().Format("2006-01-02T15:04:05.000Z"), b.Title, b.Standfirst))
		batchIDs = append(batchIDs, b.ID)
	}
	prompt := "RECENT STORIES (id: headline):\n" + recentList + "\n\nNEW ITEMS:\n\n" + strings.Join(items, "\n\n")
	clusterIDs := append([]string(nil), recentIDs...)
	for _, id := range batchIDs {
		if !seen[id] {
			seen[id] = true
			clusterIDs = append(clusterIDs, id)
		}
	}
	sch := schema(batchIDs, clusterIDs, c.Short)
	system := SystemPrompt(c)

	fail := func(msg string) bool {
		st.ModelError = stamp(f.now()) + ": " + clip(msg, 200)
		log.Error("filter failed", "err", msg)
		return false
	}
	code, body, err := f.call(ctx, system, prompt, sch, true)
	if err == nil && code == 400 && f.Thinking != "" { // a swapped-in model may not accept the thinking level
		log.Warn("gemini 400, retrying without thinkingConfig", "body", clip(string(body), 300))
		code, body, err = f.call(ctx, system, prompt, sch, false)
	}
	for _, wait := range []time.Duration{5 * time.Second, 20 * time.Second} { // overload or rate limit: back off twice, then leave for next run
		if err != nil || (code != 503 && code != 429 && code != 500) {
			break
		}
		log.Warn("gemini busy, retrying", "status", code, "wait", wait)
		f.sleep(wait)
		code, body, err = f.call(ctx, system, prompt, sch, true)
	}
	if err != nil {
		return fail(err.Error())
	}
	if code != 200 {
		return fail(fmt.Sprintf("HTTP %d %s", code, clip(string(body), 300)))
	}
	var resp struct {
		Candidates []struct {
			FinishReason string `json:"finishReason"`
			Content      struct {
				Parts []struct {
					Text    string `json:"text"`
					Thought bool   `json:"thought"`
				} `json:"parts"`
			} `json:"content"`
		} `json:"candidates"`
		Usage struct {
			Prompt     int `json:"promptTokenCount"`
			Candidates int `json:"candidatesTokenCount"`
			Thoughts   int `json:"thoughtsTokenCount"`
		} `json:"usageMetadata"`
	}
	if err := json.Unmarshal(body, &resp); err != nil {
		return fail("response was not JSON")
	}
	u.In += resp.Usage.Prompt
	u.Out += resp.Usage.Candidates + resp.Usage.Thoughts
	u.Calls++
	var text strings.Builder
	finish := ""
	if len(resp.Candidates) > 0 {
		finish = resp.Candidates[0].FinishReason
		for _, p := range resp.Candidates[0].Content.Parts {
			if !p.Thought {
				text.WriteString(p.Text)
			}
		}
	}
	var out struct {
		Results []result `json:"results"`
	}
	if err := json.Unmarshal([]byte(text.String()), &out); err != nil {
		return fail("unparseable JSON (" + finish + ")")
	}
	st.ModelError = ""
	Apply(batch, out.Results, recent)
	return true
}

// Apply records the model's verdicts on batch. Unknown or repeated ids are ignored; an item with no verdict stays
// pending. Cluster pointers resolve to a recent story or another item in the batch, and chains collapse to one card.
func Apply(batch []*wire.Item, results []result, recent *[]*wire.Item) {
	inBatch := map[string]*wire.Item{}
	for _, b := range batch {
		inBatch[b.ID] = b
	}
	byID := map[string]result{}
	for _, r := range results {
		if _, ok := inBatch[r.ID]; ok {
			if _, dup := byID[r.ID]; !dup { // the schema guarantees shape, not uniqueness
				byID[r.ID] = r
			}
		}
	}
	valid := map[string]bool{}
	for _, r := range *recent {
		valid[r.Cluster] = true
	}
	for _, b := range batch {
		valid[b.ID] = true
	}
	for _, it := range batch {
		d, ok := byID[it.ID]
		if !ok {
			continue
		}
		kept := d.Status == "kept"
		it.Status = wire.Dropped
		it.Category, it.Reason, it.DropKind, it.Summary = "", "", "", ""
		if kept {
			it.Status = wire.Kept
			it.Category = d.Category
			if it.Category == "none" || it.Category == "" {
				it.Category = "other"
			}
			it.Summary = dashRe.ReplaceAllString(d.Summary, ", ")
		} else {
			it.Reason = d.Reason
			if d.DropKind != "none" {
				it.DropKind = d.DropKind
			}
		}
		it.Material = d.Material && kept
		target := it.ID
		if d.Cluster != "new" && d.Cluster != it.ID && valid[d.Cluster] {
			target = d.Cluster
		}
		if b, ok := inBatch[target]; ok && b.Cluster != "" {
			it.Cluster = b.Cluster
		} else {
			it.Cluster = target
		}
		if kept {
			*recent = append([]*wire.Item{it}, *recent...)
		}
	}
	for _, it := range batch { // collapse chains such as B -> A -> recent story X
		for hops := 0; hops < 5; hops++ {
			nxt, ok := inBatch[it.Cluster]
			if !ok || nxt == it || nxt.Cluster == it.Cluster {
				break
			}
			it.Cluster = nxt.Cluster
		}
	}
}
