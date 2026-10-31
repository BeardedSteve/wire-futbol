// Package club holds the per-club configuration that drives every page and poll, and resolves a request's Host to a club.
package club

import (
	"crypto/sha1"
	"encoding/hex"
	"encoding/json"
	"net"
	"strings"
	"time"
)

// Kind says how a source is read.
type Kind int

const (
	RSS      Kind = iota // RSS 2.0 or Atom feed
	ClubSite             // a club website's news index, then each new article page
)

// Source is one outlet. A source listed by several clubs is fetched once per run and its items go to each of them.
type Source struct {
	Key         string // stable id, used for source health in the state file
	Name        string // display name, stored on every item
	Short       string // name on story cards
	Kind        Kind
	URL         string
	Timeout     time.Duration   // per request; zero means the fetch client's default
	Retry       []time.Duration // ClubSite only: waits before each retry of the news index; nil means the fetch client's default
	SiteBase    string          // ClubSite only: origin that news paths are relative to
	TitleSuffix string          // ClubSite only: trimmed from og:title
}

// Channel is a YouTube channel whose Shorts appear on the Shorts page.
type Channel struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

// Colours are the club accent in light and dark themes.
type Colours struct {
	Accent, AccentText, AccentWash             string
	AccentDark, AccentTextDark, AccentWashDark string
}

// Prompt fills the club-specific parts of the filter's instructions.
type Prompt struct {
	Outlets       string // "liverpoolfc.com, Sky Sports, BBC Sport, Liverpool Echo, The Athletic"
	Journalists   string // examples of first-hand reporting
	Example       string // a model summary sentence
	OutletExample string // an outlet for the "never describe the article" example, e.g. "The Echo"
	Manager       string // a manager name for the same example
}

// Club is everything that differs between clubs.
type Club struct {
	Slug        string   // storage prefix and URL-safe id
	Name        string   // "Liverpool FC"
	Short       string   // "Liverpool", as used in prose and prompts
	Mark        string   // "LFC", the header badge; the app is called "<Mark> Wire"
	Hosts       []string // hostnames served for this club
	Enabled     bool
	Official    string // key of the club's own site among Sources
	Sources     []string
	ReadsLine   string // footer: which outlets the wire reads
	BBCTeam     string // BBC Sport team slug: its fixtures page gives cup and European ties
	FixtureName string // the club's name as it appears in fixture data
	FPLTeam     string // Fantasy Premier League team short name
	Shorts      []Channel
	Colours     Colours
	Prompt      Prompt
}

// App is the product name for this club.
func (c *Club) App() string { return c.Mark + " Wire" }

// OfficialName is the display name of the club's own site.
func (c *Club) OfficialName() string { return Sources[c.Official].Name }

// SourceList returns the club's sources in configured order.
func (c *Club) SourceList() []Source {
	out := make([]Source, 0, len(c.Sources))
	for _, k := range c.Sources {
		out = append(out, Sources[k])
	}
	return out
}

// Fingerprint changes whenever what a poll reads for the club changes: a source added, removed or pointed
// elsewhere, or a new BBC team page. The poller stores it with the club's state to spot a deploy that needs a run.
func (c *Club) Fingerprint() string {
	b, _ := json.Marshal(struct {
		Sources               []Source
		Fixtures, FixtureName string
	}{c.SourceList(), c.BBCTeam, c.FixtureName})
	h := sha1.Sum(b)
	return hex.EncodeToString(h[:])[:12]
}

// Enabled returns the clubs that are switched on.
func Enabled() []*Club {
	var out []*Club
	for i := range Clubs {
		if Clubs[i].Enabled {
			out = append(out, &Clubs[i])
		}
	}
	return out
}

// BySlug finds an enabled club.
func BySlug(slug string) *Club {
	for _, c := range Enabled() {
		if c.Slug == slug {
			return c
		}
	}
	return nil
}

// Enable switches on the listed clubs, from ENABLE_CLUBS, so staging can serve and poll clubs that are off in production.
// It returns the slugs it doesn't know.
func Enable(slugs []string) (unknown []string) {
	for _, slug := range slugs {
		slug = strings.TrimSpace(slug)
		found := false
		for i := range Clubs {
			if Clubs[i].Slug == slug {
				Clubs[i].Enabled, found = true, true
			}
		}
		if !found {
			unknown = append(unknown, slug)
		}
	}
	return unknown
}

// Resolver maps a Host header to a club.
type Resolver struct {
	Default string // slug served on hosts outside wire.futbol, such as a railway.app domain or localhost
}

// Resolve returns the club for host, or nil. Unknown or disabled *.wire.futbol hosts never fall back to the default,
// so a typo'd subdomain can't show another club's wire.
func (r Resolver) Resolve(host string) *Club {
	host = strings.ToLower(strings.TrimSuffix(stripPort(host), "."))
	for _, c := range Enabled() {
		for _, h := range c.Hosts {
			if h == host {
				return c
			}
		}
	}
	if host == "wire.futbol" || strings.HasSuffix(host, ".wire.futbol") || r.Default == "" {
		return nil
	}
	return BySlug(r.Default)
}

// Pickable says whether a visitor may choose the club on this host with ?club=. Only hosts outside wire.futbol,
// such as a railway.app domain or localhost, so staging can show every club on one address.
func Pickable(host string) bool {
	host = strings.ToLower(strings.TrimSuffix(stripPort(host), "."))
	return host != "wire.futbol" && !strings.HasSuffix(host, ".wire.futbol")
}

func stripPort(h string) string {
	if host, _, err := net.SplitHostPort(h); err == nil {
		return host
	}
	return h
}
