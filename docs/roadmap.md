# Roadmap

The plan for making the wire excellent. Claude reads this at the start of every session and changes it in the same pull request as the work. The `roadmap` skill (`.claude/skills/roadmap/SKILL.md`) is the session routine.

## The bar

What excellent means, and how a session checks it.

| | Excellent when | Checked by |
|---|---|---|
| Fresh | Every enabled club polled in the last 20 minutes. No source failing for more than an hour | Production poller logs |
| True | No rumour or opinion on the wire. No real news spiked | Sampling `/spiked` and the wire against the filter prompt |
| Calm | A fan's phone only buzzes for news that matters, never at night, never for our own faults | Push code paths and tests |
| Fast | The wire is usable on a phone over 4G in under a second | Page weight and a 390px Chromium run |
| Same for every club | Every club has the same panels, filled from the same kinds of source | `TestEveryClubSharesOneLayout` |
| Tidy | Railway and DNS match `CLAUDE.md` exactly | Railway MCP reads |

## Waiting on Steve

Things a session can't do from here. Each one is a few taps.

- **Let sessions see the live site.** The cloud environment's network policy blocks `lfc.wire.futbol`, `avfc.wire.futbol` and `afc.wire.futbol` (proxy 403, 29 Oct). Without them a session can't sample the wire or `/status`. Add the three hosts under Allowed domains in the environment's Network access settings: https://code.claude.com/docs/en/cloud-environments#network-access
- **Clear out Railway leftovers.** The `lfc-wire` project still has `Postgres` and `Postgres-1Eva` services, it isn't yet renamed `wire-futbol`, and the `production` branch still exists on GitHub. Deletes and renames time out over the Railway MCP. Ask the Railway agent in the project: "Delete the Postgres and Postgres-1Eva services in every environment, delete the project wire-futbol-go-staging, and rename this project to wire-futbol."

## Now

At most three. The top one is what the next session picks up unless Steve says otherwise.

1. **Stop pushing source failures to fans.** `internal/poll/poll.go:262` sends "X is failing" and "X is back" to every subscriber of the club after four failed runs, ignoring quiet hours and the daily cap. On 28-29 Oct that fired for arsenal.com twice in the evening and for The Athletic at 01:16 for all three clubs. Done when: source health only shows on `/status`, with a test that a failing source sends no push.
2. **arsenal.com fails about one poll in four.** The index returns HTTP 503 and article fetches hit their deadline (Railway logs, 28-29 Oct). Done when: the cause is known (rate limit, bot block or outage) and arsenal.com fails fewer than one poll a day, or it's swapped for a steadier official source.
3. **The Athletic went dark for four hours.** All three Athletic feeds returned 504 from 00:28 to 04:26 on 29 Oct and recovered on their own. Done when: one more night of logs shows whether this repeats. If it does, poll it less often overnight.

## Next

Ranked. A session moves the top one into Now when a Now slot frees up.

- **Settings page with an FPL switch.** First tester ask (Todd, 28-29 Oct): FPL points, form and value. Many fans don't play FPL, so it's opt-in per device. Steve's calls (30 Oct): a new Settings page in the nav, FPL off by default, stored in a cookie so the server draws the nav without a flash. The switch is per viewer, so every club still looks the same. Phone alerts move there too (Steve, 30 Oct): the masthead `Alerts` button and its dialog (`layout.html`, `push.js`) become a section on `/settings`. Done when: `/settings` exists for every club with an FPL switch and the alerts on/off and test controls, toggling FPL sets the cookie and shows or hides the FPL nav entry with a test for both states, and the masthead no longer carries the alerts button.
- **FPL insights page.** Behind the switch above. Keep `total_points`, `now_cost`, `form`, `event_points` and `selected_by_percent` from the bootstrap payload the poller already fetches (no new source). Store a per-gameweek points snapshot ourselves for hot and cold. Fetching each player's history would be about 600 calls a poll. Sections: top points, form, value (points per £m), and the club's players against the league's best at each position ("Matty Cash vs my right back"). The club's players are highlighted in every section. Done when: `/fpl` renders those sections for every enabled club, `TestEveryClubSharesOneLayout` covers it, and 390px screenshots in light and dark are reviewed.
- **Filter accuracy audit.** Sample a week of kept and spiked stories per club, count wrong calls, tune `internal/filter/prompt.tmpl`. Needs the live site (see Waiting on Steve).
- **Cup ties for Villa and Arsenal.** League fixtures come from FPL, cup ties only from a fixtures page, which only Liverpool has. Find one cup source every club has.
- **Check Safari and Firefox.** Only Chromium has seen the front end. `:has()` on the spiked reasons and the double-height transform are the first things to look at. Steve's iPhone is the quickest Safari check.
- **Table tie-breaks.** Ties past goals scored fall back to the alphabet. Use head-to-head from FPL results.

## Later

- Live scores during a match. Needs a score feed every club has.
- More clubs. Each one is a `clubs.go` entry, a staging check and three hosting records (README, Add a club).

## Decided against

Settled. Don't reopen without new evidence.

- Postgres or any database. JSON in a bucket covers it.
- Railway cron services. They never run on deploy, so `wire work` replaced them.
- Third-party Go modules. The standard library covers it.
- Inline styles or scripts. The Content Security Policy stays `'self'` only.
- Sections or panels that only some clubs show (`CLAUDE.md`, Every club looks the same).
