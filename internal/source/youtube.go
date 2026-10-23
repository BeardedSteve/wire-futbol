package source

import (
	"bytes"
	"encoding/xml"
	"regexp"
	"time"
)

// Short is one YouTube Short.
type Short struct {
	ID        string    `json:"id"`
	Title     string    `json:"title"`
	Channel   string    `json:"channel"`
	Published time.Time `json:"published"`
}

var videoIDRe = regexp.MustCompile(`^[A-Za-z0-9_-]{6,20}$`)

type ytFeed struct {
	Entries []struct {
		VideoID   string `xml:"http://www.youtube.com/xml/schemas/2015 videoId"`
		Title     string `xml:"title"`
		Published string `xml:"published"`
	} `xml:"entry"`
}

// ShortsFeedURL is a channel's Shorts playlist feed: the channel id with UC replaced by UUSH.
func ShortsFeedURL(channelID string) string {
	id := channelID
	if len(id) > 2 && id[:2] == "UC" {
		id = id[2:]
	}
	return "https://www.youtube.com/feeds/videos.xml?playlist_id=UUSH" + id
}

// ParseShorts reads a YouTube Atom feed. Entries with a malformed video id or date are skipped.
func ParseShorts(data []byte, channel string) ([]Short, error) {
	d := xml.NewDecoder(bytes.NewReader(data))
	d.Strict = false
	d.CharsetReader = charsetReader
	var f ytFeed
	if err := d.Decode(&f); err != nil {
		return nil, err
	}
	var out []Short
	for _, e := range f.Entries {
		pub, ok := ParseDate(e.Published)
		if !ok || !videoIDRe.MatchString(e.VideoID) {
			continue
		}
		title := Clean(e.Title)
		if title == "" {
			title = "Untitled"
		}
		out = append(out, Short{ID: e.VideoID, Title: title, Channel: channel, Published: pub})
	}
	return out, nil
}
