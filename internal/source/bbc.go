package source

import (
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"time"
)

// Fixture is one cup or European tie. League matches come from FPL, which is the record for every club.
type Fixture struct {
	Start       time.Time `json:"start"`
	Home        string    `json:"home"`
	Away        string    `json:"away"`
	URL         string    `json:"url,omitempty"`
	Competition string    `json:"competition,omitempty"`
}

// BBCBase is BBC Sport's origin. Tests point it at a fake.
var BBCBase = "https://www.bbc.co.uk"

// BBCFixturesURL is a BBC Sport team's fixtures and results page for one month. Every club has one, and it lists
// every competition the club plays in.
func BBCFixturesURL(team string, month time.Time) string {
	return fmt.Sprintf("%s/sport/football/teams/%s/scores-fixtures/%s", BBCBase, team, month.Format("2006-01"))
}

// The page carries its data as a JSON string assigned to window.__INITIAL_DATA__.
var bbcDataRe = regexp.MustCompile(`window\.__INITIAL_DATA__\s*=\s*("(?:[^"\\]|\\.)*")`)

type bbcTeam struct {
	ShortName string `json:"shortName"`
	URN       string `json:"urn"`
}

type bbcEvent struct {
	Home          bbcTeam `json:"home"`
	Away          bbcTeam `json:"away"`
	StartDateTime string  `json:"startDateTime"`
	Link          string  `json:"onwardJourneyLink"`
	Tournament    struct {
		Name string `json:"name"`
		URN  string `json:"urn"`
	} `json:"tournament"`
}

type bbcModule struct {
	Name string `json:"name"`
	Data struct {
		EventGroups []struct {
			SecondaryGroups []struct {
				Events []bbcEvent `json:"events"`
			} `json:"secondaryGroups"`
		} `json:"eventGroups"`
	} `json:"data"`
}

// ParseBBCFixtures reads team's BBC Sport fixtures page and returns its matches outside the Premier League. The
// team is called name and opponents go by BBC's short names ("Man Utd"), as FPL names them. A month with none is
// an empty list. An error means the page no longer looks like a fixtures page.
func ParseBBCFixtures(page []byte, team, name string) ([]Fixture, error) {
	m := bbcDataRe.FindSubmatch(page)
	if m == nil {
		return nil, errors.New("bbc fixtures: no __INITIAL_DATA__")
	}
	var inner string
	if err := json.Unmarshal(m[1], &inner); err != nil {
		return nil, fmt.Errorf("bbc fixtures: %w", err)
	}
	var doc struct {
		Data map[string]bbcModule `json:"data"`
	}
	if err := json.Unmarshal([]byte(inner), &doc); err != nil {
		return nil, fmt.Errorf("bbc fixtures: %w", err)
	}
	found := false
	out := []Fixture{}
	for _, mod := range doc.Data {
		if mod.Name != "sport-data-scores-fixtures" {
			continue
		}
		found = true
		for _, g := range mod.Data.EventGroups {
			for _, sg := range g.SecondaryGroups {
				for _, e := range sg.Events {
					start, err := time.Parse(time.RFC3339, e.StartDateTime)
					if err != nil || strings.HasSuffix(e.Tournament.URN, ":premier-league") {
						continue
					}
					f := Fixture{Start: start, Home: side(e.Home, team, name), Away: side(e.Away, team, name), Competition: competition(e.Tournament.Name)}
					if strings.HasPrefix(e.Link, "/sport/") {
						f.URL = "https://www.bbc.co.uk" + e.Link
					}
					out = append(out, f)
				}
			}
		}
	}
	if !found {
		return nil, errors.New("bbc fixtures: no scores-fixtures data")
	}
	return out, nil
}

func side(t bbcTeam, team, name string) string {
	if strings.HasSuffix(t.URN, ":team:"+team) {
		return name
	}
	return Clean(t.ShortName)
}

// competition is the name a fan uses: "UEFA Champions League" reads as "Champions League", the League Cup by its
// sponsor's name.
func competition(name string) string {
	switch name {
	case "League Cup":
		return "Carabao Cup"
	case "UEFA Europa Conference League":
		return "Conference League"
	}
	return strings.TrimPrefix(name, "UEFA ")
}
