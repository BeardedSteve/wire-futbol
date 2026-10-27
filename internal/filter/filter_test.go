package filter

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/BeardedSteve/wire-futbol/internal/club"
	"github.com/BeardedSteve/wire-futbol/internal/wire"
)

func lfc() *club.Club { return club.BySlug("lfc") }

// The Liverpool prompt and schema must match the golden files word for word.
func TestPromptMatchesGolden(t *testing.T) {
	want, _ := os.ReadFile("testdata/prompt-lfc.txt")
	if got := SystemPrompt(lfc()); got != string(want) {
		t.Fatalf("prompt differs from the golden file:\n%s", got)
	}
}

func TestSchemaMatchesGolden(t *testing.T) {
	b, _ := os.ReadFile("testdata/schema-lfc.json")
	var want, got any
	json.Unmarshal(b, &want)
	g, _ := json.Marshal(schema([]string{"aaa", "bbb"}, []string{"xxx", "aaa", "bbb"}, lfc().Short))
	json.Unmarshal(g, &got)
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("schema differs from the golden file:\n%s", g)
	}
}

func item(id string) *wire.Item {
	return &wire.Item{ID: id, Title: "Headline " + id, Status: wire.Pending, Published: time.Date(2026, 10, 23, 9, 0, 0, 0, time.UTC)}
}

func TestApplyClustersAndChains(t *testing.T) {
	recent := []*wire.Item{{ID: "r1", Cluster: "story1", Status: wire.Kept}}
	a, b, c, d, e := item("a"), item("b"), item("c"), item("d"), item("e")
	res := []result{
		{ID: "a", Status: "kept", Category: "injury", Summary: "Isak is out — hamstring, the club confirms.", Material: true, DropKind: "none", Cluster: "story1"},
		{ID: "b", Status: "kept", Category: "none", Summary: "B", DropKind: "none", Cluster: "a"},
		{ID: "c", Status: "dropped", Category: "none", Reason: "opinion column", Material: true, DropKind: "opinion", Cluster: "new"},
		{ID: "c", Status: "kept", Cluster: "new"}, // duplicate id ignored
		{ID: "zzz", Status: "kept"},               // not in batch
		{ID: "e", Status: "kept", Category: "result", Summary: "E", DropKind: "none", Cluster: "unknown"},
	}
	Apply([]*wire.Item{a, b, c, d, e}, res, &recent)
	if a.Status != wire.Kept || a.Cluster != "story1" || !a.Material || a.Summary != "Isak is out, hamstring, the club confirms." {
		t.Errorf("a %+v", a)
	}
	if b.Cluster != "story1" || b.Category != "other" {
		t.Errorf("b should chain to story1: %+v", b)
	}
	if c.Status != wire.Dropped || c.Material || c.DropKind != "opinion" || c.Reason != "opinion column" || c.Summary != "" {
		t.Errorf("c %+v", c)
	}
	if d.Status != wire.Pending {
		t.Errorf("d had no verdict but changed: %+v", d)
	}
	if e.Cluster != "e" {
		t.Errorf("e pointed at an unknown cluster, should stand alone: %+v", e)
	}
	if len(recent) != 4 || recent[0] != e {
		t.Errorf("recent not updated: %d", len(recent))
	}
}

func TestClassifyAgainstFakeGemini(t *testing.T) {
	var calls atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		n := calls.Add(1)
		if n == 1 {
			w.WriteHeader(503)
			return
		}
		if r.Header.Get("x-goog-api-key") != "k" || !strings.HasSuffix(r.URL.Path, "/models/gemini-test:generateContent") {
			t.Errorf("request %s %v", r.URL.Path, r.Header)
		}
		var req map[string]any
		b, _ := io.ReadAll(r.Body)
		json.Unmarshal(b, &req)
		sys := req["systemInstruction"].(map[string]any)["parts"].([]any)[0].(map[string]any)["text"].(string)
		if !strings.Contains(sys, "Liverpool FC news wire") {
			t.Error("system prompt missing")
		}
		user := req["contents"].([]any)[0].(map[string]any)["parts"].([]any)[0].(map[string]any)["text"].(string)
		if !strings.Contains(user, "RECENT STORIES (id: headline):\n(none)") || !strings.Contains(user, "id: a\nsource: BBC Sport\npublished: 2026-10-23T09:00:00.000Z\nheadline: Headline a") {
			t.Errorf("user prompt %q", user)
		}
		out, _ := json.Marshal(map[string]any{"results": []result{{ID: "a", Status: "kept", Category: "transfer", Summary: "Signed.", DropKind: "none", Cluster: "new"}}})
		json.NewEncoder(w).Encode(map[string]any{
			"candidates":    []any{map[string]any{"content": map[string]any{"parts": []any{map[string]any{"text": "thinking", "thought": true}, map[string]any{"text": string(out)}}}}},
			"usageMetadata": map[string]any{"promptTokenCount": 100, "candidatesTokenCount": 20, "thoughtsTokenCount": 5},
		})
	}))
	defer srv.Close()
	now := time.Date(2026, 10, 23, 12, 0, 0, 0, time.UTC)
	f := &Filter{APIKey: "k", Model: "gemini-test", Thinking: "low", BaseURL: srv.URL, DailyCap: 1000, Sleep: func(time.Duration) {}, Now: func() time.Time { return now }}
	st := (&wire.State{}).Init()
	a := item("a")
	a.Source = "BBC Sport"
	var recent []*wire.Item
	if !f.Classify(context.Background(), lfc(), []*wire.Item{a}, &recent, st) {
		t.Fatalf("classify failed: %s", st.ModelError)
	}
	if calls.Load() != 2 || a.Status != wire.Kept || a.Category != "transfer" {
		t.Fatalf("calls %d, item %+v", calls.Load(), a)
	}
	if u := st.Usage["2026-10-23"]; u.In != 100 || u.Out != 25 || u.Calls != 1 {
		t.Fatalf("usage %+v", u)
	}
	st.Usage["2026-10-23"].In = 2000
	if f.Classify(context.Background(), lfc(), []*wire.Item{item("b")}, &recent, st) || calls.Load() != 2 {
		t.Fatal("cap not enforced")
	}
}

func TestClassifyRecordsModelError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(403)
		io.WriteString(w, "API key not valid")
	}))
	defer srv.Close()
	f := &Filter{APIKey: "k", Model: "m", BaseURL: srv.URL, DailyCap: 1000, Sleep: func(time.Duration) {}}
	st := (&wire.State{}).Init()
	var recent []*wire.Item
	it := item("a")
	if f.Classify(context.Background(), lfc(), []*wire.Item{it}, &recent, st) {
		t.Fatal("should fail")
	}
	if !strings.Contains(st.ModelError, "HTTP 403 API key not valid") || it.Status != wire.Pending {
		t.Fatalf("model error %q, item %s", st.ModelError, it.Status)
	}
}

// fakeGemini keeps every item it is sent, unless reject says the request is bad.
func fakeGemini(calls *atomic.Int32, reject func(ids []string) bool) *httptest.Server {
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		var req map[string]any
		b, _ := io.ReadAll(r.Body)
		json.Unmarshal(b, &req)
		user := req["contents"].([]any)[0].(map[string]any)["parts"].([]any)[0].(map[string]any)["text"].(string)
		var ids []string
		for _, line := range strings.Split(user, "\n") {
			if id, ok := strings.CutPrefix(line, "id: "); ok {
				ids = append(ids, id)
			}
		}
		if reject(ids) {
			w.WriteHeader(400)
			io.WriteString(w, `{"error":{"code":400,"status":"INVALID_ARGUMENT"}}`)
			return
		}
		var res []result
		for _, id := range ids {
			res = append(res, result{ID: id, Status: "kept", Category: "other", Summary: "S.", DropKind: "none", Cluster: "new"})
		}
		out, _ := json.Marshal(map[string]any{"results": res})
		json.NewEncoder(w).Encode(map[string]any{"candidates": []any{map[string]any{"content": map[string]any{"parts": []any{map[string]any{"text": string(out)}}}}}})
	}))
}

func TestClassifySplitsRejectedBatch(t *testing.T) {
	var calls atomic.Int32
	srv := fakeGemini(&calls, func(ids []string) bool { return len(ids) > 2 })
	defer srv.Close()
	f := &Filter{APIKey: "k", Model: "m", BaseURL: srv.URL, DailyCap: 1 << 20, Sleep: func(time.Duration) {}}
	st := (&wire.State{}).Init()
	batch := []*wire.Item{item("a"), item("b"), item("c"), item("d"), item("e")}
	var recent []*wire.Item
	if !f.Classify(context.Background(), lfc(), batch, &recent, st) {
		t.Fatalf("classify failed: %s", st.ModelError)
	}
	for _, it := range batch {
		if it.Status != wire.Kept {
			t.Errorf("%s left %s", it.ID, it.Status)
		}
	}
	if st.ModelError != "" {
		t.Errorf("model error kept: %q", st.ModelError)
	}
	// 5 rejected, 2 kept, 3 rejected, 1 kept, 2 kept
	if calls.Load() != 5 {
		t.Errorf("calls %d", calls.Load())
	}
}

func TestClassifyStopsSplittingWhenEverythingIsRejected(t *testing.T) {
	var calls atomic.Int32
	srv := fakeGemini(&calls, func([]string) bool { return true })
	defer srv.Close()
	f := &Filter{APIKey: "k", Model: "m", BaseURL: srv.URL, DailyCap: 1 << 20, Sleep: func(time.Duration) {}}
	st := (&wire.State{}).Init()
	var batch []*wire.Item
	for _, id := range strings.Split("abcdefgh", "") {
		batch = append(batch, item(id))
	}
	var recent []*wire.Item
	if f.Classify(context.Background(), lfc(), batch, &recent, st) {
		t.Fatal("should fail")
	}
	// 8, then the first 4, 2 and 1
	if calls.Load() != 4 || batch[0].Status != wire.Pending || !strings.Contains(st.ModelError, "HTTP 400") {
		t.Fatalf("calls %d, status %s, error %q", calls.Load(), batch[0].Status, st.ModelError)
	}
}
