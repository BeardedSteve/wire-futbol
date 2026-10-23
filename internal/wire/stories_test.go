package wire

import (
	"compress/gzip"
	"encoding/json"
	"os"
	"testing"
	"time"
)

func loadFixture(t *testing.T) *State {
	t.Helper()
	f, err := os.Open("../../test/fixtures/state.json.gz")
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	z, err := gzip.NewReader(f)
	if err != nil {
		t.Fatal(err)
	}
	var s State
	if err := json.NewDecoder(z).Decode(&s); err != nil {
		t.Fatal(err)
	}
	return s.Init()
}

func TestReadsBunStateFile(t *testing.T) {
	s := loadFixture(t)
	if len(s.Items) != 600 || s.Health["bbc"].LastCount != 24 || s.LastRun.IsZero() || s.Fixtures == nil {
		t.Fatalf("state: %d items, health %+v", len(s.Items), s.Health["bbc"])
	}
	// Round trip: what we write reads back the same.
	b, _ := json.Marshal(s)
	var again State
	if err := json.Unmarshal(b, &again); err != nil {
		t.Fatal(err)
	}
	b2, _ := json.Marshal(again)
	if string(b) != string(b2) {
		t.Fatal("state does not round-trip")
	}
}

func TestStoriesFromRealState(t *testing.T) {
	s := loadFixture(t)
	st := s.Stories("liverpoolfc.com")
	if len(st) == 0 {
		t.Fatal("no stories")
	}
	kept := s.Count(Kept)
	n := 0
	for i, x := range st {
		n += len(x.Items)
		if i > 0 && x.Latest.After(st[i-1].Latest) {
			t.Fatal("stories not newest first")
		}
		for _, it := range x.Items {
			if it.Status != Kept {
				t.Fatal("non-kept item in a story")
			}
		}
	}
	if n != kept {
		t.Fatalf("stories hold %d items, %d kept", n, kept)
	}
}

func TestClubReportLeadsWithin12Hours(t *testing.T) {
	base := time.Date(2026, 10, 23, 12, 0, 0, 0, time.UTC)
	mk := func(id, src string, ago time.Duration) *Item {
		return &Item{ID: id, Source: src, Status: Kept, Cluster: "x", Summary: id, Published: base.Add(-ago), Category: "injury"}
	}
	s := (&State{Items: []*Item{mk("club", "liverpoolfc.com", 3*time.Hour), mk("echo", "Liverpool Echo", 0)}}).Init()
	if st := s.Stories("liverpoolfc.com"); len(st) != 1 || st[0].Lead.ID != "club" || !st[0].Official || st[0].Group != Fitness {
		t.Fatalf("%+v", st[0])
	}
	s.Items[0].Published = base.Add(-13 * time.Hour)
	if st := s.Stories("liverpoolfc.com"); st[0].Lead.ID != "echo" {
		t.Fatal("stale club report still leads")
	}
}

func TestSimilarSummariesMerge(t *testing.T) {
	base := time.Date(2026, 10, 23, 12, 0, 0, 0, time.UTC)
	s := (&State{Items: []*Item{
		{ID: "a", Status: Kept, Cluster: "a", Published: base, Summary: "Mohamed Salah signs new contract until 2028 at Liverpool, the club confirms."},
		{ID: "b", Status: Kept, Cluster: "b", Published: base.Add(-2 * time.Hour), Summary: "Salah signs a new contract until 2028, the Echo reports."},
		{ID: "c", Status: Kept, Cluster: "c", Published: base, Summary: "Liverpool beat Brentford 3-1 in the Premier League."},
	}}).Init()
	st := s.Stories("liverpoolfc.com")
	if len(st) != 2 || len(st[0].Items)+len(st[1].Items) != 3 {
		t.Fatalf("got %d stories", len(st))
	}
}

func TestRetain(t *testing.T) {
	now := time.Date(2026, 10, 23, 12, 0, 0, 0, time.UTC)
	s := (&State{Items: []*Item{{ID: "old", Published: now.AddDate(0, 0, -15)}, {ID: "new", Published: now}},
		Usage: map[string]*Usage{"2026-10-01": {}, "2026-10-20": {}}, Pushes: map[string]int{"2026-10-01": 1}}).Init()
	s.Retain(now, 14)
	if len(s.Items) != 1 || s.Items[0].ID != "new" || len(s.Usage) != 1 || len(s.Pushes) != 0 {
		t.Fatalf("%+v", s)
	}
}

func TestID(t *testing.T) {
	// Matches the Bun app: sha1 hex of the URL, first 12 characters.
	if got := ID("https://www.liverpoolfc.com/news/jurgen-klopp-sends-message-gratitude-mini-statue-lfc-museum"); got != "61ce2893491e" {
		t.Fatal(got)
	}
}
