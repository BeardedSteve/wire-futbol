package push

import (
	"bytes"
	"context"
	"crypto/ecdh"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/BeardedSteve/wire-futbol/internal/store"
)

// Keys are a subscription's encryption keys, base64url as the browser sends them.
type Keys struct {
	P256dh string `json:"p256dh"`
	Auth   string `json:"auth"`
}

// Sub is one browser's push subscription.
type Sub struct {
	Endpoint string `json:"endpoint"`
	Keys     Keys   `json:"keys"`
	Added    string `json:"added,omitempty"`
	UA       string `json:"ua,omitempty"`
}

// Message is what the service worker shows.
type Message struct {
	Title string `json:"title"`
	Body  string `json:"body"`
	URL   string `json:"url,omitempty"`
	Tag   string `json:"tag,omitempty"`
}

// pushHosts are the browser push services we will send to. Anything else is refused, so the server can't be
// pointed at an arbitrary URL.
var pushHosts = []string{
	"fcm.googleapis.com",        // Chrome, Edge on Android, Brave, Opera, Samsung Internet
	"push.services.mozilla.com", // Firefox
	"push.apple.com",            // Safari
	"notify.windows.com",        // Edge on Windows
}

// Validate checks a subscription before it is stored.
func Validate(s Sub) error {
	if len(s.Endpoint) > 1000 {
		return errors.New("endpoint too long")
	}
	u, err := url.Parse(s.Endpoint)
	if err != nil || u.Scheme != "https" || u.User != nil || u.Port() != "" {
		return errors.New("endpoint must be a plain https URL")
	}
	host := strings.ToLower(u.Hostname())
	ok := false
	for _, h := range pushHosts {
		if host == h || strings.HasSuffix(host, "."+h) {
			ok = true
			break
		}
	}
	if !ok {
		return fmt.Errorf("unknown push service %q", host)
	}
	p, err := b64(s.Keys.P256dh)
	if err != nil {
		return errors.New("p256dh is not base64url")
	}
	if _, err := ecdh.P256().NewPublicKey(p); err != nil {
		return errors.New("p256dh is not a P-256 public key")
	}
	if a, err := b64(s.Keys.Auth); err != nil || len(a) != 16 {
		return errors.New("auth must be 16 bytes")
	}
	return nil
}

// Sender delivers messages.
type Sender struct {
	VAPID  *VAPID
	Client *http.Client
}

// Send encrypts and posts one message, returning the push service's status code.
func (s *Sender) Send(ctx context.Context, sub Sub, m Message, ttl time.Duration, urgency string) (int, error) {
	if err := Validate(sub); err != nil {
		return 0, err
	}
	payload, _ := json.Marshal(m)
	p256, _ := b64(sub.Keys.P256dh)
	auth, _ := b64(sub.Keys.Auth)
	salt := make([]byte, 16)
	if _, err := rand.Read(salt); err != nil {
		return 0, err
	}
	body, err := encrypt(payload, p256, auth, nil, salt)
	if err != nil {
		return 0, err
	}
	authz, err := s.VAPID.header(sub.Endpoint, time.Now())
	if err != nil {
		return 0, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, sub.Endpoint, bytes.NewReader(body))
	if err != nil {
		return 0, err
	}
	req.Header.Set("Authorization", authz)
	req.Header.Set("Content-Encoding", "aes128gcm")
	req.Header.Set("Content-Type", "application/octet-stream")
	req.Header.Set("TTL", strconv.Itoa(int(ttl.Seconds())))
	req.Header.Set("Urgency", urgency)
	c := s.Client
	if c == nil {
		c = &http.Client{Timeout: 15 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	}
	r, err := c.Do(req)
	if err != nil {
		return 0, err
	}
	defer r.Body.Close()
	if r.StatusCode >= 300 {
		msg, _ := io.ReadAll(io.LimitReader(r.Body, 200))
		return r.StatusCode, fmt.Errorf("push service returned %d: %s", r.StatusCode, msg)
	}
	return r.StatusCode, nil
}

// ErrFull means the subscription list is at its cap. New devices are refused; existing ones are never evicted.
var ErrFull = errors.New("subscription list is full")

// List is one club's subscriptions, stored as a JSON array.
type List struct {
	Store store.Store
	Key   string // e.g. lfc/subs.json
	Max   int
	mu    sync.Mutex
}

// Load reads the list. A missing file is an empty list.
func (l *List) Load(ctx context.Context) ([]Sub, error) {
	b, err := l.Store.Get(ctx, l.Key)
	if errors.Is(err, store.ErrNotFound) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var subs []Sub
	if err := json.Unmarshal(b, &subs); err != nil {
		return nil, fmt.Errorf("%s: %w", l.Key, err)
	}
	return subs, nil
}

func (l *List) save(ctx context.Context, subs []Sub) error {
	if subs == nil {
		subs = []Sub{}
	}
	b, _ := json.Marshal(subs)
	return l.Store.Put(ctx, l.Key, b, "application/json")
}

// Add stores sub, replacing any entry with the same endpoint. It reports whether the device is new.
func (l *List) Add(ctx context.Context, sub Sub) (bool, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	subs, err := l.Load(ctx)
	if err != nil {
		return false, err
	}
	for i := range subs {
		if subs[i].Endpoint == sub.Endpoint {
			sub.Added = subs[i].Added
			subs[i] = sub
			return false, l.save(ctx, subs)
		}
	}
	if len(subs) >= l.Max {
		return false, ErrFull
	}
	return true, l.save(ctx, append([]Sub{sub}, subs...))
}

// Find returns the stored subscription for endpoint.
func (l *List) Find(ctx context.Context, endpoint string) (Sub, bool, error) {
	subs, err := l.Load(ctx)
	if err != nil {
		return Sub{}, false, err
	}
	for _, s := range subs {
		if s.Endpoint == endpoint {
			return s, true, nil
		}
	}
	return Sub{}, false, nil
}

// Remove drops every endpoint in gone.
func (l *List) Remove(ctx context.Context, gone ...string) error {
	l.mu.Lock()
	defer l.mu.Unlock()
	subs, err := l.Load(ctx)
	if err != nil {
		return err
	}
	drop := map[string]bool{}
	for _, g := range gone {
		drop[g] = true
	}
	kept := subs[:0]
	for _, s := range subs {
		if !drop[s.Endpoint] {
			kept = append(kept, s)
		}
	}
	return l.save(ctx, kept)
}
