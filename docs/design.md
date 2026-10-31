# Front end

The web service's pages, built from the design on `claude/magical-babbage-dsryw0`: a newsprint sheet with a teletext service running through it. Server-rendered Go templates, one stylesheet, htmx for the parts that change in place, and about 150 lines of plain JavaScript.

## What the fan is asking

Each visit is one of four questions, answered in this order from the top of the wire.

1. **Is anything happening?** A major story under six hours old runs as a stop press ribbon. Between six and 24 hours it leads the page above the feed. If nothing has landed for 20 hours the page says "All quiet", so quiet reads as nothing missed, not broken.
2. **When do we play, and who is missing?** The board, the one dark panel on the sheet. It follows the calendar: next up with a countdown, matchday (from midnight, or six hours before kick-off) with seconds, live for two hours with time since kick-off, then the full-time score for 20 hours. Players ruled out and doubtful are listed on separate labelled lines, so the distinction never rests on colour alone.
3. **Is it true?** Every story states how sure we are, then who said it: `Confirmed` (green) when the club's own site carries it, `Unconfirmed` (amber) for injury, team news, transfer, contract and staff stories the club hasn't announced, otherwise `Reported`. The outlet links follow, the club's first.
4. **What did I miss?** "3 new since 09:14" and a green NEW flag, worked out in the browser from the last time it had the wire open.

## Copy

Minimal. No introductions or explanations on pages; labels, numbers, status words and icons carry the meaning, and detail sits behind a tap. The full rule is in `CLAUDE.md`.

## Pages

Every page has a teletext number. Typing three digits anywhere goes to it.

| No. | Route | Shows |
|---|---|---|
| 100 | `/` | The wire. Desks 110 Fitness, 120 Transfers, 130 Results, 140 Club are `/?desk=` |
| 200 | `/squad` | Every player with per-90 stats ranked against the division. Status icons after Football Manager: red cross injured, amber cross doubtful, red card suspended. Opening a row shows the injury, then the spread. Availability by match |
| 300 | `/table` | Next eight fixtures, the Premier League table and form |
| 400 | `/shorts` | The Shorts player, unchanged apart from the title block and tokens |
| 500 | `/spiked` | What the filter rejected and why. `/filtered` redirects here |
| 600 | `/status` | Sources, schedule, filter cost |

The first four are the phone tab bar, with the four teletext fast-text colours above them. From 980px the wire has a rail: fixtures, standing, treatment room and sources.

## htmx contract

Navigation is `hx-boost` on `<body>`, except links to Shorts, which has its own layout. Scripts load in `<head>` with `defer` and bind their listeners once at the document, so body swaps never re-run them. htmx is configured in a meta tag with eval, script tags and its injected indicator styles all off, which keeps the Content Security Policy at `script-src 'self'; style-src 'self'`.

Fragment responses depend on `HX-Request` and `HX-Target`, so every page sends `Vary: HX-Request, HX-Target`.

| Interaction | Request | Returns |
|---|---|---|
| Desk change | `GET /?desk=fitness`, target `feedzone` | `#feedzone`, plus the title block's page number out of band |
| New stories | `GET /fragments/pulse?run=&n=` every 120s | The poller again, or a toast once a new run adds stories |
| Player spread | `GET /squad/player/{id}` when a row first opens | Five dot plots as inline SVG |
| Spiked search | `GET /spiked?q=&bucket=`, target `spiked-results` | The count and rows; URL pushed |
| Status | `GET /status` every 30s, `hx-select="#status-live"` | The whole page, selected |

## Decisions that differ from the design branch

- **One provenance line.** The branch stated confidence, then repeated it as five outlet pips, then named the outlets. Three encodings of one fact per card became one: the status word, then the links.
- **Signal colours mean status only.** The branch said so, then gave section headings decorative teletext colours. Every section rule now carries the club square.
- **Nothing blinks unless it needs you.** The status lamp no longer flashes when all is well. Only "Live now" and a stale wire blink, and neither does with reduced motion.
- **Double height that wraps.** Teletext double height is done by setting the type twice as large in a box twice as wide, then squeezing it to half width. Long club names wrap inside the board instead of running off it.
- **Honest elapsed time.** The board shows wall-clock time since kick-off (`T+57 min`). It doesn't guess half-time or cap at 90, because it has no match clock.
- **The lead story stays for 24 hours, not 72,** and is the most widely reported major story in the window, not just the newest.
- **No inline styles.** Bars on the squad and spiked pages are SVG, so the CSP needs no `unsafe-inline`. The squad page's 19 KB of embedded JSON and its client-side chart code are replaced by plots drawn on the server, about 9 KB per player when a row is opened, positioned in percentages so they are sharp at any width. A small delegated handler shows the nearest player's name under a finger or pointer.
- **Fonts are self-hosted and subset.** Bedstead goes from 126 KB to 10 KB. Newsreader adds Latin Extended-A, which the branch's file lacked, so names like Çalhanoğlu or Kovář don't fall back to Georgia mid-word. No requests go to Google.
- **Amber is darker** (`#8f5200`). The branch's amber was 4.1:1 on paper, under the 4.5:1 that small text needs. Every token is now at least 4.7:1 on paper and card, light and dark.
- **Compression.** HTML, CSS, JavaScript and JSON are gzipped; static files are compressed once at start-up.
- **Shorts is page 400 and the fourth tab,** with its unseen count. Spiked moves to 500 and status to 600.
- **One layout for every club.** The rail always has fixtures, standing, treatment room and sources, in that order, with a one-line empty state. League fixtures, names and kick-offs come from FPL for every club. Cup and European ties come from BBC Sport's team fixtures page, which every club has. League fixtures link to the club's site; a tie links to BBC Sport's match page once BBC has one, otherwise to the club's site. The board shows no venue.

## Not done

- No live score during a match: the wire has no score feed. The board links to the club's match centre.
- The table and form come from Fantasy Premier League results, so they cover league matches only, and ties past goals scored fall back to the alphabet.
- Checked in Chromium at 390px and 1280px, light and dark. Untested in Safari and Firefox, so `:has()` on the spiked reasons (Firefox 121+, Safari 15.4+) and the double-height transform are the things to look at first.
