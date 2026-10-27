// Command wire runs wire.futbol: the web service and the two pollers, one binary.
//
//	wire serve   web service (always on)
//	wire poll    read sources, filter, alert, save state (cron, every 15 minutes)
//	wire squad   copy the Fantasy Premier League feed into the store (cron, every 2 hours)
package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"
	_ "time/tzdata" // the runtime image has no zoneinfo

	"github.com/BeardedSteve/wire-futbol/internal/club"
	"github.com/BeardedSteve/wire-futbol/internal/fetch"
	"github.com/BeardedSteve/wire-futbol/internal/filter"
	"github.com/BeardedSteve/wire-futbol/internal/poll"
	"github.com/BeardedSteve/wire-futbol/internal/push"
	"github.com/BeardedSteve/wire-futbol/internal/squad"
	"github.com/BeardedSteve/wire-futbol/internal/store"
	"github.com/BeardedSteve/wire-futbol/internal/web"
)

func env(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

func envInt(k string, def int) int {
	if n, err := strconv.Atoi(os.Getenv(k)); err == nil {
		return n
	}
	return def
}

func envFloat(k string, def float64) float64 {
	if f, err := strconv.ParseFloat(os.Getenv(k), 64); err == nil {
		return f
	}
	return def
}

func main() {
	slog.SetDefault(slog.New(slog.NewJSONHandler(os.Stdout, nil)))
	if len(os.Args) < 2 {
		fmt.Fprintln(os.Stderr, "usage: wire serve|poll|squad")
		os.Exit(2)
	}
	if v := os.Getenv("ENABLE_CLUBS"); v != "" {
		if unknown := club.Enable(strings.Split(v, ",")); len(unknown) > 0 {
			slog.Warn("ENABLE_CLUBS lists unknown clubs", "slugs", unknown)
		}
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	var err error
	switch os.Args[1] {
	case "serve":
		err = serve(ctx)
	case "poll":
		err = runPoll(ctx)
	case "squad":
		err = runSquad(ctx)
	default:
		err = fmt.Errorf("unknown command %q", os.Args[1])
	}
	if err != nil {
		slog.Error("failed", "command", os.Args[1], "err", err)
		os.Exit(1)
	}
}

func openStore() store.Store {
	st := store.FromEnv(os.Getenv, env("DATA_DIR", "./data"))
	if b, ok := st.(*store.S3); ok {
		slog.Info("store", "kind", "bucket", "bucket", b.Bucket)
	} else {
		slog.Info("store", "kind", "directory", "path", env("DATA_DIR", "./data"))
	}
	return st
}

func vapid() *push.VAPID {
	pub, priv := os.Getenv("VAPID_PUBLIC_KEY"), os.Getenv("VAPID_PRIVATE_KEY")
	if pub == "" || priv == "" {
		return nil
	}
	v, err := push.NewVAPID(pub, priv, env("VAPID_SUBJECT", "mailto:alerts@wire.futbol"))
	if err != nil {
		slog.Error("VAPID keys unusable, alerts off", "err", err)
		return nil
	}
	return v
}

// fetchClient is the outbound client. With SAVE_FIXTURES=1 every response body is also written to the store under
// fixtures/, so real responses can become test fixtures.
func fetchClient(st store.Store) *fetch.Client {
	c := &fetch.Client{HTTP: &http.Client{}}
	if os.Getenv("SAVE_FIXTURES") == "1" {
		c.Record = func(u string, body []byte) {
			ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
			defer cancel()
			if err := st.Put(ctx, "fixtures/"+url.PathEscape(u), body, "application/octet-stream"); err != nil {
				slog.Warn("fixture save failed", "url", u, "err", err)
			}
		}
	}
	return c
}

func serve(ctx context.Context) error {
	st := openStore()
	s, err := web.New(web.Config{
		Resolver:      club.Resolver{Default: os.Getenv("DEFAULT_CLUB")},
		CanonicalHost: os.Getenv("CANONICAL_HOST"),
		MaxPushPerDay: envInt("MAX_PUSH_PER_DAY", 6),
		MaxSubs:       envInt("MAX_SUBS", 100),
		Model:         env("GEMINI_MODEL", "gemini-3.8-flash"),
		PriceIn:       envFloat("PRICE_IN_PER_MTOK_USD", 0.75),
		PriceOut:      envFloat("PRICE_OUT_PER_MTOK_USD", 3.75),
		USDToGBP:      envFloat("USD_TO_GBP", 0.75),
	}, st, vapid(), &fetch.Client{UA: "wire.futbol/1.0", HTTP: &http.Client{}})
	if err != nil {
		return err
	}
	srv := &http.Server{
		Addr:              ":" + env("PORT", "3000"),
		Handler:           s.Handler(),
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       30 * time.Second,
		WriteTimeout:      60 * time.Second,
		IdleTimeout:       120 * time.Second,
		MaxHeaderBytes:    32 << 10,
	}
	go func() {
		<-ctx.Done()
		sctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		srv.Shutdown(sctx)
	}()
	slog.Info("web up", "addr", srv.Addr)
	if err := srv.ListenAndServe(); !errors.Is(err, http.ErrServerClosed) {
		return err
	}
	return nil
}

func runPoll(ctx context.Context) error {
	st := openStore()
	var sender *push.Sender
	if v := vapid(); v != nil {
		sender = &push.Sender{VAPID: v}
	}
	var only []string
	for _, s := range strings.Split(os.Getenv("SOURCES"), ",") {
		if s = strings.TrimSpace(s); s != "" {
			only = append(only, s)
		}
	}
	seeds := map[string]string{}
	for _, pair := range strings.Split(os.Getenv("SEED_STATE_URLS"), ",") {
		if slug, u, ok := strings.Cut(strings.TrimSpace(pair), "="); ok {
			seeds[slug] = u
		}
	}
	p := &poll.Poller{
		Store: st,
		Fetch: fetchClient(st),
		Filter: &filter.Filter{
			APIKey:   os.Getenv("GEMINI_API_KEY"),
			Model:    env("GEMINI_MODEL", "gemini-3.8-flash"),
			Thinking: env("GEMINI_THINKING_LEVEL", "low"),
			BaseURL:  os.Getenv("GEMINI_BASE_URL"),
			DailyCap: envInt("DAILY_TOKEN_CAP", 150000),
		},
		Push:          sender,
		MaxSubs:       envInt("MAX_SUBS", 100),
		MaxPushPerDay: envInt("MAX_PUSH_PER_DAY", 6),
		QuietStart:    envInt("QUIET_START_HOUR", 22),
		QuietEnd:      envInt("QUIET_END_HOUR", 7),
		IngestMaxAge:  time.Duration(envInt("INGEST_MAX_AGE_H", 72)) * time.Hour,
		RetainDays:    14,
		Only:          only,
		Seeds:         seeds,
	}
	ctx, cancel := context.WithTimeout(ctx, 12*time.Minute) // finish before the next 15-minute tick
	defer cancel()
	return p.Run(ctx)
}

func runSquad(ctx context.Context) error {
	st := openStore()
	fc := fetchClient(st)
	fc.UA = "wire.futbol/1.0 (+https://wire.futbol)"
	fc.Backoff = []time.Duration{5 * time.Second}
	get := func(ctx context.Context, path string) ([]byte, error) {
		return fc.Get(ctx, "https://fantasy.premierleague.com/api/"+path, fetch.AcceptJSON, 30*time.Second)
	}
	ctx, cancel := context.WithTimeout(ctx, 5*time.Minute)
	defer cancel()
	run, err := squad.Poll(ctx, st, get, time.Now())
	if err != nil {
		return err
	}
	slog.Info("squad poll ok", "season", run.Season, "players", run.Players, "status_changes", run.Events, "ms", run.Ms)
	return nil
}
