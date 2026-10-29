---
name: roadmap
description: The session routine for planning and shipping wire-futbol work from docs/roadmap.md. Use at the start of any session that asks what's next, what's the state of the wire, to add an idea, to plan, to work on the roadmap, or that opens with a short greeting and no task. Also use before merging, to update the roadmap in the same pull request.
---

# Roadmap sessions

Steve drives this from his phone a few times a week. Each session is a fresh container, so `docs/roadmap.md` and git are the only memory. Keep replies short enough to read on a phone: lines, not paragraphs.

## 1. Brief

Before anything else, gather this in parallel:

- `docs/roadmap.md`.
- Open pull requests and open issues on `BeardedSteve/wire-futbol`. Open issues are the inbox: ideas Steve jotted in the GitHub app between sessions.
- Production poller errors since the last roadmap change: Railway `get-logs`, project `10c8d9d9-f512-4cc7-bb45-21aa287ca64e`, environment `2fa3fe94-599f-4f65-ad44-200228797171`, service `wire-poller`, filter `@level:error OR @level:warn`. Count failures per source. Read `/status` on each club too if the network allows it.
- The last few production deployments, and whether each succeeded.

Then reply with at most eight lines:

- Health: one line per thing that's wrong against the bar, with numbers. "All green" if nothing.
- Inbox: one line per new issue, with where you'd rank it.
- Now: the top item, and what you'll do about it.
- One question, only if the answer changes what happens next.

If Steve's opening message already names a task, give the brief in three lines or fewer and get on with it.

## 2. Triage an idea

For each new idea, from chat or an inbox issue:

- Which line of the bar does it move? If none, it goes under Later or Decided against.
- Rank it against what's in Now and Next. Say where it went in one line.
- Write it in the roadmap as one item: a bold title, the evidence or reason, then "Done when:" with something a session can check.
- Close the inbox issue with a link to the pull request that added it.

Never add more than three items to Now. Something comes out first.

## 3. Work an item

- One roadmap item per pull request. If an item is bigger than one session, split it in the roadmap first and do the first part.
- Follow `CLAUDE.md`: minimal copy, every club the same, hosting as written.
- Run `gofmt -l .`, `go vet ./...` and `go test -race ./...` before every push.
- Front-end changes: run `wire serve` locally with test data, screenshot at 390px in light and dark with the pre-installed Chromium, and send the screenshots with `SendUserFile`. Steve reviews on his phone.
- Poller, source and filter changes: merge to `staging` first, read one poll cycle (15 minutes) of staging poller logs, then merge to `main`.
- Decide everything a reasonable engineer would decide alone, and say what you decided in the pull request. Ask Steve only about taste (what a fan sees or reads), anything that costs money, and anything listed under Waiting on Steve.

## 4. Ship

- In the same pull request, update `docs/roadmap.md`: delete the finished item (git keeps the history), promote the top of Next if Now has a free slot, add follow-ups found along the way, and move anything blocked on Steve to Waiting on Steve.
- Once CI is green, merge with a merge commit. Steve has said Claude may merge.
- Merging to `main` deploys production. Check the new deployment succeeds and the next poll logs no new errors.
- Reply in three lines: what changed for fans, the pull request link, what's next.

## Keep the roadmap honest

- Every item says why, with evidence and a date where there is one.
- "Done when" is something a later session can check without asking.
- Delete stale items. A short roadmap that's true beats a long one that isn't.
- Don't keep a shipped list. The pull requests are the record.
