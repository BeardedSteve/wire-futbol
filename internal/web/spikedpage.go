package web

import (
	"math"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/BeardedSteve/wire-futbol/internal/club"
	"github.com/BeardedSteve/wire-futbol/internal/wire"
)

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

func kindOf(it *wire.Item) string {
	if _, ok := kindLabel[it.DropKind]; ok {
		return it.DropKind
	}
	r := strings.ToLower(it.Reason)
	for _, l := range legacy {
		if l.re.MatchString(r) {
			return l.kind
		}
	}
	return "other"
}

func kindName(c *club.Club, kind string) string {
	if kind == "off-topic" {
		return "Not about " + c.Short
	}
	return kindLabel[kind]
}

type bucketView struct {
	Key, Label string
	N, Width   int
	Checked    bool
}

type rowView struct {
	Day                                       string
	Published, HM, URL, Title, Source, Reason string
}

type spikedResults struct {
	Filtered bool
	N        int
	Capped   bool
	Rows     []rowView
}

type spikedView struct {
	Dropped, Total, NoisePct, Pending int
	Q                                 string
	Buckets                           []bucketView
	Results                           spikedResults
}

const spikedCap = 150

func (s *Server) spikedPage(c *club.Club, st *wire.State, now time.Time, q, bucket string) *page {
	p := s.basePage(c, st, now, "Spiked · "+c.App(), "spiked")
	p.H1, p.Em = "", "Spiked"
	if st == nil {
		return p
	}
	var dropped []*wire.Item
	for _, it := range st.Items {
		if it.Status == wire.Dropped && !it.Published.After(now) {
			dropped = append(dropped, it)
		}
	}
	sort.SliceStable(dropped, func(i, j int) bool { return dropped[i].Published.After(dropped[j].Published) })
	if _, ok := kindLabel[bucket]; !ok {
		bucket = ""
	}
	q = strings.TrimSpace(q)
	v := &spikedView{Dropped: len(dropped), Pending: st.Count(wire.Pending), Q: q}
	v.Total = len(st.Items) - v.Pending
	if v.Total > 0 {
		v.NoisePct = int(math.Round(float64(len(dropped)) / float64(v.Total) * 100))
	}
	tally := map[string]int{}
	var order []string
	for _, d := range dropped {
		k := kindOf(d)
		if tally[k] == 0 {
			order = append(order, k)
		}
		tally[k]++
	}
	most := 1
	for _, n := range tally {
		most = max(most, n)
	}
	sort.SliceStable(order, func(i, j int) bool { return tally[order[i]] > tally[order[j]] })
	v.Buckets = append(v.Buckets, bucketView{Key: "", Label: "Any reason", N: len(dropped), Width: 100, Checked: bucket == ""})
	for _, k := range order {
		v.Buckets = append(v.Buckets, bucketView{Key: k, Label: kindName(c, k), N: tally[k], Width: int(math.Round(float64(tally[k]) / float64(most) * 100)), Checked: k == bucket})
	}
	v.Results = results(dropped, q, bucket, now)
	p.Data = v
	return p
}

// results is the list under the filter, and the fragment the search form swaps in.
func results(dropped []*wire.Item, q, bucket string, now time.Time) spikedResults {
	t := strings.ToLower(q)
	r := spikedResults{Filtered: t != "" || bucket != ""}
	last := ""
	for _, d := range dropped {
		if (bucket != "" && kindOf(d) != bucket) || (t != "" && !strings.Contains(strings.ToLower(d.Title+" "+d.Source+" "+d.Reason), t)) {
			continue
		}
		r.N++
		if r.N > spikedCap {
			r.Capped = true
			continue
		}
		if day := dayLabel(d.Published, now); day != last {
			r.Rows = append(r.Rows, rowView{Day: day})
			last = day
		}
		r.Rows = append(r.Rows, rowView{Published: iso(d.Published), HM: hm(d.Published), URL: safeURL(d.URL), Title: d.Title,
			Source: shortName(d.Source), Reason: orDefault(d.Reason, "No reason given")})
	}
	return r
}
