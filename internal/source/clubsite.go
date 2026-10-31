package source

import (
	"context"
	"fmt"
	"log/slog"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/BeardedSteve/wire-futbol/internal/club"
	"github.com/BeardedSteve/wire-futbol/internal/fetch"
)

var (
	// newsPathRe takes /news/<slug> (liverpoolfc.com), /news/<yyyy>/<month>/<d>/<slug> (avfc.co.uk) and /news/<slug>-<mixed-case id>
	// (arsenal.com), relative or on the site's own origin.
	newsPathRe  = `href="(?:%s)?(/news/(?:\d{4}/[a-z]+/\d{1,2}/)?[a-z0-9-]+(?:-[A-Za-z0-9]{12})?)"`
	datePubRe   = regexp.MustCompile(`"datePublished":"([^"]+)"`)
	metaContent = func(name string) *regexp.Regexp {
		return regexp.MustCompile(`<meta (?:property|name)="` + regexp.QuoteMeta(name) + `" content="([^"]*)"`)
	}
	ogTitleRe = metaContent("og:title")
	ogDescRe  = metaContent("og:description")
)

// NewsLinks lists article URLs on a club news index, in page order, without duplicates.
func NewsLinks(index []byte, base string) []string {
	seen := map[string]bool{}
	var out []string
	re := regexp.MustCompile(fmt.Sprintf(newsPathRe, regexp.QuoteMeta(base)))
	for _, m := range re.FindAllSubmatch(index, -1) {
		u := base + string(m[1])
		if !seen[u] {
			seen[u] = true
			out = append(out, u)
		}
	}
	return out
}

// ParseArticle reads an article page's Open Graph title and description and its schema.org publish date.
// ok is false when the page has no title.
func ParseArticle(page []byte, url, titleSuffix string, now time.Time) (Raw, bool) {
	meta := func(re *regexp.Regexp) string {
		if m := re.FindSubmatch(page); m != nil {
			return Clean(string(m[1]))
		}
		return ""
	}
	title := strings.TrimSuffix(meta(ogTitleRe), titleSuffix)
	if title == "" {
		return Raw{}, false
	}
	pub := now
	if m := datePubRe.FindSubmatch(page); m != nil {
		if t, ok := ParseDate(string(m[1])); ok {
			pub = t
		}
	}
	return Raw{URL: url, Title: title, Standfirst: Truncate(meta(ogDescRe), 400), Published: pub}, true
}

// FetchClubSite reads the news index and up to 15 articles not already known, four at a time.
// A failed article is logged and skipped; only a failed index fails the source.
func FetchClubSite(ctx context.Context, c *fetch.Client, s club.Source, known map[string]bool, now time.Time) ([]Raw, error) {
	index, err := c.Get(ctx, s.URL, fetch.AcceptFeed, s.Timeout)
	if err != nil {
		return nil, err
	}
	var fresh []string
	for _, u := range NewsLinks(index, s.SiteBase) {
		if !known[u] {
			fresh = append(fresh, u)
		}
		if len(fresh) == 15 {
			break
		}
	}
	results := make([]*Raw, len(fresh))
	sem := make(chan struct{}, 4)
	var wg sync.WaitGroup
	for i, u := range fresh {
		wg.Add(1)
		go func() {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()
			page, err := c.Get(ctx, u, fetch.AcceptFeed, s.Timeout)
			if err != nil {
				slog.Warn("article fetch failed", "source", s.Key, "url", u, "err", err)
				return
			}
			if r, ok := ParseArticle(page, u, s.TitleSuffix, now); ok {
				results[i] = &r
			}
		}()
	}
	wg.Wait()
	var out []Raw
	for _, r := range results {
		if r != nil {
			out = append(out, *r)
		}
	}
	return out, nil
}
