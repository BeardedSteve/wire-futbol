# Club Wire front end

A front end for fans who want news about their own club and nothing else. It is written to be lifted into the Go and htmx service: static CSS and JS, server-rendered HTML, and a small set of htmx fragments. Nothing in `services/` was touched.

Run it: `bun install && bun run design`, then open http://localhost:3100. A clock switcher at the top left jumps between quiet, matchday, live and full-time states and swaps club colours. Add `?demo=0` to hide it.

## What the fan is asking

Each visit is one of four questions. The page answers them in this order.

1. **Is anything happening?** Stop press ribbon for a major story under six hours old. Otherwise a plain "All quiet" line, so a quiet page reads as "nothing missed" and not "broken".
2. **When do we play, and who is missing?** The board at the top. It changes with the fixture calendar: next up with a countdown, matchday with seconds, live with elapsed time, full time with the score. Out and doubtful players sit on it as chips.
3. **Is it true?** Every story carries its provenance: a block per outlet (five, the club's in red), the outlet links, and either a green "CLUB CONFIRMED" or a flashing yellow "AWAITING CLUB" on injury, transfer, contract and staff stories nobody official has confirmed. That is the product's promise, so it is visible on every card.
4. **What did I miss?** "N new since 09:14", a green NEW flag on new headlines, per-browser, no server state.

Supporting questions have their own pages: fixtures, league position and form (300), treatment room (200), source health (500).

## Voice: a working drawing with a teletext heart

Between a newsprint front page and a 1980s teletext service. Newsreader serif headlines on warm paper with a faint drawing-pad grid. Teletext's numbered pages, Bedstead mono labels and signal colours, used where they carry meaning. One dark instrument panel, the board, for the thing that is live. Dark mode inverts the paper.

Why it looks like this: it is built around someone who writes plain and short, does engineering for a living, and wants to know how sure we are. That is an inference from the brief, so change it freely.

- **Title block** instead of a masthead: page number, revision (a live clock), date, system status. Page numbers still work. Type three digits anywhere to jump (100 Wire, 110 to 140 desks, 200 Squad, 300 Table, 400 Spiked, 500 Status, 600 Shorts).
- **Stated confidence on every story.** `Confirmed by the club, plus 2 outlets`, `Unconfirmed: 1 outlet, club silent` (amber), or `Reported by 2 outlets`. The five outlet blocks stay, the club's in red. Nothing implies more certainty than we have.
- **Signal colours mean status only.** Green is confirmed or healthy, amber is unconfirmed or doubtful, red is out or major. Club red is also the one brand colour, so it is used for page rules and the next-match panel, not for decoration.
- **T-minus.** The countdown reads "T-minus to kick-off", then "T+57" once the match is on. It is a small nod and it is a real unit.
- **Squad as a data sheet.** Each stat is a value with a bullet bar to the percentile, and a six-step bar colour from red to green. The number is always printed. Player rows open to a server-drawn spread of the division.
- **Spiked** is the reject log, with the reason and a count. Search and filter are form fields.
- **Copy.** Short sentences, UK English, no filler.
- Four coloured keys on the phone tab bar are the fast-text nod, with the page number under each.

## Theming and layout

One club per deployment. `<html data-club="lfc">` sets `--club`. Two demo clubs are at the top of `static/css/wire.css`.

Phones: title block, board, feed, then the rail panels are reached through the tab bar pages. From 980px the rail (fixtures, standing, treatment room, sources) sits beside the feed and sticks.

## htmx contract

Navigation is `hx-boost` on `<body>`. Scripts live in `<head>` with `defer`, so body swaps never re-run them. `wire.js` and `push.js` listen for `htmx:afterSettle` to re-bind.

Responses vary on `HX-Request` and `HX-Target`, so send `Vary: HX-Request, HX-Target`. Fragment routes can alternatively return the full page and let htmx use `hx-select` on the target id. That costs a full render and needs no extra handler.

| Interaction | Request | Returns | Swap |
|---|---|---|---|
| Desk menu (110 to 140) | `GET /?desk=fitness` with `HX-Target: feedzone` | `#feedzone` (desk menu plus feed) | `outerHTML`, `hx-push-url` |
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
| `tablePage` | fixtures, league table and last five results (computed from finished fixtures in `data.ts`) |
| squad page and board chips | squad model from `lib/squad/core.ts` |
| `playerStrips` | percentile pools per position |
| `spikedResults` | dropped items and drop kind |

Phase logic (`phase()`): live from kick-off to 2.5 hours after, matchday on the day or within six hours, full time for 20 hours after a result, otherwise next up.

## Not done

- **Shorts** keeps its current player and gets only the new masthead and tokens. The page here is a placeholder.
- **The board** uses the pure teletext colours on black on purpose. Soften `--tk-*` if they are too bright.
- **Live score** is not shown during a match because the wire has no score feed. The board shows elapsed time and a link to the club's match centre. A score slot exists in the full-time variant.
- **Squad injury history** in the harness is one event per flagged player, so "missed N matches" is approximate. The service has the full status log.
- The league table is computed from FPL fixtures, so it covers league matches only.
- Untested in Safari and Firefox. Checked in Chromium at 390px and 1280px, light and dark.

## Files

- `static/css/wire.css`, `fonts.css`: the design system. `static/fonts/Bedstead.otf` is CC0 (licence file alongside). Newsreader is OFL.
- `static/js/wire.js`, `push.js`, `sw.js`, `htmx.min.js` (2.0.4).
- `render.ts`, `data.ts`, `serve.ts`: harness only. Replace `data.ts` and `serve.ts` with the Go handlers.
- `screens/`: reference captures.
