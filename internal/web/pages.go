package web

import (
	"encoding/json"
	"fmt"
	"html/template"
	"math"
	"sort"
	"strings"
	"time"

	"github.com/BeardedSteve/wire-futbol/internal/club"
	"github.com/BeardedSteve/wire-futbol/internal/squad"
	"github.com/BeardedSteve/wire-futbol/internal/wire"
)

// page is what layout.html renders.
type page struct {
	Club    *club.Club
	ClubCSS string
	Title   string
	Active  string // section key, marks the index and tab bar
	No      string // teletext page number: 100 for the wire, 110 for its first desk, 200 for the squad
	H1, Em  string // page title; Em is its last word, set in italic
	Sub     string
	Live    liveness
	Now     string // the server's clock, which the client uses as its reference
	Clock   string
	Date    string
	Pages   string // JSON of page number to URL, for typed page entry
	Nav     []navLink
	Rail    bool
	Favicon template.URL
	Data    any
}

type navLink struct {
	No, URL, Label, Key string
	Current             bool
}

// sections are the numbered pages. The first four are the phone tab bar and the teletext fast-text keys.
var sections = []navLink{
	{No: "100", URL: "/", Label: "Wire", Key: "wire"},
	{No: "200", URL: "/squad", Label: "Squad", Key: "squad"},
	{No: "300", URL: "/table", Label: "Table", Key: "table"},
	{No: "400", URL: "/shorts", Label: "Shorts", Key: "shorts"},
	{No: "500", URL: "/spiked", Label: "Spiked", Key: "spiked"},
	{No: "600", URL: "/status", Label: "Status", Key: "status"},
}

// desks are the wire's sections, numbered under 100.
var desks = []struct{ Key, Label, No string }{
	{"all", "All", "100"}, {"fitness", "Fitness", "110"}, {"transfers", "Transfers", "120"}, {"results", "Results", "130"}, {"club", "Club", "140"},
}

var pagesJSON = func() string {
	m := map[string]string{}
	for _, s := range sections {
		m[s.No] = s.URL
	}
	for _, d := range desks[1:] {
		m[d.No] = "/?desk=" + d.Key
	}
	b, _ := json.Marshal(m)
	return string(b)
}()

type liveness struct {
	Tone, Label, Title, Since string
	Stale                     bool
	Backlog                   int
}

// backlog counts items the filter has failed to process for over 30 minutes: the real signal the model is broken.
func backlog(st *wire.State, now time.Time) int {
	n := 0
	for _, it := range st.Items {
		if it.Status == wire.Pending && now.Sub(it.Fetched) > 30*time.Minute {
			n++
		}
	}
	return n
}

func failingSources(c *club.Club, st *wire.State) int {
	n := 0
	for _, k := range c.Sources {
		if h := st.Health[k]; h != nil && h.Fails > 0 {
			n++
		}
	}
	return n
}

func live(c *club.Club, st *wire.State, now time.Time) liveness {
	if st == nil || st.LastRun.IsZero() {
		return liveness{Tone: "warn", Label: "Waiting", Title: "No run recorded yet", Since: "it started"}
	}
	age := math.Max(0, now.Sub(st.LastRun).Minutes())
	l := liveness{Stale: age > 45, Backlog: backlog(st, now), Since: rel(st.LastRun, now)}
	failing := failingSources(c, st)
	switch {
	case l.Stale:
		l.Tone, l.Label, l.Title = "bad", "Stale", "Last update "+rel(st.LastRun, now)
	case failing > 0:
		l.Tone, l.Title = "warn", fmt.Sprintf("%d source%s failing", failing, plural(failing, "", "s"))
	case l.Backlog > 0:
		l.Tone, l.Title = "warn", fmt.Sprintf("%d items waiting over 30 minutes for the filter", l.Backlog)
	default:
		l.Tone, l.Title = "ok", "All sources healthy"
	}
	if !l.Stale {
		switch {
		case age < 1:
			l.Label = "Now"
		case age < 60:
			l.Label = fmt.Sprintf("%d min", int(age))
		default:
			l.Label = fmt.Sprintf("%dh", int(age/60))
		}
	}
	return l
}

func (s *Server) basePage(c *club.Club, st *wire.State, now time.Time, title, active string) *page {
	p := &page{Club: c, ClubCSS: s.clubCSSPath(c), Title: title, Active: active, Live: live(c, st, now), Favicon: favicon(c.Colours.Accent),
		Now: iso(now), Clock: lon(now).Format("15:04/05"), Date: lon(now).Format("Mon 2 Jan 2006"), Pages: pagesJSON}
	for _, l := range sections {
		l.Current = l.Key == active
		if l.Current {
			p.No = l.No
		}
		p.Nav = append(p.Nav, l)
	}
	return p
}

// ---------- shared pieces ----------

// safeURL only lets http(s) links through; html/template would also neuter javascript: URLs, but scraped links
// shouldn't reach a page as anything else.
func safeURL(u string) string {
	if strings.HasPrefix(u, "https://") || strings.HasPrefix(u, "http://") {
		return u
	}
	return "#"
}

// shortName is the outlet name on story cards.
func shortName(name string) string {
	for _, src := range club.Sources {
		if src.Name == name && src.Short != "" {
			return src.Short
		}
	}
	return name
}

type fixtureView struct {
	URL, Day, HM, Opp, Competition, Venue, Start string
	Home                                         bool
}

func fixture(c *club.Club, e fixtureLike) fixtureView {
	v := fixtureView{URL: safeURL(e.url), Day: shortDay(e.start), HM: hm(e.start), Competition: e.competition, Venue: e.venue, Start: iso(e.start),
		Home: strings.EqualFold(e.home, c.FixtureName)}
	v.Opp = e.away
	if !v.Home {
		v.Opp = e.home
	}
	return v
}

type fixtureLike struct {
	start                               time.Time
	home, away, url, competition, venue string
}

// upcoming is the club's next matches, including one that kicked off in the last two hours.
func upcoming(c *club.Club, st *wire.State, now time.Time, n int) []fixtureView {
	var out []fixtureView
	if st == nil || st.Fixtures == nil {
		return out
	}
	for _, e := range st.Fixtures.Events {
		if e.Start.After(now.Add(-liveFor)) && len(out) < n {
			out = append(out, fixture(c, fixtureLike{e.Start, e.Home, e.Away, e.URL, e.Competition, e.Venue}))
		}
	}
	return out
}

// ---------- squad flags, shared by the board, the treatment room and the squad page ----------

type flagView struct {
	ID                                    int
	Name, Tone, Flag, What, Since, Missed string
	Chance                                string
	StoryID, StoryText                    string
	Doubt                                 bool
}

func what(r *squad.Row) string {
	w := r.What
	if w == "" {
		w = strings.SplitN(r.P.News, " - ", 2)[0]
	}
	return strings.TrimSuffix(strings.TrimSuffix(w, " injury"), " Injury")
}

// flagged lists every flagged player, ruled out first, then doubtful, each in squad order.
func flagged(m *squad.Model) []flagView {
	var out, doubt []flagView
	for _, r := range m.Rows {
		if r.Flag == nil {
			continue
		}
		f := flagView{ID: r.P.ID, Name: r.P.WebName, Tone: r.Flag.Tone, Flag: r.Flag.Text, What: what(r), Doubt: r.Flag.Tone == "warn"}
		if f.Doubt && r.P.Chance != nil {
			f.Chance = fmt.Sprintf("%d%%", *r.P.Chance)
		}
		switch {
		case r.Current != nil:
			f.Since = shortDate(r.Current.Start)
			f.Missed = fmt.Sprintf("missed %d", r.Current.Missed)
		case !r.P.NewsAdded.IsZero():
			f.Since = shortDate(r.P.NewsAdded)
		}
		if f.Doubt {
			doubt = append(doubt, f)
		} else {
			out = append(out, f)
		}
	}
	return append(out, doubt...)
}

// ---------- league table ----------

type standingRow struct {
	Pos             int
	Short, Name     string
	P, W, D, L, Pts int
	GD              string
	Me              bool
}

type formView struct{ Res, Title string }

type standingView struct {
	Pos, Played, Pts int
	Ord, GD          string
	Rows             []standingRow // the whole table
	Near             []standingRow // five rows around the club
	Form             []formView
}

func signed(n int) string {
	if n > 0 {
		return fmt.Sprintf("+%d", n)
	}
	return fmt.Sprint(n)
}

func standing(sq *squad.Data, m *squad.Model) *standingView {
	if sq == nil || m == nil {
		return nil
	}
	tab := squad.Table(sq.Teams, sq.Fixtures)
	v := &standingView{}
	for i, r := range tab {
		row := standingRow{Pos: i + 1, Short: r.Team.ShortName, Name: r.Team.Name, P: r.P, W: r.W, D: r.D, L: r.L, Pts: r.Pts, GD: signed(r.GD()), Me: r.Team.ID == m.Team.ID}
		if row.Me {
			v.Pos, v.Played, v.Pts, v.GD = row.Pos, r.P, r.Pts, row.GD
		}
		v.Rows = append(v.Rows, row)
	}
	if v.Pos == 0 || v.Played == 0 {
		return nil
	}
	v.Ord = strings.ToUpper(ordinal(float64(v.Pos)))
	lo := max(0, min(len(v.Rows)-5, v.Pos-3))
	v.Near = v.Rows[lo:min(len(v.Rows), lo+5)]
	ms := m.Matches
	if len(ms) > 5 {
		ms = ms[len(ms)-5:]
	}
	for _, f := range ms {
		us, them := f.HScore, f.AScore
		if !f.Home {
			us, them = them, us
		}
		if us == nil || them == nil {
			continue
		}
		res := "D"
		switch {
		case *us > *them:
			res = "W"
		case *us < *them:
			res = "L"
		}
		prep := "at"
		if f.Home {
			prep = "v"
		}
		v.Form = append(v.Form, formView{Res: res, Title: fmt.Sprintf("%s %s %d-%d, %s", prep, f.Opp, *us, *them, shortDate(f.Kickoff))})
	}
	return v
}

// ---------- table page ----------

type tableView struct {
	Fixtures []fixtureView
	Standing *standingView
	Why      string
}

func (s *Server) tablePage(c *club.Club, st *wire.State, sq *squad.Data, now time.Time) *page {
	p := s.basePage(c, st, now, "Table · "+c.App(), "table")
	p.H1, p.Em = "Fixtures and", "table"
	v := &tableView{Fixtures: upcoming(c, st, now, 8)}
	if sq != nil {
		v.Standing = standing(sq, sq.Model(c.FPLTeam, now))
	}
	if v.Standing == nil {
		v.Why = "The league table appears once the squad data has loaded and the season has started."
	}
	p.Data = v
	return p
}

// ---------- status ----------

type sourceRow struct {
	Name, Dot, State, Error string
	OK                      bool
	Last                    template.HTML
}

func sourceRows(c *club.Club, st *wire.State, now time.Time) []sourceRow {
	var out []sourceRow
	for _, src := range c.SourceList() {
		h := st.Health[src.Key]
		r := sourceRow{Name: src.Name}
		r.OK = h != nil && h.Fails == 0 && !h.LastOK.IsZero()
		switch {
		case r.OK:
			r.Dot = "ok"
		case h != nil && !h.LastOK.IsZero():
			r.Dot, r.State = "bad", fmt.Sprintf("Failing for %d run%s", h.Fails, plural(h.Fails, "", "s"))
		default:
			r.Dot, r.State = "warn", "Never read"
		}
		if h != nil {
			if !h.LastOK.IsZero() {
				r.Last = timeTag(h.LastOK, now)
			}
			r.Error = h.LastError
		}
		out = append(out, r)
	}
	return out
}

type sparkBar struct {
	Day, Pence, Label string
	X, Y, BW, H, TX   float64
	Today             bool
}

type statusView struct {
	Headline           string
	Sources            []sourceRow
	LastRun, Fixtures  template.HTML
	Pushes, MaxPush    int
	Squad              template.HTML
	SquadBad           bool
	CostToday, CostAvg string
	Spark              *struct {
		W    float64
		Bars []sparkBar
	}
	FilterState, Model, CallsWord string
	Calls                         int
	TokensIn, TokensOut           string
	PriceIn, PriceOut             string
	Kept, Dropped                 int
}

func (s *Server) pence(u *wire.Usage) float64 {
	if u == nil {
		return 0
	}
	return (float64(u.In)*s.cfg.PriceIn + float64(u.Out)*s.cfg.PriceOut) / 1e6 * s.cfg.USDToGBP * 100
}

func (s *Server) statusPage(c *club.Club, st *wire.State, sq *squad.Data, now time.Time) *page {
	p := s.basePage(c, st, now, "Status · "+c.App(), "status")
	p.H1, p.Em = "", "Status"
	if st == nil {
		return p
	}
	l := p.Live
	failing := failingSources(c, st)
	v := &statusView{MaxPush: s.cfg.MaxPushPerDay, Model: s.cfg.Model, Kept: st.Count(wire.Kept), Dropped: st.Count(wire.Dropped),
		PriceIn: trimFloat(s.cfg.PriceIn), PriceOut: trimFloat(s.cfg.PriceOut), LastRun: timeTag(st.LastRun, now), Sources: sourceRows(c, st, now)}
	switch {
	case l.Stale:
		v.Headline = "The wire has stopped updating"
	case failing > 0:
		v.Headline = fmt.Sprintf("%d source%s failing", failing, plural(failing, "", "s"))
	case l.Backlog > 0:
		v.Headline = "The filter is falling behind"
	default:
		v.Headline = "Everything is working"
	}
	if st.Fixtures != nil {
		v.Fixtures = timeTag(st.Fixtures.FetchedAt, now)
	}
	today := wire.Day(now)
	v.Pushes = st.Pushes[today]

	switch last := lastRun(sq); {
	case sq == nil || last == nil:
		v.Squad = "Not loaded yet"
	case !last.OK:
		v.SquadBad = true
		msg := "Last refresh failed: " + template.HTMLEscapeString(orDefault(last.Error, "unknown error"))
		if ok := sq.LastOK(); ok != nil {
			msg += ". Last good " + string(timeTag(ok.At, now))
		}
		v.Squad = template.HTML(msg)
	default:
		v.Squad = "Refreshed " + timeTag(sq.LastOK().At, now) + ", every two hours"
	}

	days := make([]string, 0, len(st.Usage))
	for d := range st.Usage {
		days = append(days, d)
	}
	sort.Strings(days)
	if len(days) > 7 {
		days = days[len(days)-7:]
	}
	t := st.Usage[today]
	if t == nil {
		t = &wire.Usage{}
	}
	var vals []float64
	sum, vmax := 0.0, 0.01
	for _, d := range days {
		x := s.pence(st.Usage[d])
		vals = append(vals, x)
		sum += x
		vmax = math.Max(vmax, x)
	}
	avg := 0.0
	if len(vals) > 0 {
		avg = sum / float64(len(vals))
	}
	v.CostToday, v.CostAvg = jsFixed(s.pence(t), 2), jsFixed(avg, 2)
	if len(days) > 0 {
		const W = 44.0
		sp := &struct {
			W    float64
			Bars []sparkBar
		}{W: float64(len(days)) * W}
		for i, d := range days {
			h := math.Max(2, vals[i]/vmax*52)
			day, _ := time.ParseInLocation("2006-01-02", d, wire.London)
			sp.Bars = append(sp.Bars, sparkBar{Day: d, Pence: jsFixed(vals[i], 2), Label: strings.ToUpper(day.Add(12 * time.Hour).Format("Mon")),
				X: float64(i)*W + 4, Y: 56 - h, BW: W - 8, H: h, TX: float64(i)*W + W/2, Today: d == today})
		}
		v.Spark = sp
	}
	switch {
	case l.Backlog > 0:
		v.FilterState = fmt.Sprintf("%d items stuck. Last error: %s", l.Backlog, orDefault(st.ModelError, "none recorded"))
	case st.ModelError != "":
		v.FilterState = "Working. The last call failed (" + st.ModelError + ") and will be retried."
	default:
		v.FilterState = "Working"
	}
	v.Calls, v.CallsWord = t.Calls, plural(t.Calls, "call", "calls")
	v.TokensIn, v.TokensOut = thousands(t.In), thousands(t.Out)
	p.Data = v
	return p
}

func lastRun(d *squad.Data) *squad.Run {
	if d == nil || len(d.Runs) == 0 {
		return nil
	}
	return &d.Runs[0]
}

func orDefault(s, d string) string {
	if s == "" {
		return d
	}
	return s
}

// trimFloat prints 0.75 as 0.75 and 3 as 3, like JavaScript.
func trimFloat(f float64) string { return fmt.Sprintf("%g", f) }
