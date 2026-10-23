// Pure view functions: state in, HTML out. Written as plain template strings so each one maps one-to-one onto a Go html/template block.
// Every function that returns a "fragment" is also what the htmx endpoints return on their own (see DESIGN.md for the route table).
import { SQ_POS, nameMatcher, textMatches, type Avail, type SquadModel } from "../lib/squad/core.ts";
import { myId, squad, state, tableAt, type Item, type Row, type State, type Result, results as allResults } from "./data.ts";

const TZ = "Europe/London";
let NOW = new Date();
let FROZEN = false;
export const setNow = (d: Date, frozen = false) => { NOW = d; FROZEN = frozen; };
export const now = () => NOW;

// ---------- formatting ----------
export const esc = (s: unknown) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
const fmt = (iso: string | Date, o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat("en-GB", { timeZone: TZ, ...o }).format(new Date(iso));
const hm = (iso: string | Date) => fmt(iso, { hour: "2-digit", minute: "2-digit", hour12: false });
const dayKey = (iso: string | Date) => fmt(iso, { year: "numeric", month: "2-digit", day: "2-digit" });
const shortDay = (iso: string | Date) => fmt(iso, { weekday: "short", day: "numeric", month: "short" });
const shortDate = (iso: string | Date) => fmt(iso, { day: "numeric", month: "short" });
const ago = (iso: string) => Math.max(0, (NOW.getTime() - new Date(iso).getTime()) / 1000);
function dayLabel(iso: string) {
  const k = dayKey(iso);
  if (k === dayKey(NOW)) return "Today";
  if (k === dayKey(new Date(NOW.getTime() - 864e5))) return "Yesterday";
  return fmt(iso, { weekday: "long", day: "numeric", month: "long" });
}
function rel(iso: string) { // mirrored in wire.js so times stay current without a reload
  const s = ago(iso);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 6 * 3600) return `${Math.floor(s / 3600)}h ago`;
  if (dayKey(iso) === dayKey(NOW)) return hm(iso);
  if (dayKey(iso) === dayKey(new Date(NOW.getTime() - 864e5))) return `Yesterday ${hm(iso)}`;
  return `${shortDay(iso)} ${hm(iso)}`;
}
const timeTag = (iso: string) => `<time data-rel datetime="${esc(iso)}" title="${esc(fmt(iso, { weekday: "long", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" }))}">${esc(rel(iso))}</time>`;
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

// ---------- icons ----------
const ic = (d: string, extra = "") => `<svg class="i" viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${d}${extra}</svg>`;
const I = {
  wire: ic(`<path d="M2 4.5h12M2 8h12M2 11.5h7"/>`),
  squad: ic(`<path d="M5.6 2.5 2.2 4.4l1.2 2.7 1.5-.6v7h6.2v-7l1.5.6 1.2-2.7-3.4-1.9a2.4 2.4 0 0 1-4.8 0Z"/>`),
  shorts: ic(`<rect x="4" y="1.8" width="8" height="12.4" rx="2"/><path d="M7 6v4l3-2z" fill="currentColor"/>`),
  spiked: ic(`<path d="M8 1.8v8.4M5.6 10.2h4.8M8 10.2v4"/><circle cx="8" cy="3" r="1.2" fill="currentColor"/>`),
  bell: ic(`<path d="M8 2.2a3.8 3.8 0 0 0-3.8 3.8v2.4L3 10.6h10l-1.2-2.2V6A3.8 3.8 0 0 0 8 2.2ZM6.5 12.4a1.5 1.5 0 0 0 3 0"/>`),
  tick: ic(`<path d="m3.5 8.3 2.8 2.7 6.2-6.3" stroke-width="2.2"/>`),
  search: ic(`<circle cx="7" cy="7" r="4.5"/><path d="m10.5 10.5 3 3"/>`),
};

// ---------- categories and outlets ----------
type Group = "fitness" | "transfers" | "results" | "club";
const CATS: Record<string, { label: string; group: Group }> = {
  injury: { label: "Injury", group: "fitness" }, "team-news": { label: "Team news", group: "fitness" },
  transfer: { label: "Transfer", group: "transfers" }, contract: { label: "Contract", group: "transfers" },
  result: { label: "Result", group: "results" },
  staff: { label: "Staff", group: "club" }, business: { label: "Business", group: "club" }, regulation: { label: "Regulation", group: "club" }, other: { label: "Club", group: "club" },
};
const DESKS: [Group | "all", string][] = [["all", "Everything"], ["fitness", "Fitness"], ["transfers", "Transfers"], ["results", "Results"], ["club", "Club"]];
const cat = (c?: string) => CATS[c || "other"] ?? CATS.other;
const OFFICIAL = "liverpoolfc.com";
const OUTLETS: [string, string][] = [[OFFICIAL, "Club"], ["Sky Sports", "Sky"], ["BBC Sport", "BBC"], ["Liverpool Echo", "Echo"], ["The Athletic", "Athletic"]];
const SOURCE_NAMES: [string, string][] = [["lfc", "liverpoolfc.com"], ["sky", "Sky Sports"], ["bbc", "BBC Sport"], ["echo", "Liverpool Echo"], ["athletic", "The Athletic"]];
const short = (s: string) => OUTLETS.find(([n]) => n === s)?.[1] ?? s;
const NEEDS_CLUB = new Set(["injury", "team-news", "transfer", "contract", "staff"]);

// ---------- stories: one card per cluster (same grouping rules as the live service) ----------
export type Story = { id: string; items: Item[]; lead: Item; latest: string; group: Group; official: boolean; material: boolean; pushed: boolean; fetched: string };
const STOP = new Set("a an the and or of to in on at for by with from as is are was were be been has have had will would that this it its his their they he she not but after before over into than then about against ahead up out off club confirms reports says said report".split(" "));
const words = (t: string) => new Set(t.toLowerCase().replace(/[^a-z0-9\s']/g, " ").split(/\s+/).filter((w) => w.length > 2 && !STOP.has(w)));
function similar(a: Item[], b: Item[]) {
  const ta = Math.max(...a.map((x) => +new Date(x.published))), tb = Math.max(...b.map((x) => +new Date(x.published)));
  if (Math.abs(ta - tb) > 36 * 36e5) return false;
  return a.some((x) => b.some((y) => {
    const A = words(x.summary || x.title), B = words(y.summary || y.title);
    let n = 0; for (const w of A) if (B.has(w)) n++;
    return n >= 4 && n / Math.min(A.size, B.size) >= 0.6;
  }));
}
export function stories(st: State): Story[] {
  const by = new Map<string, Item[]>();
  for (const it of st.items) if (it.status === "kept" && +new Date(it.published) <= NOW.getTime()) { const k = it.cluster || it.id; (by.get(k) ?? by.set(k, []).get(k)!).push(it); }
  const keys = [...by.keys()];
  for (let i = 0; i < keys.length; i++) for (let j = i + 1; j < keys.length; j++) {
    const a = by.get(keys[i]), b = by.get(keys[j]);
    if (a && b && similar(a, b)) { a.push(...b); by.delete(keys[j]); }
  }
  return [...by.entries()].map(([id, g]) => {
    const items = [...g].sort((a, b) => b.published.localeCompare(a.published));
    const off = items.find((x) => x.source === OFFICIAL);
    const lead = off && new Date(items[0].published).getTime() - new Date(off.published).getTime() < 12 * 36e5 ? off : items[0];
    return { id, items, lead, latest: items[0].published, group: cat(lead.category).group, official: !!off, material: items.some((x) => x.material), pushed: items.some((x) => x.pushed), fetched: items.reduce((m, x) => (x.fetched > m ? x.fetched : m), items[0].fetched) };
  }).sort((a, b) => b.latest.localeCompare(a.latest));
}

function provenance(s: Story) {
  const byOutlet = new Map<string, Item>();
  for (const x of s.items) if (!byOutlet.has(x.source)) byOutlet.set(x.source, x);
  const n = byOutlet.size;
  const pips = `<span class="pips" role="img" aria-label="Reported by ${n} of ${OUTLETS.length} outlets">${OUTLETS.map(([o]) => `<i class="${byOutlet.has(o) ? (o === OFFICIAL ? "club" : "on") : ""}"></i>`).join("")}</span>`;
  const links = OUTLETS.filter(([o]) => byOutlet.has(o)).map(([o, l]) => { const x = byOutlet.get(o)!; return `<a${o === OFFICIAL ? ' class="club"' : ""} href="${esc(x.url)}" rel="noopener" target="_blank" title="${esc(x.title)}">${esc(l)}</a>`; }).join("");
  const reports = s.items.length > 1
    ? `<details class="reports"><summary><span class="o">${plural(s.items.length, "report")}</span><span class="x">Hide reports</span></summary><ol>${s.items.map((x) => `<li${x === s.lead ? ' class="lead"' : ""}><p>${esc(x.summary || x.title)}</p><div><a href="${esc(x.url)}" rel="noopener" target="_blank">${esc(x.source)}</a>${timeTag(x.published)}</div></li>`).join("")}</ol></details>` : "";
  return `<div class="story-f">${pips}<span class="outlets">${links}</span>${reports}</div>`;
}
function slug(s: Story) {
  const c = cat(s.lead.category);
  const trust = s.official ? `<span class="stamp">${I.tick}Club confirmed</span>` : NEEDS_CLUB.has(s.lead.category ?? "") ? `<span class="await" title="No report from liverpoolfc.com yet">Awaiting club</span>` : "";
  return `<p class="slug"><span class="cat">${esc(c.label)}</span>${s.material ? `<span class="major">${s.pushed ? "Alert sent" : "Major"}</span>` : ""}${trust}</p>`;
}
function storyHtml(s: Story) {
  return `<article class="story${s.material ? " is-major" : ""}" id="s-${esc(s.id)}" data-group="${s.group}" data-fetched="${esc(s.fetched)}">
  <time class="story-t" datetime="${esc(s.latest)}" title="${esc(fmt(s.latest, { weekday: "long", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" }))}">${hm(s.latest)}</time>
  <div class="story-b">${slug(s)}<h3 class="story-h">${esc(s.lead.summary || s.lead.title)}</h3>${provenance(s)}</div>
</article>`;
}
const splashHtml = (s: Story) => `<section class="splash" aria-labelledby="splash-h" data-fetched="${esc(s.fetched)}" id="s-${esc(s.id)}">
  <p class="slugline">Biggest story, last 72 hours · ${timeTag(s.latest)}</p>${slug(s)}
  <h2 id="splash-h"><mark>${esc(s.lead.summary || s.lead.title)}</mark></h2>${provenance(s)}</section>`;

// ---------- wire fragments ----------
const emptyState = (h: string, p: string) => `<div class="empty"><b>${esc(h)}</b><p>${esc(p)}</p></div>`;

/** The desk bar plus the feed. This is the htmx swap target for desk changes, so it is a fragment on its own. */
export function feedzone(st: State, desk: string, splashId: string | null): string {
  const all = stories(st).filter((s) => s.id !== splashId);
  const counts: Record<string, number> = { all: all.length };
  for (const s of all) counts[s.group] = (counts[s.group] ?? 0) + 1;
  const d = DESKS.some(([g]) => g === desk) ? desk : "all";
  const desks = `<nav class="desks" aria-label="Desks">${DESKS.filter(([g]) => g === "all" || counts[g]).map(([g, l]) =>
    `<a class="desk" href="${g === "all" ? "/" : `/?desk=${g}`}" hx-get="${g === "all" ? "/" : `/?desk=${g}`}" hx-target="#feedzone" hx-swap="outerHTML" hx-push-url="true"${d === g ? ' aria-current="true"' : ""}>${esc(l)}<small>${counts[g] ?? 0}</small></a>`).join("")}</nav>`;
  const shown = all.filter((s) => d === "all" || s.group === d);
  let list = "", last = "", open = false;
  const dayCount = (label: string) => shown.filter((s) => dayLabel(s.latest) === label).length;
  for (const s of shown) {
    const lbl = dayLabel(s.latest);
    if (lbl !== last) { list += `${open ? "</section>" : ""}<section class="day"><h2 class="day-h"><b>${esc(lbl)}</b><span>${plural(dayCount(lbl), "story").replace("storys", "stories")}</span></h2>`; last = lbl; open = true; }
    list += storyHtml(s);
  }
  if (open) list += "</section>";
  return `<div id="feedzone"><div class="since" id="since" hidden><span id="since-t"></span></div>${desks}<div class="feed" id="feed">${list || emptyState("Nothing on this desk", "Try Everything to see every story.")}</div></div>`;
}

// ---------- phase and board ----------
export type Ev = NonNullable<State["fixtures"]>["events"][number];
const isUs = (t: string) => /^liverpool$/i.test(t);
const nextEv = (): Ev | undefined => state.fixtures?.events.find((e) => new Date(e.start).getTime() > NOW.getTime() - 2.5 * 36e5);
export const resultsNow = (): Result[] => allResults.filter((r) => new Date(r.kickoff).getTime() + 2.2 * 36e5 < NOW.getTime());
export function phase(): "pre" | "matchday" | "live" | "post" {
  const ev = nextEv(), last = resultsNow().at(-1);
  if (ev) {
    const t = new Date(ev.start).getTime();
    if (t <= NOW.getTime()) return "live";
    if (dayKey(ev.start) === dayKey(NOW) || t - NOW.getTime() < 6 * 36e5) return "matchday";
  }
  if (last && NOW.getTime() - new Date(last.kickoff).getTime() < 20 * 36e5) return "post";
  return "pre";
}
const tiles = (iso: string, withSeconds: boolean) => {
  const s = Math.max(0, Math.floor((new Date(iso).getTime() - NOW.getTime()) / 1000));
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
  const t = (v: number, l: string, k: string) => `<div class="tile" data-u="${k}"><b>${String(v).padStart(2, "0")}</b><span>${l}</span></div>`;
  return `<div class="clock" data-kickoff="${esc(iso)}" role="timer" aria-label="Time to kick-off">${d > 0 ? t(d, "Days", "d") : ""}${t(h, "Hours", "h")}${t(m, "Mins", "m")}${withSeconds ? t(x, "Secs", "s") : ""}</div>`;
};
const fixtureHead = (ev: Ev) => isUs(ev.home)
  ? `<h2 class="fixture" id="board-h">Liverpool<span class="vs"><i>v</i>${esc(ev.away)}</span></h2>`
  : `<h2 class="fixture" id="board-h">Liverpool<span class="vs"><i>at</i>${esc(ev.home)}</span></h2>`;

function availability() {
  const flagged = squad.rows.filter((r) => r.flag);
  const out = flagged.filter((r) => r.flag!.tone === "bad"), doubt = flagged.filter((r) => r.flag!.tone === "warn");
  return { out, doubt, flagged };
}
const what = (r: SquadRow) => (r.what || r.p.news.split(" - ")[0] || "").replace(/ injury$/i, "");
type SquadRow = SquadModel["rows"][number];
const chip = (r: SquadRow) => `<a class="chip${r.flag!.tone === "warn" ? " doubt" : ""}" href="/squad#p-${r.p.id}">${esc(r.p.web_name)}${what(r) ? ` <em>${esc(what(r))}${r.p.chance != null && r.flag!.tone === "warn" ? ` ${r.p.chance}%` : ""}</em>` : ""}</a>`;

export function board(): string {
  const ph = phase(), ev = nextEv(), a = availability();
  const last = resultsNow().at(-1);
  if (ph === "post" && last) {
    const t = `${last.home ? "Liverpool" : last.opp}`, o = `${last.home ? last.opp : "Liverpool"}`;
    const [hs, as] = last.home ? [last.for, last.against] : [last.against, last.for];
    const nxt = ev ? `<span class="lbl">Next</span><span class="all-fit">${isUs(ev.home) ? esc(ev.away) : `at ${esc(ev.home)}`}, ${esc(ev.competition ?? "")}, ${esc(shortDay(ev.start))} ${hm(ev.start)}</span>` : "";
    return `<section class="board" aria-labelledby="board-h"><div class="board-top"><span class="tag">Full time</span><span>Premier League</span><span>${esc(shortDay(last.kickoff))}</span></div>
<div class="board-main"><h2 class="fixture" id="board-h">${esc(t)}<span class="vs"><i>v</i>${esc(o)}</span></h2><div class="score" aria-label="${esc(`${t} ${hs}, ${o} ${as}`)}"><span>${hs}</span><span class="dash">-</span><span>${as}</span></div></div>
<div class="board-foot">${nxt}</div></section>`;
  }
  if (!ev) return "";
  const top = `<div class="board-top"><span class="tag${ph === "live" ? " live" : ""}">${ph === "live" ? "Live now" : ph === "matchday" ? "Matchday" : "Next up"}</span><span>${esc(ev.competition ?? "")}</span><span>${esc(shortDay(ev.start))} · ${hm(ev.start)}</span><span>${esc(ev.venue || "")}</span></div>`;
  const main = ph === "live"
    ? `<div class="ko-big" data-kickoff="${esc(ev.start)}"><small>Kicked off ${hm(ev.start)}</small><span data-elapsed>${Math.min(90, Math.max(1, Math.floor((NOW.getTime() - new Date(ev.start).getTime()) / 60000)))}'</span></div>`
    : tiles(ev.start, ph === "matchday");
  const foot = a.flagged.length
    ? `<span class="lbl">${ph === "pre" ? "Team news so far" : "Out"}</span><div class="chips">${[...a.out, ...a.doubt].slice(0, 7).map(chip).join("")}</div><a class="more" href="/squad">${a.flagged.length > 7 ? `+${a.flagged.length - 7} more · ` : ""}Squad</a>`
    : `<span class="lbl">Team news</span><span class="all-fit">Nobody on the injury list.</span>`;
  return `<section class="board" aria-labelledby="board-h">${top}<div class="board-main">${fixtureHead(ev)}${main}</div><div class="board-foot">${foot}</div>${ph === "live" ? `<div class="board-foot" style="border:0;margin:0;padding-top:6px"><a class="more" style="margin:0" href="${esc(ev.url)}" rel="noopener" target="_blank">Follow the match on liverpoolfc.com</a></div>` : ""}</section>`;
}

function stopPress(all: Story[]) {
  const s = all.find((x) => x.material && ago(x.latest) < 6 * 3600);
  if (!s) return "";
  return `<div class="stoppress-wrap"><div class="stoppress" role="status"><b>Stop press</b><a href="#s-${esc(s.id)}">${esc(s.lead.summary || s.lead.title)}<small>${timeTag(s.latest)} · ${s.official ? "Club confirmed" : "Awaiting club"}</small></a></div></div>`;
}

// ---------- rail ----------
const fixturePanel = () => {
  const evs = (state.fixtures?.events ?? []).filter((e) => new Date(e.start).getTime() > NOW.getTime() - 2.5 * 36e5).slice(0, 5);
  if (!evs.length) return "";
  return `<section class="panel" aria-labelledby="fx-h"><h2 id="fx-h">Fixtures</h2><ol class="fx">${evs.map((e) => `<li><a href="${esc(e.url)}" rel="noopener" target="_blank"><span class="d">${esc(shortDay(e.start))}</span><b>${isUs(e.home) ? "" : "<i>at</i>"}${esc(isUs(e.home) ? e.away : e.home)}</b><span class="c">${esc(e.competition ?? "")} · ${hm(e.start)}</span></a></li>`).join("")}</ol></section>`;
};
const ord = (n: number) => { const t = n % 100, u = n % 10; return `${n}<sup>${t >= 11 && t <= 13 ? "th" : u === 1 ? "st" : u === 2 ? "nd" : u === 3 ? "rd" : "th"}</sup>`; };
export function standingsAt(): { tab: Row[]; pos: number; me: Row } {
  const tab = tableAt(NOW.getTime());
  return { tab, pos: tab.findIndex((r) => r.id === myId) + 1, me: tab.find((r) => r.id === myId)! };
}
const standingPanel = () => {
  const { tab, pos, me } = standingsAt();
  const form = resultsNow().slice(-5);
  const lo = Math.max(0, Math.min(tab.length - 5, pos - 3)), win = tab.slice(lo, lo + 5);
  return `<section class="panel" aria-labelledby="st-h"><h2 id="st-h">Standing<small>Premier League</small></h2>
<div class="pos-big"><b>${ord(pos)}</b><span>${me.pts} points<br>${me.p} played, GD ${me.gf - me.ga > 0 ? "+" : ""}${me.gf - me.ga}</span></div>
<div class="form" role="img" aria-label="Last ${form.length}: ${form.map((r) => r.res).join(" ")}">${form.map((r) => `<span class="${r.res}" title="${esc(`${r.home ? "v" : "at"} ${r.opp} ${r.for}-${r.against}, ${shortDate(r.kickoff)}`)}">${r.res}</span>`).join("")}</div>
<table class="mini-table"><thead><tr><th></th><th>Club</th><th>P</th><th>GD</th><th>Pts</th></tr></thead><tbody>${win.map((r, i) => `<tr${r.id === me.id ? ' class="me"' : ""}><td>${lo + i + 1}</td><td>${esc(r.short)}</td><td>${r.p}</td><td>${r.gf - r.ga > 0 ? "+" : ""}${r.gf - r.ga}</td><td>${r.pts}</td></tr>`).join("")}</tbody></table></section>`;
};
function treatmentPanel() {
  const a = availability();
  const list = [...a.out, ...a.doubt];
  return `<section class="panel" aria-labelledby="tr-h"><h2 id="tr-h">Treatment room<a href="/squad">Squad</a></h2>${list.length ? `<ul class="treat">${list.map((r) => {
    const since = r.current?.start ?? r.p.news_added;
    return `<li><span class="dot${r.flag!.tone === "warn" ? " doubt" : ""}"></span><b>${esc(r.p.web_name)}</b><span>${esc(r.flag!.text)}</span><small>${esc(what(r) || "Unavailable")}${since ? ` · since ${esc(shortDate(since))}` : ""}${r.current ? ` · missed ${r.current.missed}` : ""}</small></li>`;
  }).join("")}</ul>` : `<p class="note">Nobody on the injury list.</p>`}</section>`;
}
function sourcesPanel(st: State) {
  const live = liveness(st);
  return `<section class="panel" aria-labelledby="so-h"><h2 id="so-h">Sources<a href="/status">${live.stale ? "Not updating" : "Status"}</a></h2><ul class="sources">${SOURCE_NAMES.map(([k, n]) => {
    const h = st.health[k], ok = h && h.fails === 0 && h.lastOk;
    return `<li><span class="dot-s ${ok ? "" : h?.lastOk ? "bad" : "warn"}"></span>${esc(n)}<span class="when">${h?.lastOk ? timeTag(h.lastOk) : "Never read"}</span></li>`;
  }).join("")}</ul><p class="note">Rumour mills, opinion and video are filtered out. <a href="/spiked">See what was spiked</a>.</p></section>`;
}

// ---------- shell ----------
function liveness(st: State | null) {
  if (!st?.lastRun) return { tone: "warn", label: "Waiting", title: "No run recorded yet", stale: false, backlog: 0 };
  const age = (NOW.getTime() - new Date(st.lastRun).getTime()) / 60000;
  const failing = SOURCE_NAMES.filter(([k]) => (st.health[k]?.fails ?? 0) > 0).length;
  const backlog = st.items.filter((i) => i.status === "pending" && NOW.getTime() - new Date(i.fetched).getTime() > 30 * 60e3).length;
  const stale = !FROZEN && age > 45;
  return { tone: stale ? "bad" : failing || backlog ? "warn" : "ok", label: stale ? "Stale" : age < 1 ? "Now" : age < 60 ? `${Math.floor(age)} min` : `${Math.floor(age / 60)}h`, title: stale ? `Last update ${rel(st.lastRun)}` : failing ? `${failing} source${failing > 1 ? "s" : ""} failing` : backlog ? `${backlog} items waiting for the filter` : "All sources healthy", stale, backlog };
}
const TABS: [string, string, string, string][] = [["wire", "/", "Wire", I.wire], ["squad", "/squad", "Squad", I.squad], ["shorts", "/shorts", "Shorts", I.shorts], ["spiked", "/spiked", "Spiked", I.spiked]];

export function shell(o: { title: string; active: string; body: string; st?: State | null; club?: string; theme?: string; top?: string; extra?: string }) {
  const st = o.st ?? state, live = liveness(st);
  const ph = phase();
  const dateline = `<div class="dateline"><div class="dateline-in"><b>${esc(fmt(NOW, { weekday: "long", day: "numeric", month: "long", year: "numeric" }))}</b><span>Edition ${hm(st.lastRun ?? NOW)}</span><span class="hide-s">Five sources, no rumours</span><span class="push">${ph === "live" ? "Match in play" : ph === "matchday" ? "Matchday" : ph === "post" ? "Full time" : "No match today"}</span></div></div>`;
  return `<!doctype html><html lang="en-GB" data-club="${esc(o.club ?? "lfc")}"${o.theme ? ` data-theme="${esc(o.theme)}"` : ""} data-now="${NOW.toISOString()}"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>${esc(o.title)}</title><meta name="description" content="Liverpool FC news from tier 1 sources only, filtered and summarised.">
<meta name="theme-color" content="#c8102e"><meta name="htmx-config" content='{"globalViewTransitions":true,"selfRequestsOnly":true,"allowScriptTags":false}'>
<link rel="icon" href="data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="#C8102E"/><path d="M10 20 20 46 32 28 44 46 54 20" fill="none" stroke="#fff" stroke-width="7" stroke-linejoin="miter"/></svg>`)}">
<link rel="preload" href="/static/fonts/BigShouldersDisplay-var.woff2" as="font" type="font/woff2" crossorigin><link rel="preload" href="/static/fonts/Newsreader-normal-400-700.woff2" as="font" type="font/woff2" crossorigin>
<link rel="stylesheet" href="/static/css/fonts.css"><link rel="stylesheet" href="/static/css/wire.css">
<script src="/static/js/htmx.min.js" defer></script><script src="/static/js/wire.js" defer></script><script src="/static/js/push.js" defer></script>
</head><body hx-boost="true">
<a class="skip" href="#main">Skip to content</a>
<header class="mast"><div class="mast-in">
  <a class="brand" href="/" aria-label="Liverpool Wire, home"><span class="brand-club">Liverpool</span><span class="brand-wire">Wire</span></a>
  <nav class="nav" aria-label="Sections">${TABS.map(([k, h, l, ico]) => `<a href="${h}"${o.active === k ? ' aria-current="page"' : ""}>${ico}${l}</a>`).join("")}
    <button type="button" class="alerts" id="alerts-btn" hidden aria-haspopup="dialog" aria-expanded="false">${I.bell}<span class="alerts-l">Alerts</span></button></nav>
  <a class="pulse-link" href="/status" title="${esc(live.title)}" aria-label="Wire status: ${esc(live.stale ? "not updating" : live.title)}"><span class="pip ${live.tone}" aria-hidden="true"></span>${esc(live.label)}</a>
</div></header>
${dateline}
${o.top ?? ""}
<div class="wrap">
  ${live.stale && o.active !== "status" ? `<p class="slugline" role="status" style="color:var(--bad);padding-top:14px">The wire hasn't updated since ${esc(rel(st.lastRun!))}. Recent news may be missing. <a href="/status">Status</a></p>` : ""}
  ${o.body}
  <footer class="foot"><p>Reads liverpoolfc.com, BBC Sport, Sky Sports, The Athletic and the Liverpool Echo every 15 minutes. Summaries are machine-written from each outlet's headline and standfirst. Follow the link before relying on detail.</p><nav aria-label="Footer"><a href="/squad">Squad</a><a href="/spiked">Spiked</a><a href="/status">Status</a></nav></footer>
</div>
<nav class="tabbar" aria-label="Sections">${TABS.map(([k, h, l, ico]) => `<a href="${h}"${o.active === k ? ' aria-current="page"' : ""}>${ico}<span>${l}</span></a>`).join("")}</nav>
<dialog class="sheet" id="alerts-sheet" aria-labelledby="sheet-h"><div class="sheet-in"><p class="sheet-h" id="sheet-h">Phone alerts</p><div id="sheet-body"></div></div></dialog>
${o.extra ?? ""}</body></html>`;
}

// ---------- pages ----------
export function wirePage(desk = "all", hxTarget?: string | null): string {
  const st = state;
  const all = stories(st);
  const splash = desk === "all" ? (all.find((s) => s.material && ago(s.latest) < 72 * 3600 && ago(s.latest) >= 6 * 3600) ?? null) : null;
  if (hxTarget === "feedzone") return feedzone(st, desk, splash?.id ?? null);
  const body = `<h1 class="sr-only">Liverpool FC news</h1>
<div style="padding-top:22px">${board()}</div>
<div class="layout has-rail"><main id="main" tabindex="-1">
${splash ? splashHtml(splash) : all.length && ago(all[0].latest) > 20 * 3600 ? `<div class="quiet"><b>All quiet</b><p>Nothing new since ${esc(rel(all[0].latest))}. If something breaks, it lands here first.</p></div>` : ""}
${feedzone(st, desk, splash?.id ?? null)}</main>
<aside class="rail" aria-label="Fixtures, standing and treatment room">${fixturePanel()}${standingPanel()}${treatmentPanel()}${sourcesPanel(st)}</aside></div>
<div id="pulse" hx-get="/fragments/pulse" hx-trigger="every 120s" hx-swap="outerHTML" hx-vals='${esc(JSON.stringify({ run: st.lastRun ?? "", n: all.length }))}'></div>`;
  return shell({ title: "Liverpool Wire", active: "wire", body, top: stopPress(all) });
}
export function pulse(run: string, n: number): string {
  const cur = stories(state).length;
  const vals = esc(JSON.stringify({ run: state.lastRun ?? "", n: cur }));
  if (state.lastRun && run && state.lastRun !== run && cur > n)
    return `<div id="pulse" class="toast" role="status"><a href="/" hx-get="/" hx-target="body" hx-push-url="true">${cur - n} new <b>${cur - n === 1 ? "story" : "stories"}</b>. Show them</a></div>`;
  return `<div id="pulse" hx-get="/fragments/pulse" hx-trigger="every 120s" hx-swap="outerHTML" hx-vals='${vals}'></div>`;
}

// ---------- squad ----------
const BINS = [10, 25, 40, 60, 75, 90];
const qClass = (p: number | null) => (p == null ? "q-na" : `q${BINS.filter((b) => p >= b).length}`);
const fmtStat = (st: { key: string; unit: string }, v: number | null) => {
  if (v == null) return "";
  if (st.unit === "pct") return `${Math.round(v)}%`;
  const s = Math.abs(v) >= 10 ? v.toFixed(1) : v.toFixed(2);
  return st.key === "finishing" || st.key === "prevented" ? (v > 0 ? `+${s}` : s) : s;
};
const ordinal = (n: number) => { const r = Math.round(n), t = r % 100, u = r % 10; return `${r}${t >= 11 && t <= 13 ? "th" : u === 1 ? "st" : u === 2 ? "nd" : u === 3 ? "rd" : "th"}`; };
const AVAIL: Record<Avail, string> = { played: "Played", injured: "Injured or doubtful", suspended: "Suspended", out: "Didn't play" };

/** Fragment: the distribution strips for one player, drawn server-side so no chart code ships to the browser. */
export function playerStrips(pid: number): string {
  const r = squad.rows.find((x) => x.p.id === pid);
  if (!r) return `<p class="note">Player not found.</p>`;
  const pool = squad.pools[r.p.pos] ?? [], stats = SQ_POS[r.p.pos].stats;
  const f = (v: number | null, s: { key: string; unit: string }) => fmtStat(s, v);
  return stats.map((s, i) => {
    const vals = pool.map((p) => p.v[i]).filter((v): v is number => v != null).sort((a, b) => a - b);
    const mv = r.cells[i].value == null ? null : Math.round(r.cells[i].value! * 1000) / 1000;
    if (!vals.length && mv == null) return "";
    const flip = s.better === "low";
    let lo = vals.length ? vals[Math.floor(vals.length * 0.02)] : mv!, hi = vals.length ? vals[Math.ceil(vals.length * 0.98) - 1] : mv!;
    if (mv != null) { lo = Math.min(lo, mv); hi = Math.max(hi, mv); }
    if (hi === lo) hi = lo + 1;
    const W = 640, H = 34, pad = 8;
    const x = (v: number) => { const c = Math.max(lo, Math.min(hi, v)), t = (c - lo) / (hi - lo); return +(pad + (flip ? 1 - t : t) * (W - 2 * pad)).toFixed(1); };
    const rank = r.ranked && mv != null ? vals.filter((v) => (flip ? v < mv - 1e-9 : v > mv + 1e-9)).length + 1 : null;
    const ties = rank != null ? vals.filter((v) => Math.abs(v - mv!) <= 1e-9).length : 0;
    const med = vals.length ? vals[Math.floor(vals.length / 2)] : null;
    const dots = pool.map((p, j) => {
      const v = p.v[i]; if (v == null) return "";
      const mate = p.t === squad.team.short_name, y = +(6 + (((j * 7919) % 97) / 97) * (H - 12)).toFixed(1);
      return `<circle cx="${x(v)}" cy="${y}" r="${mate ? 3.4 : 2.7}" class="${mate ? "mate" : "dot"}"><title>${esc(`${p.n} (${p.t}) ${f(v, s)}`)}</title></circle>`;
    }).join("");
    const ends = [[lo, flip ? "end" : "start"], [hi, flip ? "start" : "end"]].map(([v, a]) => `<text x="${x(v as number)}" y="${H + 10}" text-anchor="${a}">${esc(f(v as number, s))}</text>`).join("");
    const label = `${s.label}: ${r.p.web_name} ${f(mv, s)}${r.cells[i].pct != null ? `, ${ordinal(r.cells[i].pct!)} percentile` : ""}`;
    return `<div class="strip"><h4><span>${esc(s.label)}${s.unit === "p90" ? " per 90" : ""}</span><span><b>${esc(f(mv, s))}</b>${rank != null ? ` · ${ties > 1 ? "joint " : ""}${ordinal(rank)} of ${vals.length}` : " · not ranked"}</span></h4>
<svg viewBox="0 0 ${W} ${H + 12}" role="img" aria-label="${esc(label)}">${med != null ? `<line class="med" x1="${x(med)}" x2="${x(med)}" y1="4" y2="${H - 4}"/>` : ""}${ends}${dots}${mv != null ? `<circle class="me" cx="${x(mv)}" cy="${H / 2}" r="7"/>` : ""}</svg></div>`;
  }).join("") + `<p class="note">Right is always better. The red dot is ${esc(r.p.web_name)}, dark dots are team-mates, grey dots are the rest of the division.</p>`;
}

export function squadPage(): string {
  const m = squad, st = state;
  const fit = stories(st).filter((s) => s.group === "fitness" && ago(s.latest) < 21 * 864e5);
  const flagged = m.rows.filter((r) => r.flag).sort((a, b) => (a.flag!.tone === b.flag!.tone ? 0 : a.flag!.tone === "bad" ? -1 : 1));
  const outNow = flagged.map((r) => {
    const re = nameMatcher(r.p); let hit: { s: Story; x: Item } | null = null;
    for (const s of re ? fit : []) { const x = s.items.find((i) => textMatches(re!, `${i.summary ?? ""} ${i.title}`)); if (x) { hit = { s, x }; break; } }
    const since = r.current?.start ?? r.p.news_added;
    return `<li id="p-${r.p.id}"><b>${esc(r.p.web_name)}</b><span class="badge${r.flag!.tone === "warn" ? " doubt" : ""}">${esc(r.flag!.text)}</span>
<span class="m">${esc(what(r) || "Unavailable")}${since ? ` · since ${esc(shortDate(since))}` : ""}${r.current ? ` · missed ${plural(r.current.missed, "match").replace("matchs", "matches")}` : ""}</span>${hit ? `<a class="s" href="/#s-${esc(hit.s.id)}">${esc(hit.x.summary || hit.x.title)}</a>` : ""}</li>`;
  }).join("");
  const scale = `<div class="legend" aria-hidden="true">Bottom of the division<span class="sw">${[0, 1, 2, 3, 4, 5, 6].map((i) => `<i style="background:var(--q${i})"></i>`).join("")}</span>Top<span class="sw"><i class="pc q-na" style="width:20px;min-height:10px"></i></span>Too few minutes</div>`;
  const positions = [1, 2, 3, 4].map((pos) => {
    const info = SQ_POS[pos], rows = m.rows.filter((r) => r.p.pos === pos);
    if (!rows.length) return "";
    const few = rows.filter((r) => r.p.minutes < 90);
    const body = rows.filter((r) => r.p.minutes >= 90).map((r) => {
      const cells = r.cells.map((c) => {
        const v = fmtStat(c.stat, c.value);
        const lbl = `${c.stat.label}${c.stat.unit === "p90" ? " per 90" : ""}: ${v || "none"}${c.pct != null ? `, ${ordinal(c.pct)} percentile` : ", not ranked"}`;
        return `<span class="pc ${qClass(c.pct)}" style="--p:${c.pct == null ? 0 : Math.round(c.pct)}" title="${esc(lbl)}" aria-label="${esc(lbl)}"><b>${esc(v)}</b>${c.pct != null ? `<i>${Math.round(c.pct)}</i>` : ""}</span>`;
      }).join("");
      const mark = r.flag ? `<i class="${r.flag.tone === "warn" ? "doubt" : ""}" role="img" aria-label="${esc(r.flag.text)}"></i>` : "";
      return `<details class="pr" id="pl-${r.p.id}" hx-get="/squad/player/${r.p.id}" hx-trigger="toggle once" hx-target="find .pr-x" hx-swap="innerHTML"><summary class="pt-row"><span class="who"><span class="nm">${mark}${esc(r.p.web_name)}</span><small>${r.p.minutes} min</small></span>${cells}</summary><div class="pr-x" aria-live="polite"></div></details>`;
    }).join("");
    return `<section class="pos-sec" id="pos-${pos}"><h2 class="h-sec">${esc(info.many)}<small>vs ${m.pools[pos]?.length ?? 0} Premier League ${esc(info.one)}s, ${Math.round(m.threshold)}+ min</small></h2>
<div class="pt-row pt-head" aria-hidden="true"><span></span>${info.stats.map((s) => `<span>${esc(s.label)}</span>`).join("")}</div>${body}
${few.length ? `<p class="few"><b>Under 90 min</b>${few.map((r) => `${esc(r.p.web_name)} ${r.p.minutes}`).join(", ")}</p>` : ""}</section>`;
  }).join("");
  const head = m.matches.map((f) => `<th scope="col" title="${esc(`${f.home ? "v" : "at"} ${f.opp}, ${shortDate(f.kickoff)}`)}"><span>${esc(f.opp)}</span><span>${f.home ? "H" : "A"}</span></th>`).join("");
  const availRows = m.rows.filter((r) => r.p.pos !== 1 || r.p.minutes > 0 || r.flag).map((r) => `<tr><th scope="row">${esc(r.p.web_name)}</th>${r.avail.map((a, i) => `<td><span class="av av-${a}" title="${esc(`${m.matches[i].opp}: ${AVAIL[a]}`)}"><span class="sr-only">${esc(AVAIL[a])}</span></span></td>`).join("")}</tr>`).join("");
  const body = `<div class="crumb"><a href="/">Wire</a> / Squad</div>
<header class="page-head"><h1>The <span>squad</span></h1><p>${m.rows.length} players. Every stat is per 90 minutes and ranked against the rest of the Premier League at that position. ${m.played} matches played.</p></header>
<div class="layout" style="padding-top:12px"><main id="main" tabindex="-1">
${outNow ? `<section><h2 class="h-sec">Out now<small>${plural(flagged.length, "player")}</small></h2><ul class="out-list">${outNow}</ul></section>` : ""}
${scale}${positions}
${m.matches.length ? `<section class="pos-sec"><h2 class="h-sec">Availability<small>league matches</small></h2><div class="legend">${(["played", "injured", "suspended", "out"] as Avail[]).map((a) => `<span><span class="av av-${a}" aria-hidden="true"></span>${esc(AVAIL[a])}</span>`).join("")}</div><div class="avt-wrap" tabindex="0"><table class="avt"><thead><tr><th scope="col"><span class="sr-only">Player</span></th>${head}</tr></thead><tbody>${availRows}</tbody></table></div></section>` : ""}
${m.away.length ? `<p class="few" style="margin-top:26px"><b>Left or on loan</b>${m.away.map((p) => esc(p.web_name)).join(", ")}</p>` : ""}</main></div>`;
  return shell({ title: "Squad · Liverpool Wire", active: "squad", body });
}

// ---------- spiked (what the filter kept out) ----------
const KIND: Record<string, string> = {
  opinion: "Opinion and analysis", reaction: "Reaction, no new facts", preview: "Previews and listings", rumour: "Relayed rumour",
  feature: "History and features", promo: "Promo, tickets, FPL, video", "off-topic": "Not about Liverpool", thin: "Thin, vague or duplicate", other: "Other",
};
const LEGACY: [string, RegExp][] = [
  ["rumour", /rumou?r|relayed|papers|gossip|unnamed/], ["preview", /preview|how to watch|broadcast|\btv\b|schedule|listing|atmosphere|travel/],
  ["promo", /ticket|promo|commercial|membership|fantasy|fpl|video|gallery|podcast|quiz|kit|retail|award|stream/], ["thin", /duplicate|vague|empty|clickbait|generic|lacking|no news|outdated|no new|thin|live (press conference )?blog|round-?up/],
  ["reaction", /reaction|quotes|comments|social media|mailbag|talk about|musing/], ["off-topic", /rival|opposition|other club|not about|not liverpool|industry|international|teammate|general premier|women/],
  ["feature", /histor|nostalg|memorabilia|retro|anecdote|museum|feature|interview|former|legend|statue/], ["opinion", /opinion|analys|column|pundit|verdict|talking|discussion|speculat|assess|predict|rating/],
];
const bucketOf = (i: Item) => KIND[i.dropKind ?? ""] ?? KIND[LEGACY.find(([, re]) => re.test((i.reason || "").toLowerCase()))?.[0] ?? "other"];
const droppedItems = () => state.items.filter((i) => i.status === "dropped" && +new Date(i.published) <= NOW.getTime()).sort((a, b) => b.published.localeCompare(a.published));

/** Fragment: result count and rows for a search and bucket. The form posts here with hx-get and swaps #spiked-results. */
export function spikedResults(q: string, bucket: string): string {
  const t = q.trim().toLowerCase();
  const rows = droppedItems().filter((d) => (!bucket || bucketOf(d) === bucket) && (!t || (d.title + " " + d.source + " " + (d.reason ?? "")).toLowerCase().includes(t))).slice(0, 120);
  let out = "", last = "";
  for (const d of rows) {
    const day = dayLabel(d.published);
    if (day !== last) { out += `<li class="rd">${esc(day)}</li>`; last = day; }
    out += `<li class="row"><time datetime="${esc(d.published)}">${hm(d.published)}</time><div><a href="${esc(d.url)}" rel="noopener" target="_blank">${esc(d.title)}</a><div class="why"><span>${esc(short(d.source))}</span><em>${esc(d.reason || "No reason given")}</em></div></div></li>`;
  }
  return `<div id="spiked-results"><output for="q" aria-live="polite">${t || bucket ? plural(rows.length, "match").replace("matchs", "matches") + (rows.length === 120 ? " (first 120)" : "") : ""}</output><ul class="rows">${out || `<li>${emptyState("Nothing spiked", "No articles match.")}</li>`}</ul></div>`;
}
export function spikedPage(q = "", bucket = ""): string {
  const d = droppedItems(), total = state.items.filter((i) => i.status !== "pending").length;
  const tally = new Map<string, number>(); for (const x of d) tally.set(bucketOf(x), (tally.get(bucketOf(x)) ?? 0) + 1);
  const max = Math.max(1, ...tally.values());
  const bars = [...tally.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => `<li><label class="bucket" ${bucket === k ? 'aria-current="true"' : ""}><input class="sr-only" type="radio" name="bucket" value="${esc(k)}"${bucket === k ? " checked" : ""}><span>${esc(k)}</span><span class="bar"><i style="width:${Math.round((n / max) * 100)}%"></i></span><span class="n">${n}</span></label></li>`).join("");
  const body = `<div class="crumb"><a href="/">Wire</a> / Spiked</div>
<header class="page-head"><h1>Spiked</h1><p>Everything the filter rejected in the last 14 days, and why. If something here should have made the wire, the filter is too strict.</p></header>
<div class="layout" style="padding-top:0"><main id="main" tabindex="-1">
<dl class="kpis"><div><dt>Spiked</dt><dd>${d.length}<small>of ${total}</small></dd></div><div><dt>Noise removed</dt><dd>${total ? Math.round((d.length / total) * 100) : 0}%</dd></div></dl>
<form action="/spiked" method="get" hx-get="/spiked" hx-trigger="input changed delay:180ms, submit" hx-target="#spiked-results" hx-swap="outerHTML" hx-push-url="true">
<h2 class="h-sec" style="margin-top:22px">Why things were spiked<small>choose one to filter</small></h2>
<ul class="buckets"><li><label class="bucket" ${bucket === "" ? 'aria-current="true"' : ""}><input class="sr-only" type="radio" name="bucket" value=""${bucket === "" ? " checked" : ""}><span>Any reason</span><span class="bar"><i style="width:100%"></i></span><span class="n">${d.length}</span></label></li>${bars}</ul>
<div class="find"><label class="sr-only" for="q">Search spiked articles</label>${I.search}<input id="q" name="q" type="search" value="${esc(q)}" placeholder="Search headlines, outlets, reasons" autocomplete="off"><noscript><button class="btn" type="submit" style="margin-top:8px">Search</button></noscript></div>
</form>
${spikedResults(q, bucket)}</main></div>`;
  return shell({ title: "Spiked · Liverpool Wire", active: "spiked", body });
}

// ---------- status ----------
const pence = (u?: { in: number; out: number }) => (u ? ((u.in * 0.75 + u.out * 3.75) / 1e6) * 0.75 * 100 : 0);
export function statusPage(): string {
  const st = state, live = liveness(st);
  const failing = SOURCE_NAMES.filter(([k]) => (st.health[k]?.fails ?? 0) > 0);
  const headline = live.stale ? "The wire has stopped updating" : failing.length ? `${failing.length} source${failing.length > 1 ? "s" : ""} failing` : live.backlog ? "The filter is falling behind" : "Everything is working";
  const srcRows = SOURCE_NAMES.map(([k, n]) => {
    const h = st.health[k], ok = h && h.fails === 0 && h.lastOk;
    return `<li><span class="dot-s ${ok ? "" : h?.lastOk ? "bad" : "warn"}"></span><span>${esc(n)}</span><span class="t">${h?.lastOk ? timeTag(h.lastOk) : ""}</span>${!ok && h?.lastError ? `<small>${esc(h.lastError)}</small>` : ""}</li>`;
  }).join("");
  const days = Object.keys(st.usage).sort().slice(-7), vals = days.map((d) => pence(st.usage[d])), vmax = Math.max(0.01, ...vals);
  const today = days.at(-1) ?? "", t = st.usage[today] ?? { in: 0, out: 0, calls: 0 };
  const spark = `<div class="spark" role="img" aria-label="Filter cost per day, last ${days.length} days">${days.map((d, i) => `<div class="${d === today ? "today" : ""}" title="${esc(d)}: ${vals[i].toFixed(2)}p"><i style="height:${Math.max(3, (vals[i] / vmax) * 64)}px"></i>${esc(new Date(d + "T12:00:00Z").toLocaleDateString("en-GB", { weekday: "short", timeZone: TZ }))}</div>`).join("")}</div>`;
  const kept = st.items.filter((i) => i.status === "kept").length, dropped = st.items.filter((i) => i.status === "dropped").length;
  const body = `<div class="crumb"><a href="/">Wire</a> / Status</div>
<header class="page-head"><h1>Status</h1></header>
<div id="status-live" hx-get="/status" hx-trigger="every 30s" hx-select="#status-live" hx-swap="outerHTML" hx-push-url="false">
<p class="headline"><span class="pip ${live.tone}" style="box-shadow:none;outline:0" aria-hidden="true"></span>${esc(headline)}</p>
<div class="grid2" style="margin-top:26px">
<section><h2 class="h-sec">Sources</h2><ul class="srcs">${srcRows}</ul></section>
<section><h2 class="h-sec">Filter</h2><dl class="facts"><dt>Last run</dt><dd>${st.lastRun ? timeTag(st.lastRun) : "Not yet"}</dd><dt>Reads sources</dt><dd>Every 15 minutes</dd><dt>Alerts today</dt><dd>${st.pushes?.[today] ?? 0} of 6, none between 22:00 and 07:00</dd><dt>Kept</dt><dd>${kept} stories in 14 days</dd><dt>Spiked</dt><dd><a href="/spiked">${dropped} articles</a></dd><dt>Cost today</dt><dd>${pence(t).toFixed(2)}p, ${plural(t.calls, "call")}</dd></dl>${spark}</section></div></div>`;
  return shell({ title: "Status · Liverpool Wire", active: "status", body });
}

export const shortsPage = () => shell({ title: "Shorts · Liverpool Wire", active: "shorts", body: `<div class="crumb"><a href="/">Wire</a> / Shorts</div><header class="page-head"><h1>Shorts</h1><p>The Shorts player keeps its current behaviour and only picks up the new tokens and masthead. It is out of scope for this pass.</p></header>` });
