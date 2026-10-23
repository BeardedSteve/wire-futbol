// Package web serves every club's wire. The club comes from the Host header; everything shown is read from the
// store, which the pollers write.
package web

import (
	"bytes"
	"context"
	"crypto/sha256"
	"embed"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"html/template"
	"io/fs"
	"log/slog"
	"net/http"
	"path"
	"runtime/debug"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/BeardedSteve/wire-futbol/internal/club"
	"github.com/BeardedSteve/wire-futbol/internal/fetch"
	"github.com/BeardedSteve/wire-futbol/internal/poll"
	"github.com/BeardedSteve/wire-futbol/internal/push"
	"github.com/BeardedSteve/wire-futbol/internal/source"
	"github.com/BeardedSteve/wire-futbol/internal/squad"
	"github.com/BeardedSteve/wire-futbol/internal/store"
	"github.com/BeardedSteve/wire-futbol/internal/wire"
)

//go:embed templates/*.html
var templateFS embed.FS

//go:embed static
var staticFS embed.FS

// Config is the web service's settings.
type Config struct {
	Resolver      club.Resolver
	CanonicalHost string // page views on *.up.railway.app redirect here
	MaxPushPerDay int    // shown on the status page
	MaxSubs       int    // per club
	Model         string
	PriceIn       float64 // USD per million input tokens
	PriceOut      float64
	USDToGBP      float64
}

// Server handles requests.
type Server struct {
	cfg    Config
	store  store.Store
	vapid  *push.VAPID
	sender *push.Sender
	fetch  *fetch.Client
	now    func() time.Time

	pages  map[string]*template.Template
	shorts *template.Template
	assets map[string]asset // by file name
	byPath map[string]asset // by hashed URL path

	mu        sync.Mutex
	states    map[string]*cached[*wire.State]
	squadData *cached[*squad.Data]
	shortList map[string]*cached[[]source.Short]
	icons     map[string][]byte
	subs      map[string]*push.List
	limiter   *limiter
}

type asset struct {
	path, ctype string
	body        []byte
}

type cached[T any] struct {
	at  time.Time
	val T
	raw []byte
	mu  sync.Mutex
}

// New builds a server. vapid may be nil, which turns alerts off.
func New(cfg Config, st store.Store, vapid *push.VAPID, fc *fetch.Client) (*Server, error) {
	s := &Server{cfg: cfg, store: st, vapid: vapid, fetch: fc, now: time.Now,
		states: map[string]*cached[*wire.State]{}, squadData: &cached[*squad.Data]{}, shortList: map[string]*cached[[]source.Short]{},
		icons: map[string][]byte{}, subs: map[string]*push.List{}, limiter: newLimiter(20, 10*time.Minute)}
	if vapid != nil {
		s.sender = &push.Sender{VAPID: vapid}
	}
	if err := s.loadAssets(); err != nil {
		return nil, err
	}
	funcs := template.FuncMap{
		"asset": func(name string) string { return s.assets[name].path },
		"icon":  func(name string) template.HTML { return icon[name] },
		"list":  func(v ...string) []string { return v },
	}
	base := template.Must(template.New("").Funcs(funcs).ParseFS(templateFS, "templates/layout.html"))
	s.pages = map[string]*template.Template{}
	for _, name := range []string{"wire", "filtered", "status", "squad"} {
		t := template.Must(base.Clone())
		s.pages[name] = template.Must(t.ParseFS(templateFS, "templates/"+name+".html"))
	}
	s.shorts = template.Must(template.Must(base.Clone()).ParseFS(templateFS, "templates/shorts.html"))
	return s, nil
}

// loadAssets fingerprints the static files so they can be cached for a year.
func (s *Server) loadAssets() error {
	s.assets, s.byPath = map[string]asset{}, map[string]asset{}
	return fs.WalkDir(staticFS, "static", func(p string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return err
		}
		b, err := staticFS.ReadFile(p)
		if err != nil {
			return err
		}
		name := path.Base(p)
		sum := sha256.Sum256(b)
		ext := path.Ext(name)
		ctype := map[string]string{".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8"}[ext]
		a := asset{path: "/static/" + strings.TrimSuffix(name, ext) + "." + hex.EncodeToString(sum[:])[:10] + ext, ctype: ctype, body: b}
		s.assets[name] = a
		s.byPath[a.path] = a
		return nil
	})
}

type ctxKey struct{}

func clubOf(r *http.Request) *club.Club { return r.Context().Value(ctxKey{}).(*club.Club) }

// Handler is the whole site.
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /{$}", s.page("wire"))
	mux.HandleFunc("GET /filtered", s.page("filtered"))
	mux.HandleFunc("GET /status", s.page("status"))
	mux.HandleFunc("GET /squad", s.page("squad"))
	mux.HandleFunc("GET /shorts", s.shortsPage)
	mux.HandleFunc("GET /api/shorts", s.apiShorts)
	mux.HandleFunc("GET /api/version", s.apiVersion)
	mux.HandleFunc("GET /api/state.json", s.apiState)
	mux.HandleFunc("GET /api/push/key", s.pushKey)
	mux.HandleFunc("POST /api/push/subscribe", s.limited(s.pushSubscribe))
	mux.HandleFunc("POST /api/push/unsubscribe", s.limited(s.pushUnsubscribe))
	mux.HandleFunc("POST /api/push/test", s.limited(s.pushTest))
	mux.HandleFunc("GET /manifest.webmanifest", s.manifest)
	mux.HandleFunc("GET /sw.js", s.serviceWorker)
	mux.HandleFunc("GET /club.css", s.clubCSS)
	mux.HandleFunc("GET /static/", s.static)
	for _, p := range []string{"/apple-touch-icon.png", "/icon-192.png", "/icon-512.png"} {
		mux.HandleFunc("GET "+p, s.iconPNG)
	}

	sites := s.withClub(mux)
	root := http.NewServeMux()
	root.HandleFunc("GET /health", func(w http.ResponseWriter, r *http.Request) { w.Write([]byte("ok")) })
	root.Handle("/", sites)
	return s.logged(secure(root))
}

// withClub resolves the club and redirects page views on the railway.app address to the canonical domain.
// The service worker, icons and push API stay put so existing installs keep working.
func (s *Server) withClub(next http.Handler) http.Handler {
	pages := map[string]bool{"/": true, "/filtered": true, "/status": true, "/shorts": true, "/squad": true}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		host := r.Host
		if canon := s.cfg.CanonicalHost; canon != "" && r.Method == http.MethodGet && pages[r.URL.Path] {
			h := strings.ToLower(strings.Split(host, ":")[0])
			if h != canon && strings.HasSuffix(h, ".up.railway.app") {
				http.Redirect(w, r, "https://"+canon+r.URL.RequestURI(), http.StatusMovedPermanently)
				return
			}
		}
		c := s.cfg.Resolver.Resolve(host)
		if c == nil {
			http.NotFound(w, r)
			return
		}
		next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), ctxKey{}, c)))
	})
}

const csp = "default-src 'self'; script-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; " +
	"img-src 'self' data: https://i.ytimg.com; frame-src https://www.youtube.com; connect-src 'self'; manifest-src 'self'; worker-src 'self'; " +
	"object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'"

// secure adds the security headers every response carries.
func secure(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("Content-Security-Policy", csp)
		h.Set("Strict-Transport-Security", "max-age=63072000; includeSubDomains")
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("Referrer-Policy", "no-referrer")
		h.Set("X-Frame-Options", "DENY")
		h.Set("Cross-Origin-Opener-Policy", "same-origin")
		h.Set("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=()")
		next.ServeHTTP(w, r)
	})
}

type statusWriter struct {
	http.ResponseWriter
	code int
}

func (w *statusWriter) WriteHeader(c int) { w.code = c; w.ResponseWriter.WriteHeader(c) }

func (s *Server) logged(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		sw := &statusWriter{ResponseWriter: w, code: 200}
		defer func() {
			if v := recover(); v != nil {
				slog.Error("handler panicked", "path", r.URL.Path, "panic", v, "stack", string(debug.Stack()))
				http.Error(sw, "Something went wrong rendering this page.", http.StatusInternalServerError)
			}
			if r.URL.Path != "/health" {
				slog.Info("request", "method", r.Method, "host", r.Host, "path", r.URL.Path, "status", sw.code, "ms", time.Since(start).Milliseconds())
			}
		}()
		next.ServeHTTP(sw, r)
	})
}

// ---------- data ----------

// state reads a club's state with a 30 second cache. On a read failure the last good copy is kept and retried soon.
func (s *Server) state(ctx context.Context, c *club.Club) (*wire.State, []byte) {
	s.mu.Lock()
	e := s.states[c.Slug]
	if e == nil {
		e = &cached[*wire.State]{}
		s.states[c.Slug] = e
	}
	s.mu.Unlock()
	e.mu.Lock()
	defer e.mu.Unlock()
	if s.now().Sub(e.at) < 30*time.Second {
		return e.val, e.raw
	}
	b, err := s.store.Get(ctx, poll.StateKey(c))
	switch {
	case errors.Is(err, store.ErrNotFound):
		e.val, e.raw, e.at = nil, nil, s.now()
	case err != nil:
		slog.Error("state read failed", "club", c.Slug, "err", err)
		e.at = s.now().Add(-20 * time.Second)
	default:
		var st wire.State
		if err := json.Unmarshal(b, &st); err != nil {
			slog.Error("state unreadable", "club", c.Slug, "err", err)
			e.at = s.now().Add(-20 * time.Second)
			break
		}
		e.val, e.raw, e.at = st.Init(), b, s.now()
	}
	return e.val, e.raw
}

// squad reads the squad store with a two minute cache, giving up after four seconds so it never holds up a page.
func (s *Server) squad(ctx context.Context) *squad.Data {
	e := s.squadData
	done := make(chan *squad.Data, 1)
	go func() {
		e.mu.Lock()
		defer e.mu.Unlock()
		if s.now().Sub(e.at) < 2*time.Minute {
			done <- e.val
			return
		}
		lctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
		defer cancel()
		b, err := s.store.Get(lctx, squad.Key)
		if err == nil {
			var d squad.Data
			if err = json.Unmarshal(b, &d); err == nil {
				e.val, e.at = &d, s.now()
			}
		}
		if errors.Is(err, store.ErrNotFound) {
			e.at = s.now()
		} else if err != nil {
			slog.Error("squad read failed", "err", err)
			e.at = s.now().Add(-90 * time.Second)
		}
		done <- e.val
	}()
	select {
	case d := <-done:
		return d
	case <-time.After(4 * time.Second):
		return nil
	case <-ctx.Done():
		return nil
	}
}

// ---------- pages ----------

func (s *Server) page(name string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		c := clubOf(r)
		st, _ := s.state(r.Context(), c)
		now := s.now()
		var p *page
		switch name {
		case "wire":
			p = s.wirePage(c, st, now)
		case "filtered":
			p = s.filteredPage(c, st, now)
		case "status":
			p = s.statusPage(c, st, s.squad(r.Context()), now)
		case "squad":
			p = s.squadPage(c, st, s.squad(r.Context()), now)
		}
		s.render(w, s.pages[name], "layout", p)
	}
}

func (s *Server) render(w http.ResponseWriter, t *template.Template, name string, data any) {
	var buf bytes.Buffer
	if err := t.ExecuteTemplate(&buf, name, data); err != nil {
		slog.Error("render failed", "template", name, "err", err)
		http.Error(w, "Something went wrong rendering this page.", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.Write(buf.Bytes())
}

func (s *Server) shortsPage(w http.ResponseWriter, r *http.Request) {
	c := clubOf(r)
	var names []string
	for _, ch := range c.Shorts {
		names = append(names, ch.Name)
	}
	list := strings.Join(names, ", ")
	if n := len(names); n > 1 {
		list = strings.Join(names[:n-1], ", ") + " and " + names[n-1]
	}
	w.Header().Set("Referrer-Policy", "strict-origin-when-cross-origin") // YouTube embeds need the origin
	w.Header().Set("X-Robots-Tag", "noindex")
	s.render(w, s.shorts, "shorts", &page{Club: c, Favicon: favicon(c.Colours.Accent), Fonts: fontsURL, Data: list})
}

// ---------- APIs ----------

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	json.NewEncoder(w).Encode(v)
}

func (s *Server) apiVersion(w http.ResponseWriter, r *http.Request) {
	c := clubOf(r)
	st, _ := s.state(r.Context(), c)
	out := map[string]any{"lastRun": nil, "stories": 0}
	if st != nil {
		if !st.LastRun.IsZero() {
			out["lastRun"] = iso(st.LastRun)
		}
		out["stories"] = len(st.Stories(c.OfficialName()))
	}
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, 200, out)
}

func (s *Server) apiState(w http.ResponseWriter, r *http.Request) {
	_, raw := s.state(r.Context(), clubOf(r))
	if raw == nil {
		raw = []byte("null")
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.Write(raw)
}

// shorts merges every channel's Shorts feed, newest first, cached five minutes. If every feed fails the last good
// list is kept and retried after a minute.
func (s *Server) loadShorts(ctx context.Context, c *club.Club) []source.Short {
	s.mu.Lock()
	e := s.shortList[c.Slug]
	if e == nil {
		e = &cached[[]source.Short]{}
		s.shortList[c.Slug] = e
	}
	s.mu.Unlock()
	e.mu.Lock()
	defer e.mu.Unlock()
	if s.now().Sub(e.at) < 5*time.Minute {
		return e.val
	}
	results := make([][]source.Short, len(c.Shorts))
	var wg sync.WaitGroup
	for i, ch := range c.Shorts {
		wg.Add(1)
		go func() {
			defer wg.Done()
			b, err := s.fetch.Get(ctx, source.ShortsFeedURL(ch.ID), "", 10*time.Second)
			if err != nil {
				slog.Warn("shorts feed failed", "channel", ch.Name, "err", err)
				return
			}
			if results[i], err = source.ParseShorts(b, ch.Name); err != nil {
				slog.Warn("shorts feed unreadable", "channel", ch.Name, "err", err)
			}
		}()
	}
	wg.Wait()
	seen := map[string]bool{}
	var all []source.Short
	for _, l := range results {
		for _, x := range l {
			if !seen[x.ID] {
				seen[x.ID] = true
				all = append(all, x)
			}
		}
	}
	sort.SliceStable(all, func(i, j int) bool { return all[i].Published.After(all[j].Published) })
	if len(all) > 0 {
		e.val, e.at = all, s.now()
	} else {
		e.at = s.now().Add(-4 * time.Minute)
	}
	return e.val
}

func (s *Server) apiShorts(w http.ResponseWriter, r *http.Request) {
	list := s.loadShorts(r.Context(), clubOf(r))
	if list == nil {
		list = []source.Short{}
	}
	res := make([]map[string]string, 0, len(list))
	for _, x := range list {
		res = append(res, map[string]string{"id": x.ID, "title": x.Title, "channel": x.Channel, "published": iso(x.Published)})
	}
	w.Header().Set("Cache-Control", "public, max-age=120")
	writeJSON(w, 200, res)
}

// ---------- static ----------

func (s *Server) static(w http.ResponseWriter, r *http.Request) {
	a, ok := s.byPath[r.URL.Path]
	if !ok {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Content-Type", a.ctype)
	w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
	w.Write(a.body)
}

func (s *Server) serviceWorker(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "text/javascript; charset=utf-8")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Service-Worker-Allowed", "/")
	w.Write(s.assets["sw.js"].body)
}

func (s *Server) manifest(w http.ResponseWriter, r *http.Request) {
	c := clubOf(r)
	m := map[string]any{
		"id": "/", "name": c.App(), "short_name": c.App(), "description": c.Name + " news from tier 1 sources only.",
		"start_url": "/", "scope": "/", "display": "standalone", "background_color": "#F5F6F7", "theme_color": "#F5F6F7",
		"icons": []map[string]string{
			{"src": "/icon-192.png", "sizes": "192x192", "type": "image/png", "purpose": "any"},
			{"src": "/icon-512.png", "sizes": "512x512", "type": "image/png", "purpose": "any"},
			{"src": "/icon-512.png", "sizes": "512x512", "type": "image/png", "purpose": "maskable"},
		},
	}
	w.Header().Set("Content-Type", "application/manifest+json")
	json.NewEncoder(w).Encode(m)
}

func (s *Server) clubCSS(w http.ResponseWriter, r *http.Request) {
	k := clubOf(r).Colours
	w.Header().Set("Content-Type", "text/css; charset=utf-8")
	w.Header().Set("Cache-Control", "public, max-age=3600")
	fmt.Fprintf(w, ":root{--red:%s;--red-text:%s;--red-wash:%s;--bad:%s}\n@media (prefers-color-scheme:dark){:root{--red:%s;--red-text:%s;--red-wash:%s;--bad:%s}}\n",
		k.Accent, k.AccentText, k.AccentWash, k.Accent, k.AccentDark, k.AccentTextDark, k.AccentWashDark, k.AccentDark)
}

func (s *Server) iconPNG(w http.ResponseWriter, r *http.Request) {
	c := clubOf(r)
	size := map[string]int{"/apple-touch-icon.png": 180, "/icon-192.png": 192, "/icon-512.png": 512}[r.URL.Path]
	key := fmt.Sprintf("%s-%d", c.Slug, size)
	s.mu.Lock()
	b, ok := s.icons[key]
	if !ok {
		b = drawIcon(size, c.Colours.Accent)
		s.icons[key] = b
	}
	s.mu.Unlock()
	w.Header().Set("Content-Type", "image/png")
	w.Header().Set("Cache-Control", "public, max-age=604800")
	w.Write(b)
}
