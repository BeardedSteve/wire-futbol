# Go rewrite: phase 1 inventory

Snapshot of the Bun/TypeScript app on `main` at commit `0899082`, and of the Railway project `lfc-wire`, taken 23 October 2026.

Acronyms used: FPL (Fantasy Premier League), xG (expected goals), xA (expected assists), xGC (expected goals conceded), RSS (Really Simple Syndication), JSON-LD (JSON for Linked Data), PWA (progressive web app), VAPID (Voluntary Application Server Identification, the web push signing scheme), CSP (Content Security Policy), HSTS (HTTP Strict Transport Security), S3 (the Amazon S3 object storage API, used by Railway buckets), SigV4 (AWS Signature Version 4), KV (Cloudflare Workers key-value store), LLM (large language model).

## 1. What runs today

The app is Bun 1.4.4 and TypeScript, not Node. Three Railway services build from one repo:

| Service | Entry | Railway schedule | Purpose |
|---|---|---|---|
| wire-web | `services/wire-web/index.ts` (1,204 lines) | always on, `sleepApplication: true` | All pages and APIs |
| wire-poller | `services/wire-poller/index.ts` (422 lines) | cron `*/15 * * * *` | Fetch sources, filter with Gemini, cluster, push alerts, write `state.json` |
| squad-poller | `services/squad-poller/index.ts` (141 lines) | cron `13 */2 * * *` | Copy FPL players, fixtures and status changes into Postgres |

`lib/squad/core.ts` (187 lines) holds the pure squad stats logic.

npm dependencies: `fast-xml-parser@4` (RSS parsing in wire-poller) and `web-push@3` (VAPID signing and payload encryption). Dev: `typescript`, `@types/bun`, `@types/web-push`.

Environments: `production` (branch `production`) and `staging` (branch `main`). Each has its own Postgres. Both list a bucket called `wire-store` with the same resource id; Railway may scope bucket instances per environment, but I have not verified that staging and production write to different buckets.

### Spool

`spool` is a Cloudflare Worker (account `14882f2f...`), not a Railway service. It proxied YouTube feeds (`/api/feed`), served a channel list (`/api/channels`), kept a seen list in KV namespace `spool-seen` (`/api/seen`) and served static assets. Its Shorts feature now lives in wire-web at `/shorts`. No custom domain is attached, only the `workers.dev` subdomain.

Deletion attempted and refused: the Cloudflare connector lacks `workers-scripts.write`. Still to delete: Worker `spool`, then KV namespace `spool-seen` (`e7018d4388004554a77b06cac49a65b2`).

## 2. Routes

No route restricts its method except the push POSTs. Every page sends `cache-control: no-store`, `x-content-type-options: nosniff` and `referrer-policy: no-referrer` (Shorts uses `strict-origin-when-cross-origin` so YouTube embeds work). No CSP, no HSTS.

| Path | Method | What it does |
|---|---|---|
| `/health` | any | `ok` |
| `/` | any | The wire: one card per story, grouped by day |
| `/filtered` | any | Kept out: everything the filter dropped in 14 days, with reason buckets and search |
| `/status` | any | Source health, schedule, push count, fixtures and squad freshness, Gemini cost and tokens |
| `/squad` | any | Squad page (section 4) |
| `/shorts` | any | YouTube Shorts player, one at a time, swipe or keys |
| `/api/shorts` | any | Merged Shorts list as JSON, cached 5 minutes |
| `/api/version` | any | `{lastRun, stories}`, polled by the wire every 2 minutes |
| `/api/state.json` | any | The raw state file, public. Staging seeds itself from production's copy |
| `/api/push/key` | any | VAPID public key |
| `/api/push/subscribe` | POST | Store a push subscription, send a welcome push if new |
| `/api/push/unsubscribe` | POST | Remove a subscription |
| `/api/push/test` | POST | Send a test push to a stored subscription |
| `/manifest.webmanifest` | any | PWA manifest |
| `/sw.js` | any | Service worker: shows pushes, opens the story on tap |
| `/apple-touch-icon.png`, `/icon-192.png`, `/icon-512.png` | any | Icons drawn in code at startup |

Page views on `*.up.railway.app` redirect (301) to `CANONICAL_HOST`. Icons, service worker and push APIs do not redirect, so old installs keep working.

## 3. Features by page

**Wire (`/`)**
- Stories built from kept items by cluster id, then merged when summaries share at least 4 non-stop words and 60% of the smaller set, within 36 hours.
- Lead report: the club's own report if within 12 hours of the newest, else the newest.
- Card: time, summary, category, "Major" or "Alert sent" for material stories, one link per outlet (club first), expandable list of all reports.
- Category chips (All, Fitness, Transfers, Results, Club), shown when at least two groups exist. Choice remembered in `localStorage`.
- "New" badges and "N new since HH:MM" from a `localStorage` last-seen time.
- Toast "New stories. Show them" when `/api/version` reports a newer run with more stories.
- Next-fixture strip with live countdown; rail with next 5 fixtures and a status summary.
- Banner when the poller has not run for 45 minutes.
- Relative times refreshed client-side every minute.
- Shorts badge with the count of unseen Shorts.

**Kept out (`/filtered`)**: counts, noise percentage, bar chart of drop reasons (clickable filter), live text search. Items from before the `drop_kind` field are bucketed by regex on the free-text reason.

**Status (`/status`)**: headline state, per-source health, last run, 15-minute schedule, pushes today against the cap, fixtures and squad freshness, Gemini cost today and 7-day average in pence with a bar sparkline, model name, calls and tokens, pricing.

**Shorts (`/shorts`)**: merged Shorts from 5 YouTube channels, newest first, deduplicated. One embedded YouTube player at a time, seen/skip/undo, mark all seen, sound toggle, keyboard and swipe controls. Seen ids live in the viewer's `localStorage` (the old spool KV seen list is not used).

**Alerts (all pages)**: bell button opens a sheet. iPhone users get Add to Home Screen instructions. Subscribe, send test, turn off.

**PWA**: manifest, icons, service worker, standalone display.

**Buy Me a Coffee**: not present anywhere in the code. See decisions.

## 4. Squad view (built and live)

Data is Premier League matches only, from FPL.

- **Out now**: every flagged player (injured, doubtful with chance %, suspended, not eligible, unavailable), the FPL injury description, "since" date, league matches missed in the current spell, and a link to the newest wire fitness story from the last 21 days that names the player (accent-folded name matching with first-name disambiguation).
- **Position heatmaps**: goalkeepers, defenders, midfielders, forwards. Five stats each, per 90 minutes unless noted, coloured by percentile in 7 steps against every Premier League player at that position with at least a third of their team's league minutes (minimum 90):
  - Goalkeepers: saves, goals conceded, xGC, goals prevented (xGC minus conceded), clean sheet % of starts.
  - Defenders: defensive contributions, recoveries, xGC, xG, xA.
  - Midfielders: goals, xG, assists, xA, defensive contributions.
  - Forwards: goals, xG, assists, xA, finishing (goals minus xG).
  - Lower-is-better stats are inverted. Players under 90 minutes are listed separately.
- **Player drill-down**: tap a row for strip plots of every ranked player at the position, teammates highlighted, the player on top, median line, rank such as "joint 3rd of 120", hover or tap tooltips.
- **Availability matrix**: one column per finished league match, each player marked played, injured or doubtful, suspended, or didn't play. Uses FPL bonus-points lists as the appearance record and the stored status log for status at kickoff.
- **Left or on loan** list.

Gaps against your brief's list: none. Goals, xG, assists, xA, per 90, positional comparison and injury status are all built. Cup matches are not covered.

## 5. Data sources

| Source | URL | Format | Poll | Notes |
|---|---|---|---|---|
| liverpoolfc.com news | `https://www.liverpoolfc.com/news` | HTML | 15 min | Regex for `/news/<slug>` links, then up to 15 unseen article pages per run: `og:title`, `og:description`, `datePublished` |
| Sky Sports | `https://www.skysports.com/rss/11669` | RSS | 15 min | First 40 items |
| BBC Sport | `https://feeds.bbci.co.uk/sport/football/teams/liverpool/rss.xml` | RSS | 15 min | First 40 items |
| Liverpool Echo | `https://www.liverpoolecho.co.uk/all-about/liverpool-fc?service=rss` | RSS | 15 min | First 40 items |
| The Athletic | `https://www.nytimes.com/athletic/rss/football/liverpool/` | RSS | 15 min | First 40 items |
| Club fixtures | `https://www.liverpoolfc.com/matches/mens-team/fixtures` | HTML with JSON-LD `SportsEvent` | 3 h, piggybacks on the 15 min run | Next 8, competition from URL |
| FPL | `https://fantasy.premierleague.com/api/bootstrap-static/`, `/api/fixtures/` | JSON | 2 h | Sanity checks: 400+ players, 20 teams, 300+ fixtures |
| YouTube Shorts | `https://www.youtube.com/feeds/videos.xml?playlist_id=UUSH<channel>` | Atom | On request, cached 5 min | Liverpool FC, Anfield Watch, The Redmen TV, The Anfield Wrap, Fabrizio Romano |
| Google Fonts | `fonts.googleapis.com` (Archivo) | CSS, woff2 | Each page view, from the browser | Third-party request from every visitor |

Fetch rules: 20 s timeout per request (30 s fixtures, 10 s YouTube, 30 s FPL), browser user agent for news, no retry on news sources (a failure is retried on the next run), FPL retried once after 5 s.

## 6. Filtering rules

- Ingest only items published in the last 72 hours (`INGEST_MAX_AGE_H`). URL normalised (query and fragment stripped). Item id is the first 12 hex characters of SHA-1 of the URL.
- Gemini (`gemini-3.8-flash`, thinking level low, temperature 0.2) classifies pending items, newest first, 20 per call, at most 60 per run. The system prompt is the filtering policy: keep injuries, results, confirmed or first-hand transfers and contracts, staff changes, ownership and regulation, substantive press conference news, material loan news. Drop opinion, reaction, relayed rumour, clickbait, listings and promos, nostalgia, other clubs, minor women's and academy items.
- Structured output schema constrains ids, categories (10), drop kinds (10) and cluster targets to valid values. Results are de-duplicated by id. Missing results stay pending for the next run.
- Summaries have em and en dashes replaced with commas.
- `material` flags phone-worthy news. Cluster pointers are collapsed through chains up to 5 hops.
- Daily token cap 150,000 (`DAILY_TOKEN_CAP`). 400 retried once without thinking, 429/500/503 retried after 5 s and 20 s.
- Retention 14 days for items, usage and push counts.

## 7. Push alerts

- Material, unpushed, published within 12 hours, one per cluster, not between 22:00 and 07:00 UK, at most 6 a day.
- Two or fewer due: one push each, titled by category, "Club confirmed" when liverpoolfc.com is in the cluster. More: one digest.
- Source failing 4 runs in a row: low-urgency push, and again when it recovers.
- Subscriptions live in `subs.json` in the bucket, capped at 10. Gone endpoints (404, 410) are pruned.

## 8. Data stores

| Store | Key or table | Written by | Read by |
|---|---|---|---|
| Bucket | `state.json` (items, source health, usage, push counts, last run, model error, fixtures) | wire-poller, once per run | wire-web (30 s cache), staging seed |
| Bucket | `subs.json` | wire-web, wire-poller | both |
| Postgres | `fpl_teams`, `fpl_players`, `fpl_fixtures`, `fpl_status_events`, `fpl_runs` | squad-poller | wire-web (2 min cache, 4 s timeout so the squad can't hold up a page) |
| Postgres | `fpl_snapshots` (daily per-player) | squad-poller | nothing |
| Browser | `localStorage`: filter, last seen, Shorts seen, sound, tip | client | client |

Local mode: `./data/` for the poller and `LOCAL_STATE` for the web.

## 9. Environment variables

| Variable | Used by | Default |
|---|---|---|
| `PORT` | web | 3000 |
| `CANONICAL_HOST` | web | none |
| `LOCAL_STATE` | web | none |
| `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_ENDPOINT`, `S3_REGION`, `S3_VIRTUAL_HOSTED` | web, wire-poller | region `auto` |
| `DATABASE_URL` | web, squad-poller | none |
| `SQUAD_CLUB` | web | `LIV` |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` | web, wire-poller | subject falls back to the railway.app URL |
| `WIRE_URL` | wire-poller (VAPID subject fallback) | none |
| `GEMINI_API_KEY`, `GEMINI_MODEL`, `GEMINI_THINKING_LEVEL`, `GEMINI_BASE_URL` | wire-poller (model name also shown by web) | `gemini-3.8-flash`, `low` |
| `DAILY_TOKEN_CAP`, `INGEST_MAX_AGE_H`, `MAX_PUSH_PER_DAY`, `QUIET_START_HOUR`, `QUIET_END_HOUR`, `SOURCES` | wire-poller (cap shown by web) | 150000, 72, 6, 22, 7, all |
| `SEED_STATE_URL` | wire-poller, staging only | none |
| `PRICE_IN_PER_MTOK_USD`, `PRICE_OUT_PER_MTOK_USD`, `USD_TO_GBP` | web | 0.75, 3.75, 0.75 |
| `SHORTS_CHANNELS` | web | 5 channels above |
| `NOW_OVERRIDE`, `FPL_BOOT_FILE`, `FPL_FIXTURES_FILE` | squad-poller, testing | none |

Set on Railway but unused by the code: `NTFY_TOPIC` (shared), `GEMINI_API_KEY` on wire-web.

## 10. External integrations

Gemini API (`generativelanguage.googleapis.com`), browser push services via VAPID, Railway bucket (S3 API), Railway Postgres, YouTube embeds and thumbnails (`www.youtube.com`, `i.ytimg.com`), Google Fonts.

## 11. Security observations in the current app

1. **Subscriber eviction.** `/api/push/subscribe` is unauthenticated, puts new subscriptions first and keeps 10. Ten POSTs with fake endpoints push every real subscriber out.
2. No CSP or HSTS. Pages use inline `<script>`, inline `<style>` and one inline `style="width:..."` attribute.
3. `/api/state.json` publishes the whole state, including Gemini error text and usage.
4. Unused secrets: `GEMINI_API_KEY` on wire-web, `NTFY_TOPIC`.
5. Every visitor's browser calls Google Fonts.
6. HTML escaping of scraped text is consistent (`esc()` everywhere, `<` escaped in embedded JSON). I found no injection path.

## 12. Build and deploy baseline

Railway, Railpack 0.43.0 builder, `bun install --frozen-lockfile`, image export, then healthcheck for wire-web. Each service builds its own image from the same commit.

| Deployment | Queued | Image exported | Ready | Queue to ready |
|---|---|---|---|---|
| production wire-web, release commit `349d6a4` | 10:25:04 | 10:27:16 | healthcheck passed 10:27:37 | 2 min 33 s |
| production wire-poller, same commit | 10:25:04 | 10:29:24 | 10:29:34 | 4 min 30 s |
| production squad-poller, same commit | 10:25:04 | 10:29:59 | 10:30:07 | 5 min 3 s |
| staging wire-web, commit `0899082` | 09:53:07 | 09:56:25 | healthcheck passed 09:56:44 | 3 min 37 s |

A production release takes about 5 minutes until all three services are on the new image. CI (`bun install`, `tsc`, tests with Postgres) is extra; I have not timed it.

## 13. Proposed Go layout

One module, one binary, one image. Subcommands keep the current Railway shape (always-on web plus two crons), so the web service can still sleep when idle.

```
go.mod                      module wire.futbol, go 1.27
cmd/wire/main.go            wire serve | wire poll | wire squad
internal/club/              per-club config (Go literals), Host -> club resolution
internal/fetch/             HTTP client: per-source timeouts, retries with backoff, size limits
internal/source/            rss.go, clubsite.go (news + fixtures JSON-LD), fpl.go, youtube.go
internal/filter/            Gemini client, prompt template per club, schema, clustering
internal/wire/              state model, story building, similarity merge, retention
internal/squad/             port of lib/squad/core.ts
internal/push/              VAPID JWT and RFC 8291 payload encryption, subscription store
internal/store/             bucket client (S3 SigV4 GET/PUT/HEAD) and local directory
internal/web/               handlers, middleware (security headers, logging), templates
internal/web/static/        htmx.min.js (pinned), app.js, squad.js, shorts.js, sw.js, CSS, Archivo woff2
testdata/                   saved fixtures from the real sources
Dockerfile                  golang pinned by digest -> distroless static nonroot pinned by digest
```

Multi-tenancy: the poller loops over enabled clubs. A source used by several clubs (for example the FPL feed, or an outlet feed that covers more than one club) is fetched once per run and its items are tagged with every club whose config lists it. Each club gets its own Gemini prompt, state and subscriptions under a key prefix such as `liverpool/state.json`. A failing source only marks that source unhealthy, and each club's run is isolated so one club's error can't stop another's.

Templates and static files are embedded with `embed`, so the image holds a single file.

## 14. Proposed dependencies

| Module | Why | Alternative |
|---|---|---|
| Go 1.27.3 standard library | HTTP server and routing, `html/template`, `encoding/xml`, `encoding/json`, `log/slog`, `crypto/ecdh`, `crypto/ecdsa`, `crypto/hkdf`, `crypto/aes`, `crypto/hmac`, `embed` | - |
| `golang.org/x/net/html` | Parse liverpoolfc.com pages and fixtures JSON-LD with a real HTML tokeniser instead of regex | Keep regex, no dependency, more fragile |
| `github.com/jackc/pgx/v5` | Postgres driver for the squad tables. The standard library has no Postgres driver. Pulls in `jackc/pgpassfile`, `jackc/pgservicefile`, `jackc/puddle/v2`, `golang.org/x/text`, `golang.org/x/sync` | Drop Postgres and keep squad data as JSON in the bucket (zero third-party modules). See decisions |
| HTMX 2.0.11 | Vendored `htmx.min.js`, SHA-256 recorded in the repo, served from `/static/` | - |
| `honnef.co/go/tools` (staticcheck) v0.8.2, `golang.org/x/vuln` (govulncheck) v1.9.0 | CI only, pinned with the `tool` directive in `go.mod` so `go.sum` covers them. Not linked into the binary | Install in CI with `go install ...@version` |

Written in-house on standard library primitives:
- **S3 SigV4 signing** for three bucket operations, about 120 lines, tested against AWS's published signing examples. The SDK alternatives (`aws-sdk-go-v2`, `minio-go`) add large dependency trees.
- **Web push**: VAPID JWT (ES256) and RFC 8291 aes128gcm encryption, about 150 lines, tested against the worked example in RFC 8291. The usual module (`webpush-go`) pulls in a JWT library. This is crypto composition, so it gets the RFC test vector and a live test against a real browser subscription on staging.

## 15. Decisions for you

1. **Postgres or bucket for squad data.** Bucket JSON removes pgx and its five transitive modules, and removes two Postgres instances. The status log grows by a few hundred rows a season, which suits a JSON file. Postgres keeps the current schema and history as is. I recommend the bucket, migrating the existing status events once.
2. **HTMX.** Parity needs none: the current client code is plain JavaScript and the strip plots and Shorts player stay plain JavaScript. I propose vendoring it and using it only for the new-stories check (fetch the feed fragment instead of a full reload). Or leave it out until something needs it.
3. **Buy Me a Coffee.** The button isn't in the current app. Should I add it, and with which link and position? Adding it goes beyond parity.
4. **Subscriber eviction (11.1).** I'd fix it: reject new subscriptions when full, cap per club, and rate-limit the push endpoints. Parity would keep the hole.
5. **Staging.** A `staging` environment already exists, running the Bun app from `main`. I propose a new environment, `go-staging`, in `lfc-wire` with its own bucket, no pushes (`MAX_PUSH_PER_DAY=0`) and a low Gemini cap. The parity report would compare it with production's public `/api/state.json`, read only. Gemini cost roughly doubles during the parity run.
6. **Fonts.** Self-host Archivo (Open Font License) so pages make no third-party requests and the CSP stays tight. It looks identical.
7. **Spool.** Delete the Worker `spool` and KV `spool-seen` in the Cloudflare dashboard, or reconnect the Cloudflare connector with Workers Scripts Write and I'll do it.
