// Command parity compares what the old and new wires surfaced over the same period and prints a Markdown report.
//
//	go run ./cmd/parity -old https://.../api/state.json -new https://.../api/state.json -since 2026-10-23T15:00:00Z
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"net/http"
	"os"
	"sort"
	"strings"
	"time"

	"github.com/BeardedSteve/wire-futbol/internal/wire"
)

func load(url string) (*wire.State, error) {
	c := &http.Client{Timeout: 30 * time.Second}
	r, err := c.Get(url)
	if err != nil {
		return nil, err
	}
	defer r.Body.Close()
	if r.StatusCode != 200 {
		return nil, fmt.Errorf("%s: HTTP %d", url, r.StatusCode)
	}
	b, err := io.ReadAll(io.LimitReader(r.Body, 64<<20))
	if err != nil {
		return nil, err
	}
	var st wire.State
	if err := json.Unmarshal(b, &st); err != nil {
		return nil, fmt.Errorf("%s: %w", url, err)
	}
	return st.Init(), nil
}

// window is every item either side fetched in [since, until), by URL.
func window(st *wire.State, since, until time.Time) map[string]*wire.Item {
	out := map[string]*wire.Item{}
	for _, it := range st.Items {
		if !it.Fetched.Before(since) && it.Fetched.Before(until) {
			out[it.URL] = it
		}
	}
	return out
}

func byURL(st *wire.State) map[string]*wire.Item {
	out := map[string]*wire.Item{}
	for _, it := range st.Items {
		out[it.URL] = it
	}
	return out
}

func main() {
	oldURL := flag.String("old", "", "old wire state.json URL")
	newURL := flag.String("new", "", "new wire state.json URL")
	sinceS := flag.String("since", "", "start of the comparison, RFC 3339")
	untilS := flag.String("until", "", "end of the comparison, RFC 3339 (default: the older of the two last runs)")
	flag.Parse()
	since, err := time.Parse(time.RFC3339, *sinceS)
	if err != nil || *oldURL == "" || *newURL == "" {
		fmt.Fprintln(os.Stderr, "usage: parity -old URL -new URL -since RFC3339 [-until RFC3339]")
		os.Exit(2)
	}
	o, err := load(*oldURL)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	n, err := load(*newURL)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	until := o.LastRun
	if n.LastRun.Before(until) {
		until = n.LastRun
	}
	if *untilS != "" {
		if until, err = time.Parse(time.RFC3339, *untilS); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(2)
		}
	}
	report(os.Stdout, o, n, since, until)
}

func report(w io.Writer, o, n *wire.State, since, until time.Time) {
	ow, nw := window(o, since, until), window(n, since, until)
	oAll, nAll := byURL(o), byURL(n)
	urls := map[string]bool{}
	for u := range ow {
		urls[u] = true
	}
	for u := range nw {
		urls[u] = true
	}
	var both, onlyOld, onlyNew, agree, disagree []string
	for u := range urls {
		a, b := oAll[u], nAll[u]
		switch {
		case a == nil:
			onlyNew = append(onlyNew, u)
		case b == nil:
			onlyOld = append(onlyOld, u)
		default:
			both = append(both, u)
			if a.Status == wire.Pending || b.Status == wire.Pending {
				continue
			}
			if a.Status == b.Status {
				agree = append(agree, u)
			} else {
				disagree = append(disagree, u)
			}
		}
	}
	for _, l := range [][]string{onlyOld, onlyNew, disagree} {
		sort.Strings(l)
	}
	count := func(m map[string]*wire.Item, st wire.Status) int {
		c := 0
		for _, it := range m {
			if it.Status == st {
				c++
			}
		}
		return c
	}
	stories := func(st *wire.State) int {
		c := 0
		for _, s := range st.Stories("liverpoolfc.com") {
			if !s.Latest.Before(since) && s.Latest.Before(until) {
				c++
			}
		}
		return c
	}
	f := func(t time.Time) string { return t.UTC().Format("2006-01-02 15:04 UTC") }
	fmt.Fprintf(w, "# Parity report\n\nWindow: %s to %s (%.1f hours). Items are matched by URL and counted when either wire fetched them in the window.\n\n", f(since), f(until), until.Sub(since).Hours())
	fmt.Fprintf(w, "| | Old (Bun, production) | New (Go, staging) |\n|---|---|---|\n")
	fmt.Fprintf(w, "| Items fetched | %d | %d |\n| Kept | %d | %d |\n| Dropped | %d | %d |\n| Still pending | %d | %d |\n| Stories with news in the window | %d | %d |\n\n",
		len(ow), len(nw), count(ow, wire.Kept), count(nw, wire.Kept), count(ow, wire.Dropped), count(nw, wire.Dropped), count(ow, wire.Pending), count(nw, wire.Pending), stories(o), stories(n))
	fmt.Fprintf(w, "Seen by both: %d. Same verdict: %d. Different verdict: %d. Only old: %d. Only new: %d.\n\n", len(both), len(agree), len(disagree), len(onlyOld), len(onlyNew))

	fmt.Fprintf(w, "## Source health at the end\n\n| Source | Old fails, last count | New fails, last count |\n|---|---|---|\n")
	keys := map[string]bool{}
	for k := range o.Health {
		keys[k] = true
	}
	for k := range n.Health {
		keys[k] = true
	}
	var ks []string
	for k := range keys {
		ks = append(ks, k)
	}
	sort.Strings(ks)
	h := func(x *wire.Health) string {
		if x == nil {
			return "never read"
		}
		return fmt.Sprintf("%d, %d", x.Fails, x.LastCount)
	}
	for _, k := range ks {
		fmt.Fprintf(w, "| %s | %s | %s |\n", k, h(o.Health[k]), h(n.Health[k]))
	}

	item := func(it *wire.Item) string {
		return fmt.Sprintf("%s, %s, published %s", it.Source, strings.ReplaceAll(it.Title, "|", "/"), f(it.Published))
	}
	section := func(title string, list []string, pick map[string]*wire.Item) {
		if len(list) == 0 {
			return
		}
		fmt.Fprintf(w, "\n## %s (%d)\n\n", title, len(list))
		for _, u := range list {
			it := pick[u]
			fmt.Fprintf(w, "- %s: %s\n", it.Status, item(it))
		}
	}
	if len(disagree) > 0 {
		fmt.Fprintf(w, "\n## Different verdicts (%d)\n\n| Article | Old | New |\n|---|---|---|\n", len(disagree))
		v := func(it *wire.Item) string {
			if it.Status == wire.Kept {
				return "kept: " + strings.ReplaceAll(it.Summary, "|", "/")
			}
			return "dropped: " + it.Reason
		}
		for _, u := range disagree {
			fmt.Fprintf(w, "| %s | %s | %s |\n", item(oAll[u]), v(oAll[u]), v(nAll[u]))
		}
	}
	section("Only in old", onlyOld, oAll)
	section("Only in new", onlyNew, nAll)
}
