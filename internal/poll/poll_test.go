package poll

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/BeardedSteve/wire-futbol/internal/club"
	"github.com/BeardedSteve/wire-futbol/internal/fetch"
	"github.com/BeardedSteve/wire-futbol/internal/filter"
	"github.com/BeardedSteve/wire-futbol/internal/store"
	"github.com/BeardedSteve/wire-futbol/internal/wire"
)

var now = time.Date(2026, 10, 23, 12, 0, 0, 0, time.UTC)

func rss(items ...string) string {
	s := `<rss><channel>`
	for _, it := range items {
		s += `<item><title>` + it + `</title><link>https://news.example/` + it + `</link><pubDate>Fri, 23 Oct 2026 10:00:00 GMT</pubDate></item>`
	}
	return s + `</channel></rss>`
}

// fakeWeb serves the sources and a Gemini that keeps everything.
func fakeWeb(t *testing.T) (*httptest.Server, map[string]int) {
	hits := map[string]int{}
	var mu sync.Mutex
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		hits[r.URL.Path]++
		mu.Unlock()
		switch {
		case r.URL.Path == "/shared.xml":
			io.WriteString(w, rss("shared-a", "shared-b"))
		case r.URL.Path == "/broken.xml":
			w.WriteHeader(500)
		case r.URL.Path == "/old.xml":
			io.WriteString(w, `<rss><channel><item><title>Old</title><link>https://news.example/old</link><pubDate>Mon, 12 Oct 2026 10:00:00 GMT</pubDate></item></channel></rss>`)
		case strings.HasSuffix(r.URL.Path, ":generateContent"):
			var req map[string]any
			json.NewDecoder(r.Body).Decode(&req)
			user := req["contents"].([]any)[0].(map[string]any)["parts"].([]any)[0].(map[string]any)["text"].(string)
			var results []map[string]any
			for _, line := range strings.Split(user, "\n") {
				if id, ok := strings.CutPrefix(line, "id: "); ok {
					results = append(results, map[string]any{"id": id, "status": "kept", "category": "transfer", "summary": "S " + id, "reason": "", "material": true, "drop_kind": "none", "cluster": "new"})
				}
			}
			out, _ := json.Marshal(map[string]any{"results": results})
			json.NewEncoder(w).Encode(map[string]any{"candidates": []any{map[string]any{"content": map[string]any{"parts": []any{map[string]any{"text": string(out)}}}}}, "usageMetadata": map[string]any{"promptTokenCount": 10}})
		default:
			w.WriteHeader(404)
		}
	}))
	t.Cleanup(srv.Close)
	return srv, hits
}

func withClubs(t *testing.T, srv string) {
	savedC, savedS := club.Clubs, club.Sources
	t.Cleanup(func() { club.Clubs, club.Sources = savedC, savedS })
	club.Sources = map[string]club.Source{
		"shared": {Key: "shared", Name: "Shared", Kind: club.RSS, URL: srv + "/shared.xml"},
		"broken": {Key: "broken", Name: "Broken", Kind: club.RSS, URL: srv + "/broken.xml"},
		"old":    {Key: "old", Name: "Old", Kind: club.RSS, URL: srv + "/old.xml"},
	}
	club.Clubs = []club.Club{
		{Slug: "aaa", Name: "A FC", Short: "A", Mark: "A", Enabled: true, Official: "shared", Sources: []string{"shared", "broken"}},
		{Slug: "bbb", Name: "B FC", Short: "B", Mark: "B", Enabled: true, Official: "shared", Sources: []string{"shared", "old"}},
	}
}

func poller(srv string, s store.Store) *Poller {
	return &Poller{
		Store:   s,
		Fetch:   &fetch.Client{Backoff: []time.Duration{}},
		Filter:  &filter.Filter{APIKey: "k", Model: "m", BaseURL: srv, DailyCap: 1 << 30, Sleep: func(time.Duration) {}, Now: func() time.Time { return now }},
		MaxSubs: 10, MaxPushPerDay: 6, QuietStart: 22, QuietEnd: 7, IngestMaxAge: 72 * time.Hour, RetainDays: 14,
		Now: func() time.Time { return now },
	}
}

func loadState(t *testing.T, s store.Store, slug string) *wire.State {
	b, err := s.Get(context.Background(), slug+"/state.json")
	if err != nil {
		t.Fatalf("%s: %v", slug, err)
	}
	var st wire.State
	json.Unmarshal(b, &st)
	return st.Init()
}

func TestSharedSourceFetchedOnceAndFailuresIsolated(t *testing.T) {
	srv, hits := fakeWeb(t)
	withClubs(t, srv.URL)
	s := store.Dir(t.TempDir())
	if err := poller(srv.URL, s).Run(context.Background()); err != nil {
		t.Fatal(err)
	}
	if hits["/shared.xml"] != 1 {
		t.Fatalf("shared feed fetched %d times", hits["/shared.xml"])
	}
	a, b := loadState(t, s, "aaa"), loadState(t, s, "bbb")
	if len(a.Items) != 2 || len(b.Items) != 2 {
		t.Fatalf("items: a %d, b %d", len(a.Items), len(b.Items))
	}
	if a.Health["broken"].Fails != 1 || a.Health["shared"].Fails != 0 || a.Health["shared"].LastCount != 2 {
		t.Fatalf("health %+v %+v", a.Health["broken"], a.Health["shared"])
	}
	if b.Health["old"].LastCount != 1 { // read fine, but the item is too old to ingest
		t.Fatalf("old source %+v", b.Health["old"])
	}
	for _, it := range a.Items {
		if it.Status != wire.Kept || it.Source != "Shared" {
			t.Fatalf("item %+v", it)
		}
	}
	if a.LastRun.IsZero() || a.Usage["2026-10-23"].Calls != 1 {
		t.Fatal("run not recorded")
	}

	// A second run adds nothing new.
	if err := poller(srv.URL, s).Run(context.Background()); err != nil {
		t.Fatal(err)
	}
	if a = loadState(t, s, "aaa"); len(a.Items) != 2 || a.Health["broken"].Fails != 2 {
		t.Fatalf("second run: %d items, %d fails", len(a.Items), a.Health["broken"].Fails)
	}
}

func TestUnreadableStateSkipsOnlyThatClub(t *testing.T) {
	srv, _ := fakeWeb(t)
	withClubs(t, srv.URL)
	s := store.Dir(t.TempDir())
	s.Put(context.Background(), "aaa/state.json", []byte("{not json"), "")
	err := poller(srv.URL, s).Run(context.Background())
	if err == nil || !strings.Contains(err.Error(), "aaa") {
		t.Fatalf("err %v", err)
	}
	if b, _ := s.Get(context.Background(), "aaa/state.json"); string(b) != "{not json" {
		t.Fatal("unreadable state was overwritten")
	}
	if len(loadState(t, s, "bbb").Items) != 2 {
		t.Fatal("other club not polled")
	}
}

func TestAlertsQuietHoursCapAndOnePerCluster(t *testing.T) {
	p := &Poller{MaxPushPerDay: 6, QuietStart: 22, QuietEnd: 7}
	c := &club.Club{Slug: "x", Official: "lfc"}
	mk := func(id, cluster string) *wire.Item {
		return &wire.Item{ID: id, Cluster: cluster, Status: wire.Kept, Material: true, Published: now.Add(-time.Hour), Summary: id}
	}
	st := (&wire.State{Items: []*wire.Item{mk("a", "c1"), mk("b", "c1"), mk("c", "c2")}}).Init()
	p.alerts(context.Background(), c, st, time.Date(2026, 10, 23, 23, 0, 0, 0, wire.London))
	if st.Pushes["2026-10-23"] != 0 || st.Items[0].Pushed {
		t.Fatal("pushed in quiet hours")
	}
	p.alerts(context.Background(), c, st, now)
	if st.Pushes["2026-10-23"] != 2 { // two clusters, so two pushes, not three
		t.Fatalf("pushes %d", st.Pushes["2026-10-23"])
	}
	for _, it := range st.Items {
		if !it.Pushed {
			t.Fatalf("%s not marked pushed", it.ID)
		}
	}
}

func TestNextRunsAndClubSubset(t *testing.T) {
	srv, hits := fakeWeb(t)
	withClubs(t, srv.URL)
	s := store.Dir(t.TempDir())
	p := poller(srv.URL, s)
	all := club.Enabled()
	if next := p.NextRuns(context.Background(), all, 15*time.Minute); !next["aaa"].Equal(now) || !next["bbb"].Equal(now) {
		t.Fatalf("no state should be due now: %v", next)
	}

	// Only aaa runs; bbb's sources are not read.
	p.Clubs = all[:1]
	if err := p.Run(context.Background()); err != nil {
		t.Fatal(err)
	}
	if hits["/old.xml"] != 0 {
		t.Fatal("bbb was polled")
	}
	next := p.NextRuns(context.Background(), all, 15*time.Minute)
	if !next["aaa"].Equal(now.Add(15*time.Minute)) || !next["bbb"].Equal(now) {
		t.Fatalf("after aaa ran: %v", next)
	}

	// A deploy that drops a source from aaa makes it due now and clears the old source's health.
	club.Clubs[0].Sources = []string{"shared"}
	if next := p.NextRuns(context.Background(), all, 15*time.Minute); !next["aaa"].Equal(now) {
		t.Fatalf("changed sources should be due now: %v", next)
	}
	if err := p.Run(context.Background()); err != nil {
		t.Fatal(err)
	}
	if a := loadState(t, s, "aaa"); a.Health["broken"] != nil || a.Config != club.Clubs[0].Fingerprint() {
		t.Fatalf("health %v, config %q", a.Health, a.Config)
	}
}
