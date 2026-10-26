package squad

import "sort"

// Standing is one club's line in the league table.
type Standing struct {
	Team                    Team
	P, W, D, L, GF, GA, Pts int
}

// GD is goal difference.
func (s Standing) GD() int { return s.GF - s.GA }

// Table is the league table from finished fixtures: points, then goal difference, then goals scored, then name.
// FPL has no head-to-head or play-off data, so a tie past goals scored falls back to the alphabet.
func Table(teams []Team, fixtures []Fixture) []Standing {
	idx := map[int]int{}
	out := make([]Standing, len(teams))
	for i, t := range teams {
		out[i].Team = t
		idx[t.ID] = i
	}
	for _, f := range fixtures {
		hi, okH := idx[f.TeamH]
		ai, okA := idx[f.TeamA]
		if !f.Finished || f.HScore == nil || f.AScore == nil || !okH || !okA {
			continue
		}
		h, a := &out[hi], &out[ai]
		hs, as := *f.HScore, *f.AScore
		h.P, a.P = h.P+1, a.P+1
		h.GF, h.GA, a.GF, a.GA = h.GF+hs, h.GA+as, a.GF+as, a.GA+hs
		switch {
		case hs > as:
			h.W, a.L, h.Pts = h.W+1, a.L+1, h.Pts+3
		case hs < as:
			a.W, h.L, a.Pts = a.W+1, h.L+1, a.Pts+3
		default:
			h.D, a.D, h.Pts, a.Pts = h.D+1, a.D+1, h.Pts+1, a.Pts+1
		}
	}
	sort.SliceStable(out, func(i, j int) bool {
		x, y := out[i], out[j]
		switch {
		case x.Pts != y.Pts:
			return x.Pts > y.Pts
		case x.GD() != y.GD():
			return x.GD() > y.GD()
		case x.GF != y.GF:
			return x.GF > y.GF
		}
		return x.Team.Name < y.Team.Name
	})
	return out
}
