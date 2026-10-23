package web

import (
	"bytes"
	"compress/gzip"
	"context"
	"crypto/ecdh"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/BeardedSteve/wire-futbol/internal/club"
	"github.com/BeardedSteve/wire-futbol/internal/fetch"
	"github.com/BeardedSteve/wire-futbol/internal/push"
	"github.com/BeardedSteve/wire-futbol/internal/squad"
	"github.com/BeardedSteve/wire-futbol/internal/store"
)

func gz(t *testing.T, name string) []byte {
	t.Helper()
	f, err := os.Open("../../test/fixtures/" + name)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	z, _ := gzip.NewReader(f)
	b, _ := io.ReadAll(z)
	return b
}

// Real state and FPL data captured on 23 October 2026.
var captured = time.Date(2026, 10, 23, 8, 30, 0, 0, time.UTC)

func testServer(t *testing.T, withSquad bool) (*Server, store.Store) {
	t.Helper()
	st := store.Dir(t.TempDir())
	ctx := context.Background()
	st.Put(ctx, "lfc/state.json", gz(t, "state.json.gz"), "")
	if withSquad {
		fpl := func(_ context.Context, p string) ([]byte, error) {
			if p == "fixtures/" {
				return gz(t, "fpl-fixtures.json.gz"), nil
			}
			return gz(t, "fpl-bootstrap.json.gz"), nil
		}
		if _, err := squad.Poll(ctx, st, fpl, captured); err != nil {
			t.Fatal(err)
		}
	}
	k, _ := ecdh.P256().GenerateKey(rand.Reader)
	enc := base64.RawURLEncoding
	v, err := push.NewVAPID(enc.EncodeToString(k.PublicKey().Bytes()), enc.EncodeToString(k.Bytes()), "mailto:test@example.com")
	if err != nil {
		t.Fatal(err)
	}
	s, err := New(Config{Resolver: club.Resolver{Default: "lfc"}, CanonicalHost: "lfc.wire.futbol", MaxPushPerDay: 6, MaxSubs: 2, Model: "gemini-3.8-flash", PriceIn: 0.75, PriceOut: 3.75, USDToGBP: 0.75},
		st, v, &fetch.Client{Backoff: []time.Duration{}})
	if err != nil {
		t.Fatal(err)
	}
	s.now = func() time.Time { return captured }
	return s, st
}

func get(t *testing.T, h http.Handler, host, path string) *http.Response {
	t.Helper()
	r := httptest.NewRequest("GET", path, nil)
	r.Host = host
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	return w.Result()
}

func body(r *http.Response) string { b, _ := io.ReadAll(r.Body); return string(b) }

var (
	inlineScript = regexp.MustCompile(`<script(?:\s[^>]*)?>[^<]+</script>`)
	inlineStyle  = regexp.MustCompile(`\sstyle=|<style`)
	inlineEvent  = regexp.MustCompile(`\son[a-z]+=`)
)

func TestPagesRenderWithoutInlineCode(t *testing.T) {
	s, _ := testServer(t, true)
	h := s.Handler()
	pages := map[string][]string{
		"/":         {"Liverpool FC news", `class="story`, "Fixtures", "Club</a>"},
		"/filtered": {"Kept out", "Why things were kept out", `data-w="100"`},
		"/status":   {"Schedule and alerts", "liverpoolfc.com", "Refreshed", "gemini-3.8-flash"},
		"/squad":    {"Out now", "Goalkeepers", "Defenders", "Midfielders", "Forwards", "Availability", "Isak", "Szoboszlai"},
		"/shorts":   {"Shorts", "The Anfield Wrap and Fabrizio Romano"},
	}
	for path, want := range pages {
		r := get(t, h, "lfc.wire.futbol", path)
		html := body(r)
		if r.StatusCode != 200 {
			t.Errorf("%s: %d %s", path, r.StatusCode, html)
			continue
		}
		for _, w := range want {
			if !strings.Contains(html, w) {
				t.Errorf("%s: missing %q", path, w)
			}
		}
		for _, m := range inlineScript.FindAllString(html, -1) {
			if !strings.Contains(m, `type="application/json"`) {
				t.Errorf("%s: inline script %.80s", path, m)
			}
		}
		if inlineStyle.MatchString(html) || inlineEvent.MatchString(html) {
			t.Errorf("%s: inline style or event handler would break the CSP", path)
		}
		if strings.Contains(html, "Something went wrong") || strings.Contains(html, "LFC Wire") == false {
			t.Errorf("%s: render problem", path)
		}
	}
}

func TestSquadData(t *testing.T) {
	s, _ := testServer(t, true)
	html := body(get(t, s.Handler(), "lfc.wire.futbol", "/squad"))
	m := regexp.MustCompile(`(?s)<script type="application/json" id="sq-data">(.*?)</script>`).FindStringSubmatch(html)
	if m == nil {
		t.Fatal("no squad data")
	}
	var d struct {
		Club  string                       `json:"club"`
		Pools map[string][]json.RawMessage `json:"pools"`
		Mine  map[string]json.RawMessage   `json:"mine"`
	}
	if err := json.Unmarshal([]byte(m[1]), &d); err != nil {
		t.Fatalf("squad JSON: %v\n%.200s", err, m[1])
	}
	if d.Club != "LIV" || len(d.Pools) != 4 || len(d.Mine) == 0 {
		t.Fatalf("%+v", d)
	}
}

func TestSquadMissingSaysSoAndWireStillWorks(t *testing.T) {
	s, _ := testServer(t, false)
	h := s.Handler()
	if r := get(t, h, "lfc.wire.futbol", "/"); r.StatusCode != 200 {
		t.Fatal(r.StatusCode)
	}
	if html := body(get(t, h, "lfc.wire.futbol", "/squad")); !strings.Contains(html, "Squad data isn&#39;t loaded yet") {
		t.Fatal("squad page should say data isn't loaded")
	}
	if html := body(get(t, h, "lfc.wire.futbol", "/status")); !strings.Contains(html, "Not loaded yet") {
		t.Fatal("status page should say squad isn't loaded")
	}
}

func TestEmptyStoreRenders(t *testing.T) {
	s, err := New(Config{Resolver: club.Resolver{Default: "lfc"}, MaxSubs: 2}, store.Dir(t.TempDir()), nil, &fetch.Client{})
	if err != nil {
		t.Fatal(err)
	}
	h := s.Handler()
	for _, p := range []string{"/", "/filtered", "/status", "/squad"} {
		if r := get(t, h, "localhost", p); r.StatusCode != 200 {
			t.Errorf("%s: %d", p, r.StatusCode)
		}
	}
	if !strings.Contains(body(get(t, h, "localhost", "/")), "Starting up") {
		t.Error("empty wire should say it is starting up")
	}
}

func TestHeadersRoutingAndClubResolution(t *testing.T) {
	s, _ := testServer(t, false)
	h := s.Handler()
	r := get(t, h, "lfc.wire.futbol", "/")
	for k, want := range map[string]string{
		"Content-Security-Policy":   "script-src 'self';",
		"Strict-Transport-Security": "max-age=63072000",
		"X-Content-Type-Options":    "nosniff",
		"Referrer-Policy":           "no-referrer",
	} {
		if !strings.Contains(r.Header.Get(k), want) {
			t.Errorf("%s = %q", k, r.Header.Get(k))
		}
	}
	if get(t, h, "ars.wire.futbol", "/").StatusCode != 404 {
		t.Error("unknown club should 404")
	}
	if get(t, h, "anything", "/health").StatusCode != 200 {
		t.Error("health should not depend on the host")
	}
	if get(t, h, "lfc.wire.futbol", "/nope").StatusCode != 404 {
		t.Error("unknown path should 404")
	}
	rd := get(t, h, "wire-web-production-7556.up.railway.app", "/squad?x=1")
	if rd.StatusCode != 301 || rd.Header.Get("Location") != "https://lfc.wire.futbol/squad?x=1" {
		t.Errorf("redirect %d %s", rd.StatusCode, rd.Header.Get("Location"))
	}
	if get(t, h, "wire-web-production-7556.up.railway.app", "/sw.js").StatusCode != 200 {
		t.Error("service worker should not redirect")
	}
	if r := get(t, h, "lfc.wire.futbol", "/shorts"); r.Header.Get("Referrer-Policy") != "strict-origin-when-cross-origin" {
		t.Error("shorts needs a referrer for YouTube embeds")
	}
	for _, p := range []string{"/manifest.webmanifest", "/sw.js", "/icon-192.png", "/apple-touch-icon.png", "/api/version", "/api/push/key", "/club.css", "/api/state.json"} {
		if r := get(t, h, "lfc.wire.futbol", p); r.StatusCode != 200 {
			t.Errorf("%s: %d", p, r.StatusCode)
		}
	}
	css := s.assets["app.css"].path
	if r := get(t, h, "lfc.wire.futbol", css); r.StatusCode != 200 || !strings.Contains(r.Header.Get("Cache-Control"), "immutable") {
		t.Errorf("asset %s: %d", css, r.StatusCode)
	}
	if r := httptest.NewRecorder(); true {
		req := httptest.NewRequest("POST", "/", nil)
		req.Host = "lfc.wire.futbol"
		h.ServeHTTP(r, req)
		if r.Code != 405 {
			t.Errorf("POST / = %d", r.Code)
		}
	}
	var v map[string]any
	json.Unmarshal([]byte(body(get(t, h, "lfc.wire.futbol", "/api/version"))), &v)
	if v["lastRun"] == nil || v["stories"].(float64) == 0 {
		t.Errorf("version %v", v)
	}
}

func post(t *testing.T, h http.Handler, path string, v any, ip string) *httptest.ResponseRecorder {
	b, _ := json.Marshal(v)
	r := httptest.NewRequest("POST", path, bytes.NewReader(b))
	r.Host = "lfc.wire.futbol"
	r.Header.Set("X-Forwarded-For", ip)
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	return w
}

func sub(endpoint string) push.Sub {
	k, _ := ecdh.P256().GenerateKey(rand.Reader)
	auth := make([]byte, 16)
	rand.Read(auth)
	enc := base64.RawURLEncoding
	return push.Sub{Endpoint: endpoint, Keys: push.Keys{P256dh: enc.EncodeToString(k.PublicKey().Bytes()), Auth: enc.EncodeToString(auth)}}
}

func TestSubscribeCannotEvictOrReachArbitraryHosts(t *testing.T) {
	s, st := testServer(t, false)
	h := s.Handler()
	// The welcome push goes to a fake push service; Validate allows only real push hosts, so swap the client's transport.
	var sent []string
	s.sender.Client = &http.Client{Transport: roundTrip(func(r *http.Request) (*http.Response, error) {
		sent = append(sent, r.URL.String())
		return &http.Response{StatusCode: 201, Body: io.NopCloser(strings.NewReader("")), Header: http.Header{}}, nil
	})}
	if w := post(t, h, "/api/push/subscribe", sub("https://169.254.169.254/latest"), "1.1.1.1"); w.Code != 400 {
		t.Fatalf("metadata endpoint accepted: %d", w.Code)
	}
	a, b, c := sub("https://fcm.googleapis.com/fcm/send/a"), sub("https://fcm.googleapis.com/fcm/send/b"), sub("https://fcm.googleapis.com/fcm/send/c")
	for _, x := range []push.Sub{a, b} {
		if w := post(t, h, "/api/push/subscribe", x, "1.1.1.2"); w.Code != 200 {
			t.Fatalf("subscribe %d %s", w.Code, w.Body)
		}
	}
	if w := post(t, h, "/api/push/subscribe", c, "1.1.1.3"); w.Code != 503 {
		t.Fatalf("third device when full: %d", w.Code)
	}
	raw, _ := st.Get(context.Background(), "lfc/subs.json")
	if !strings.Contains(string(raw), "/a") || !strings.Contains(string(raw), "/b") || strings.Contains(string(raw), "/c\"") {
		t.Fatalf("subscriptions changed: %s", raw)
	}
	if len(sent) != 2 {
		t.Fatalf("welcome pushes %d", len(sent))
	}
	if w := post(t, h, "/api/push/test", map[string]string{"endpoint": a.Endpoint}, "1.1.1.4"); w.Code != 200 {
		t.Fatalf("test push %d %s", w.Code, w.Body)
	}
	if w := post(t, h, "/api/push/test", map[string]string{"endpoint": c.Endpoint}, "1.1.1.4"); w.Code != 404 {
		t.Fatalf("test push to unknown %d", w.Code)
	}
	if w := post(t, h, "/api/push/unsubscribe", map[string]string{"endpoint": a.Endpoint}, "1.1.1.4"); w.Code != 200 {
		t.Fatal(w.Code)
	}
	// Rate limit: 20 per address per 10 minutes.
	for i := 0; i < 20; i++ {
		post(t, h, "/api/push/unsubscribe", map[string]string{"endpoint": "x"}, "9.9.9.9")
	}
	if w := post(t, h, "/api/push/unsubscribe", map[string]string{"endpoint": "x"}, "9.9.9.9"); w.Code != 429 {
		t.Fatalf("rate limit not applied: %d", w.Code)
	}
}

type roundTrip func(*http.Request) (*http.Response, error)

func (f roundTrip) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

// Every static script must parse. Needs Node; skipped without it.
func TestStaticScriptsParse(t *testing.T) {
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("node not installed")
	}
	files, _ := filepath.Glob("static/*.js")
	for _, f := range files {
		if out, err := exec.Command(node, "--check", f).CombinedOutput(); err != nil {
			t.Errorf("%s: %s", f, out)
		}
	}
}
