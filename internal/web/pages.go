package web

import (
	"fmt"
	"html/template"
	"math"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/BeardedSteve/wire-futbol/internal/club"
	"github.com/BeardedSteve/wire-futbol/internal/squad"
	"github.com/BeardedSteve/wire-futbol/internal/wire"
)

// page is what layout.html renders.
type page struct {
	Club       *club.Club
	Title      string
	Active     string // nav item marked current
	Page       string // data-page, picks the script boot.js runs
	Live       liveness
	Rail       bool
	CSS        []string
	Scripts    []string
	LastRun    string
	StoryCount int
	Favicon    template.URL
	Fonts      string
	Data       any
}

const fontsURL = "https://fonts.googleapis.com/css2?family=Archivo:wdth,wght@75..125,400..800&display=swap"

type liveness struct {
	Tone, Label, Title, Short, Since string
	Stale                            bool
	Backlog                          int
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
		return liveness{Tone: "warn", Label: "Waiting", Title: "No run recorded yet", Short: "Waiting", Since: "it started"}
	}
	age := now.Sub(st.LastRun).Minutes()
	l := liveness{Stale: age > 45, Backlog: backlog(st, now), Since: rel(st.LastRun, now)}
	failing := failingSources(c, st)
	switch {
	case l.Stale:
		l.Tone = "bad"
	case failing > 0 || l.Backlog > 0:
		l.Tone = "warn"
	default:
		l.Tone = "ok"
	}
	switch {
	case l.Stale:
		l.Label = "Stale"
	case age < 1:
		l.Label = "Updated just now"
	default:
		l.Label = fmt.Sprintf("Updated %d min ago", int(age))
	}
	switch {
	case l.Stale:
		l.Title = "Last update " + rel(st.LastRun, now)
	case failing > 0:
		l.Title = fmt.Sprintf("%d source%s failing", failing, plural(failing, "", "s"))
	case l.Backlog > 0:
		l.Title = fmt.Sprintf("%d items waiting over 30 minutes for the filter", l.Backlog)
	default:
		l.Title = "All sources healthy"
	}
	ago := int(math.Max(0, age))
	switch {
	case l.Stale:
		l.Short = "Stale"
	case ago < 1:
		l.Short = "Now"
	case ago < 60:
		l.Short = fmt.Sprintf("%d min", ago)
	default:
		l.Short = fmt.Sprintf("%dh", ago/60)
	}
	return l
}

func (s *Server) basePage(c *club.Club, st *wire.State, now time.Time, title, active string) *page {
	p := &page{Club: c, Title: title, Active: active, Page: active, Live: live(c, st, now), Favicon: favicon(c.Colours.Accent), Fonts: fontsURL}
	if st != nil && !st.LastRun.IsZero() {
		p.LastRun = iso(st.LastRun)
	}
	return p
}

// ---------- wire ----------

type outletView struct {
	Club             bool
	URL, Title, Name string
}

type reportView struct {
	Lead                 bool
	Summary, URL, Source string
	Time                 template.HTML
}

type storyView struct {
	ID, Group, Fetched, Latest, When, HM, Headline, Label string
	Material, Pushed                                      bool
	Outlets                                               []outletView
	Reports                                               []reportView
}

type dayView struct {
	Label   string
	Stories []storyView
}

type chipView struct {
	Key, Label string
	N          int
	Pressed    bool
}

type fixtureView struct {
	URL, Home, Away, When, Competition, Start, Until, Spoken, Day, Opponent string
	HomeUs, AwayUs, Live                                                    bool
}

type wireView struct {
	Chips                []chipView
	Days                 []dayView
	Next                 *fixtureView
	Fixtures             []fixtureView
	Healthy, SourceCount int
	AllHealthy           bool
	LastRead             template.HTML
	Kept, Dropped        int
}

func (s *Server) storyView(c *club.Club, st *wire.Story, now time.Time) storyView {
	official := c.OfficialName()
	cat := wire.Cat(st.Lead.Category)
	v := storyView{ID: st.ID, Group: string(st.Group), Fetched: iso(st.Fetched), Latest: iso(st.Latest), When: longWhen(st.Latest), HM: hm(st.Latest),
		Headline: st.Lead.Summary, Label: cat.Label, Material: st.Material, Pushed: st.Pushed}
	if v.Headline == "" {
		v.Headline = st.Lead.Title
	}
	// provenance: one link per outlet (its newest piece), the club first
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
		v.Outlets = append(v.Outlets, outletView{Club: x.Source == official, URL: safeURL(x.URL), Title: x.Title, Name: s.shortName(x.Source)})
	}
	if len(st.Items) > 1 {
		for _, x := range st.Items {
			v.Reports = append(v.Reports, reportView{Lead: x == st.Lead, Summary: x.Summary, URL: safeURL(x.URL), Source: x.Source, Time: timeTag(x.Published, now)})
		}
	}
	return v
}

// shortName is the outlet name on story cards.
func (s *Server) shortName(name string) string {
	for _, src := range club.Sources {
		if src.Name == name && src.Short != "" {
			return src.Short
		}
	}
	return name
}

// safeURL only lets http(s) links through; html/template would also neuter javascript: URLs, but scraped links
// shouldn't reach a page as anything else.
func safeURL(u string) string {
	if strings.HasPrefix(u, "https://") || strings.HasPrefix(u, "http://") {
		return u
	}
	return "#"
}

func (s *Server) fixture(c *club.Club, e fixtureLike, now time.Time) fixtureView {
	homeUs, awayUs := strings.EqualFold(e.home, c.FixtureName), strings.EqualFold(e.away, c.FixtureName)
	v := fixtureView{URL: safeURL(e.url), Home: e.home, Away: e.away, Competition: e.competition, Start: iso(e.start), Until: untilText(e.start, now),
		HomeUs: homeUs, AwayUs: awayUs, Day: shortDay(e.start), When: shortDay(e.start) + ", " + hm(e.start)}
	v.Live = v.Until == "Live now"
	if homeUs {
		v.Spoken, v.Opponent = c.Short+" at home to "+e.away, e.away
	} else {
		v.Spoken, v.Opponent = c.Short+" away to "+e.home, e.home
	}
	return v
}

type fixtureLike struct {
	start                        time.Time
	home, away, url, competition string
}

func (s *Server) wirePage(c *club.Club, st *wire.State, now time.Time) *page {
	p := s.basePage(c, st, now, c.App(), "wire")
	if st == nil {
		return p
	}
	p.Rail = true
	all := st.Stories(c.OfficialName())
	p.StoryCount = len(all)
	v := &wireView{}
	counts := map[string]int{"all": len(all)}
	for _, x := range all {
		counts[string(x.Group)]++
	}
	present := 0
	for _, g := range wire.Groups {
		if g.Key != "all" && counts[g.Key] > 0 {
			present++
		}
	}
	if present >= 2 {
		for _, g := range wire.Groups {
			if g.Key == "all" || counts[g.Key] > 0 {
				v.Chips = append(v.Chips, chipView{Key: g.Key, Label: g.Label, N: counts[g.Key], Pressed: g.Key == "all"})
			}
		}
	}
	for _, x := range all {
		d := dayLabel(x.Latest, now)
		if len(v.Days) == 0 || v.Days[len(v.Days)-1].Label != d {
			v.Days = append(v.Days, dayView{Label: d})
		}
		v.Days[len(v.Days)-1].Stories = append(v.Days[len(v.Days)-1].Stories, s.storyView(c, x, now))
	}
	if st.Fixtures != nil {
		for _, e := range st.Fixtures.Events {
			if e.Start.After(now.Add(-150 * time.Minute)) {
				f := s.fixture(c, fixtureLike{e.Start, e.Home, e.Away, e.URL, e.Competition}, now)
				if v.Next == nil {
					v.Next = &f
				}
				if len(v.Fixtures) < 5 {
					v.Fixtures = append(v.Fixtures, f)
				}
			}
		}
	}
	v.SourceCount = len(c.Sources)
	for _, k := range c.Sources {
		if h := st.Health[k]; h != nil && h.Fails == 0 && !h.LastOK.IsZero() {
			v.Healthy++
		}
	}
	v.AllHealthy = v.Healthy == v.SourceCount
	if !st.LastRun.IsZero() {
		v.LastRead = timeTag(st.LastRun, now)
	}
	v.Kept, v.Dropped = st.Count(wire.Kept), st.Count(wire.Dropped)
	p.Data = v
	return p
}

// ---------- kept out ----------

var kindLabel = map[string]string{
	"opinion": "Opinion and analysis", "reaction": "Reaction, no new facts", "preview": "Previews and listings", "rumour": "Relayed rumour",
	"feature": "History and features", "promo": "Promo, tickets, FPL, video", "off-topic": "Not about the club", "thin": "Thin, vague or duplicate", "other": "Other",
}

// Older items predate the drop_kind field: classify their free-text reason instead.
var legacy = []struct {
	kind string
	re   *regexp.Regexp
}{
	{"rumour", regexp.MustCompile(`rumou?r|relayed|papers|gossip|unnamed`)},
	{"preview", regexp.MustCompile(`preview|how to watch|broadcast|\btv\b|schedule|listing|atmosphere|travel`)},
	{"promo", regexp.MustCompile(`ticket|promo|commercial|membership|fantasy|fpl|video|gallery|podcast|quiz|kit|retail|award|stream`)},
	{"thin", regexp.MustCompile(`duplicate|vague|empty|clickbait|generic|lacking|no news|outdated|no new|thin|live (press conference )?blog|round-?up`)},
	{"reaction", regexp.MustCompile(`reaction|quotes|comments|social media|mailbag|talk about|musing`)},
	{"off-topic", regexp.MustCompile(`rival|opposition|other club|not about|not liverpool|industry|international|teammate|general premier|women`)},
	{"feature", regexp.MustCompile(`histor|nostalg|memorabilia|retro|anecdote|museum|feature|interview|former|legend|statue`)},
	{"opinion", regexp.MustCompile(`opinion|analys|column|pundit|verdict|talking|discussion|speculat|assess|predict|rating`)},
}

func bucketOf(c *club.Club, it *wire.Item) string {
	kind := it.DropKind
	if _, ok := kindLabel[kind]; !ok {
		kind = "other"
		r := strings.ToLower(it.Reason)
		for _, l := range legacy {
			if l.re.MatchString(r) {
				kind = l.kind
				break
			}
		}
	}
	if kind == "off-topic" {
		return "Not about " + c.Short
	}
	return kindLabel[kind]
}

type bucketView struct {
	Label    string
	N, Width int
}

type rowView struct {
	Day                                                     string
	Bucket, Text, Published, HM, URL, Title, Source, Reason string
}

type filteredView struct {
	Dropped, Total, NoisePct, Pending int
	Buckets                           []bucketView
	Rows                              []rowView
}

func (s *Server) filteredPage(c *club.Club, st *wire.State, now time.Time) *page {
	p := s.basePage(c, st, now, "Kept out · "+c.App(), "filtered")
	if st == nil {
		return p
	}
	var dropped []*wire.Item
	for _, it := range st.Items {
		if it.Status == wire.Dropped {
			dropped = append(dropped, it)
		}
	}
	sort.SliceStable(dropped, func(i, j int) bool { return dropped[i].Published.After(dropped[j].Published) })
	v := &filteredView{Dropped: len(dropped), Pending: st.Count(wire.Pending)}
	v.Total = len(st.Items) - v.Pending
	if v.Total > 0 {
		v.NoisePct = int(math.Round(float64(len(dropped)) / float64(v.Total) * 100))
	}
	tally := map[string]int{}
	var order []string
	for _, d := range dropped {
		b := bucketOf(c, d)
		if tally[b] == 0 {
			order = append(order, b)
		}
		tally[b]++
	}
	most := 1
	for _, n := range tally {
		most = max(most, n)
	}
	sort.SliceStable(order, func(i, j int) bool { return tally[order[i]] > tally[order[j]] })
	for _, b := range order {
		v.Buckets = append(v.Buckets, bucketView{Label: b, N: tally[b], Width: int(math.Round(float64(tally[b]) / float64(most) * 100))})
	}
	last := ""
	for _, d := range dropped {
		if day := dayLabel(d.Published, now); day != last {
			v.Rows = append(v.Rows, rowView{Day: day})
			last = day
		}
		reason := d.Reason
		if reason == "" {
			reason = "No reason given"
		}
		v.Rows = append(v.Rows, rowView{Bucket: bucketOf(c, d), Text: strings.ToLower(d.Title + " " + d.Source + " " + d.Reason), Published: iso(d.Published), HM: hm(d.Published),
			URL: safeURL(d.URL), Title: d.Title, Source: s.shortName(d.Source), Reason: reason})
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
	if st == nil {
		return p
	}
	l := p.Live
	failing := failingSources(c, st)
	v := &statusView{MaxPush: s.cfg.MaxPushPerDay, Model: s.cfg.Model, Kept: st.Count(wire.Kept), Dropped: st.Count(wire.Dropped),
		PriceIn: trimFloat(s.cfg.PriceIn), PriceOut: trimFloat(s.cfg.PriceOut), LastRun: timeTag(st.LastRun, now)}
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
	for _, src := range c.SourceList() {
		h := st.Health[src.Key]
		r := sourceRow{Name: src.Name}
		r.OK = h != nil && h.Fails == 0 && !h.LastOK.IsZero()
		switch {
		case r.OK:
			r.Dot = "ok"
		case h != nil && !h.LastOK.IsZero():
			r.Dot = "bad"
		default:
			r.Dot = "warn"
		}
		if !r.OK {
			if h != nil && !h.LastOK.IsZero() {
				r.State = fmt.Sprintf("Failing for %d run%s", h.Fails, plural(h.Fails, "", "s"))
			} else {
				r.State = "Never read"
			}
		}
		if h != nil {
			if !h.LastOK.IsZero() {
				r.Last = timeTag(h.LastOK, now)
			}
			r.Error = h.LastError
		}
		v.Sources = append(v.Sources, r)
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
		const W = 34.0
		sp := &struct {
			W    float64
			Bars []sparkBar
		}{W: float64(len(days)) * W}
		for i, d := range days {
			h := math.Max(2, vals[i]/vmax*40)
			day, _ := time.ParseInLocation("2006-01-02", d, wire.London)
			sp.Bars = append(sp.Bars, sparkBar{Day: d, Pence: jsFixed(vals[i], 2), Label: day.Add(12 * time.Hour).Format("Mon"),
				X: float64(i)*W + 6, Y: 46 - h, BW: W - 12, H: h, TX: float64(i)*W + W/2, Today: d == today})
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

// ---------- squad ----------

var qBins = []float64{10, 25, 40, 60, 75, 90}

func qClass(pct *float64) string {
	if pct == nil {
		return "q-na"
	}
	n := 0
	for _, b := range qBins {
		if *pct >= b {
			n++
		}
	}
	return fmt.Sprintf("q%d", n)
}

func fmtStat(st squad.Stat, v *float64) string {
	if v == nil {
		return ""
	}
	if st.Unit == "pct" {
		return fmt.Sprintf("%d%%", int(math.Round(*v)))
	}
	s := jsFixed(*v, 2)
	if math.Abs(*v) >= 10 {
		s = jsFixed(*v, 1)
	}
	if (st.Key == "finishing" || st.Key == "prevented") && *v > 0 {
		s = "+" + s
	}
	return s
}

var availLabel = map[squad.Avail]string{squad.Played: "Played", squad.Injured: "Injured or doubtful", squad.Suspended: "Suspended", squad.Out: "Didn't play"}

type outView struct {
	Name, Tone, Flag, What, Since, StoryID, StoryText string
	Missed                                            bool
	MissedN                                           int
}

type cellView struct {
	Class, Label, Value, Pct string
	HasPct                   bool
}

type hmRow struct {
	ID, Pos          int
	Ranked           bool
	Name, Flag, Tone string
	Minutes          int
	Cells            []cellView
}

type posView struct {
	Pos, PoolN int
	Many, One  string
	Threshold  int
	Heads      []string
	Rows, Few  []hmRow
}

type keyLabel struct{ Key, Label, Title string }

type matchView struct{ Title, Opp, HA string }

type availRow struct {
	Name  string
	Cells []keyLabel
}

type squadView struct {
	M           *squad.Model
	Why, Season string
	LastOK      template.HTML
	Out         []outView
	Steps       []int
	Positions   []posView
	Legend      []keyLabel
	Matches     []matchView
	Avail       []availRow
	Away        string
	JSON        any
}

func score(f squad.Match) string {
	h, a := 0, 0
	if f.HScore != nil {
		h = *f.HScore
	}
	if f.AScore != nil {
		a = *f.AScore
	}
	if f.Home {
		return fmt.Sprintf("%d-%d", h, a)
	}
	return fmt.Sprintf("%d-%d", a, h)
}

func (s *Server) squadPage(c *club.Club, st *wire.State, sq *squad.Data, now time.Time) *page {
	p := s.basePage(c, st, now, "Squad · "+c.App(), "squad")
	v := &squadView{}
	p.Data = v
	var m *squad.Model
	if sq != nil {
		m = sq.Model(c.FPLTeam, now)
	}
	if m == nil {
		v.Why = "It refreshes every two hours."
		if last := lastRun(sq); last != nil && !last.OK && last.Error != "" {
			v.Why = "Last attempt failed: " + last.Error
		}
		return p
	}
	p.CSS, p.Scripts = []string{"squad.css"}, []string{"squad.js"}
	v.M, v.Season = m, sq.Season
	if ok := sq.LastOK(); ok != nil {
		v.LastOK = timeTag(ok.At, now)
	}

	// Out now: everyone flagged, with the latest fitness story on the wire that names them.
	var fit []*wire.Story
	if st != nil {
		for _, x := range st.Stories(c.OfficialName()) {
			if x.Group == wire.Fitness && now.Sub(x.Latest) < 21*24*time.Hour {
				fit = append(fit, x)
			}
		}
	}
	for _, r := range m.Rows {
		if r.Flag == nil {
			continue
		}
		o := outView{Name: r.P.WebName, Tone: r.Flag.Tone, Flag: r.Flag.Text, What: r.What}
		if o.What == "" {
			o.What = strings.SplitN(r.P.News, " - ", 2)[0]
		}
		if r.Current != nil {
			o.Since = shortDate(r.Current.Start)
			o.Missed, o.MissedN = true, r.Current.Missed
		} else if !r.P.NewsAdded.IsZero() {
			o.Since = shortDate(r.P.NewsAdded)
		}
		if mt := squad.NameMatcher(r.P); mt != nil {
		stories:
			for _, x := range fit {
				for _, it := range x.Items {
					if mt.Match(it.Summary + " " + it.Title) {
						o.StoryID, o.StoryText = x.ID, orDefault(it.Summary, it.Title)
						break stories
					}
				}
			}
		}
		v.Out = append(v.Out, o)
	}
	v.Steps = []int{0, 1, 2, 3, 4, 5, 6}

	for pos := 1; pos <= 4; pos++ {
		info := squad.Positions[pos]
		pv := posView{Pos: pos, PoolN: len(m.Pools[pos]), Many: info.Many, One: info.One, Threshold: int(math.Round(m.Threshold))}
		for _, st := range info.Stats {
			pv.Heads = append(pv.Heads, st.Label)
		}
		for _, r := range m.Rows {
			if r.P.Pos != pos {
				continue
			}
			row := hmRow{ID: r.P.ID, Pos: pos, Ranked: r.Ranked, Name: r.P.WebName, Minutes: r.P.Minutes}
			if r.Flag != nil {
				row.Flag, row.Tone = r.Flag.Text, r.Flag.Tone
			}
			if r.P.Minutes < 90 {
				pv.Few = append(pv.Few, row)
				continue
			}
			for _, cell := range r.Cells {
				val := fmtStat(cell.Stat, cell.Value)
				label := cell.Stat.Label
				if cell.Stat.Unit == "p90" {
					label += " per 90"
				}
				label += ": " + orDefault(val, "none")
				cv := cellView{Class: qClass(cell.Pct), Value: val}
				if cell.Pct != nil {
					label += ", " + ordinal(*cell.Pct) + " percentile"
					cv.HasPct, cv.Pct = true, fmt.Sprint(int(math.Round(*cell.Pct)))
				} else {
					label += ", not ranked"
				}
				cv.Label = label
				row.Cells = append(row.Cells, cv)
			}
			pv.Rows = append(pv.Rows, row)
		}
		if len(pv.Rows)+len(pv.Few) > 0 {
			v.Positions = append(v.Positions, pv)
		}
	}

	for _, a := range []squad.Avail{squad.Played, squad.Injured, squad.Suspended, squad.Out} {
		v.Legend = append(v.Legend, keyLabel{Key: string(a), Label: availLabel[a]})
	}
	for _, f := range m.Matches {
		ha, prep := "A", "at"
		if f.Home {
			ha, prep = "H", "v"
		}
		v.Matches = append(v.Matches, matchView{Title: fmt.Sprintf("%s %s, %s, %s", prep, f.Opp, shortDate(f.Kickoff), score(f)), Opp: f.Opp, HA: ha})
	}
	for _, r := range m.Rows {
		if r.P.Pos == 1 && r.P.Minutes == 0 && r.Flag == nil {
			continue
		}
		ar := availRow{Name: r.P.WebName}
		for i, a := range r.Avail {
			ar.Cells = append(ar.Cells, keyLabel{Key: string(a), Label: availLabel[a], Title: m.Matches[i].Opp + ": " + availLabel[a]})
		}
		v.Avail = append(v.Avail, ar)
	}
	var away []string
	for _, a := range m.Away {
		away = append(away, a.WebName)
	}
	v.Away = strings.Join(away, ", ")

	type statJS struct {
		K string `json:"k"`
		L string `json:"l"`
		B string `json:"b"`
		U string `json:"u"`
	}
	type mineJS struct {
		N string     `json:"n"`
		V []*float64 `json:"v"`
		P []*int     `json:"p"`
		R bool       `json:"r"`
	}
	stats := map[string][]statJS{}
	pools := map[string][]squad.PoolEntry{}
	for pos := 1; pos <= 4; pos++ {
		for _, st := range squad.Positions[pos].Stats {
			stats[fmt.Sprint(pos)] = append(stats[fmt.Sprint(pos)], statJS{st.Key, st.Label, st.Better, st.Unit})
		}
		pools[fmt.Sprint(pos)] = m.Pools[pos]
	}
	mine := map[string]mineJS{}
	for _, r := range m.Rows {
		mj := mineJS{N: r.P.WebName, R: r.Ranked}
		for _, cell := range r.Cells {
			if cell.Value == nil {
				mj.V = append(mj.V, nil)
			} else {
				x := math.Round(*cell.Value*1000) / 1000
				mj.V = append(mj.V, &x)
			}
			if cell.Pct == nil {
				mj.P = append(mj.P, nil)
			} else {
				x := int(math.Round(*cell.Pct))
				mj.P = append(mj.P, &x)
			}
		}
		mine[fmt.Sprint(r.P.ID)] = mj
	}
	v.JSON = map[string]any{"club": m.Team.ShortName, "stats": stats, "pools": pools, "mine": mine}
	return p
}
