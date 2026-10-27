package web

import (
	"fmt"
	"html/template"
	"math"
	"strconv"
	"strings"
	"time"

	"github.com/BeardedSteve/wire-futbol/internal/wire"
)

// Times are shown in London, in en-GB formats.

func lon(t time.Time) time.Time { return t.In(wire.London) }

func hm(t time.Time) string        { return lon(t).Format("15:04") }
func dayKey(t time.Time) string    { return lon(t).Format("2006-01-02") }
func shortDay(t time.Time) string  { return lon(t).Format("Mon 2 Jan") }
func shortDate(t time.Time) string { return lon(t).Format("2 Jan") }
func longWhen(t time.Time) string  { return lon(t).Format("Monday 2 January, 15:04") }

func dayLabel(t, now time.Time) string {
	switch dayKey(t) {
	case dayKey(now):
		return "Today"
	case dayKey(now.Add(-24 * time.Hour)):
		return "Yesterday"
	}
	return lon(t).Format("Monday 2 January")
}

// rel is mirrored in client.js so times stay current without a reload.
func rel(t, now time.Time) string {
	s := now.Sub(t).Seconds()
	switch {
	case s < 60:
		return "just now"
	case s < 3600:
		return fmt.Sprintf("%d min ago", int(s/60))
	case s < 6*3600:
		return fmt.Sprintf("%dh ago", int(s/3600))
	case dayKey(t) == dayKey(now):
		return hm(t)
	case dayKey(t) == dayKey(now.Add(-24*time.Hour)):
		return "Yesterday " + hm(t)
	}
	return shortDay(t) + " " + hm(t)
}

func iso(t time.Time) string { return t.UTC().Format("2006-01-02T15:04:05.000Z") }

// timeTag is a <time> that client.js keeps relative.
func timeTag(t, now time.Time) template.HTML {
	e := template.HTMLEscapeString
	return template.HTML(`<time class="rel " datetime="` + e(iso(t)) + `" title="` + e(longWhen(t)) + `">` + e(rel(t, now)) + `</time>`)
}

func plural(n int, one, many string) string {
	if n == 1 {
		return one
	}
	return many
}

// thousands formats 12345 as 12,345.
func thousands(n int) string {
	s := strconv.Itoa(n)
	neg := strings.HasPrefix(s, "-")
	s = strings.TrimPrefix(s, "-")
	var b strings.Builder
	for i, c := range s {
		if i > 0 && (len(s)-i)%3 == 0 {
			b.WriteByte(',')
		}
		b.WriteRune(c)
	}
	if neg {
		return "-" + b.String()
	}
	return b.String()
}

func ordinal(v float64) string {
	r := int(math.Round(v))
	suf := "th"
	if t := r % 100; t < 11 || t > 13 {
		switch r % 10 {
		case 1:
			suf = "st"
		case 2:
			suf = "nd"
		case 3:
			suf = "rd"
		}
	}
	return strconv.Itoa(r) + suf
}

// jsFixed matches JavaScript's toFixed for the values shown here.
func jsFixed(v float64, d int) string { return strconv.FormatFloat(v, 'f', d, 64) }
