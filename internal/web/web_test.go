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
	f, err := os.Open("../../testdata/" + name)
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
		"/":       {`class="story`, "NEXT UP", "BRIGHTON", "liverpool-v-brighton-and-hove-albion-english-premier-league-20261025", "Treatment room", "Standing", "Confirmed", "Unconfirmed", `aria-current="true"><b>100</b>All`},
		"/spiked": {"Why spiked", "Any reason", `name="bucket" value="promo"`},
		"/status": {"Schedule and alerts", "liverpoolfc.com", "Refreshed", "gemini-3.8-flash"},
		"/squad":  {`class="si si-inj"`, `class="si si-doubt"`, `<div class="med">`, `id="p-`, "Goalkeepers", "Defenders", "Midfielders", "Forwards", "Availability", "Isak", "Szoboszlai", `hx-get="/squad/player/`},
		"/table":  {"Premier League", `class="me"`, "Form", "Carabao Cup"},
		"/shorts": {"Shorts", "The Redmen TV and The Anfield Wrap", `class="tabbar"`, `href="/shorts" hx-boost="false" aria-current="page"`},
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
		seen := map[string]bool{}
		for _, m := range idAttr.FindAllStringSubmatch(html, -1) {
			if seen[m[1]] {
				t.Errorf("%s: duplicate id %q", path, m[1])
			}
			seen[m[1]] = true
		}
	}
}

var idAttr = regexp.MustCompile(`\sid="([^"]+)"`)

func hx(t *testing.T, h http.Handler, path, target string) *http.Response {
	t.Helper()
	r := httptest.NewRequest("GET", path, nil)
	r.Host = "lfc.wire.futbol"
	r.Header.Set("HX-Request", "true")
	r.Header.Set("HX-Target", target)
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	return w.Result()
}

func TestFragments(t *testing.T) {
	s, _ := testServer(t, true)
	h := s.Handler()

	r := hx(t, h, "/?desk=fitness", "feedzone")
	f := body(r)
	if !strings.HasPrefix(f, `<div id="feedzone">`) || strings.Contains(f, "<html") || !strings.Contains(f, `hx-swap-oob="true">P110<`) || !strings.Contains(r.Header.Get("Vary"), "HX-Target") {
		t.Errorf("desk fragment: %.200s", f)
	}
	if strings.Count(f, `class="story`) == 0 || strings.Contains(f, "Transfer</span>") {
		t.Error("fitness desk should hold only fitness stories")
	}
	if full := body(get(t, h, "lfc.wire.futbol", "/?desk=fitness")); !strings.Contains(full, "<html") || !strings.Contains(full, ">P110<") || strings.Contains(full, "hx-swap-oob") {
		t.Error("a desk loaded directly is a whole page numbered 110")
	}
	if body(get(t, h, "lfc.wire.futbol", "/?desk=nonsense")) == "" {
		t.Error("unknown desk")
	}

	res := body(hx(t, h, "/spiked?q=ticket&bucket=promo", "spiked-results"))
	if !strings.HasPrefix(res, `<div id="spiked-results">`) || !regexp.MustCompile(`\d+ match`).MatchString(res) {
		t.Errorf("spiked fragment: %.200s", res)
	}
	if !strings.Contains(body(get(t, h, "lfc.wire.futbol", "/spiked?bucket=promo")), `value="promo" checked`) {
		t.Error("the chosen reason should be checked when the URL is loaded directly")
	}

	page := body(get(t, h, "lfc.wire.futbol", "/squad"))
	id := regexp.MustCompile(`hx-get="/squad/player/(\d+)"`).FindStringSubmatch(page)[1]
	strips := body(get(t, h, "lfc.wire.futbol", "/squad/player/"+id))
	if strings.Count(strips, `class="strip"`) != 5 || !strings.Contains(strips, `class="me"`) || !strings.Contains(strips, "data-t=") || strings.Contains(strips, "<html") {
		t.Errorf("strips: %.300s", strips)
	}
	if r := get(t, h, "lfc.wire.futbol", "/squad/player/1"); r.StatusCode != 404 {
		t.Errorf("another club's player: %d", r.StatusCode)
	}

	idle := body(get(t, h, "lfc.wire.futbol", "/fragments/pulse?run=x&n=999"))
	if !strings.Contains(idle, `hx-trigger="every 120s"`) || strings.Contains(idle, "toast") {
		t.Errorf("pulse with nothing new: %s", idle)
	}
	if fresh := body(get(t, h, "lfc.wire.futbol", "/fragments/pulse?run=2020-01-01T00:00:00.000Z&n=3")); !strings.Contains(fresh, "new stories") {
		t.Errorf("pulse after a new run: %s", fresh)
	}
}

// The board follows the fixture calendar. Liverpool play Brighton at 14:00 on Sunday 25 October 2026 and won 2-1
// at Brentford on Saturday 17 October.
func TestBoardPhases(t *testing.T) {
	s, _ := testServer(t, true)
	h := s.Handler()
	for _, c := range []struct {
		at   string
		want []string
		not  []string
	}{
		{"2026-10-23T08:30:00Z", []string{"NEXT UP", `data-u="d"`, "T-minus", "Out</span>", "Doubtful</span>"}, []string{`data-u="s"`}},
		{"2026-10-25T10:20:00Z", []string{"MATCHDAY", `data-u="s"`}, []string{`data-u="d"`}},
		{"2026-10-25T14:57:00Z", []string{"LIVE NOW", "T+<span data-elapsed>57</span>", "Follow on LIVERPOOLFC.COM"}, []string{"T-minus"}},
		{"2026-10-17T16:45:00Z", []string{"FULL TIME", ">BRENTFORD<", ">LIVERPOOL<", ">1<", ">2<", "Next</span>v BRIGHTON"}, []string{"T-minus"}},
	} {
		at, _ := time.Parse(time.RFC3339, c.at)
		s.now = func() time.Time { return at }
		b := body(get(t, h, "lfc.wire.futbol", "/"))
		i := strings.Index(b, `<section class="board`)
		if i < 0 {
			t.Errorf("%s: no board", c.at)
			continue
		}
		b = b[i : i+strings.Index(b[i:], "</section>")]
		for _, w := range c.want {
			if !strings.Contains(b, w) {
				t.Errorf("%s: board missing %q", c.at, w)
			}
		}
		for _, w := range c.not {
			if strings.Contains(b, w) {
				t.Errorf("%s: board shouldn't have %q", c.at, w)
			}
		}
	}
}

func TestAssetsAreFingerprintedAndCompressed(t *testing.T) {
	s, _ := testServer(t, false)
	h := s.Handler()
	css := string(s.assets["wire.css"].body)
	if strings.Contains(css, "/static/Bedstead.woff2") || !strings.Contains(css, s.assets["Bedstead.woff2"].path) {
		t.Error("stylesheet should point at the fingerprinted fonts")
	}
	r := httptest.NewRequest("GET", s.assets["wire.css"].path, nil)
	r.Host = "lfc.wire.futbol"
	r.Header.Set("Accept-Encoding", "gzip, br")
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Header().Get("Content-Encoding") != "gzip" || w.Body.Len() >= len(s.assets["wire.css"].body) {
		t.Errorf("css not compressed: %v", w.Header())
	}
	r = httptest.NewRequest("GET", "/", nil)
	r.Host = "lfc.wire.futbol"
	r.Header.Set("Accept-Encoding", "gzip")
	w = httptest.NewRecorder()
	h.ServeHTTP(w, r)
	z, err := gzip.NewReader(w.Body)
	if err != nil || w.Header().Get("Content-Encoding") != "gzip" {
		t.Fatalf("page not compressed: %v", err)
	}
	if b, _ := io.ReadAll(z); !strings.Contains(string(b), "</html>") {
		t.Error("compressed page doesn't decode")
	}
	font := get(t, h, "lfc.wire.futbol", s.assets["Bedstead.woff2"].path)
	if font.Header.Get("Content-Type") != "font/woff2" || font.Header.Get("Content-Encoding") != "" {
		t.Errorf("font headers %v", font.Header)
	}
	if !strings.Contains(csp, "font-src 'self'") || strings.Contains(csp, "googleapis") {
		t.Error("fonts are self-hosted")
	}
	if onColour("#C8102E") != "#fff" || onColour("#F2B705") != "#14110e" {
		t.Error("text colour on the club colour")
	}
}

func TestSquadMissingSaysSoAndWireStillWorks(t *testing.T) {
	s, _ := testServer(t, false)
	h := s.Handler()
	if r := get(t, h, "lfc.wire.futbol", "/"); r.StatusCode != 200 {
		t.Fatal(r.StatusCode)
	}
	if html := body(get(t, h, "lfc.wire.futbol", "/squad")); !strings.Contains(html, "No squad data yet.") {
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
	for _, p := range []string{"/", "/spiked", "/status", "/squad", "/table", "/fragments/pulse"} {
		if r := get(t, h, "localhost", p); r.StatusCode != 200 {
			t.Errorf("%s: %d", p, r.StatusCode)
		}
	}
	html := body(get(t, h, "localhost", "/"))
	for _, want := range []string{"No run yet.", "No fixtures yet.", "No table yet.", "No squad data yet.", "never read"} {
		if !strings.Contains(html, want) {
			t.Errorf("empty wire: missing %q", want)
		}
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
	if r := get(t, h, "lfc.wire.futbol", "/filtered"); r.StatusCode != 301 || r.Header.Get("Location") != "/spiked" {
		t.Errorf("old kept-out page: %d %s", r.StatusCode, r.Header.Get("Location"))
	}
	css := s.assets["wire.css"].path
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

func TestPickClubOffWireFutbol(t *testing.T) {
	saved := club.Clubs
	t.Cleanup(func() { club.Clubs = saved })
	club.Clubs = append([]club.Club{}, saved...)
	for i := range club.Clubs {
		club.Clubs[i].Enabled = club.Clubs[i].Slug == "lfc"
	}
	club.Enable([]string{"avfc"})
	s, _ := testServer(t, false)
	h := s.Handler()
	css := func(host, path, cookie string) (string, *http.Response) {
		r := httptest.NewRequest("GET", path, nil)
		r.Host = host
		if cookie != "" {
			r.AddCookie(&http.Cookie{Name: "club", Value: cookie})
		}
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		b, _ := io.ReadAll(w.Result().Body)
		return string(b), w.Result()
	}
	body, res := css("localhost:3000", "/club.css?club=avfc", "")
	if !strings.Contains(body, "#670E36") || !strings.Contains(res.Header.Get("Set-Cookie"), "club=avfc") {
		t.Fatalf("pick: %q, cookie %q", body, res.Header.Get("Set-Cookie"))
	}
	if body, _ := css("localhost:3000", "/club.css", "avfc"); !strings.Contains(body, "#670E36") {
		t.Fatalf("cookie: %q", body)
	}
	if body, _ := css("localhost:3000", "/club.css?club=afc", ""); !strings.Contains(body, "#C8102E") {
		t.Fatalf("disabled club picked: %q", body)
	}
	if body, res := css("lfc.wire.futbol", "/club.css?club=avfc", "avfc"); !strings.Contains(body, "#C8102E") || res.Header.Get("Set-Cookie") != "" {
		t.Fatalf("pick honoured on wire.futbol: %q", body)
	}
}

// skeleton is a page's layout: its landmarks, panels and section headings in order, without their contents.
var skeletonRe = regexp.MustCompile(`<(section|aside|nav|footer|main|dl|form|table)\b[^>]*?(?:\sclass="([^"]*)")?[^>]*>|class="sec"[^>]*><span>([^<]*)</span>`)

func skeleton(html string) []string {
	var out []string
	for _, m := range skeletonRe.FindAllStringSubmatch(html, -1) {
		if m[3] != "" {
			out = append(out, "sec "+m[3])
		} else {
			out = append(out, strings.TrimSpace(m[1]+" "+m[2]))
		}
	}
	return out
}

// Every club's pages are laid out the same: the same panels and sections in the same places. A club without a
// fixtures page still gets the board and its league fixtures from FPL.
func TestEveryClubSharesOneLayout(t *testing.T) {
	s, st := testServer(t, true)
	var state map[string]json.RawMessage
	json.Unmarshal(gz(t, "state.json.gz"), &state)
	delete(state, "fixtures")
	noFixtures, _ := json.Marshal(state)
	for _, c := range club.Enabled() {
		if c.FixturesURL == "" {
			st.Put(context.Background(), c.Slug+"/state.json", noFixtures, "")
		}
	}
	h := s.Handler()
	for _, path := range []string{"/", "/squad", "/table", "/spiked", "/status"} {
		var want []string
		for i, c := range club.Enabled() {
			html := body(get(t, h, c.Hosts[0], path))
			got := skeleton(html)
			if path == "/" && !strings.Contains(html, `class="board`) {
				t.Errorf("%s: no board", c.Slug)
			}
			if i == 0 {
				want = got
				continue
			}
			if strings.Join(got, "\n") != strings.Join(want, "\n") {
				t.Errorf("%s%s is laid out differently from %s:\n got %q\nwant %q", c.Slug, path, club.Enabled()[0].Slug, got, want)
			}
		}
	}
}
