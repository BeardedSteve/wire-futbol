package wire

import (
	"regexp"
	"sort"
	"strings"
	"time"
)

// Group is a filter chip on the wire.
type Group string

const (
	Fitness   Group = "fitness"
	Transfers Group = "transfers"
	Results   Group = "results"
	ClubNews  Group = "club"
)

// Category is how a kept item is labelled.
type Category struct {
	Label string
	Group Group
}

var categories = map[string]Category{
	"injury": {"Injury", Fitness}, "team-news": {"Team news", Fitness},
	"transfer": {"Transfer", Transfers}, "contract": {"Contract", Transfers},
	"result": {"Result", Results},
	"staff":  {"Staff", ClubNews}, "business": {"Business", ClubNews}, "regulation": {"Regulation", ClubNews}, "other": {"Club", ClubNews},
}

// Cat looks up a category, falling back to general club news.
func Cat(c string) Category {
	if v, ok := categories[c]; ok {
		return v
	}
	return categories["other"]
}

// Groups are the chips in display order.
var Groups = []struct {
	Key   string
	Label string
}{{"all", "All"}, {"fitness", "Fitness"}, {"transfers", "Transfers"}, {"results", "Results"}, {"club", "Club"}}

// Story is one card: every kept report of the same news.
type Story struct {
	ID       string
	Items    []*Item // newest first
	Lead     *Item
	Latest   time.Time
	First    time.Time
	Group    Group
	Official bool
	Material bool
	Pushed   bool
	Fetched  time.Time
}

var stop = map[string]bool{}

func init() {
	for _, w := range strings.Fields("a an the and or of to in on at for by with from as is are was were be been has have had will would that this it its his their they he she not but after before over into than then about against ahead up out off club confirms reports says said report") {
		stop[w] = true
	}
}

var nonWord = regexp.MustCompile(`[^a-z0-9\s']`)

func words(t string) map[string]bool {
	out := map[string]bool{}
	for _, w := range strings.Fields(nonWord.ReplaceAllString(strings.ToLower(t), " ")) {
		if len(w) > 2 && !stop[w] {
			out[w] = true
		}
	}
	return out
}

func text(it *Item) string {
	if it.Summary != "" {
		return it.Summary
	}
	return it.Title
}

func newest(items []*Item) time.Time {
	var t time.Time
	for _, x := range items {
		if x.Published.After(t) {
			t = x.Published
		}
	}
	return t
}

// similar is the safety net for the model's clustering: two groups within 36 hours whose summaries share at least
// four significant words, and at least 60% of the smaller set.
func similar(a, b []*Item) bool {
	d := newest(a).Sub(newest(b))
	if d < 0 {
		d = -d
	}
	if d > 36*time.Hour {
		return false
	}
	for _, x := range a {
		A := words(text(x))
		for _, y := range b {
			B := words(text(y))
			n := 0
			for w := range A {
				if B[w] {
					n++
				}
			}
			small := min(len(A), len(B))
			if n >= 4 && float64(n)/float64(small) >= 0.6 {
				return true
			}
		}
	}
	return false
}

// Stories groups kept items into cards, newest first. official is the display name of the club's own site.
func (s *State) Stories(official string) []*Story {
	by := map[string][]*Item{}
	var keys []string
	for _, it := range s.Items {
		if it.Status != Kept {
			continue
		}
		k := it.Cluster
		if k == "" {
			k = it.ID
		}
		if _, ok := by[k]; !ok {
			keys = append(keys, k)
		}
		by[k] = append(by[k], it)
	}
	for i := 0; i < len(keys); i++ {
		for j := i + 1; j < len(keys); j++ {
			a, b := by[keys[i]], by[keys[j]]
			if a != nil && b != nil && similar(a, b) {
				by[keys[i]] = append(a, b...)
				delete(by, keys[j])
			}
		}
	}
	var out []*Story
	for _, id := range keys {
		g, ok := by[id]
		if !ok {
			continue
		}
		items := append([]*Item(nil), g...)
		sort.SliceStable(items, func(i, j int) bool { return items[i].Published.After(items[j].Published) })
		// The club's own report leads when it is within 12 hours of the latest word; otherwise the newest leads.
		lead := items[0]
		for _, x := range items {
			if x.Source == official {
				if items[0].Published.Sub(x.Published) < 12*time.Hour {
					lead = x
				}
				break
			}
		}
		st := &Story{ID: id, Items: items, Lead: lead, Latest: items[0].Published, First: items[len(items)-1].Published, Group: Cat(lead.Category).Group, Fetched: items[0].Fetched}
		for _, x := range items {
			st.Official = st.Official || x.Source == official
			st.Material = st.Material || x.Material
			st.Pushed = st.Pushed || x.Pushed
			if x.Fetched.After(st.Fetched) {
				st.Fetched = x.Fetched
			}
		}
		out = append(out, st)
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].Latest.After(out[j].Latest) })
	return out
}
