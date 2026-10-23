package squad

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"time"

	"github.com/BeardedSteve/wire-futbol/internal/store"
)

// Key is where the squad data lives in the store. It is shared by every club.
const Key = "fpl.json"

// Run is one poll attempt.
type Run struct {
	At      time.Time `json:"at"`
	OK      bool      `json:"ok"`
	Season  string    `json:"season,omitempty"`
	Players int       `json:"players,omitempty"`
	Events  int       `json:"events,omitempty"`
	Error   string    `json:"error,omitempty"`
	Ms      int64     `json:"ms"`
}

// Data is the whole squad store: the current season's players, teams and fixtures, every status change
// seen this season, and recent runs (newest first).
type Data struct {
	Season   string    `json:"season"`
	Teams    []Team    `json:"teams"`
	Players  []*Player `json:"players"`
	Fixtures []Fixture `json:"fixtures"`
	Events   []Event   `json:"events"`
	Runs     []Run     `json:"runs"`
}

// LastOK is the newest successful run.
func (d *Data) LastOK() *Run {
	for i := range d.Runs {
		if d.Runs[i].OK {
			return &d.Runs[i]
		}
	}
	return nil
}

// Load reads the squad store. A missing file is an empty store; any other failure is an error, so a poll never
// overwrites data it couldn't read.
func Load(ctx context.Context, s store.Store) (*Data, error) {
	b, err := store.Retry(ctx, func() ([]byte, error) { return s.Get(ctx, Key) })
	if errors.Is(err, store.ErrNotFound) {
		return &Data{}, nil
	}
	if err != nil {
		return nil, err
	}
	var d Data
	if err := json.Unmarshal(b, &d); err != nil {
		return nil, fmt.Errorf("%s: %w", Key, err)
	}
	return &d, nil
}

// Save writes the squad store.
func Save(ctx context.Context, s store.Store, d *Data) error {
	b, err := json.Marshal(d)
	if err != nil {
		return err
	}
	_, err = store.Retry(ctx, func() (struct{}, error) { return struct{}{}, s.Put(ctx, Key, b, "application/json") })
	return err
}

// num reads FPL numbers, which arrive as numbers or as strings such as "0.45".
type num float64

func (n *num) UnmarshalJSON(b []byte) error {
	if string(b) == "null" {
		*n = 0
		return nil
	}
	if len(b) > 0 && b[0] == '"' {
		var s string
		if err := json.Unmarshal(b, &s); err != nil {
			return err
		}
		if s == "" {
			*n = 0
			return nil
		}
		f, err := strconv.ParseFloat(s, 64)
		*n = num(f)
		return err
	}
	var f float64
	err := json.Unmarshal(b, &f)
	*n = num(f)
	return err
}

type bootstrap struct {
	Events []struct {
		Deadline string `json:"deadline_time"`
	} `json:"events"`
	Teams []struct {
		ID        int    `json:"id"`
		Code      int    `json:"code"`
		Name      string `json:"name"`
		ShortName string `json:"short_name"`
	} `json:"teams"`
	Elements []struct {
		ID         int    `json:"id"`
		Code       int    `json:"code"`
		Team       int    `json:"team"`
		Type       int    `json:"element_type"`
		WebName    string `json:"web_name"`
		FirstName  string `json:"first_name"`
		SecondName string `json:"second_name"`
		KnownName  string `json:"known_name"`
		Minutes    num    `json:"minutes"`
		Starts     num    `json:"starts"`
		Goals      num    `json:"goals_scored"`
		Assists    num    `json:"assists"`
		XG         num    `json:"expected_goals"`
		XA         num    `json:"expected_assists"`
		Saves      num    `json:"saves"`
		Conceded   num    `json:"goals_conceded"`
		XGC        num    `json:"expected_goals_conceded"`
		CS         num    `json:"clean_sheets"`
		Defcon     num    `json:"defensive_contribution"`
		Recoveries num    `json:"recoveries"`
		Tackles    num    `json:"tackles"`
		CBI        num    `json:"clearances_blocks_interceptions"`
		Status     string `json:"status"`
		Chance     *int   `json:"chance_of_playing_next_round"`
		News       string `json:"news"`
		NewsAdded  string `json:"news_added"`
		Removed    bool   `json:"removed"`
	} `json:"elements"`
}

type fplFixture struct {
	ID       int    `json:"id"`
	Event    int    `json:"event"`
	Kickoff  string `json:"kickoff_time"`
	TeamH    int    `json:"team_h"`
	TeamA    int    `json:"team_a"`
	HScore   *int   `json:"team_h_score"`
	AScore   *int   `json:"team_a_score"`
	Finished bool   `json:"finished"`
	Stats    []struct {
		Identifier string `json:"identifier"`
		H          []struct {
			Element int `json:"element"`
		} `json:"h"`
		A []struct {
			Element int `json:"element"`
		} `json:"a"`
	} `json:"stats"`
}

// Update applies a fresh FPL payload to d: sanity checks first, then players, teams and fixtures are replaced and
// status changes are appended to the log. It returns the number of new status events. On error d is unchanged.
func Update(d *Data, bootJSON, fixturesJSON []byte, now time.Time) (int, error) {
	var boot bootstrap
	if err := json.Unmarshal(bootJSON, &boot); err != nil {
		return 0, fmt.Errorf("bootstrap-static was not JSON (FPL may be mid-update): %.80s", bootJSON)
	}
	var fx []fplFixture
	if err := json.Unmarshal(fixturesJSON, &fx); err != nil {
		return 0, fmt.Errorf("fixtures was not JSON (FPL may be mid-update): %.80s", fixturesJSON)
	}
	// A partial or placeholder payload must never overwrite good data.
	if len(boot.Elements) < 400 {
		return 0, fmt.Errorf("bootstrap-static has %d players, expected 400+", len(boot.Elements))
	}
	if len(boot.Teams) != 20 {
		return 0, fmt.Errorf("bootstrap-static has %d teams, expected 20", len(boot.Teams))
	}
	if len(fx) < 300 {
		return 0, fmt.Errorf("fixtures has %d matches, expected 380", len(fx))
	}
	if len(boot.Events) == 0 || boot.Events[0].Deadline == "" {
		return 0, errors.New("bootstrap-static has no gameweeks")
	}
	first, err := time.Parse(time.RFC3339, boot.Events[0].Deadline)
	if err != nil {
		return 0, fmt.Errorf("first deadline %q: %w", boot.Events[0].Deadline, err)
	}
	y := first.UTC().Year()
	season := fmt.Sprintf("%d/%02d", y, (y+1)%100)

	var teams []Team
	for _, t := range boot.Teams {
		teams = append(teams, Team{ID: t.ID, Code: t.Code, Name: t.Name, ShortName: t.ShortName})
	}
	var players []*Player
	for _, e := range boot.Elements {
		p := &Player{
			ID: e.ID, Code: e.Code, Team: e.Team, Pos: e.Type, WebName: e.WebName, FirstName: e.FirstName, SecondName: e.SecondName, KnownName: e.KnownName,
			Minutes: int(e.Minutes), Starts: int(e.Starts), Goals: int(e.Goals), Assists: int(e.Assists), XG: float64(e.XG), XA: float64(e.XA),
			Saves: int(e.Saves), GoalsConceded: int(e.Conceded), XGC: float64(e.XGC), CleanSheets: int(e.CS), Defcon: int(e.Defcon),
			Recoveries: int(e.Recoveries), Tackles: int(e.Tackles), CBI: int(e.CBI), Status: e.Status, Chance: e.Chance, News: e.News,
			Removed: e.Removed, UpdatedAt: now,
		}
		if t, err := time.Parse(time.RFC3339, e.NewsAdded); err == nil {
			p.NewsAdded = t.UTC()
		}
		players = append(players, p)
	}
	var fixtures []Fixture
	for _, f := range fx {
		k, err := time.Parse(time.RFC3339, f.Kickoff)
		if err != nil {
			continue // not yet scheduled
		}
		out := Fixture{ID: f.ID, Event: f.Event, Kickoff: k.UTC(), TeamH: f.TeamH, TeamA: f.TeamA, HScore: f.HScore, AScore: f.AScore, Finished: f.Finished}
		// Every player who appeared is in the bonus-points list, so it doubles as the appearance record.
		for _, s := range f.Stats {
			if s.Identifier == "bps" && f.Finished {
				out.AppearedH, out.AppearedA = []int{}, []int{}
				for _, x := range s.H {
					out.AppearedH = append(out.AppearedH, x.Element)
				}
				for _, x := range s.A {
					out.AppearedA = append(out.AppearedA, x.Element)
				}
			}
		}
		fixtures = append(fixtures, out)
	}

	prevEvents := d.Events
	prev := map[int]*Player{}
	if d.Season == season {
		for _, p := range d.Players {
			prev[p.ID] = p
		}
	} else {
		prevEvents = nil // a new season starts a new log
	}
	var evs []Event
	for _, p := range players {
		o := prev[p.ID]
		added := p.NewsAdded
		if o == nil {
			// First sighting. FPL's news_added is when the current status was set, so an existing injury keeps its real start.
			if p.Status != "a" {
				at := now
				if !added.IsZero() && !added.After(now) {
					at = added
				}
				evs = append(evs, Event{ID: p.ID, At: at, Status: p.Status, Chance: p.Chance, News: p.News})
			}
			continue
		}
		if o.Status == p.Status && eqInt(o.Chance, p.Chance) && o.News == p.News {
			continue
		}
		// Prefer FPL's own timestamp when it falls between our last look and now.
		at := now
		if !added.IsZero() && added.After(o.UpdatedAt) && !added.After(now) {
			at = added
		}
		evs = append(evs, Event{ID: p.ID, At: at, Status: p.Status, Chance: p.Chance, News: p.News, PrevStatus: o.Status})
	}
	d.Season, d.Teams, d.Players, d.Fixtures = season, teams, players, fixtures
	d.Events = append(prevEvents, evs...)
	return len(evs), nil
}

func eqInt(a, b *int) bool {
	if a == nil || b == nil {
		return a == nil && b == nil
	}
	return *a == *b
}

// Record adds a run to the front of the log, keeping the last 100.
func (d *Data) Record(r Run) {
	d.Runs = append([]Run{r}, d.Runs...)
	if len(d.Runs) > 100 {
		d.Runs = d.Runs[:100]
	}
}

// Model builds the squad page for a club from the stored data.
func (d *Data) Model(fplTeam string, now time.Time) *Model {
	return Build(d.Players, d.Teams, d.Fixtures, d.Events, fplTeam, now)
}

// FetchFunc gets an FPL API path such as "bootstrap-static/".
type FetchFunc func(ctx context.Context, path string) ([]byte, error)

// Poll fetches FPL, updates the store and records the run. A failed fetch or bad payload records a failed run
// and leaves the data as it was.
func Poll(ctx context.Context, s store.Store, fetch FetchFunc, now time.Time) (Run, error) {
	started := time.Now()
	d, err := Load(ctx, s)
	if err != nil {
		return Run{}, fmt.Errorf("read squad store, not writing: %w", err)
	}
	run := Run{At: now}
	boot, err := fetch(ctx, "bootstrap-static/")
	var fixtures []byte
	if err == nil {
		fixtures, err = fetch(ctx, "fixtures/")
	}
	var n int
	if err == nil {
		n, err = Update(d, boot, fixtures, now)
	}
	run.Ms = time.Since(started).Milliseconds()
	if err != nil {
		run.Error = clip(err.Error(), 500)
	} else {
		run.OK, run.Season, run.Players, run.Events = true, d.Season, len(d.Players), n
	}
	d.Record(run)
	if serr := Save(ctx, s, d); serr != nil {
		return run, serr
	}
	if err != nil {
		return run, err
	}
	return run, nil
}

func clip(s string, n int) string {
	if len(s) > n {
		return s[:n]
	}
	return s
}
