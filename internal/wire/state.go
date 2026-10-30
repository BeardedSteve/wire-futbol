// Package wire holds one club's wire state (the items each run has read and the filter's verdicts) and turns it
// into stories.
package wire

import (
	"crypto/sha1"
	"encoding/hex"
	"time"

	"github.com/BeardedSteve/wire-futbol/internal/source"
)

// London is the wire's clock for days, quiet hours and display.
var London = mustLoad("Europe/London")

func mustLoad(name string) *time.Location {
	l, err := time.LoadLocation(name)
	if err != nil {
		panic(err)
	}
	return l
}

// Status is the filter's verdict on an item.
type Status string

const (
	Pending Status = "pending"
	Kept    Status = "kept"
	Dropped Status = "dropped"
)

// Item is one article from one source.
type Item struct {
	ID         string    `json:"id"`
	URL        string    `json:"url"`
	Source     string    `json:"source"`
	Title      string    `json:"title"`
	Standfirst string    `json:"standfirst"`
	Published  time.Time `json:"published"`
	Fetched    time.Time `json:"fetched"`
	Status     Status    `json:"status"`
	Category   string    `json:"category,omitempty"`
	Summary    string    `json:"summary,omitempty"`
	Reason     string    `json:"reason,omitempty"`
	Material   bool      `json:"material,omitempty"`
	Cluster    string    `json:"cluster,omitempty"`
	Pushed     bool      `json:"pushed,omitempty"`
	DropKind   string    `json:"dropKind,omitempty"`
}

// Health tracks one source across runs.
type Health struct {
	LastOK      time.Time `json:"lastOk,omitzero"`
	LastError   string    `json:"lastError,omitempty"`
	LastErrorAt time.Time `json:"lastErrorAt,omitzero"`
	LastCount   int       `json:"lastCount"`
	Fails       int       `json:"fails"`
}

// Usage is one day's filter spend.
type Usage struct {
	In    int `json:"in"`
	Out   int `json:"out"`
	Calls int `json:"calls"`
}

// Fixtures is the club's next matches and when they were read.
type Fixtures struct {
	FetchedAt time.Time        `json:"fetchedAt"`
	Events    []source.Fixture `json:"events"`
}

// State is everything the poller keeps for one club between runs.
type State struct {
	Items      []*Item            `json:"items"`
	Health     map[string]*Health `json:"health"`
	Usage      map[string]*Usage  `json:"usage"`
	Pushes     map[string]int     `json:"pushes"`
	LastRun    time.Time          `json:"lastRun,omitzero"`
	Config     string             `json:"config,omitempty"` // the club's Fingerprint at the last run
	ModelError string             `json:"modelError,omitempty"`
	Fixtures   *Fixtures          `json:"fixtures,omitempty"`
}

// Init fills nil maps so callers can write to them.
func (s *State) Init() *State {
	if s.Health == nil {
		s.Health = map[string]*Health{}
	}
	if s.Usage == nil {
		s.Usage = map[string]*Usage{}
	}
	if s.Pushes == nil {
		s.Pushes = map[string]int{}
	}
	if s.Items == nil {
		s.Items = []*Item{}
	}
	return s
}

// ID is the item id for a URL: the first 12 hex characters of its SHA-1.
func ID(url string) string {
	h := sha1.Sum([]byte(url))
	return hex.EncodeToString(h[:])[:12]
}

// Day is the London calendar date, yyyy-mm-dd, used to key usage and push counts.
func Day(t time.Time) string { return t.In(London).Format("2006-01-02") }

// Retain drops items, usage and push counts older than days.
func (s *State) Retain(now time.Time, days int) {
	cutoff := now.Add(-time.Duration(days) * 24 * time.Hour)
	kept := s.Items[:0]
	for _, it := range s.Items {
		if !it.Published.Before(cutoff) {
			kept = append(kept, it)
		}
	}
	s.Items = kept
	cut := cutoff.UTC().Format("2006-01-02")
	for k := range s.Usage {
		if k < cut {
			delete(s.Usage, k)
		}
	}
	for k := range s.Pushes {
		if k < cut {
			delete(s.Pushes, k)
		}
	}
}

// Count returns how many items have status st.
func (s *State) Count(st Status) int {
	n := 0
	for _, it := range s.Items {
		if it.Status == st {
			n++
		}
	}
	return n
}
