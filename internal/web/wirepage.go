package web

import (
	"fmt"
	"html/template"
	"sort"
	"strings"
	"time"

	"github.com/BeardedSteve/wire-futbol/internal/club"
	"github.com/BeardedSteve/wire-futbol/internal/squad"
	"github.com/BeardedSteve/wire-futbol/internal/wire"
)

// Timings that decide what the top of the wire shows.
const (
	liveFor      = 2 * time.Hour  // a match is on for two hours after kick-off, half-time and stoppages included
	matchdayFrom = 6 * time.Hour  // or from midnight on the day, whichever is earlier
	fullTimeFor  = 20 * time.Hour // the result stays on the board this long after kick-off
	stopPressFor = 6 * time.Hour  // a major story this new runs as stop press
	splashFor    = 24 * time.Hour // after that it leads the page until this age
	quietAfter   = 20 * time.Hour // no story this recent and the page says so
)

// needsClub are the categories the club itself normally announces, so a report without it is unconfirmed.
var needsClub = map[string]bool{"injury": true, "team-news": true, "transfer": true, "contract": true, "staff": true}

type outletView struct {
	Club             bool
	URL, Title, Name string
}

type reportView struct {
	Lead                 bool
	Summary, URL, Source string
	Time                 template.HTML
}

type basisView struct{ Tone, Word, Title string }

type storyView struct {
	ID, Group, Fetched, Latest, When, HM, Headline, Label string
	Material, Pushed                                      bool
	Basis                                                 basisView
	Outlets                                               []outletView
	Reports                                               []reportView
	Ago                                                   template.HTML
}

func storyCard(c *club.Club, st *wire.Story, now time.Time) storyView {
	official := c.OfficialName()
	v := storyView{ID: st.ID, Group: string(st.Group), Fetched: iso(st.Fetched), Latest: iso(st.Latest), When: longWhen(st.Latest), HM: hm(st.Latest),
		Headline: orDefault(st.Lead.Summary, st.Lead.Title), Label: wire.Cat(st.Lead.Category).Label, Material: st.Material, Pushed: st.Pushed,
		Ago: timeTag(st.Latest, now)}
	// One link per outlet, its newest piece, the club first.
	seen := map[string]bool{}
	var outlets []*wire.Item
	for _, x := range st.Items {
		if !seen[x.Source] {
			seen[x.Source] = true
			outlets = append(outlets, x)
		}
	}
	sort.SliceStable(outlets, func(i, j int) bool { return outlets[i].Source == official && outlets[j].Source != official })
	for _, x := range outlets {
		v.Outlets = append(v.Outlets, outletView{Club: x.Source == official, URL: safeURL(x.URL), Title: x.Title, Name: shortName(x.Source)})
	}
	switch {
	case st.Official:
		v.Basis = basisView{"ok", "Confirmed", "Reported by " + official}
	case needsClub[st.Lead.Category]:
		v.Basis = basisView{"warn", "Unconfirmed", "Nothing from " + official + " yet"}
	default:
		v.Basis = basisView{"", "Reported", ""}
	}
	if len(st.Items) > 1 {
		for _, x := range st.Items {
			v.Reports = append(v.Reports, reportView{Lead: x == st.Lead, Summary: orDefault(x.Summary, x.Title), URL: safeURL(x.URL), Source: x.Source, Time: timeTag(x.Published, now)})
		}
	}
	return v
}

// ---------- feed ----------

type deskView struct {
	Key, Label, No, URL string
	N                   int
	Current             bool
}

type dayView struct {
	Label   string
	Stories []storyView
}

type feedView struct {
	OOB   bool // a desk change: the page number in the title block changes with the feed
	No    string
	Desks []deskView
	Days  []dayView
}

func feed(c *club.Club, all []*wire.Story, desk string, now time.Time) feedView {
	counts := map[string]int{"all": len(all)}
	for _, x := range all {
		counts[string(x.Group)]++
	}
	v := feedView{No: "100"}
	present := 0
	for _, d := range desks[1:] {
		if counts[d.Key] > 0 {
			present++
		}
	}
	for _, d := range desks {
		cur := d.Key == desk
		if cur {
			v.No = d.No
		}
		if present < 2 && !cur {
			continue
		}
		if d.Key == "all" || counts[d.Key] > 0 || cur {
			u := "/"
			if d.Key != "all" {
				u = "/?desk=" + d.Key
			}
			v.Desks = append(v.Desks, deskView{Key: d.Key, Label: d.Label, No: d.No, URL: u, N: counts[d.Key], Current: cur})
		}
	}
	if len(v.Desks) < 2 {
		v.Desks = nil
	}
	for _, x := range all {
		if desk != "all" && string(x.Group) != desk {
			continue
		}
		d := dayLabel(x.Latest, now)
		if len(v.Days) == 0 || v.Days[len(v.Days)-1].Label != d {
			v.Days = append(v.Days, dayView{Label: d})
		}
		v.Days[len(v.Days)-1].Stories = append(v.Days[len(v.Days)-1].Stories, storyCard(c, x, now))
	}
	return v
}

// ---------- the board ----------

type tileView struct{ U, V, L string }

type boardView struct {
	Phase, Tag             string // pre, matchday, live or post
	Competition, Day, HM   string
	Us, Opp, Prep          string
	Kickoff, URL, Official string
	Tiles                  []tileView
	Elapsed                int
	Out, Doubt             []flagView
	More                   int
	Home, Away             string // full time
	HomeScore, AwayScore   int
	Next                   *fixtureView
}

func tiles(at, now time.Time, seconds bool) []tileView {
	s := int(max(0, at.Sub(now).Seconds()))
	d, h, m := s/86400, s%86400/3600, s%3600/60
	var out []tileView
	if d > 0 {
		out = append(out, tileView{"d", fmt.Sprintf("%02d", d), "Days"})
	}
	out = append(out, tileView{"h", fmt.Sprintf("%02d", h), "Hrs"}, tileView{"m", fmt.Sprintf("%02d", m), "Min"})
	if seconds {
		out = append(out, tileView{"s", fmt.Sprintf("%02d", s%60), "Sec"})
	}
	return out
}

// board answers "when do we play, and who is missing?" It follows the calendar: next up with a countdown, matchday
// with seconds, live with time since kick-off, then the full-time score.
func board(c *club.Club, st *wire.State, sq *squad.Data, m *squad.Model, now time.Time) *boardView {
	var next *fixtureView
	if f := upcoming(c, st, sq, now, 1); len(f) > 0 {
		next = &f[0]
	}
	var last *squad.Match
	if m != nil {
		for i := len(m.Matches) - 1; i >= 0; i-- {
			if k := m.Matches[i].Kickoff; k.Add(liveFor).Before(now) {
				last = &m.Matches[i]
				break
			}
		}
	}
	b := &boardView{Official: c.OfficialName()}
	if next != nil {
		start, _ := time.Parse(time.RFC3339, next.Start)
		midnight := time.Date(lon(start).Year(), lon(start).Month(), lon(start).Day(), 0, 0, 0, 0, wire.London)
		switch {
		case !start.After(now):
			b.Phase, b.Tag = "live", "Live now"
			b.Elapsed = max(1, int(now.Sub(start).Minutes()))
		case start.Sub(now) < matchdayFrom || !now.Before(midnight):
			b.Phase, b.Tag = "matchday", "Matchday"
		}
	}
	if b.Phase == "" && last != nil && now.Sub(last.Kickoff) < fullTimeFor {
		b.Phase, b.Tag, b.Next = "post", "Full time", next
		names := map[int]string{}
		for _, t := range sq.Teams {
			names[t.ID] = t.Name
		}
		b.Home, b.Away, b.Day = names[last.TeamH], names[last.TeamA], shortDay(last.Kickoff)
		if last.Home {
			b.Home = c.Short
		} else {
			b.Away = c.Short
		}
		if last.HScore != nil && last.AScore != nil {
			b.HomeScore, b.AwayScore = *last.HScore, *last.AScore
		}
		b.Competition = "Premier League"
		return b
	}
	if next == nil {
		return nil
	}
	if b.Phase == "" {
		b.Phase, b.Tag = "pre", "Next up"
	}
	b.Competition, b.Day, b.HM, b.Kickoff, b.URL = next.Competition, next.Day, next.HM, next.Start, next.URL
	b.Us, b.Opp, b.Prep = c.Short, next.Opp, "v"
	if !next.Home {
		b.Prep = "at"
	}
	if b.Phase != "live" {
		start, _ := time.Parse(time.RFC3339, next.Start)
		b.Tiles = tiles(start, now, b.Phase == "matchday")
	}
	if m != nil {
		const show = 8
		fl := flagged(m)
		for i, f := range fl {
			switch {
			case i >= show:
				b.More++
			case f.Doubt:
				b.Doubt = append(b.Doubt, f)
			default:
				b.Out = append(b.Out, f)
			}
		}
	}
	return b
}

// ---------- the wire page ----------

type wireView struct {
	Started      bool // the club has a state file; until then the feed says so and the rest still shows
	Stop, Splash *storyView
	Board        *boardView
	Quiet        template.HTML
	Feed         feedView
	Run          string
	N            int
	Fixtures     []fixtureView
	Standing     *standingView
	Treatment    []flagView
	HasSquad     bool
	Sources      []sourceRow
}

// stories are the wire's cards. A feed's clock can run ahead, so nothing dated in the future is shown yet.
func stories(c *club.Club, st *wire.State, now time.Time) []*wire.Story {
	var out []*wire.Story
	for _, x := range st.Stories(c.OfficialName()) {
		if !x.Latest.After(now) {
			out = append(out, x)
		}
	}
	return out
}

// lead picks the major story to run above the feed: the newest one in the window, or the one more outlets carry.
func lead(all []*wire.Story, from, to time.Duration, now time.Time) *wire.Story {
	var best *wire.Story
	outlets := func(s *wire.Story) int {
		m := map[string]bool{}
		for _, x := range s.Items {
			m[x.Source] = true
		}
		return len(m)
	}
	for _, s := range all {
		if age := now.Sub(s.Latest); s.Material && age >= from && age < to && (best == nil || outlets(s) > outlets(best)) {
			best = s
		}
	}
	return best
}

func (s *Server) wirePage(c *club.Club, st *wire.State, sq *squad.Data, now time.Time, desk string) *page {
	p := s.basePage(c, st, now, c.App(), "wire")
	p.H1, p.Em, p.Sub = c.Short, "Wire", "Club news. Nothing else."
	p.Rail = true
	var m *squad.Model
	if sq != nil {
		m = sq.Model(c.FPLTeam, now)
	}
	v := &wireView{Started: st != nil, Fixtures: upcoming(c, st, sq, now, 5), Sources: sourceRows(c, st, now), Board: board(c, st, sq, m, now)}
	if m != nil {
		v.HasSquad = true
		v.Standing = standing(sq, m)
		v.Treatment = flagged(m)
	}
	p.Data = v
	if st == nil {
		return p
	}
	valid := false
	for _, d := range desks {
		valid = valid || d.Key == desk
	}
	if !valid {
		desk = "all"
	}
	all := stories(c, st, now)
	v.N = len(all)
	if !st.LastRun.IsZero() {
		v.Run = iso(st.LastRun)
	}
	if x := lead(all, 0, stopPressFor, now); x != nil {
		sv := storyCard(c, x, now)
		v.Stop = &sv
	}
	rest := all
	if desk == "all" {
		if x := lead(all, stopPressFor, splashFor, now); x != nil {
			sv := storyCard(c, x, now)
			v.Splash = &sv
			rest = nil
			for _, y := range all {
				if y != x {
					rest = append(rest, y)
				}
			}
		} else if len(all) > 0 && now.Sub(all[0].Latest) > quietAfter {
			v.Quiet = timeTag(all[0].Latest, now)
		}
	}
	v.Feed = feed(c, rest, desk, now)
	p.No = v.Feed.No
	return p
}

// pulseView is the poller that offers new stories without reloading under the reader.
type pulseView struct {
	Run   string
	N     int
	Fresh int
}

func pulse(c *club.Club, st *wire.State, now time.Time, run string, n int) pulseView {
	v := pulseView{Run: run, N: n}
	if st == nil || st.LastRun.IsZero() {
		return v
	}
	cur := len(stories(c, st, now))
	if r := iso(st.LastRun); r != run && run != "" && cur > n {
		v.Fresh = cur - n
	}
	return v
}

// plainList joins names as "a, b and c".
func plainList(names []string) string {
	if n := len(names); n > 1 {
		return strings.Join(names[:n-1], ", ") + " and " + names[n-1]
	}
	return strings.Join(names, "")
}
