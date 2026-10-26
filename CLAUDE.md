# Working on wire-futbol

See `README.md` for how the app fits together and `docs/design.md` for the front end.

## Copy on pages: as little as possible

The wire is for fans checking in on their phone. Every word on a page has to earn its place.

- No introductions, explanations or instructions above or under content. If a page needs a paragraph to make sense, fix the design.
- Labels, numbers and headlines carry the meaning: `Injured`, `5th, 12 pts`, `Unconfirmed`. Prefer a status word, icon or number over a sentence.
- Detail goes behind a tap (an open row, a `title`, the status page), not on the page by default.
- Empty and error states get one short line that says what is missing.
- Accessible names (`aria-label`, `sr-only`) may say more than the visible text. That is not page copy.
- Before adding a sentence to a template, try deleting it. Keep it only if a fan would be confused without it.
