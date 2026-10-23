# wire-futbol

Club news wires for wire.futbol. Liverpool runs at lfc.wire.futbol on Railway.

## Services

| Service | What it does | Runs |
|---|---|---|
| `services/wire-web` | Web front: the wire, kept-out log, status, Shorts | Always on |
| `services/wire-poller` | Reads tier 1 sources, filters with Gemini, sends push alerts, writes `state.json` to the bucket | Every 15 minutes |
| `services/squad-poller` | Copies the Fantasy Premier League feed (players, fixtures, injury status changes) into Postgres for the squad page | Every 2 hours |

`lib/squad` holds the squad stats and injury logic shared by wire-web and the tests.

## Branches and environments

| Branch | Railway environment |
|---|---|
| `main` | staging |
| `production` | production |

Work goes in a branch and a pull request into `main`. CI must pass before merging. Merging deploys to staging. To release, open a pull request from `main` into `production`.

Staging has its own Postgres and bucket. Its wire-poller runs with `MAX_PUSH_PER_DAY=0` and a low `DAILY_TOKEN_CAP`, so it sends no alerts and spends little on Gemini. On its first run, `SEED_STATE_URL` copies production's public state so staging starts with real stories.

## Local development

```sh
bun install
bun run typecheck
bun test                      # smoke tests use DATABASE_URL when set
LOCAL_STATE=path/to/state.json bun run web
```

## CI

`.github/workflows/ci.yml` runs on every pull request and on pushes to `main` and `production`:

- type check (`tsc`)
- unit tests
- smoke tests that boot each service against Postgres and fixture data, and check every inline browser script parses

Test fixtures in `test/fixtures` are gzipped snapshots of real data from 23 October 2026.
