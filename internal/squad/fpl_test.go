package squad

import (
	"bytes"
	"compress/gzip"
	"context"
	"errors"
	"io"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/BeardedSteve/wire-futbol/internal/store"
)

// Real FPL payloads captured on 23 October 2026.
func fixture(t *testing.T, name string) []byte {
	t.Helper()
	f, err := os.Open("../../test/fixtures/" + name)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	z, err := gzip.NewReader(f)
	if err != nil {
		t.Fatal(err)
	}
	b, err := io.ReadAll(z)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

var captured = time.Date(2026, 10, 23, 8, 30, 0, 0, time.UTC)

func fakeFPL(boot, fixtures []byte) FetchFunc {
	return func(_ context.Context, path string) ([]byte, error) {
		switch path {
		case "bootstrap-static/":
			return boot, nil
		case "fixtures/":
			return fixtures, nil
		}
		return nil, errors.New("unexpected path " + path)
	}
}

func TestPollRealPayload(t *testing.T) {
	ctx := context.Background()
	s := store.Dir(t.TempDir())
	boot, fx := fixture(t, "fpl-bootstrap.json.gz"), fixture(t, "fpl-fixtures.json.gz")

	run, err := Poll(ctx, s, fakeFPL(boot, fx), captured)
	if err != nil || !run.OK || run.Season != "2026/27" || run.Players != 668 {
		t.Fatalf("first poll %+v %v", run, err)
	}
	d, _ := Load(ctx, s)
	withApps := 0
	for _, f := range d.Fixtures {
		if f.Finished && f.AppearedH != nil {
			withApps++
		}
	}
	if withApps != 70 {
		t.Fatalf("%d finished fixtures with appearances, want 70", withApps)
	}
	if run.Events == 0 {
		t.Fatal("existing injuries should be logged at first sighting")
	}

	run, err = Poll(ctx, s, fakeFPL(boot, fx), captured.Add(2*time.Hour))
	if err != nil || run.Events != 0 {
		t.Fatalf("second identical poll: %+v %v", run, err)
	}

	run, err = Poll(ctx, s, fakeFPL([]byte("<html>The game is being updated.</html>"), fx), captured.Add(4*time.Hour))
	if err == nil || run.OK || !strings.Contains(run.Error, "not JSON") {
		t.Fatalf("bad payload: %+v %v", run, err)
	}
	after, _ := Load(ctx, s)
	if len(after.Players) != 668 || after.Runs[0].OK || !after.Runs[1].OK {
		t.Fatal("bad payload changed stored data")
	}

	m := after.Model("LIV", captured)
	if m == nil || len(m.Rows) == 0 || len(m.Matches) == 0 || len(m.Pools) != 4 {
		t.Fatalf("model %+v", m)
	}
	names := map[string]bool{}
	for _, r := range m.Rows {
		names[r.P.WebName] = true
	}
	for _, n := range []string{"Isak", "Szoboszlai"} {
		if !names[n] {
			t.Errorf("%s missing from squad", n)
		}
	}
}

func TestStatusChangeIsLogged(t *testing.T) {
	boot, fx := fixture(t, "fpl-bootstrap.json.gz"), fixture(t, "fpl-fixtures.json.gz")
	d := &Data{}
	if _, err := Update(d, boot, fx, captured); err != nil {
		t.Fatal(err)
	}
	n0 := len(d.Events)
	// Raya (id 1) goes from available to injured.
	changed := bytes.Replace(boot, []byte(`"news":"","news_added":null,"removed":false`), []byte(`"news":"Knee injury - Unknown return date","news_added":null,"removed":false`), 1)
	changed = bytes.Replace(changed, []byte(`"status":"a"`), []byte(`"status":"i"`), 1)
	n, err := Update(d, changed, fx, captured.Add(time.Hour))
	if err != nil || n == 0 || len(d.Events) != n0+n {
		t.Fatalf("events %d -> %d (%d new) %v", n0, len(d.Events), n, err)
	}
	last := d.Events[len(d.Events)-1]
	if last.PrevStatus == "" || !last.At.Equal(captured.Add(time.Hour)) {
		t.Fatalf("event %+v", last)
	}
}

func TestSanityChecks(t *testing.T) {
	fx := fixture(t, "fpl-fixtures.json.gz")
	d := &Data{Season: "keep"}
	if _, err := Update(d, []byte(`{"elements":[],"teams":[],"events":[]}`), fx, captured); err == nil || d.Season != "keep" {
		t.Fatal("empty payload accepted")
	}
}

func TestLoadRefusesUnreadableStore(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel() // Retry gives up at once
	if _, err := Load(ctx, failing{}); err == nil {
		t.Fatal("unreadable store treated as empty")
	}
}

type failing struct{}

func (failing) Get(context.Context, string) ([]byte, error)       { return nil, errors.New("boom") }
func (failing) Put(context.Context, string, []byte, string) error { return errors.New("boom") }
