# Go rewrite: phases 2 and 3 status

## Build and deploy times

Railway, all three services building from one push, measured from deployment created to ready (healthcheck passed for the web service).

| | Bun (lfc-wire production, 23 Oct) | Go (wire-futbol-go-staging, 23 Oct) |
|---|---|---|
| Web | 2 min 33 s | 68 s (first build, no cache), 2 min 24 s (second) |
| Wire poller | 4 min 30 s | 63 s, 55 s |
| Squad poller | 5 min 3 s | 59 s, 1 min 42 s |
| Whole release | about 5 min | 70 s to 2 min 24 s |

The second Go release was slower than the first because the three builds queued behind each other. Each service builds the same image separately; building once and deploying the image to all three would cut that further.

GitHub Actions for the Go app (gofmt, vet, staticcheck, govulncheck, race tests, image build and smoke test): 2 min 28 s.

Image: 22 MB, distroless static, non-root, no shell. Binary 11 MB.

## Decisions taken

- Squad data in `fpl.json` in the bucket. Postgres and the unread `fpl_snapshots` table are gone.
- No HTMX until something needs it.
- Push subscriptions: only browser push services are accepted as endpoints (Google FCM, Mozilla, Apple, Windows), a full list refuses new devices instead of evicting existing ones (`MAX_SUBS`, default 100), and the push API is limited to 20 requests per address per 10 minutes.
- One alert per story cluster even when two reports of it are due in the same run. The Bun app could send two.
- Staging is a separate Railway project, `wire-futbol-go-staging`, so no call made for it can reach `lfc-wire` production.
- Google Fonts stays for now (the design review may change it). The CSP allows `fonts.googleapis.com` and `fonts.gstatic.com`.
- The Dockerfile is in `deploy/` so Railway doesn't pick it up for the Bun services.

## Differences from the Bun app a user could see

- Pixel comparison of the wire, Kept out and Status pages on the same state file: identical. Shorts: identical apart from the video frame.
- Kept-out bucket "Not about Liverpool" is generated from the club name.
- Tooltip date format on times reads "Thursday 23 October, 14:05" (the Bun app's depends on the ICU version).

## Open items

- `GEMINI_API_KEY` must be set on the `poller` service in `wire-futbol-go-staging`. Until then new items stay pending on staging.
- Real fixtures for the RSS feeds, liverpoolfc.com and the fixtures page: the poller saves every response under `fixtures/` in the staging bucket (`SAVE_FIXTURES=1`), but this session can't reach those sites or read the bucket keys. They need copying into `testdata/` and wiring into the parser tests.
- Parity report: due 24 hours after the Gemini key is set.
- Spool: Worker `spool` and KV namespace `spool-seen` still exist on Cloudflare.
- At cutover: move `deploy/Dockerfile` to the root, copy `state.json` and `subs.json` to `lfc/` keys, and run `wire squad` once (FPL status history starts again; production's Postgres history also only began on 23 October).
