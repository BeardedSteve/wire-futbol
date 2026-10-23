// Package source reads each kind of source into raw items. Input is scraped and untrusted: parsers only extract
// plain text and URLs, and templates escape everything on output.
package source

import (
	"html"
	"net/url"
	"regexp"
	"strings"
	"time"
)

// Raw is one article as a source lists it.
type Raw struct {
	URL        string
	Title      string
	Standfirst string
	Published  time.Time
}

var (
	tagRe   = regexp.MustCompile(`<[^>]+>`)
	spaceRe = regexp.MustCompile(`\s+`)
)

// Clean turns feed text into one line of plain text: entities decoded, tags removed, whitespace collapsed.
func Clean(s string) string {
	s = html.UnescapeString(s)
	s = tagRe.ReplaceAllString(s, " ")
	return strings.TrimSpace(spaceRe.ReplaceAllString(s, " "))
}

// Truncate cuts s to at most n characters.
func Truncate(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n])
}

// NormURL drops the query and fragment and any trailing slash, so the same article from two links dedupes.
func NormURL(u string) string {
	x, err := url.Parse(strings.TrimSpace(u))
	if err != nil || x.Host == "" {
		return strings.TrimSpace(u)
	}
	x.RawQuery, x.Fragment, x.RawFragment = "", "", ""
	x.ForceQuery = false
	return strings.TrimSuffix(x.String(), "/")
}

var dateLayouts = []string{
	time.RFC1123Z, time.RFC1123, time.RFC3339Nano, time.RFC3339,
	"Mon, 2 Jan 2006 15:04:05 -0700", "Mon, 2 Jan 2006 15:04:05 MST", "2 Jan 2006 15:04:05 -0700",
	"Mon, 02 Jan 2006 15:04 -0700", "2006-01-02T15:04:05", "2006-01-02T15:04:05.000-0700", "2006-01-02T15:04:05-0700",
}

// ParseDate reads the date formats feeds use. ok is false when none fit.
func ParseDate(s string) (time.Time, bool) {
	s = strings.TrimSpace(s)
	for _, l := range dateLayouts {
		if t, err := time.Parse(l, s); err == nil {
			return t.UTC(), true
		}
	}
	return time.Time{}, false
}
