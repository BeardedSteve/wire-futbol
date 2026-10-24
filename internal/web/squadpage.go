package web

import (
	"fmt"
	"math"
	"sort"
	"strings"
	"time"

	"github.com/BeardedSteve/wire-futbol/internal/club"
	"github.com/BeardedSteve/wire-futbol/internal/squad"
	"github.com/BeardedSteve/wire-futbol/internal/wire"
)

// qBins split percentiles into the six steps of the squad page's colour scale, bottom of the division to top.
var qBins = []float64{10, 25, 50, 75, 90}

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

// shortStat is the column head on a phone, where five full labels don't fit.
var shortStat = map[string]string{
	"saves": "Saves", "conceded": "Conc", "xgc": "xGA", "prevented": "Prev", "cs": "CS",
	"defcon": "Def", "recoveries": "Recov", "xg": "xG", "xa": "xA", "goals": "Goals", "assists": "Ast", "finishing": "Fin",
}

var availLabel = map[squad.Avail]string{squad.Played: "Played", squad.Injured: "Injured or doubtful", squad.Suspended: "Suspended", squad.Out: "Didn't play"}

type cellView struct {
	Class, Label, Value string
	Pct                 int
}

type headView struct{ Full, Short, Title string }

type hmRow struct {
	ID      int
	Name    string
	Minutes string
	Spread  bool      // enough minutes for the dot plots
	Status  *flagView // injured, doubtful, suspended or otherwise unavailable
	Kind    string    // the status icon: inj, doubt, sus or out
	Cells   []cellView
}

type posView struct {
	Pos, PoolN int
	Many       string
	Threshold  int
	Heads      []headView
	Rows       []hmRow
}

type keyLabel struct{ Key, Label, Title string }

type matchView struct{ Title, Opp, HA string }

type availRow struct {
	Name  string
	Cells []keyLabel
}

type squadView struct {
	M         *squad.Model
	Why       string
	Steps     []int
	Positions []posView
	Legend    []keyLabel
	Matches   []matchView
	Avail     []availRow
	Away      string
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
	p.H1, p.Em = "The", "squad"
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
	v.M = m

	// Each flagged player carries the latest fitness story on the wire that names them.
	var fit []*wire.Story
	if st != nil {
		for _, x := range st.Stories(c.OfficialName()) {
			if x.Group == wire.Fitness && now.Sub(x.Latest) < 21*24*time.Hour {
				fit = append(fit, x)
			}
		}
	}
	status := map[int]*flagView{}
	for _, f := range flagged(m) {
		status[f.ID] = &f
	}
	story := func(r *squad.Row, f *flagView) {
		mt := squad.NameMatcher(r.P)
		if mt == nil {
			return
		}
		for _, x := range fit {
			for _, it := range x.Items {
				if mt.Match(it.Summary + " " + it.Title) {
					f.StoryID, f.StoryText = x.ID, orDefault(it.Summary, it.Title)
					return
				}
			}
		}
	}
	v.Steps = []int{0, 1, 2, 3, 4, 5}

	for pos := 1; pos <= 4; pos++ {
		info := squad.Positions[pos]
		pv := posView{Pos: pos, PoolN: len(m.Pools[pos]), Many: info.Many, Threshold: int(math.Round(m.Threshold))}
		for _, st := range info.Stats {
			h := headView{Full: st.Label, Short: orDefault(shortStat[st.Key], st.Label), Title: st.Label}
			if st.Unit == "p90" {
				h.Title += " per 90 minutes"
			}
			pv.Heads = append(pv.Heads, h)
		}
		for _, r := range m.Rows {
			if r.P.Pos != pos {
				continue
			}
			row := hmRow{ID: r.P.ID, Name: r.P.WebName, Minutes: thousands(r.P.Minutes), Spread: r.P.Minutes >= 90}
			if f := status[r.P.ID]; f != nil {
				story(r, f)
				row.Status = f
				row.Kind = map[string]string{"i": "inj", "d": "doubt", "s": "sus"}[r.P.Status]
				if row.Kind == "" {
					row.Kind = "out"
				}
			}
			for _, cell := range r.Cells {
				val := fmtStat(cell.Stat, cell.Value)
				if !row.Spread {
					val = "" // per 90 over a few minutes says nothing
				}
				label := cell.Stat.Label
				if cell.Stat.Unit == "p90" {
					label += " per 90"
				}
				label += ": " + orDefault(val, "none")
				cv := cellView{Class: qClass(cell.Pct), Value: val}
				if cell.Pct != nil {
					label += ", " + ordinal(*cell.Pct) + " percentile"
					cv.Pct = int(math.Round(*cell.Pct))
				} else {
					label += ", not ranked"
				}
				cv.Label = label
				row.Cells = append(row.Cells, cv)
			}
			pv.Rows = append(pv.Rows, row)
		}
		if len(pv.Rows) > 0 {
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
	return p
}

// ---------- one player's spread against the division, drawn on the server ----------

type dotView struct {
	X    string // percent of the strip's width
	Y, R float64
	Mate bool
	T    string
}

type stripView struct {
	Label, Value, Rank, Aria string
	Lo, Hi                   string
	Med                      string
	Dots                     []dotView
	Me                       *dotView
}

type stripsView struct {
	Name   string
	Strips []stripView
}

// strips are the dot plots under an open player row: every ranked player at the position, team-mates darker, the
// player in the club colour, the median dashed. Right is always better. Positions are percentages so the plot is
// crisp at any width without a script.
func strips(m *squad.Model, id int) *stripsView {
	var r *squad.Row
	for _, x := range m.Rows {
		if x.P.ID == id {
			r = x
		}
	}
	if r == nil {
		return nil
	}
	const h = 34.0
	pool := m.Pools[r.P.Pos]
	v := &stripsView{Name: r.P.WebName}
	for i, st := range squad.Positions[r.P.Pos].Stats {
		var vals []float64
		for _, p := range pool {
			if p.V[i] != nil {
				vals = append(vals, *p.V[i])
			}
		}
		sort.Float64s(vals)
		var mv *float64
		if r.Cells[i].Value != nil {
			x := math.Round(*r.Cells[i].Value*1000) / 1000
			mv = &x
		}
		if len(vals) == 0 && mv == nil {
			continue
		}
		flip := st.Better == "low"
		var lo, hi float64
		if len(vals) > 0 {
			lo, hi = vals[int(float64(len(vals))*0.02)], vals[int(math.Ceil(float64(len(vals))*0.98))-1]
		} else {
			lo, hi = *mv, *mv
		}
		if mv != nil {
			lo, hi = math.Min(lo, *mv), math.Max(hi, *mv)
		}
		if hi == lo {
			hi = lo + 1
		}
		x := func(v float64) string {
			t := (math.Max(lo, math.Min(hi, v)) - lo) / (hi - lo)
			if flip {
				t = 1 - t
			}
			return trimFloat(math.Round((1.5+t*97)*10) / 10)
		}
		sv := stripView{Label: st.Label, Value: fmtStat(st, mv)}
		if st.Unit == "p90" {
			sv.Label += " /90"
		}
		if r.Ranked && mv != nil {
			rank, ties := 1, 0
			for _, v := range vals {
				if (flip && v < *mv-1e-9) || (!flip && v > *mv+1e-9) {
					rank++
				}
				if math.Abs(v-*mv) <= 1e-9 {
					ties++
				}
			}
			sv.Rank = fmt.Sprintf("%s of %d", ordinal(float64(rank)), len(vals))
			if ties > 1 {
				sv.Rank = "joint " + sv.Rank
			}
		} else {
			sv.Rank = "not ranked"
		}
		sv.Aria = st.Label + ": " + r.P.WebName + " " + orDefault(sv.Value, "none")
		if p := r.Cells[i].Pct; p != nil {
			sv.Aria += ", " + ordinal(*p) + " percentile"
		}
		worst, best := lo, hi
		if flip {
			worst, best = hi, lo
		}
		sv.Lo, sv.Hi = fmtStat(st, &worst), fmtStat(st, &best)
		if len(vals) > 0 {
			sv.Med = x(vals[len(vals)/2])
		}
		for j, p := range pool {
			if p.V[i] == nil {
				continue
			}
			mate := p.T == m.Team.ShortName
			d := dotView{X: x(*p.V[i]), Y: math.Round((6+float64(j*7919%97)/97*(h-12))*10) / 10, R: 2.6, Mate: mate, T: fmt.Sprintf("%s (%s) %s", p.N, p.T, fmtStat(st, p.V[i]))}
			if mate {
				d.R = 3.4
			}
			sv.Dots = append(sv.Dots, d)
		}
		if mv != nil {
			sv.Me = &dotView{X: x(*mv), Y: h / 2, R: 6.5}
		}
		v.Strips = append(v.Strips, sv)
	}
	return v
}
