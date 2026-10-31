# Working on wire-futbol

See `README.md` for how the app fits together and `docs/design.md` for the front end.

## Planning

`docs/roadmap.md` is the plan: what excellent means, what's next, and what waits on Steve. Use the `roadmap` skill to run a session, and update the roadmap in the same pull request as the work. Open GitHub issues are an inbox to sweep into it.

## Copy on pages: as little as possible

The wire is for fans checking in on their phone. Every word on a page has to earn its place.

- No introductions, explanations or instructions above or under content. If a page needs a paragraph to make sense, fix the design.
- Labels, numbers and headlines carry the meaning: `Injured`, `5th, 12 pts`, `Unconfirmed`. Prefer a status word, icon or number over a sentence.
- Detail goes behind a tap (an open row, a `title`, the status page), not on the page by default.
- Empty and error states get one short line that says what is missing.
- Accessible names (`aria-label`, `sr-only`) may say more than the visible text. That is not page copy.
- Before adding a sentence to a template, try deleting it. Keep it only if a fan would be confused without it.

## Every club looks the same

Every club's pages show the same panels and sections in the same places. Only the club's name, colour and data differ.

- A section with no data keeps its heading and shows one short line (`No fixtures yet.`). Never drop a section or panel for one club.
- Anything shown must come from a source every club has. FPL is the record for league fixtures, the table and the squad. BBC Sport's team fixtures page (`BBCTeam` in `clubs.go`) adds cup and European ties.
- `TestEveryClubSharesOneLayout` compares every enabled club's pages. Keep it passing when you add a club or a section.

## Hosting: the one ideal state

Keep Railway and DNS exactly like this. If what you find differs, fix it back to this; never work around it.

- **One Railway project:** `lfc-wire` (id `10c8d9d9-f512-4cc7-bb45-21aa287ca64e`), to be renamed `wire-futbol`. Never create another project for wire.futbol. `wire-futbol-go-staging` is a mistake to delete.
- **Two environments in it, same services in each:**

| Environment | Id | Branch | Web URL |
|---|---|---|---|
| production | `2fa3fe94-599f-4f65-ad44-200228797171` | `main` | `<club>.wire.futbol` for every enabled club |
| staging | `c217a2cc-2bad-4b0a-9e8f-b15f1ae49e16` | `staging` | `wire-web-staging.up.railway.app`, `?club=<slug>` |

- **Services:** `wire-web` runs `/wire serve` with health check `/health`. `wire-poller` runs `/wire work`, restart always, no cron. Both build from `deploy/Dockerfile`, with `RAILWAY_DOCKERFILE_PATH=deploy/Dockerfile` shared so Railway never falls back to Railpack. Nothing else: no Postgres, no separate squad or cron services.
- **Storage:** each environment has its own `wire-store` bucket. Staging must never point at production's bucket.
- **Variables:** only those in the README's Environment table. No `DATABASE_URL`, `LEGACY_CLUB`, `NTFY_TOPIC`, `WIRE_URL`.
- **Domains:** production `wire-web` has a custom domain `<slug>.wire.futbol` for every club with `Enabled: true` in `internal/club/clubs.go` (today `lfc`, `avfc`, `afc`). DNS for wire.futbol is at Namecheap: one CNAME to the Railway target and one `_railway-verify.<slug>` TXT per club. A club is live only when all three exist: `Enabled: true` on `main`, the Railway custom domain, the DNS records.
- **Releases:** merging to `main` deploys production. Merge to `staging` first to try a change on staging. There is no `production` branch.

## Railway MCP: what works and what doesn't

Seen in practice (October 2026). Plan around it; don't retry the failures.

- **Works:** reads (`list-*`, `describe-*`, `get-logs`, `domain-status`, `get-staged-changes`), `update-service` and `set-variables` applied live to one environment, and `generate-domain`.
- **Fails:** `accept-deploy` and deletes. They ask the user to confirm, the question never reaches them, and the call times out after 60s. So never stage a change (`staged: true`): it can't be applied from here.
- **Trap:** `connect-service-source` without `staged` changes the branch in every environment at once. Don't use it to change one environment's branch.
- **Limits:** variable values come back redacted, so secrets can't be copied between environments or projects. `redeploy` fails on a service whose latest deployment was skipped. Pushing to the branch is the only way to get a fresh build.
- **Anything that needs accept-deploy, a delete or a branch switch:** give the user a short prompt for the Railway agent in the project, or exact dashboard steps.
