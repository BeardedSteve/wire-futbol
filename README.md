# wire-futbol

Club news wires for wire.futbol. Each club's wire reads tier 1 sources, keeps the news, drops opinion, rumour and clickbait, and shows the rest in one place. Liverpool runs at lfc.wire.futbol.

Production runs the Go app under `cmd/` and `internal/` (since 23 October 2026). The old Bun/TypeScript app under `services/` and `lib/` stays in the repo as a rollback until it is removed.

## How it fits together

One binary, `wire`, with three commands:

| Command | What it does | Runs on Railway as |
|---|---|---|
| `wire serve` | Web service for every enabled club. The club comes from the Host header | Always-on service |
| `wire poll` | Reads every enabled club's sources, filters new items with Gemini, sends alerts, writes `<club>/state.json` | Cron, every 15 minutes |
| `wire squad` | Copies the Fantasy Premier League (FPL) feed into `fpl.json` for the squad pages | Cron, every 2 hours |

Everything is stored as JSON in a Railway bucket (or a local directory). A source used by several clubs is fetched once per run. A failing source or club never stops the others.

| Package | Holds |
|---|---|
| `internal/club` | Club and source config (`clubs.go`), Host to club resolution |
| `internal/source` | RSS/Atom, club website, fixtures, YouTube Shorts parsers |
| `internal/fetch` | Outbound HTTP: timeouts, retries with backoff, size cap |
| `internal/filter` | Gemini prompt (`prompt.tmpl`), schema and clustering |
| `internal/wire` | State file model and story building |
| `internal/poll` | One poller run |
| `internal/squad` | FPL import and squad stats |
| `internal/push` | Web push: encryption, VAPID, subscriptions |
| `internal/store` | Bucket (S3 API) and local directory storage |
| `internal/web` | Handlers, templates, static files |

There are no third-party Go modules. The standard library covers HTTP, templates, XML, JSON, crypto and logging.

## Run it locally

Needs Go 1.27.3 (`go.mod` pins it; `GOTOOLCHAIN=auto` fetches it).

```sh
go test ./...
go run ./cmd/wire squad          # needs network access to fantasy.premierleague.com
GEMINI_API_KEY=... go run ./cmd/wire poll
DEFAULT_CLUB=lfc go run ./cmd/wire serve   # http://localhost:3000
```

Without `S3_BUCKET` everything is read from and written to `./data` (or `DATA_DIR`). `DEFAULT_CLUB` picks the club for hosts outside wire.futbol, such as localhost or a railway.app domain. To view a copy of production, put its `/api/state.json` at `data/lfc/state.json`.

Container: `docker build -f deploy/Dockerfile -t wire-futbol .` then `docker run -p 3000:3000 -e DEFAULT_CLUB=lfc wire-futbol`.

### Environment

| Variable | Used by | Default |
|---|---|---|
| `PORT` | serve | 3000 |
| `DEFAULT_CLUB` | serve | none |
| `CANONICAL_HOST` | serve: redirects page views on `*.up.railway.app` | none |
| `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_ENDPOINT`, `S3_REGION`, `S3_VIRTUAL_HOSTED` | all | local `./data` |
| `DATA_DIR` | all, without a bucket | `./data` |
| `GEMINI_API_KEY`, `GEMINI_MODEL`, `GEMINI_THINKING_LEVEL`, `GEMINI_BASE_URL` | poll (model name shown by serve) | `gemini-3.8-flash`, `low` |
| `DAILY_TOKEN_CAP` | poll | 150000 |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` | serve, poll | alerts off |
| `MAX_PUSH_PER_DAY`, `QUIET_START_HOUR`, `QUIET_END_HOUR` | poll (cap shown by serve) | 6, 22, 7 |
| `MAX_SUBS` | serve, poll: alert devices per club | 100 |
| `INGEST_MAX_AGE_H` | poll | 72 |
| `SOURCES` | poll: comma-separated source keys to read | all |
| `SEED_STATE_URLS` | poll, staging only: `lfc=https://.../api/state.json` | none |
| `LEGACY_CLUB` | serve, poll: copies the Bun app's root `state.json` and `subs.json` to this club's keys if they don't exist yet | none |
| `SAVE_FIXTURES` | poll, squad: `1` saves every fetched body under `fixtures/` in the store | off |
| `PRICE_IN_PER_MTOK_USD`, `PRICE_OUT_PER_MTOK_USD`, `USD_TO_GBP` | serve | 0.75, 3.75, 0.75 |

## Add a source

1. Add an entry to `Sources` in `internal/club/clubs.go` with a new key. `Kind` is `RSS` for an RSS or Atom feed, or `ClubSite` for a club website news index (set `SiteBase` and `TitleSuffix`).
2. Add the key to `Sources` for each club that should read it.
3. If it is a new outlet, add it to the club's `ReadsLine` and `Prompt.Outlets` so the footer and the filter know about it.
4. Run `go test ./...`. `TestConfigIsConsistent` catches unknown keys.

A source listed by several clubs is fetched once and its items go to each club's filter.

## Add a club

1. Add a `Club` to `Clubs` in `internal/club/clubs.go`: slug, names, mark, host (`<slug>.wire.futbol`), sources, fixtures page, FPL team short name (for example `ARS`), Shorts channels, colours and prompt details. Leave `Enabled: false`.
2. Run `go test ./...`.
3. Turn on `Enabled`, deploy, and add the custom domain to the web service on Railway.

## Branches and environments

| Branch | Railway environment | Runs |
|---|---|---|
| `production` | production | Go app, built from `deploy/Dockerfile` |
| `main` | staging | Bun app |
| `claude/youthful-pascal-r6sggv` | `wire-futbol-go-staging` project | Go app, built from `deploy/Dockerfile` |

## CI

`.github/workflows/go.yml`: gofmt, `go vet`, staticcheck, govulncheck, tests with `-race`, container build and a smoke test of the image. Actions are pinned by commit SHA and Dependabot proposes updates for Go modules, actions and base images.

`.github/workflows/ci.yml` still checks the Bun app.

The Dockerfile lives in `deploy/` because Railway builds any root Dockerfile it finds, which would switch the Bun services on `main` to the Go image. Move it to the root at cutover.
