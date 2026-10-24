# Parity report: Bun and Go wires

Staging (Go, `wire-futbol-go-staging`) ran alongside production from 14:47 UTC on 23 October. Production switched from Bun to Go at 21:37 UTC that day, so the comparison has two parts:

1. Bun production against Go staging, 14:47 to 21:31 UTC on 23 October (the last Bun run was 21:30 UTC). 6.7 hours.
2. Go production against Go staging, 21:47 UTC on 23 October to 15:16 UTC on 24 October. 17.5 hours. This checks the production deployment, not the port.

Together they cover 24.2 hours. Items are matched by URL. Both wires call Gemini separately, so the same verdict on every item also shows the filter is stable run to run on this sample.

## Summary

| Window | Items seen by both | Same verdict | Different | Only one side |
|---|---|---|---|---|
| Bun vs Go staging (6.7 h) | 13 | 13 | 0 | 0 |
| Go production vs Go staging (17.5 h) | 26 | 26 | 0 | 0 |

Every source read without failures on both sides throughout. The `lfc` row reads 0 because liverpoolfc.com reports new articles only; it added items on both sides during the window.

One difference turned up before the window closed and is fixed: Sky Sports feed dates use a time zone abbreviation that neither runtime understands. Bun falls back to the fetch time; Go read it as UTC, an hour out. Go now does what Bun does (commit `b15f429`).

No alerts went out on either side: none of the 4 kept items was marked material. Push delivery from Go production is still unproven against a real subscriber.

## Bun production vs Go staging

Window: 2026-10-23 14:47 UTC to 2026-10-23 21:31 UTC (6.7 hours). Items are matched by URL and counted when either wire fetched them in the window.

| | Old (Bun, production) | New (Go, staging) |
|---|---|---|
| Items fetched | 13 | 13 |
| Kept | 1 | 1 |
| Dropped | 12 | 12 |
| Still pending | 0 | 0 |
| Stories with news in the window | 1 | 1 |

Seen by both: 13. Same verdict: 13. Different verdict: 0. Only old: 0. Only new: 0.

## Source health at the end

| Source | Old fails, last count | New fails, last count |
|---|---|---|
| athletic | 0, 40 | 0, 40 |
| bbc | 0, 24 | 0, 24 |
| echo | 0, 25 | 0, 25 |
| lfc | 0, 0 | 0, 0 |
| sky | 0, 20 | 0, 20 |

## Go production vs Go staging

Window: 2026-10-23 21:47 UTC to 2026-10-24 15:16 UTC (17.5 hours). Items are matched by URL and counted when either wire fetched them in the window.

| | Old (Bun, production) | New (Go, staging) |
|---|---|---|
| Items fetched | 26 | 26 |
| Kept | 3 | 3 |
| Dropped | 23 | 23 |
| Still pending | 0 | 0 |
| Stories with news in the window | 2 | 2 |

Seen by both: 26. Same verdict: 26. Different verdict: 0. Only old: 0. Only new: 0.

## Source health at the end

| Source | Old fails, last count | New fails, last count |
|---|---|---|
| athletic | 0, 40 | 0, 40 |
| bbc | 0, 24 | 0, 24 |
| echo | 0, 25 | 0, 25 |
| lfc | 0, 0 | 0, 0 |
| sky | 0, 20 | 0, 20 |
