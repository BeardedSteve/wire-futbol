package source

import (
	"os"
	"slices"
	"testing"
	"time"
)

var now = time.Date(2026, 10, 23, 12, 0, 0, 0, time.UTC)

func TestParseRSS(t *testing.T) {
	feed := `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:atom="http://www.w3.org/2005/Atom"><channel>
<atom:link href="https://example.com/feed" rel="self"/>
<item><title><![CDATA[Isak &amp; Gakpo out for City game]]></title>
<link>https://www.bbc.co.uk/sport/football/articles/abc123?at_medium=RSS&amp;at_campaign=rss</link>
<description><![CDATA[<p>The pair have <b>hamstring</b> injuries.</p>]]></description>
<pubDate>Thu, 23 Oct 2026 09:15:00 GMT</pubDate></item>
<item><title>No link</title></item>
<item><title>Dated by dc</title><guid>https://example.com/b/</guid><dc:date>2026-10-22T08:00:00Z</dc:date></item>
<item><title>Bad date</title><link>https://example.com/c#top</link><pubDate>yesterday</pubDate></item>
</channel></rss>`
	got, err := ParseFeed([]byte(feed), now)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 3 {
		t.Fatalf("got %d items: %+v", len(got), got)
	}
	a := got[0]
	if a.URL != "https://www.bbc.co.uk/sport/football/articles/abc123" || a.Title != "Isak & Gakpo out for City game" || a.Standfirst != "The pair have hamstring injuries." {
		t.Errorf("first item %+v", a)
	}
	if !a.Published.Equal(time.Date(2026, 10, 23, 9, 15, 0, 0, time.UTC)) {
		t.Errorf("published %v", a.Published)
	}
	if got[1].URL != "https://example.com/b" || !got[1].Published.Equal(time.Date(2026, 10, 22, 8, 0, 0, 0, time.UTC)) {
		t.Errorf("dc item %+v", got[1])
	}
	if got[2].URL != "https://example.com/c" || !got[2].Published.Equal(now) {
		t.Errorf("undated item %+v", got[2])
	}
}

func TestParseAtomAndLimit(t *testing.T) {
	feed := `<feed xmlns="http://www.w3.org/2005/Atom">`
	for i := 0; i < 45; i++ {
		feed += `<entry><title type="html">Story</title><link rel="alternate" href="https://example.com/s` + string(rune('a'+i%26)) + `"/><summary>s</summary><published>2026-10-23T08:00:00+01:00</published></entry>`
	}
	feed += `</feed>`
	got, err := ParseFeed([]byte(feed), now)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 40 || got[0].URL != "https://example.com/sa" || !got[0].Published.Equal(time.Date(2026, 10, 23, 7, 0, 0, 0, time.UTC)) {
		t.Fatalf("atom: %d items, first %+v", len(got), got[0])
	}
}

func TestParseFeedRejectsGarbage(t *testing.T) {
	got, err := ParseFeed([]byte("<html><body>The game is being updated</body></html>"), now)
	if err != nil {
		return
	}
	if len(got) != 0 {
		t.Fatalf("html parsed as %d items", len(got))
	}
}

func TestClubSiteArticle(t *testing.T) {
	index := []byte(`<a href="/news/ekitike-returns-training">x</a><a href="/news/ekitike-returns-training">dup</a><a href="/news/Upper-Case">no</a><a href="/news/cup-draw-confirmed">y</a><a href="/matches">z</a>`)
	links := NewsLinks(index, "https://www.liverpoolfc.com")
	if len(links) != 2 || links[0] != "https://www.liverpoolfc.com/news/ekitike-returns-training" {
		t.Fatalf("links %v", links)
	}
	page := []byte(`<html><head><meta property="og:title" content="Ekitik&eacute; returns to training - Liverpool FC">
<meta name="og:description" content="The striker &amp; Bradley trained on Thursday.">
<script type="application/ld+json">{"@type":"NewsArticle","datePublished":"2026-10-23T10:30:00.000Z"}</script></head></html>`)
	r, ok := ParseArticle(page, links[0], " - Liverpool FC", now)
	if !ok || r.Title != "Ekitiké returns to training" || r.Standfirst != "The striker & Bradley trained on Thursday." || !r.Published.Equal(time.Date(2026, 10, 23, 10, 30, 0, 0, time.UTC)) {
		t.Fatalf("article %+v", r)
	}
	if _, ok := ParseArticle([]byte("<html></html>"), links[0], "", now); ok {
		t.Fatal("page without a title accepted")
	}
}

func TestClubSiteDatedLinks(t *testing.T) {
	index := []byte(`<a href="/news/2026/october/24/report-aston-villa-2-1-man-city">x</a><a href="https://www.avfc.co.uk/news/2026/october/24/report-aston-villa-2-1-man-city">dup</a><a href="https://www.avfc.co.uk/news/2026/october/26/emery-press-conference">y</a><a href="https://example.com/news/elsewhere">no</a><a href="/news/2026/october">no</a>`)
	got := NewsLinks(index, "https://www.avfc.co.uk")
	want := []string{"https://www.avfc.co.uk/news/2026/october/24/report-aston-villa-2-1-man-city", "https://www.avfc.co.uk/news/2026/october/26/emery-press-conference"}
	if !slices.Equal(got, want) {
		t.Fatalf("links %v", got)
	}
}

func TestClubSiteIDLinks(t *testing.T) {
	index := []byte(`<a href="/news/every-word-from-artetas-post-everton-press-conference-a35Bj5F4a2lz">x</a><a href="/news/Upper-Case">no</a>`)
	got := NewsLinks(index, "https://www.arsenal.com")
	want := []string{"https://www.arsenal.com/news/every-word-from-artetas-post-everton-press-conference-a35Bj5F4a2lz"}
	if !slices.Equal(got, want) {
		t.Fatalf("links %v", got)
	}
}

func TestParseFixtures(t *testing.T) {
	page := []byte(`<script type="application/ld+json">{"@type":"ItemList","itemListElement":[
{"@type":"SportsEvent","startDate":"2026-11-01T15:00:00Z","url":"https://www.liverpoolfc.com/matches/2026-27/premier-league/x","homeTeam":{"name":"Liverpool"},"awayTeam":{"name":"Aston Villa"},"location":{"name":"Anfield"}},
{"@type":"SportsEvent","startDate":"2026-10-23T10:00:00Z","url":"https://www.liverpoolfc.com/matches/2026-27/champions-league/y","homeTeam":{"name":"Real Madrid"},"awayTeam":{"name":"Liverpool"},"location":{"name":"Bernabeu"}},
{"@type":"SportsEvent","startDate":"2026-10-01T10:00:00Z","url":"old"},
{"@type":"Thing","startDate":"2026-12-01T10:00:00Z"}]}</script>
<script type="application/ld+json">not json</script>`)
	got := ParseFixtures(page, now)
	if len(got) != 2 {
		t.Fatalf("fixtures %+v", got)
	}
	if got[0].Home != "Real Madrid" || got[0].Competition != "Champions League" || got[1].Competition != "Premier League" || got[1].Venue != "Anfield" {
		t.Fatalf("fixtures %+v", got)
	}
}

func TestParseShortsFromRealFeed(t *testing.T) {
	b, err := os.ReadFile("../../testdata/youtube-shorts.xml")
	if err != nil {
		t.Fatal(err)
	}
	got, err := ParseShorts(b, "Liverpool FC")
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 15 {
		t.Fatalf("got %d shorts", len(got))
	}
	if got[0].ID != "-WCVS9SHw3E" || got[0].Title != "Iraola & Isak's reaction 😍" || got[0].Channel != "Liverpool FC" {
		t.Fatalf("first %+v", got[0])
	}
	if ShortsFeedURL("UC9LQwHZoucFT94I2h6JOcjw") != "https://www.youtube.com/feeds/videos.xml?playlist_id=UUSH9LQwHZoucFT94I2h6JOcjw" {
		t.Fatal("feed url")
	}
}

func TestNormURL(t *testing.T) {
	for in, want := range map[string]string{
		"https://www.skysports.com/football/news/11669/1/story-x?utm=rss#c": "https://www.skysports.com/football/news/11669/1/story-x",
		"https://example.com/a/":  "https://example.com/a",
		"not a url":               "not a url",
		" https://example.com/b ": "https://example.com/b",
	} {
		if got := NormURL(in); got != want {
			t.Errorf("NormURL(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestParseDate(t *testing.T) {
	cases := []struct {
		in   string
		want string
	}{
		{"Fri, 23 Oct 2026 14:15:00 +0100", "2026-10-23T13:15:00Z"},
		{"Fri, 23 Oct 2026 13:15:00 GMT", "2026-10-23T13:15:00Z"},
		{"Fri, 23 Oct 2026 13:15:00 UTC", "2026-10-23T13:15:00Z"},
		{"2026-10-23T14:15:00+01:00", "2026-10-23T13:15:00Z"},
		{"2026-10-23T13:15:00Z", "2026-10-23T13:15:00Z"},
		{"Fri, 23 Oct 2026 14:15:00 BST", "2026-10-23T13:15:00Z"},
		{"Fri, 23 Oct 2026 14:15:00 CEST", ""},
		{"yesterday", ""},
	}
	for _, c := range cases {
		got, ok := ParseDate(c.in)
		if c.want == "" {
			if ok {
				t.Errorf("ParseDate(%q) = %v, want unparseable", c.in, got)
			}
			continue
		}
		if !ok || got.Format(time.RFC3339) != c.want {
			t.Errorf("ParseDate(%q) = %v %v, want %s", c.in, got, ok, c.want)
		}
	}
}
