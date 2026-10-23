# Third-party files in static/

| File | What | Licence |
|---|---|---|
| `Bedstead.woff2` | Bedstead by bjh21 (https://bjh21.me.uk/bedstead/), subset to Latin and punctuation | CC0-1.0, public domain |
| `Newsreader-latin.woff2`, `Newsreader-ext.woff2`, `Newsreader-italic.woff2` | Newsreader by Production Type, from Google Fonts, weight range trimmed and subset | SIL Open Font License 1.1, see `Newsreader-OFL.txt` |
| `htmx.min.js` | htmx 2.0.4 (https://htmx.org) | 0BSD |

The subsets were made with fontTools: Bedstead to U+0020-017F, general punctuation, arrows and two geometric shapes;
Newsreader roman pinned to weights 400 to 700 in Google's latin and latin-ext splits; Newsreader italic to weights
400 to 600 and printable ASCII, since italic is only used for the last word of page titles.
