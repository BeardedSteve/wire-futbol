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

const U = (s: string) => esc(s).toUpperCase();

// ---------- teletext page numbers ----------
// Every page has a number. Typing three digits anywhere jumps to it (wire.js), and the four fast-text keys cover the main sections.
export const PAGES: [string, string, string][] = [
  ["100", "/", "Wire"], ["110", "/?desk=fitness", "Fitness"], ["120", "/?desk=transfers", "Transfers"], ["130", "/?desk=results", "Results"], ["140", "/?desk=club", "Club"],
  ["200", "/squad", "Squad"], ["300", "/table", "Table"], ["400", "/spiked", "Spiked"], ["500", "/status", "Status"], ["600", "/shorts", "Shorts"],
];
const pageNo = (desk: string) => PAGES.find(([, u]) => u === (desk === "all" ? "/" : `/?desk=${desk}`))?.[0] ?? "100";

// ---------- story blocks ----------
function provenance(s: Story) {
  const byOutlet = new Map<string, Item>();
  for (const x of s.items) if (!byOutlet.has(x.source)) byOutlet.set(x.source, x);
  const n = byOutlet.size;
  const pips = `<span class="ob" role="img" aria-label="Reported by ${n} of ${OUTLETS.length} outlets">${OUTLETS.map(([o]) => `<i class="${byOutlet.has(o) ? (o === OFFICIAL ? "club" : "on") : ""}"></i>`).join("")}</span>`;
  const links = OUTLETS.filter(([o]) => byOutlet.has(o)).map(([o, l]) => { const x = byOutlet.get(o)!; return `<a${o === OFFICIAL ? ' class="club"' : ""} href="${esc(x.url)}" rel="noopener" target="_blank" title="${esc(x.title)}">${esc(l)}</a>`; }).join("");
  const reports = s.items.length > 1
    ? `<details class="reports"><summary><span class="o">${plural(s.items.length, "report")}</span><span class="x">Hide reports</span></summary><ol>${s.items.map((x) => `<li${x === s.lead ? ' class="lead"' : ""}><p>${esc(x.summary || x.title)}</p><div><a href="${esc(x.url)}" rel="noopener" target="_blank">${esc(x.source)}</a> ${timeTag(x.published)}</div></li>`).join("")}</ol></details>` : "";
  return `<p class="ft">${pips}<span class="outlets">${links}</span>${reports}</p>`;
}
function head(s: Story, withTime: boolean) {
  const c = cat(s.lead.category);
  const trust = s.official ? `<span class="stamp">CLUB CONFIRMED</span>` : NEEDS_CLUB.has(s.lead.category ?? "") ? `<span class="await" title="No report from liverpoolfc.com yet">AWAITING CLUB</span>` : "";
  return `<p class="hd">${withTime ? `<time datetime="${esc(s.latest)}" title="${esc(fmt(s.latest, { weekday: "long", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" }))}">${hm(s.latest)}</time>` : ""}<span class="cat">${esc(c.label)}</span>${s.material ? `<span class="major">${s.pushed ? "ALERT SENT" : "MAJOR"}</span>` : ""}${trust}</p>`;
}
const storyHtml = (s: Story) => `<article class="story${s.material ? " is-major" : ""}" id="s-${esc(s.id)}" data-group="${s.group}" data-fetched="${esc(s.fetched)}">${head(s, true)}<h3>${esc(s.lead.summary || s.lead.title)}</h3>${provenance(s)}</article>`;
const splashHtml = (s: Story) => `<section class="splash" aria-labelledby="splash-h" id="s-${esc(s.id)}" data-fetched="${esc(s.fetched)}"><p class="lbl">BIGGEST STORY, LAST 72 HOURS ${timeTag(s.latest)}</p>${head(s, false)}<h2 id="splash-h">${esc(s.lead.summary || s.lead.title)}</h2>${provenance(s)}</section>`;
const emptyState = (h: string, p: string) => `<div class="empty"><p>${U(h)}</p><p class="c-w">${esc(p)}</p></div>`;

/** The desk menu plus the feed. This is the htmx swap target for desk changes, so it is a fragment on its own. */
export function feedzone(st: State, desk: string, splashId: string | null): string {
  const all = stories(st).filter((s) => s.id !== splashId);
  const counts: Record<string, number> = { all: all.length };
  for (const s of all) counts[s.group] = (counts[s.group] ?? 0) + 1;
  const d = DESKS.some(([g]) => g === desk) ? desk : "all";
  const menu = `<nav class="menu" aria-label="Desks">${DESKS.filter(([g]) => g === "all" || counts[g]).map(([g, l]) => {
    const url = g === "all" ? "/" : `/?desk=${g}`;
    return `<a href="${url}" hx-get="${url}" hx-target="#feedzone" hx-swap="outerHTML" hx-push-url="true"${d === g ? ' aria-current="true"' : ""}><b>${pageNo(g)}</b>${U(l === "Everything" ? "All" : l)}<small>${counts[g] ?? 0}</small></a>`;
  }).join("")}</nav>`;
  const shown = all.filter((s) => d === "all" || s.group === d);
  let list = "", last = "", open = false;
  const dayCount = (label: string) => shown.filter((s) => dayLabel(s.latest) === label).length;
  for (const s of shown) {
    const lbl = dayLabel(s.latest);
    if (lbl !== last) { list += `${open ? "</section>" : ""}<section class="day"><h2 class="band"><span>${U(lbl)}</span><small>${dayCount(lbl)}</small></h2>`; last = lbl; open = true; }
    list += storyHtml(s);
  }
  if (open) list += "</section>";
  return `<div id="feedzone">${menu}<p class="since" id="since" hidden><span id="since-t"></span></p><div class="feed" id="feed">${list || emptyState("Nothing on this desk", "Try All to see every story.")}</div></div>`;
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
  return `<div class="clock" data-kickoff="${esc(iso)}" role="timer" aria-label="Time to kick-off">${d > 0 ? t(d, "DAYS", "d") : ""}${t(h, "HRS", "h")}${t(m, "MIN", "m")}${withSeconds ? t(x, "SEC", "s") : ""}</div>`;
};

function availability() {
  const flagged = squad.rows.filter((r) => r.flag);
  return { out: flagged.filter((r) => r.flag!.tone === "bad"), doubt: flagged.filter((r) => r.flag!.tone === "warn"), flagged };
}
type SquadRow = SquadModel["rows"][number];
const what = (r: SquadRow) => (r.what || r.p.news.split(" - ")[0] || "").replace(/ injury$/i, "");
const chip = (r: SquadRow) => `<a class="${r.flag!.tone === "warn" ? "d" : "o"}" href="/squad#p-${r.p.id}">${U(r.p.web_name)}${what(r) ? ` <em>${esc(what(r))}${r.p.chance != null && r.flag!.tone === "warn" ? ` ${r.p.chance}%` : ""}</em>` : ""}</a>`;

export function board(): string {
  const ph = phase(), ev = nextEv(), a = availability(), last = resultsNow().at(-1);
  if (ph === "post" && last) {
    const t = last.home ? "Liverpool" : last.opp, o = last.home ? last.opp : "Liverpool";
    const [hs, as] = last.home ? [last.for, last.against] : [last.against, last.for];
    return `<section class="board" aria-labelledby="board-h"><p class="tags"><span class="t">FULL TIME</span> PREMIER LEAGUE ${U(shortDay(last.kickoff))}</p>
<h2 class="dh fx-a" id="board-h">${U(t)} ${hs}</h2><h2 class="dh fx-b">${U(o)} ${as}</h2>
${ev ? `<p class="out"><span class="lbl">NEXT</span> ${isUs(ev.home) ? U(ev.away) : `AT ${U(ev.home)}`}, ${U(ev.competition ?? "")}, <span class="c-w">${U(shortDay(ev.start))} ${hm(ev.start)}</span></p>` : ""}</section>`;
  }
  if (!ev) return "";
  const tag = ph === "live" ? `<span class="t flash">LIVE NOW</span>` : `<span class="t">${ph === "matchday" ? "MATCHDAY" : "NEXT UP"}</span>`;
  const main = ph === "live"
    ? `<p class="ko" data-kickoff="${esc(ev.start)}">KICKED OFF ${hm(ev.start)} <b data-elapsed>${Math.min(90, Math.max(1, Math.floor((NOW.getTime() - new Date(ev.start).getTime()) / 60000)))}'</b></p>`
    : tiles(ev.start, ph === "matchday");
  const opp = isUs(ev.home) ? `<i>V</i>${U(ev.away)}` : `<i>AT</i>${U(ev.home)}`;
  const outs = a.flagged.length
    ? `<p class="out"><span class="lbl">${ph === "pre" ? "TEAM NEWS SO FAR" : "OUT"}</span>${[...a.out, ...a.doubt].slice(0, 7).map(chip).join(" ")}</p><a class="more" href="/squad">${a.flagged.length > 7 ? `+${a.flagged.length - 7} MORE ` : ""}FULL SQUAD 200</a>`
    : `<p class="out"><span class="lbl">TEAM NEWS</span> Nobody on the injury list.</p>`;
  return `<section class="board" aria-labelledby="board-h"><p class="tags">${tag} ${U(ev.competition ?? "")}</p><p class="tags"><span class="c-w">${U(shortDay(ev.start))} ${hm(ev.start)}</span> ${U(ev.venue || "")}</p>
<h2 class="dh fx-a" id="board-h">LIVERPOOL</h2><h2 class="dh fx-b">${opp}</h2>${main}${outs}${ph === "live" ? `<a class="more" href="${esc(ev.url)}" rel="noopener" target="_blank">FOLLOW THE MATCH ON LIVERPOOLFC.COM</a>` : ""}</section>`;
}

function stopPress(all: Story[]) {
  const s = all.find((x) => x.material && ago(x.latest) < 6 * 3600);
  if (!s) return "";
  return `<div class="stop" role="status"><p class="band red flash"><span>STOP PRESS</span></p><a href="#s-${esc(s.id)}">${esc(s.lead.summary || s.lead.title)}<small>${timeTag(s.latest)} ${s.official ? "CLUB CONFIRMED" : "AWAITING CLUB"}</small></a></div>`;
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
const FAST: [string, string, string][] = [["wire", "/", "Wire"], ["squad", "/squad", "Squad"], ["table", "/table", "Table"], ["spiked", "/spiked", "Spiked"]];
const indexMenu = () => `<nav class="menu" aria-label="Page index">${PAGES.filter(([n]) => n.endsWith("00")).map(([n, u, l]) => `<a href="${u}"><b>${n}</b>${U(l)}</a>`).join("")}</nav>`;

export function shell(o: { title: string; active: string; page: string; band: string; tone?: string; body: string; top?: string; club?: string }) {
  const st = state, live = liveness(st);
  const clock = `<span class="dt" data-clock>${esc(fmt(NOW, { weekday: "short", day: "numeric", month: "short" }))} <i>${hm(NOW)}/${String(NOW.getSeconds()).padStart(2, "0")}</i></span>`;
  return `<!doctype html><html lang="en-GB" data-club="${esc(o.club ?? "lfc")}" data-now="${NOW.toISOString()}"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>${esc(o.title)}</title><meta name="description" content="Liverpool FC news from tier 1 sources only, filtered and summarised.">
<meta name="theme-color" content="#000000"><meta name="color-scheme" content="dark"><meta name="htmx-config" content='{"globalViewTransitions":false,"selfRequestsOnly":true,"allowScriptTags":false}'>
<link rel="icon" href="data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="#000"/><rect x="4" y="4" width="56" height="26" fill="#C8102E"/><rect x="4" y="34" width="26" height="26" fill="#0ff"/><rect x="34" y="34" width="26" height="26" fill="#ff0"/></svg>`)}">
<link rel="preload" href="/static/fonts/Bedstead.otf" as="font" type="font/otf" crossorigin>
<link rel="stylesheet" href="/static/css/fonts.css"><link rel="stylesheet" href="/static/css/wire.css">
<script src="/static/js/htmx.min.js" defer></script><script src="/static/js/wire.js" defer></script><script src="/static/js/push.js" defer></script>
</head><body hx-boost="true" data-pages='${esc(JSON.stringify(PAGES.map(([n, u]) => [n, u])))}'>
<a class="skip" href="#main">Skip to content</a>
<div class="screen">
<header class="th"><a class="pg" id="pgnum" href="/" aria-label="Page ${o.page}">P${o.page}</a>
  <button type="button" class="bell" id="alerts-btn" hidden aria-haspopup="dialog" aria-expanded="false"><span class="alerts-l">ALERTS</span></button>
  <a class="st ${live.tone}" href="/status" title="${esc(live.title)}" aria-label="Wire status: ${esc(live.stale ? "not updating" : live.title)}">${live.stale ? "STALE" : "● " + U(live.label)}</a>${clock}</header>
<div class="title"><h1 class="dh ${o.tone ?? ""}">${U(o.band)}</h1></div>
${live.stale && o.active !== "status" ? `<p class="c-r flash" role="status">NOT UPDATING SINCE ${U(rel(st.lastRun!))}. <a href="/status">STATUS 500</a></p>` : ""}
${o.top ?? ""}
<main id="main" tabindex="-1">${o.body}</main>
<footer class="foot"><p>READS LIVERPOOLFC.COM, BBC SPORT, SKY SPORTS, THE ATHLETIC AND THE LIVERPOOL ECHO EVERY 15 MINUTES.</p><p class="c-d">Summaries are machine-written from each outlet's headline and standfirst. Follow the link before relying on detail.</p>${indexMenu()}</footer>
</div>
<nav class="fast" aria-label="Sections"><div class="fast-in">${FAST.map(([k, h, l]) => `<a href="${h}"${o.active === k ? ' aria-current="page"' : ""}>${l}</a>`).join("")}</div></nav>
<dialog class="sheet" id="alerts-sheet" aria-labelledby="sheet-h"><div class="sheet-in"><p class="sheet-h" id="sheet-h">PHONE ALERTS</p><div id="sheet-body"></div></div></dialog>
</body></html>`;
}

// ---------- wire page ----------
export function wirePage(desk = "all", hxTarget?: string | null): string {
  const st = state, all = stories(st);
  const splash = desk === "all" ? (all.find((s) => s.material && ago(s.latest) < 72 * 3600 && ago(s.latest) >= 6 * 3600) ?? null) : null;
  if (hxTarget === "feedzone") return feedzone(st, desk, splash?.id ?? null);
  const body = `${board()}
${splash ? splashHtml(splash) : all.length && ago(all[0].latest) > 20 * 3600 ? `<div class="quiet"><p>ALL QUIET</p><p>Nothing new since ${esc(rel(all[0].latest))}. If something breaks, it lands here first.</p></div>` : ""}
${feedzone(st, desk, splash?.id ?? null)}
<div id="pulse" hx-get="/fragments/pulse" hx-trigger="every 120s" hx-swap="outerHTML" hx-vals='${esc(JSON.stringify({ run: st.lastRun ?? "", n: all.length }))}'></div>`;
  return shell({ title: "Liverpool Wire", active: "wire", page: pageNo(desk), band: "Liverpool Wire", body, top: stopPress(all) });
}
export function pulse(run: string, n: number): string {
  const cur = stories(state).length;
  const vals = esc(JSON.stringify({ run: state.lastRun ?? "", n: cur }));
  if (state.lastRun && run && state.lastRun !== run && cur > n)
    return `<div id="pulse" class="toast" role="status"><a href="/" hx-get="/" hx-target="body" hx-push-url="true">${cur - n} NEW ${cur - n === 1 ? "STORY" : "STORIES"}. SHOW <b>THEM</b></a></div>`;
  return `<div id="pulse" hx-get="/fragments/pulse" hx-trigger="every 120s" hx-swap="outerHTML" hx-vals='${vals}'></div>`;
}

// ---------- table page: fixtures, standing, form ----------
export function standingsAt(): { tab: Row[]; pos: number; me: Row } {
  const tab = tableAt(NOW.getTime());
  return { tab, pos: tab.findIndex((r) => r.id === myId) + 1, me: tab.find((r) => r.id === myId)! };
}
const ordText = (n: number) => { const t = n % 100, u = n % 10; return `${n}${t >= 11 && t <= 13 ? "TH" : u === 1 ? "ST" : u === 2 ? "ND" : u === 3 ? "RD" : "TH"}`; };
export function tablePage(): string {
  const { tab, pos, me } = standingsAt();
  const evs = (state.fixtures?.events ?? []).filter((e) => new Date(e.start).getTime() > NOW.getTime() - 2.5 * 36e5).slice(0, 8);
  const form = resultsNow().slice(-5);
  const body = `<h2 class="band yellow"><span>FIXTURES</span><small>NEXT ${evs.length}</small></h2>
<ol class="fxl">${evs.map((e) => `<li><a href="${esc(e.url)}" rel="noopener" target="_blank"><span class="d">${U(shortDay(e.start))}</span><span class="o">${isUs(e.home) ? "" : '<span class="at">AT </span>'}${U(isUs(e.home) ? e.away : e.home)}</span><span class="c">${U(e.competition ?? "")} ${hm(e.start)}</span></a></li>`).join("")}</ol>
<h2 class="band green" style="margin-top:.65em"><span>PREMIER LEAGUE</span><small>${me.p} PLAYED</small></h2>
<p class="pos"><b>${ordText(pos)}</b> ${me.pts} POINTS, GD ${me.gf - me.ga > 0 ? "+" : ""}${me.gf - me.ga}</p>
<p class="formrow" role="img" aria-label="Last ${form.length}: ${form.map((r) => r.res).join(" ")}"><span class="l">FORM</span>${form.map((r) => `<span class="r ${r.res}" title="${esc(`${r.home ? "v" : "at"} ${r.opp} ${r.for}-${r.against}, ${shortDate(r.kickoff)}`)}">${r.res}</span>`).join("")}</p>
<table class="lg"><thead><tr><th></th><th>CLUB</th><th>P</th><th>W</th><th>D</th><th>L</th><th>GD</th><th>PTS</th></tr></thead><tbody>${tab.map((r, i) => `<tr${r.id === me.id ? ' class="me"' : ""}><td>${i + 1}</td><td>${U(r.short)}</td><td>${r.p}</td><td>${r.w}</td><td>${r.d}</td><td>${r.l}</td><td>${r.gf - r.ga > 0 ? "+" : ""}${r.gf - r.ga}</td><td>${r.pts}</td></tr>`).join("")}</tbody></table>`;
  return shell({ title: "Table · Liverpool Wire", active: "table", page: "300", band: "Fixtures and table", tone: "green", body });
}

// ---------- squad ----------
const BINS = [10, 25, 50, 75, 90]; // six teletext colours: red, magenta, yellow, white, cyan, green
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
      return `<circle cx="${x(v)}" cy="${y}" r="${mate ? 3.6 : 2.8}" class="${mate ? "mate" : "dot"}"><title>${esc(`${p.n} (${p.t}) ${f(v, s)}`)}</title></circle>`;
    }).join("");
    const ends = [[lo, flip ? "end" : "start"], [hi, flip ? "start" : "end"]].map(([v, a]) => `<text x="${x(v as number)}" y="${H + 10}" text-anchor="${a}">${esc(f(v as number, s))}</text>`).join("");
    const label = `${s.label}: ${r.p.web_name} ${f(mv, s)}${r.cells[i].pct != null ? `, ${ordinal(r.cells[i].pct!)} percentile` : ""}`;
    return `<div class="strip"><h4><span>${U(s.label)}${s.unit === "p90" ? " /90" : ""}</span><span><b>${esc(f(mv, s))}</b>${rank != null ? ` ${ties > 1 ? "JOINT " : ""}${ordinal(rank).toUpperCase()} OF ${vals.length}` : " NOT RANKED"}</span></h4>
<svg viewBox="0 0 ${W} ${H + 12}" role="img" aria-label="${esc(label)}">${med != null ? `<line class="med" x1="${x(med)}" x2="${x(med)}" y1="4" y2="${H - 4}"/>` : ""}${ends}${dots}${mv != null ? `<circle class="me" cx="${x(mv)}" cy="${H / 2}" r="7"/>` : ""}</svg></div>`;
  }).join("") + `<p class="note">Right is always better. Yellow is ${esc(r.p.web_name)}, cyan are team-mates, grey is the rest of the division.</p>`;
}

const POS_TONE: Record<number, string> = { 1: "yellow", 2: "cyan", 3: "green", 4: "magenta" };
export function squadPage(): string {
  const m = squad, st = state;
  const fit = stories(st).filter((s) => s.group === "fitness" && ago(s.latest) < 21 * 864e5);
  const flagged = m.rows.filter((r) => r.flag).sort((a, b) => (a.flag!.tone === b.flag!.tone ? 0 : a.flag!.tone === "bad" ? -1 : 1));
  const outNow = flagged.map((r) => {
    const re = nameMatcher(r.p); let hit: { s: Story; x: Item } | null = null;
    for (const s of re ? fit : []) { const x = s.items.find((i) => textMatches(re!, `${i.summary ?? ""} ${i.title}`)); if (x) { hit = { s, x }; break; } }
    const since = r.current?.start ?? r.p.news_added;
    return `<li id="p-${r.p.id}"><span class="n">${U(r.p.web_name)}</span><span class="badge${r.flag!.tone === "warn" ? " doubt" : ""}">${U(r.flag!.text)}</span>
<span class="m">${esc(what(r) || "Unavailable")}${since ? ` since ${esc(shortDate(since))}` : ""}${r.current ? `, missed ${r.current.missed}` : ""}</span>${hit ? `<a class="s" href="/#s-${esc(hit.s.id)}">${esc(hit.x.summary || hit.x.title)}</a>` : ""}</li>`;
  }).join("");
  const scale = `<p class="legend" aria-hidden="true">BOTTOM<span class="sw">${[0, 1, 2, 3, 4, 5].map((i) => `<i class="q${i}" style="background:var(--cc)"></i>`).join("")}</span>TOP <span class="sw"><i class="pc q-na"></i></span>TOO FEW MINS</p>`;
  const positions = [1, 2, 3, 4].map((pos) => {
    const info = SQ_POS[pos], rows = m.rows.filter((r) => r.p.pos === pos);
    if (!rows.length) return "";
    const few = rows.filter((r) => r.p.minutes < 90);
    const body = rows.filter((r) => r.p.minutes >= 90).map((r) => {
      const cells = r.cells.map((c) => {
        const v = fmtStat(c.stat, c.value);
        const lbl = `${c.stat.label}${c.stat.unit === "p90" ? " per 90" : ""}: ${v || "none"}${c.pct != null ? `, ${ordinal(c.pct)} percentile` : ", not ranked"}`;
        return `<span class="pc ${qClass(c.pct)}" title="${esc(lbl)}" aria-label="${esc(lbl)}">${esc(v) || "-"}</span>`;
      }).join("");
      const mark = r.flag ? `<i class="${r.flag.tone === "warn" ? "doubt" : ""}" role="img" aria-label="${esc(r.flag.text)}">●</i>` : "";
      return `<details class="pr" id="pl-${r.p.id}" hx-get="/squad/player/${r.p.id}" hx-trigger="toggle once" hx-target="find .pr-x" hx-swap="innerHTML"><summary class="pt-row"><span class="who">${mark}${U(r.p.web_name)}</span>${cells}</summary><div class="pr-x" aria-live="polite"></div></details>`;
    }).join("");
    return `<section class="pos-sec" id="pos-${pos}"><h2 class="band ${POS_TONE[pos]}"><span>${U(info.many)}</span><small>${m.pools[pos]?.length ?? 0} IN LEAGUE</small></h2>
<div class="pt-row pt-head" aria-hidden="true"><span></span>${info.stats.map((s) => `<span>${U(s.label)}</span>`).join("")}</div>${body}
${few.length ? `<p class="few"><b>UNDER 90 MIN</b>${few.map((r) => `${esc(r.p.web_name)} ${r.p.minutes}`).join(", ")}</p>` : ""}</section>`;
  }).join("");
  const head = m.matches.map((f) => `<th scope="col" title="${esc(`${f.home ? "v" : "at"} ${f.opp}, ${shortDate(f.kickoff)}`)}"><span>${U(f.opp)}</span><span>${f.home ? "H" : "A"}</span></th>`).join("");
  const availRows = m.rows.filter((r) => r.p.pos !== 1 || r.p.minutes > 0 || r.flag).map((r) => `<tr><th scope="row">${U(r.p.web_name)}</th>${r.avail.map((a, i) => `<td><span class="av av-${a}" title="${esc(`${m.matches[i].opp}: ${AVAIL[a]}`)}"><span class="sr-only">${esc(AVAIL[a])}</span></span></td>`).join("")}</tr>`).join("");
  const body = `<p class="lead">${m.rows.length} PLAYERS. EVERY STAT IS PER 90 MINUTES AND RANKED AGAINST THE REST OF THE PREMIER LEAGUE AT THAT POSITION. ${m.played} MATCHES PLAYED. SELECT A PLAYER FOR DETAIL.</p>
${outNow ? `<section><h2 class="band red"><span>OUT NOW</span><small>${flagged.length}</small></h2><ul class="outl">${outNow}</ul></section>` : ""}
${scale}${positions}
${m.matches.length ? `<section class="pos-sec"><h2 class="band"><span>AVAILABILITY</span><small>LEAGUE</small></h2><p class="legend">${(["played", "injured", "suspended", "out"] as Avail[]).map((a) => `<span><span class="av av-${a}" aria-hidden="true"></span>${U(AVAIL[a])}</span>`).join(" ")}</p><div class="avt-wrap" tabindex="0"><table class="avt"><thead><tr><th scope="col"><span class="sr-only">Player</span></th>${head}</tr></thead><tbody>${availRows}</tbody></table></div></section>` : ""}
${m.away.length ? `<p class="few"><b>LEFT OR ON LOAN</b>${m.away.map((p) => esc(p.web_name)).join(", ")}</p>` : ""}`;
  return shell({ title: "Squad · Liverpool Wire", active: "squad", page: "200", band: "The squad", tone: "blue", body });
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

/** Fragment: result count and rows for a search and bucket. The form swaps this into #spiked-results. */
export function spikedResults(q: string, bucket: string): string {
  const t = q.trim().toLowerCase();
  const rows = droppedItems().filter((d) => (!bucket || bucketOf(d) === bucket) && (!t || (d.title + " " + d.source + " " + (d.reason ?? "")).toLowerCase().includes(t))).slice(0, 120);
  let out = "", last = "";
  for (const d of rows) {
    const day = dayLabel(d.published);
    if (day !== last) { out += `<li class="rd"><span class="band blue">${U(day)}</span></li>`; last = day; }
    out += `<li class="row"><time datetime="${esc(d.published)}">${hm(d.published)}</time><a href="${esc(d.url)}" rel="noopener" target="_blank">${esc(d.title)}</a><span class="why">${U(short(d.source))} <em>${esc(d.reason || "No reason given")}</em></span></li>`;
  }
  return `<div id="spiked-results"><output for="q" aria-live="polite">${t || bucket ? plural(rows.length, "match").replace("matchs", "matches").toUpperCase() + (rows.length === 120 ? " (FIRST 120)" : "") : ""}</output><ul class="rows">${out || `<li>${emptyState("Nothing spiked", "No articles match.")}</li>`}</ul></div>`;
}
export function spikedPage(q = "", bucket = ""): string {
  const d = droppedItems(), total = state.items.filter((i) => i.status !== "pending").length;
  const tally = new Map<string, number>(); for (const x of d) tally.set(bucketOf(x), (tally.get(bucketOf(x)) ?? 0) + 1);
  const max = Math.max(1, ...tally.values());
  const row = (k: string, n: number, w: number, label: string) => `<li><label class="bucket"${bucket === k ? " aria-current=\"true\"" : ""}><input class="sr-only" type="radio" name="bucket" value="${esc(k)}"${bucket === k ? " checked" : ""}><span>${U(label)}</span><span class="n">${n}</span><span class="bar"><i style="width:${w}%"></i></span></label></li>`;
  const bars = [...tally.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => row(k, n, Math.round((n / max) * 100), k)).join("");
  const body = `<p class="lead">EVERYTHING THE FILTER REJECTED IN THE LAST 14 DAYS, AND WHY. IF SOMETHING HERE SHOULD HAVE MADE THE WIRE, THE FILTER IS TOO STRICT.</p>
<dl class="kpis"><div><dt>SPIKED</dt><dd><b>${d.length}</b> <small>OF ${total}</small></dd></div><div><dt>NOISE REMOVED</dt><dd><b>${total ? Math.round((d.length / total) * 100) : 0}%</b></dd></div></dl>
<form action="/spiked" method="get" hx-get="/spiked" hx-trigger="input changed delay:180ms, submit" hx-target="#spiked-results" hx-swap="outerHTML" hx-push-url="true">
<h2 class="band magenta" style="margin-top:.65em"><span>WHY SPIKED</span><small>CHOOSE ONE</small></h2>
<ul class="buckets">${row("", d.length, 100, "Any reason")}${bars}</ul>
<p class="find"><label for="q">FIND&gt;</label><input id="q" name="q" type="search" value="${esc(q)}" placeholder="headline, outlet or reason" autocomplete="off"><noscript><button class="btn" type="submit">GO</button></noscript></p>
</form>
${spikedResults(q, bucket)}`;
  return shell({ title: "Spiked · Liverpool Wire", active: "spiked", page: "400", band: "Spiked", tone: "magenta", body });
}

// ---------- status ----------
const pence = (u?: { in: number; out: number }) => (u ? ((u.in * 0.75 + u.out * 3.75) / 1e6) * 0.75 * 100 : 0);
export function statusPage(): string {
  const st = state, live = liveness(st);
  const failing = SOURCE_NAMES.filter(([k]) => (st.health[k]?.fails ?? 0) > 0);
  const headline = live.stale ? "THE WIRE HAS STOPPED UPDATING" : failing.length ? `${failing.length} SOURCE${failing.length > 1 ? "S" : ""} FAILING` : live.backlog ? "THE FILTER IS FALLING BEHIND" : "EVERYTHING IS WORKING";
  const srcRows = SOURCE_NAMES.map(([k, n]) => {
    const h = st.health[k], ok = h && h.fails === 0 && h.lastOk;
    return `<li><span class="dot-s ${ok ? "" : h?.lastOk ? "bad" : "warn"}">●</span><span>${U(n)}</span><span class="t">${h?.lastOk ? timeTag(h.lastOk) : ""}</span>${!ok && h?.lastError ? `<small>${esc(h.lastError)}</small>` : ""}</li>`;
  }).join("");
  const days = Object.keys(st.usage).sort().slice(-7), vals = days.map((d) => pence(st.usage[d])), vmax = Math.max(0.01, ...vals);
  const today = days.at(-1) ?? "", t = st.usage[today] ?? { in: 0, out: 0, calls: 0 };
  const spark = `<div class="spark" role="img" aria-label="Filter cost per day, last ${days.length} days">${days.map((d, i) => `<div class="${d === today ? "today" : ""}" title="${esc(d)}: ${vals[i].toFixed(2)}p"><i style="height:${Math.max(3, (vals[i] / vmax) * 64)}px"></i>${U(new Date(d + "T12:00:00Z").toLocaleDateString("en-GB", { weekday: "short", timeZone: TZ }))}</div>`).join("")}</div>`;
  const kept = st.items.filter((i) => i.status === "kept").length, dropped = st.items.filter((i) => i.status === "dropped").length;
  const body = `<div id="status-live" hx-get="/status" hx-trigger="every 30s" hx-select="#status-live" hx-swap="outerHTML" hx-push-url="false">
<p class="headline"><span class="pip ${live.tone === "ok" ? "" : live.tone}"></span>${headline}</p>
<h2 class="band cyan" style="margin-top:.65em"><span>SOURCES</span></h2><ul class="srcs">${srcRows}</ul>
<h2 class="band yellow" style="margin-top:.65em"><span>FILTER</span></h2>
<dl class="facts"><div><dt>LAST RUN</dt><dd>${st.lastRun ? timeTag(st.lastRun) : "Not yet"}</dd></div><div><dt>READS</dt><dd>EVERY 15 MIN</dd></div><div><dt>ALERTS TODAY</dt><dd>${st.pushes?.[today] ?? 0} OF 6</dd></div><div><dt>KEPT</dt><dd>${kept} IN 14 DAYS</dd></div><div><dt>SPIKED</dt><dd><a class="c-c" href="/spiked">${dropped} ARTICLES</a></dd></div><div><dt>COST TODAY</dt><dd>${pence(t).toFixed(2)}P, ${plural(t.calls, "call").toUpperCase()}</dd></div></dl>${spark}</div>`;
  return shell({ title: "Status · Liverpool Wire", active: "status", page: "500", band: "Status", tone: "cyan", body });
}

export const shortsPage = () => shell({ title: "Shorts · Liverpool Wire", active: "shorts", page: "600", band: "Shorts", tone: "blue", body: `<p class="lead">THE SHORTS PLAYER KEEPS ITS CURRENT BEHAVIOUR AND ONLY PICKS UP THE NEW LOOK. IT IS OUT OF SCOPE FOR THIS PASS.</p>` });
