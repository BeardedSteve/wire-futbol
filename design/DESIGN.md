# Club Wire front end

A front end for fans who want news about their own club and nothing else. It is written to be lifted into the Go and htmx service: static CSS and JS, server-rendered HTML, and a small set of htmx fragments. Nothing in `services/` was touched.

Run it: `bun install && bun run design`, then open http://localhost:3100. A clock switcher at the bottom left jumps between quiet, matchday, live and full-time states and swaps club colours. Add `?demo=0` to hide it.

## What the fan is asking

Each visit is one of four questions. The page answers them in this order.

1. **Is anything happening?** Stop press ribbon for a major story under six hours old. Otherwise a plain "All quiet" line, so a quiet page reads as "nothing missed" and not "broken".
2. **When do we play, and who is missing?** The board at the top. It changes with the fixture calendar: next up with a countdown, matchday with seconds, live with elapsed time, full time with the score. Out and doubtful players sit on it as chips.
3. **Is it true?** Every story carries its provenance: a pip per outlet (five pips, the club's in red), the outlet links, and either a green "Club confirmed" stamp or a dashed amber "Awaiting club" tag on injury, transfer, contract and staff stories nobody official has confirmed. That is the product's promise, so it is visible on every card.
4. **What did I miss?** "N new since 09:14", a highlighter sweep on new headlines, per-browser, no server state.

The rail answers the supporting questions: fixtures, league position with last five results, treatment room, source health.

## Voice

Newspaper late edition meets scoreboard.

| Role | Family | Used for |
|---|---|---|
| Display | Big Shoulders Display (variable) | Nav, headings, the board, numerals |
| Text | Newsreader (variable, optical size) | Headlines and summaries |
| Mono | IBM Plex Mono | Times, slugs, provenance, data labels |

Newsprint paper with a faint tooth, ink black, and one club colour. Double rule under the masthead, 3px rules over each section, a halftone corner on the board. The sources page is "Spiked", the newsroom word for a story killed, in place of "Kept out". Fonts and htmx are self-hosted under `static/` (about 400 KB of fonts, 50 KB of htmx), so there are no third-party requests.

## Theming

One club per deployment. `<html data-club="lfc">` selects four tokens in `static/css/wire.css`: `--club`, `--club-deep`, `--club-ink`, `--club-wash` (plus `--club-text` for small text on paper). Two demo palettes are included at the top of the file. Light and dark follow the system, with `data-theme` to force one.

## Layout

- Phones: red masthead, bottom tab bar (Wire, Squad, Shorts, Spiked) for thumb reach, board first, then the feed. Rail panels sit below the feed.
- 980px and up: feed plus a sticky 330px rail. Sticky desk bar and day headings.
- Sizes are fluid. No horizontal scroll at 360px. Reduced motion is respected and the page works without JavaScript apart from live clocks.

## htmx contract

Navigation is `hx-boost` on `<body>`. Scripts live in `<head>` with `defer`, so body swaps never re-run them. `wire.js` and `push.js` listen for `htmx:afterSettle` to re-bind.

Responses vary on `HX-Request` and `HX-Target`, so send `Vary: HX-Request, HX-Target`. Fragment routes can alternatively return the full page and let htmx use `hx-select` on the target id. That costs a full render and needs no extra handler.

| Interaction | Request | Returns | Swap |
|---|---|---|---|
| Desk tabs | `GET /?desk=fitness` with `HX-Target: feedzone` | `#feedzone` (desk bar plus feed) | `outerHTML`, `hx-push-url` |
| New stories toast | `GET /fragments/pulse?run=ISO&n=36` every 120s | Empty poller, or a toast link when `lastRun` changed and the count rose | `outerHTML` on `#pulse` |
| Player detail | `GET /squad/player/{id}` on the `toggle` event of the `<details>`, `once` | Distribution strips as inline SVG, drawn on the server, tooltips as `<title>` | `innerHTML` of `.pr-x` |
| Spiked search and filter | `GET /spiked?q=&bucket=` on input of the form (180ms debounce) | `#spiked-results` (count and rows) | `outerHTML`, `hx-push-url` |
| Status refresh | `GET /status` every 30s with `hx-select="#status-live"` | Full page, selected | `outerHTML` |

Spiked reasons are radio inputs styled as rows, so filter state lives in the form and the URL.

Kept in the browser: relative times and countdown tiles (`wire.js`), the last-seen timestamp in `localStorage`, and the phone alert sheet (`push.js`, same logic as today). The server stamps `<html data-now>` and the client uses it as its clock reference, so a wrong phone clock does not skew "5 min ago".

## Component to data mapping

Each function in `render.ts` is a plain template string with the inputs it needs, so it ports to one Go template block.

| Component (`render.ts`) | Needs |
|---|---|
| `shell` | active section, lastRun, health, phase |
| `board` | next fixture, last result, squad flags, `now` |
| `stopPress`, `splashHtml`, `storyHtml` | story clusters: items, lead, material, pushed, official |
| `feedzone` | stories, desk, counts per desk |
| `standingPanel` | league table and last five results (computed from finished fixtures in `data.ts`) |
| `treatmentPanel`, squad page | squad model from `lib/squad/core.ts` |
| `playerStrips` | percentile pools per position |
| `spikedResults` | dropped items and drop kind |

Phase logic (`phase()`): live from kick-off to 2.5 hours after, matchday on the day or within six hours, full time for 20 hours after a result, otherwise next up.

## Not done

- **Shorts** keeps its current player and gets only the new masthead and tokens. The page here is a placeholder.
- **Live score** is not shown during a match because the wire has no score feed. The board shows elapsed time and a link to the club's match centre. A score slot exists in the full-time variant.
- **Squad injury history** in the harness is one event per flagged player, so "missed N matches" is approximate. The service has the full status log.
- The league table is computed from FPL fixtures, so it covers league matches only.
- Untested in Safari and Firefox. Checked in Chromium at 390px and 1280px, light and dark.

## Files

- `static/css/wire.css`, `fonts.css`: the design system.
- `static/js/wire.js`, `push.js`, `sw.js`, `htmx.min.js` (2.0.4).
- `render.ts`, `data.ts`, `serve.ts`: harness only. Replace `data.ts` and `serve.ts` with the Go handlers.
- `screens/`: reference captures.
