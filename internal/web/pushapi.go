package web

import (
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/BeardedSteve/wire-futbol/internal/club"
	"github.com/BeardedSteve/wire-futbol/internal/poll"
	"github.com/BeardedSteve/wire-futbol/internal/push"
)

func (s *Server) list(c *club.Club) *push.List {
	s.mu.Lock()
	defer s.mu.Unlock()
	l := s.subs[c.Slug]
	if l == nil {
		l = &push.List{Store: s.store, Key: poll.SubsKey(c), Max: s.cfg.MaxSubs}
		s.subs[c.Slug] = l
	}
	return l
}

func (s *Server) pushKey(w http.ResponseWriter, r *http.Request) {
	key := ""
	if s.vapid != nil {
		key = s.vapid.Public
	}
	writeJSON(w, 200, map[string]string{"key": key})
}

func readSub(r *http.Request) (push.Sub, error) {
	var sub push.Sub
	err := json.NewDecoder(http.MaxBytesReader(nil, r.Body, 4096)).Decode(&sub)
	return sub, err
}

func (s *Server) pushSubscribe(w http.ResponseWriter, r *http.Request) {
	c := clubOf(r)
	if s.sender == nil {
		writeJSON(w, 503, map[string]string{"error": "alerts are not configured"})
		return
	}
	sub, err := readSub(r)
	if err == nil {
		err = push.Validate(sub)
	}
	if err != nil {
		writeJSON(w, 400, map[string]string{"error": "bad subscription"})
		return
	}
	sub = push.Sub{Endpoint: sub.Endpoint, Keys: sub.Keys, Added: s.now().UTC().Format(time.RFC3339), UA: clipUA(r.UserAgent())}
	isNew, err := s.list(c).Add(r.Context(), sub)
	if errors.Is(err, push.ErrFull) {
		writeJSON(w, 503, map[string]string{"error": "alerts are full"})
		return
	}
	if err != nil {
		slog.Error("subscribe failed", "club", c.Slug, "err", err)
		writeJSON(w, 500, map[string]string{"error": "server error"})
		return
	}
	if isNew {
		msg := push.Message{Title: c.App(), Body: "Alerts are on. You will hear from me when material news breaks.", Tag: "welcome", URL: "/"}
		if _, err := s.sender.Send(r.Context(), sub, msg, time.Hour, "high"); err != nil {
			slog.Warn("welcome push failed", "club", c.Slug, "err", err)
		}
	}
	writeJSON(w, 200, map[string]bool{"ok": true})
}

func (s *Server) pushUnsubscribe(w http.ResponseWriter, r *http.Request) {
	c := clubOf(r)
	sub, err := readSub(r)
	if err != nil || sub.Endpoint == "" {
		writeJSON(w, 400, map[string]string{"error": "bad request"})
		return
	}
	if err := s.list(c).Remove(r.Context(), sub.Endpoint); err != nil {
		slog.Error("unsubscribe failed", "club", c.Slug, "err", err)
		writeJSON(w, 500, map[string]string{"error": "server error"})
		return
	}
	writeJSON(w, 200, map[string]bool{"ok": true})
}

func (s *Server) pushTest(w http.ResponseWriter, r *http.Request) {
	c := clubOf(r)
	in, err := readSub(r)
	if err != nil || s.sender == nil {
		writeJSON(w, 400, map[string]string{"error": "bad request"})
		return
	}
	sub, ok, err := s.list(c).Find(r.Context(), in.Endpoint)
	if err != nil {
		writeJSON(w, 500, map[string]string{"error": "server error"})
		return
	}
	if !ok {
		writeJSON(w, 404, map[string]string{"error": "not subscribed"})
		return
	}
	msg := push.Message{Title: c.App() + " test", Body: "This is what an alert looks like. Tap to open the wire.", Tag: "test", URL: "/"}
	code, err := s.sender.Send(r.Context(), sub, msg, time.Hour, "high")
	if err != nil {
		writeJSON(w, 502, map[string]string{"error": fmt.Sprintf("push service returned %d", code)})
		return
	}
	writeJSON(w, 200, map[string]bool{"ok": true})
}

func clipUA(ua string) string {
	if len(ua) > 120 {
		return ua[:120]
	}
	return ua
}

// limiter allows n requests per client per window on the push endpoints.
type limiter struct {
	n      int
	window time.Duration
	mu     sync.Mutex
	hits   map[string][]time.Time
}

func newLimiter(n int, window time.Duration) *limiter {
	return &limiter{n: n, window: window, hits: map[string][]time.Time{}}
}

func (l *limiter) allow(key string, now time.Time) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	if len(l.hits) > 10000 { // forget everyone rather than grow without bound
		l.hits = map[string][]time.Time{}
	}
	recent := l.hits[key][:0]
	for _, t := range l.hits[key] {
		if now.Sub(t) < l.window {
			recent = append(recent, t)
		}
	}
	if len(recent) >= l.n {
		l.hits[key] = recent
		return false
	}
	l.hits[key] = append(recent, now)
	return true
}

// clientIP is the address Railway's edge saw: the last X-Forwarded-For hop it appended, else the socket peer.
func clientIP(r *http.Request) string {
	if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
		parts := strings.Split(xff, ",")
		return strings.TrimSpace(parts[len(parts)-1])
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

func (s *Server) limited(h http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !s.limiter.allow(clientIP(r), s.now()) {
			w.Header().Set("Retry-After", "600")
			writeJSON(w, 429, map[string]string{"error": "too many requests"})
			return
		}
		h(w, r)
	}
}
