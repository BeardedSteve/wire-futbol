package source

import (
	"bytes"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"strings"
	"time"
)

type feedLink struct {
	Href string `xml:"href,attr"`
	Rel  string `xml:"rel,attr"`
	Text string `xml:",chardata"`
}

type feedItem struct {
	Title       string     `xml:"title"`
	Links       []feedLink `xml:"link"`
	GUID        string     `xml:"guid"`
	ID          string     `xml:"id"`
	Description string     `xml:"description"`
	Summary     string     `xml:"summary"`
	PubDate     string     `xml:"pubDate"`
	Published   string     `xml:"published"`
	Updated     string     `xml:"updated"`
	DCDate      string     `xml:"http://purl.org/dc/elements/1.1/ date"`
}

type feedDoc struct {
	Channel struct {
		Items []feedItem `xml:"item"`
	} `xml:"channel"`
	Entries []feedItem `xml:"entry"`
}

func (it feedItem) link() string {
	for _, l := range it.Links { // RSS: <link>url</link>
		if t := strings.TrimSpace(l.Text); t != "" {
			return t
		}
	}
	for _, l := range it.Links { // Atom: the alternate link, else the first
		if l.Href != "" && (l.Rel == "" || l.Rel == "alternate") {
			return l.Href
		}
	}
	if len(it.Links) > 0 && it.Links[0].Href != "" {
		return it.Links[0].Href
	}
	if it.GUID != "" {
		return it.GUID
	}
	return it.ID
}

func firstNonEmpty(v ...string) string {
	for _, s := range v {
		if strings.TrimSpace(s) != "" {
			return s
		}
	}
	return ""
}

// ParseFeed reads an RSS 2.0 or Atom document: the first 40 items with a link and a title.
// Items without a parseable date are stamped now.
func ParseFeed(data []byte, now time.Time) ([]Raw, error) {
	d := xml.NewDecoder(bytes.NewReader(data))
	d.Strict = false
	d.Entity = xml.HTMLEntity
	d.CharsetReader = charsetReader
	var doc feedDoc
	if err := d.Decode(&doc); err != nil {
		return nil, fmt.Errorf("feed: %w", err)
	}
	items := doc.Channel.Items
	if len(items) == 0 {
		items = doc.Entries
	}
	if len(items) > 40 {
		items = items[:40]
	}
	out := make([]Raw, 0, len(items))
	for _, it := range items {
		pub, ok := ParseDate(firstNonEmpty(it.PubDate, it.Published, it.Updated, it.DCDate))
		if !ok {
			pub = now
		}
		r := Raw{
			URL:        NormURL(it.link()),
			Title:      Clean(it.Title),
			Standfirst: Truncate(Clean(firstNonEmpty(it.Description, it.Summary)), 400),
			Published:  pub,
		}
		if r.URL != "" && r.Title != "" {
			out = append(out, r)
		}
	}
	return out, nil
}

// charsetReader accepts UTF-8 and Latin-1 feeds. Other encodings are refused rather than garbled.
func charsetReader(label string, in io.Reader) (io.Reader, error) {
	switch strings.ToLower(label) {
	case "utf-8", "utf8", "us-ascii", "ascii":
		return in, nil
	case "iso-8859-1", "latin1", "latin-1", "windows-1252":
		b, err := io.ReadAll(in)
		if err != nil {
			return nil, err
		}
		r := make([]rune, len(b))
		for i, c := range b {
			r[i] = rune(c)
		}
		return strings.NewReader(string(r)), nil
	}
	return nil, errors.New("unsupported charset " + label)
}
