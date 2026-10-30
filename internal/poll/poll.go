// Package poll is one run of the wire poller: read every enabled club's sources (each shared source once), filter
// new items, send alerts and save each club's state. A failing source or club never stops the others.
package poll

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"runtime/debug"
	"slices"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/BeardedSteve/wire-futbol/internal/club"
	"github.com/BeardedSteve/wire-futbol/internal/fetch"
	"github.com/BeardedSteve/wire-futbol/internal/filter"
	"github.com/BeardedSteve/wire-futbol/internal/push"
	"github.com/BeardedSteve/wire-futbol/internal/source"
	"github.com/BeardedSteve/wire-futbol/internal/store"
	"github.com/BeardedSteve/wire-futbol/internal/wire"
)

// StateKey and SubsKey are where a club's files live in the store.
func StateKey(c *club.Club) string { return c.Slug + "/state.json" }
func SubsKey(c *club.Club) string  { return c.Slug + "/subs.json" }

// Poller holds the settings for a run.
type Poller struct {
	Store         store.Store
	Fetch         *fetch.Client
	Filter        *filter.Filter
	Push          *push.Sender // nil disables alerts
	MaxSubs       int
	MaxPushPerDay int
	QuietStart    int // London hour alerts stop
	QuietEnd      int // London hour alerts resume
	IngestMaxAge  time.Duration
	RetainDays    int
	Only          []string          // source keys to read; empty means all
	Seeds         map[string]string // club slug to a state.json URL used when the club has no state yet (staging only)
	Clubs         []*club.Club      // clubs to poll; nil means every enabled club
	Now           func() time.Time
}

func (p *Poller) now() time.Time {
	if p.Now != nil {
		return p.Now()
	}
	return time.Now()
}

type fetched struct {
	raws []source.Raw
	err  error
}

// Run polls every club once. It returns an error if any club could not be saved.
func (p *Poller) Run(ctx context.Context) error {
	clubs := p.Clubs
	if clubs == nil {
		clubs = club.Enabled()
	}
	states := map[string]*wire.State{}
	for _, c := range clubs {
		st, err := p.load(ctx, c)
		if err != nil {
			slog.Error("state read failed, skipping club so its state is not overwritten", "club", c.Slug, "err", err)
			continue
		}
		states[c.Slug] = st
	}

	// Each source once, however many clubs read it. Article pages already known to any of those clubs are skipped.
	need := map[string]map[string]bool{}
	for _, c := range clubs {
		st := states[c.Slug]
		if st == nil {
			continue
		}
		for _, k := range c.Sources {
			if !p.wanted(k) {
				continue
			}
			if need[k] == nil {
				need[k] = map[string]bool{}
			}
			for _, it := range st.Items {
				need[k][it.URL] = true
			}
		}
	}
	results := p.fetchAll(ctx, need)

	var failed []string
	for _, c := range clubs {
		st := states[c.Slug]
		if st == nil {
			failed = append(failed, c.Slug)
			continue
		}
		if err := p.runClub(ctx, c, st, results); err != nil {
			slog.Error("club run failed", "club", c.Slug, "err", err)
			failed = append(failed, c.Slug)
		}
	}
	if len(failed) > 0 {
		return fmt.Errorf("clubs not saved: %s", strings.Join(failed, ", "))
	}
	return nil
}

// NextRuns says when each club is next due a poll: now if it has no state, its state can't be read or its sources
// changed since its last run (a deploy that adds a club or a source), otherwise every after its last run.
func (p *Poller) NextRuns(ctx context.Context, clubs []*club.Club, every time.Duration) map[string]time.Time {
	now := p.now()
	out := map[string]time.Time{}
	for _, c := range clubs {
		out[c.Slug] = now
		b, err := store.Retry(ctx, func() ([]byte, error) { return p.Store.Get(ctx, StateKey(c)) })
		if err != nil {
			continue
		}
		var st struct {
			LastRun time.Time `json:"lastRun"`
			Config  string    `json:"config"`
		}
		if json.Unmarshal(b, &st) == nil && st.Config == c.Fingerprint() {
			out[c.Slug] = st.LastRun.Add(every)
		}
	}
	return out
}

func (p *Poller) wanted(key string) bool {
	if len(p.Only) == 0 {
		return true
	}
	for _, k := range p.Only {
		if k == key {
			return true
		}
	}
	return false
}

func (p *Poller) fetchAll(ctx context.Context, need map[string]map[string]bool) map[string]fetched {
	out := map[string]fetched{}
	var mu sync.Mutex
	var wg sync.WaitGroup
	for key, known := range need {
		wg.Add(1)
		go func() {
			defer wg.Done()
			var f fetched
			defer func() {
				if r := recover(); r != nil {
					f = fetched{err: fmt.Errorf("panic: %v", r)}
					slog.Error("source panicked", "source", key, "panic", r, "stack", string(debug.Stack()))
				}
				mu.Lock()
				out[key] = f
				mu.Unlock()
			}()
			s := club.Sources[key]
			if s.Timeout == 0 {
				s.Timeout = club.DefaultTimeout
			}
			sctx, cancel := context.WithTimeout(ctx, 3*time.Minute) // whole-source budget, retries included
			defer cancel()
			switch s.Kind {
			case club.ClubSite:
				f.raws, f.err = source.FetchClubSite(sctx, p.Fetch, s, known, p.now())
			default:
				var b []byte
				if b, f.err = p.Fetch.Get(sctx, s.URL, fetch.AcceptFeed, s.Timeout); f.err == nil {
					f.raws, f.err = source.ParseFeed(b, p.now())
				}
			}
		}()
	}
	wg.Wait()
	return out
}

func (p *Poller) load(ctx context.Context, c *club.Club) (*wire.State, error) {
	b, err := store.Retry(ctx, func() ([]byte, error) { return p.Store.Get(ctx, StateKey(c)) })
	if errors.Is(err, store.ErrNotFound) {
		if seed := p.Seeds[c.Slug]; seed != "" {
			if st := p.seed(ctx, c, seed); st != nil {
				return st, nil
			}
		}
		return (&wire.State{}).Init(), nil
	}
	if err != nil {
		return nil, err
	}
	var st wire.State
	if err := json.Unmarshal(b, &st); err != nil {
		return nil, fmt.Errorf("%s: %w", StateKey(c), err)
	}
	return st.Init(), nil
}

// seed starts an empty wire from another environment's public state, so staging has real stories on day one.
func (p *Poller) seed(ctx context.Context, c *club.Club, url string) *wire.State {
	b, err := p.Fetch.Get(ctx, url, fetch.AcceptJSON, 20*time.Second)
	if err != nil {
		slog.Error("seed state fetch failed, starting empty", "club", c.Slug, "err", err)
		return nil
	}
	var st wire.State
	if err := json.Unmarshal(b, &st); err != nil || st.Items == nil {
		slog.Error("seed state was not a wire state, starting empty", "club", c.Slug)
		return nil
	}
	slog.Info("seeded state", "club", c.Slug, "from", url, "items", len(st.Items))
	return st.Init()
}

func (p *Poller) runClub(ctx context.Context, c *club.Club, st *wire.State, results map[string]fetched) (err error) {
	defer func() {
		if r := recover(); r != nil {
			err = fmt.Errorf("panic: %v\n%s", r, debug.Stack())
		}
	}()
	log := slog.With("club", c.Slug)
	now := p.now()
	known := map[string]bool{}
	for _, it := range st.Items {
		known[it.URL] = true
	}
	added := 0
	changed := st.Config != c.Fingerprint()
	if changed {
		for k := range st.Health {
			if !slices.Contains(c.Sources, k) {
				delete(st.Health, k)
			}
		}
	}

	// 1. ingest
	for _, s := range c.SourceList() {
		res, ok := results[s.Key]
		if !ok {
			continue
		}
		h := st.Health[s.Key]
		if h == nil {
			h = &wire.Health{}
			st.Health[s.Key] = h
		}
		if res.err != nil {
			h.Fails++
			h.LastError, h.LastErrorAt = clip(res.err.Error(), 200), now
			// Source health shows on /status only. A fan's phone never buzzes for our own faults.
			log.Error("source failed", "source", s.Key, "fails", h.Fails, "err", h.LastError)
			continue
		}
		h.LastOK, h.LastCount, h.Fails = now, len(res.raws), 0
		for _, r := range res.raws {
			if known[r.URL] || now.Sub(r.Published) > p.IngestMaxAge {
				continue
			}
			known[r.URL] = true
			added++
			st.Items = append(st.Items, &wire.Item{ID: wire.ID(r.URL), URL: r.URL, Source: s.Name, Title: r.Title, Standfirst: r.Standfirst, Published: r.Published, Fetched: now, Status: wire.Pending})
		}
	}

	// 1b. fixtures every 3 hours, or straight away when the club's config changed; a failure keeps the previous list
	if c.FixturesURL != "" && (changed || st.Fixtures == nil || now.Sub(st.Fixtures.FetchedAt) > 3*time.Hour) {
		if b, err := p.Fetch.Get(ctx, c.FixturesURL, fetch.AcceptFeed, 30*time.Second); err != nil {
			log.Error("fixtures failed", "err", err)
		} else if evs := source.ParseFixtures(b, now); len(evs) > 0 {
			st.Fixtures = &wire.Fixtures{FetchedAt: now, Events: evs}
		}
	}

	// 2. classify pending, newest first, batches of 10, at most 6 batches a run. Gemini rejects 20-item batches
	// with 400 INVALID_ARGUMENT, seen on a new club's first poll.
	var pending, recent []*wire.Item
	for _, it := range st.Items {
		switch {
		case it.Status == wire.Pending:
			pending = append(pending, it)
		case it.Status == wire.Kept && now.Sub(it.Published) < 48*time.Hour:
			recent = append(recent, it)
		}
	}
	newestFirst := func(xs []*wire.Item) {
		sort.SliceStable(xs, func(i, j int) bool { return xs[i].Published.After(xs[j].Published) })
	}
	newestFirst(pending)
	newestFirst(recent)
	for i := 0; i < min(len(pending), 60); i += 10 {
		if !p.Filter.Classify(ctx, c, pending[i:min(i+10, len(pending))], &recent, st) {
			break
		}
	}

	// 3. alerts
	p.alerts(ctx, c, st, now)

	// 4. retain and save
	st.Retain(now, p.RetainDays)
	st.LastRun, st.Config = now, c.Fingerprint()
	b, err := json.Marshal(st)
	if err != nil {
		return err
	}
	if _, err := store.Retry(ctx, func() (struct{}, error) { return struct{}{}, p.Store.Put(ctx, StateKey(c), b, "application/json") }); err != nil {
		return err
	}
	log.Info("run done", "added", added, "pending", st.Count(wire.Pending), "kept", st.Count(wire.Kept))
	return nil
}

var catLabel = map[string]string{"injury": "Injury", "team-news": "Team news", "result": "Result", "transfer": "Transfer", "contract": "Contract", "staff": "Staff", "business": "Business", "regulation": "Regulation", "other": "Club news"}

// alerts pushes material stories (one push per cluster), outside quiet hours and within the daily cap.
func (p *Poller) alerts(ctx context.Context, c *club.Club, st *wire.State, now time.Time) {
	hour := now.In(wire.London).Hour()
	quiet := hour >= p.QuietStart && hour < p.QuietEnd
	if p.QuietStart > p.QuietEnd {
		quiet = hour >= p.QuietStart || hour < p.QuietEnd
	}
	if quiet {
		return
	}
	pushed := map[string]bool{}
	for _, it := range st.Items {
		if it.Pushed {
			pushed[it.Cluster] = true
		}
	}
	var due []*wire.Item
	for _, it := range st.Items {
		if it.Material && !it.Pushed && !pushed[it.Cluster] && now.Sub(it.Published) < 12*time.Hour {
			pushed[it.Cluster] = true // one per cluster, even when two reports of it are due together
			due = append(due, it)
		}
	}
	if len(due) == 0 {
		return
	}
	day := wire.Day(now)
	sent := st.Pushes[day]
	room := max(0, p.MaxPushPerDay-sent)
	text := func(it *wire.Item) string {
		if it.Summary != "" {
			return it.Summary
		}
		return it.Title
	}
	if room > 0 {
		if len(due) <= min(room, 2) {
			for _, it := range due {
				label := catLabel[it.Category]
				if label == "" {
					label = "Club news"
				}
				for _, x := range st.Items {
					if x.Cluster == it.Cluster && x.Status == wire.Kept && x.Source == c.OfficialName() {
						label += " · Club confirmed"
						break
					}
				}
				p.notify(ctx, c, push.Message{Title: label, Body: text(it), URL: "/#s-" + it.Cluster, Tag: it.Cluster}, "high")
			}
			st.Pushes[day] = sent + len(due)
		} else {
			var lines []string
			for _, it := range due[:min(4, len(due))] {
				lines = append(lines, text(it))
			}
			p.notify(ctx, c, push.Message{Title: fmt.Sprintf("%d new stories", len(due)), Body: strings.Join(lines, "\n"), URL: "/", Tag: "digest"}, "high")
			st.Pushes[day] = sent + 1
		}
	}
	for _, it := range due {
		for _, x := range st.Items {
			if x.Cluster == it.Cluster {
				x.Pushed = true
			}
		}
	}
}

// notify sends m to every subscriber of the club and prunes subscriptions the push service says are gone.
func (p *Poller) notify(ctx context.Context, c *club.Club, m push.Message, urgency string) {
	if p.Push == nil {
		slog.Info("no VAPID keys, skipping push", "club", c.Slug)
		return
	}
	list := &push.List{Store: p.Store, Key: SubsKey(c), Max: p.MaxSubs}
	subs, err := list.Load(ctx)
	if err != nil {
		slog.Error("subs read failed", "club", c.Slug, "err", err)
		return
	}
	var gone []string
	for _, s := range subs {
		code, err := p.Push.Send(ctx, s, m, 6*time.Hour, urgency)
		if code == 404 || code == 410 {
			gone = append(gone, s.Endpoint)
		} else if err != nil {
			slog.Error("push failed", "club", c.Slug, "status", code, "err", err)
		}
	}
	if len(gone) > 0 {
		if err := list.Remove(ctx, gone...); err != nil {
			slog.Error("subs cleanup failed", "club", c.Slug, "err", err)
		}
	}
}

func clip(s string, n int) string {
	if len(s) > n {
		return s[:n]
	}
	return s
}
